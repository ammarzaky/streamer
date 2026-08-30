/**
 * The lobby microphone check.
 *
 * Runs before joining, which is the whole point: a blocked, missing, muted or silent microphone
 * is trivial to fix while you are still on the join screen and awkward to fix once four people
 * are waiting. It also moves the permission prompt to the moment the user is expecting one.
 *
 * It acquires its own stream because the media manager does not exist until `welcome` has
 * arrived and brought the server config with it -- which happens after the user has already
 * pressed Join. But it acquires it with the SAME constraint builder the room uses, and on join
 * the stream is HANDED OVER (`takeStream`) rather than stopped and re-acquired, so the track the
 * bar moved for is the track peers receive. A green bar here used to prove nothing about the
 * room; now it does.
 */

import { createLevelMeter, SPEAKING_THRESHOLD } from './level-meter.js';
import { SILENT_LEVEL } from './audio-health.js';
import { micConstraints, pickSettings, CLIENT_AUDIO_DEFAULTS } from './mic-constraints.js';
import { micError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { ERRORS } from '../../shared/protocol.js';

/** What the check concluded, as something the UI can render without interpreting errors. */
export const MIC_STATE = Object.freeze({
  CHECKING: 'checking',
  /** Acquired, and picking up sound. */
  HEARING: 'hearing',
  /** Acquired, but nothing above the noise floor yet. Not a fault. */
  QUIET: 'quiet',
  /** Acquired, but the capture endpoint is muted in Windows: the track's `muted` flag is true.
   *  Chromium polls the endpoint's mute state once a second and mirrors it onto the track, so
   *  this is definitive, arrives within a second, and clears by itself on unmute. */
  OS_MUTED: 'os-muted',
  /** Acquired, live and NOT muted, and not one sample above SILENT_LEVEL for LOBBY_SILENT_MS.
   *  The fallback for a capture that delivers real near-zero samples with `muted: false` -- an
   *  APO or hardware-gated mute, a headset's own switch, or simply a quiet room. */
  SILENT: 'silent',
  /** Unusable: denied, absent, or held by another application. */
  FAILED: 'failed',
});

/**
 * How long a live, unmuted lobby track may deliver nothing above SILENT_LEVEL before the check
 * stops calling it "quiet" and says so. Counted from acquisition, or from the last `unmute`.
 *
 * Measured (Electron 33 / Chrome 130, a real device): a Windows capture endpoint muted at OS
 * level (IAudioEndpointVolume mute -- the keyboard's mic-mute key, or Settings › System › Sound ›
 * Input › the device) IS visible to the page. A track acquired while the endpoint is already
 * muted reports `muted: true` from its first tick; muting a live track fires `mute` within about
 * a second (Chromium polls the OS mute state once a second); unmuting fires `unmute`. That case
 * is OS_MUTED and needs no waiting. What the signal alone cannot distinguish is a capture that
 * delivers real near-zero samples with `muted: false` (measured processed-path peak 6e-5..1e-4
 * against speech at 0.1..0.2) from a live but quiet room. For that this budget is the fallback:
 * no sound at all for this long.
 */
export const LOBBY_SILENT_MS = 6000;

/** How many times the meter is rebuilt when only its clone ended while the track stayed live.
 *  Bounded so a clone that keeps dying cannot spin the check forever. */
const MAX_METER_REBUILDS = 3;

/**
 * The lobby verdict from what the meter has seen so far. Pure, so the rule is a unit test.
 *
 * Precedence: OS_MUTED (the track says so) > HEARING (the latch) > QUIET > SILENT (the budget).
 * FAILED is decided outside this helper, from errors and the meter's death.
 *
 * @param {object} facts
 * @param {boolean} facts.everHeard       a level above SPEAKING_THRESHOLD has been seen (latched)
 * @param {boolean} facts.soundSeen       a level above SILENT_LEVEL has been seen since the track
 *   was last unmuted (latched until the next unmute)
 * @param {number} facts.msSinceUnmuted   time since the track was last known unmuted: since
 *   getUserMedia resolved for a track that started unmuted, since the last `unmute` otherwise.
 *   The silence budget runs from there, so a mute-then-unmute never inherits a stale count.
 * @param {boolean} [facts.trackMuted]    the track's `muted` flag: the endpoint is muted in Windows
 * @param {string|null} [facts.contextState]  the meter's AudioContext state; a suspended engine
 *   reads zero through no fault of the device, so only 'running' can conclude silence
 * @returns {string} one of MIC_STATE.OS_MUTED, MIC_STATE.HEARING, MIC_STATE.QUIET, MIC_STATE.SILENT
 */
export function lobbyMicState({ everHeard, soundSeen, msSinceUnmuted, trackMuted = false, contextState = 'running' }) {
  // The OS mute outranks the latch: a microphone that worked a moment ago and is muted now is
  // muted now, and the line must say so rather than "working".
  if (trackMuted) return MIC_STATE.OS_MUTED;
  if (everHeard) return MIC_STATE.HEARING;
  if (soundSeen || contextState !== 'running') return MIC_STATE.QUIET;
  if (Number.isFinite(msSinceUnmuted) && msSinceUnmuted >= LOBBY_SILENT_MS) return MIC_STATE.SILENT;
  return MIC_STATE.QUIET;
}

/**
 * @param {(update: {state: string, level: number, code?: string, label?: string, settings?: object}) => void} onUpdate
 * @param {{deviceId?: string|null}} [options]  a specific input, or null for the browser default
 * @returns {{stop: () => void, takeStream: () => MediaStream|null, result: () => object}}
 */
export function startMicCheck(onUpdate, { deviceId = null } = {}) {
  const requestedDeviceId = deviceId;
  let stopped = false;
  let handedOff = false;
  let meter = null;
  let stream = null;
  let state = MIC_STATE.CHECKING;
  let label = '';
  let settings = null;
  let code = null;
  let peak = 0;
  let lastLevel = 0;
  /** Latches once sound is heard, so a natural pause between words does not flip the label
   *  back to "quiet" and make a working microphone look intermittent. */
  let everHeard = false;
  /** Latches on the first level above SILENT_LEVEL: anything at all, speech or not. Reset on
   *  unmute, because what arrived before the mute says nothing about what arrives after it. */
  let soundSeen = false;
  let acquiredAt = null;
  /** When the current unmuted stretch began: acquisition, or the last `unmute`. The silence
   *  budget counts from here, and does not run at all while the endpoint is muted. */
  let silenceSince = null;
  /** The 'silent' warning is worth one log line per check, not one per transition. */
  let silentWarned = false;
  /** The meter's AudioContext state, from its health reports. */
  let contextState = null;
  /** Set when the meter reports itself dead. A dead meter's final zero is not a reading, and
   *  nothing it says afterwards can conclude anything about the device. */
  let meterDead = false;
  let meterRebuilds = 0;
  /** The ORIGINAL track and the mute/unmute listener on it. The meter's clone follows the
   *  source's `muted` flag in Chromium, but the verdict reads the original: it is the track the
   *  room receives, and the one a test can stub. */
  let sourceTrack = null;
  let onSourceMuteChange = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    meter?.stop();
    meter = null;
    if (sourceTrack && onSourceMuteChange) {
      sourceTrack.removeEventListener('mute', onSourceMuteChange);
      sourceTrack.removeEventListener('unmute', onSourceMuteChange);
    }
    onSourceMuteChange = null;
    // Released so the real acquisition on join is not competing with this one for the device --
    // unless the room took it over, in which case it is the room's now.
    if (!handedOff) stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  /** Hand the live stream to the room. The meter's clone is stopped by `stop()`; the original
   *  track survives, which is the point. */
  const takeStream = () => {
    if (stopped || !stream) return null;
    handedOff = true;
    return stream;
  };

  /** What happened, for the log and the diagnostics dump. `peak` is the loudest smoothed level
   *  seen; above SPEAKING_THRESHOLD means the device delivered speech at least once. */
  const result = () => ({
    state,
    code,
    label,
    settings,
    peak,
    deviceId,
    requestedDeviceId,
    heard: everHeard,
    trackMuted: sourceTrack?.muted ?? null,
    meter: meter?.state?.() ?? null,
  });

  onUpdate?.({ state, level: 0 });

  (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
      let acquired;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(CLIENT_AUDIO_DEFAULTS, { deviceId }),
          video: false,
        });
      } catch (err) {
        // The chosen device vanished; the default is better than nothing, and the log says so.
        if (deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
          logger.warn('audio: lobby device unavailable, using default', { deviceId, name: err?.name });
          acquired = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints(CLIENT_AUDIO_DEFAULTS, {}),
            video: false,
          });
          // What was opened is what the result reports; the room follows it on Join rather
          // than re-asking for a device that is not there. The only writer of `deviceId`
          // after the await is this branch, so the race the lint rule guards against cannot
          // happen here.
          // eslint-disable-next-line require-atomic-updates
          deviceId = null;
        } else {
          throw err;
        }
      }

      // The user may have pressed Join while the permission prompt was open.
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = acquired;
      acquiredAt = Date.now();
      silenceSince = acquiredAt;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no audio track');
      sourceTrack = track;

      label = track.label;
      try {
        settings = pickSettings(track.getSettings?.() ?? {});
      } catch {
        settings = null;
      }
      logger.info('audio: lobby mic acquired', { label, muted: track.muted, settings });

      /**
       * Re-derive the verdict from the latches and the track, narrate the transitions, and tell
       * the UI. Called on every meter tick and, without waiting for one, on the track's
       * mute/unmute events.
       */
      const recompute = (level) => {
        const now = Date.now();
        if (state === MIC_STATE.OS_MUTED && !track.muted) {
          // The budget starts over from the unmute, and so does "anything at all": what the
          // device delivered before Windows muted it says nothing about what it delivers now.
          silenceSince = now;
          soundSeen = false;
          logger.info('audio: lobby mic os-unmuted', { label });
        }
        const next = lobbyMicState({
          everHeard,
          soundSeen,
          msSinceUnmuted: now - silenceSince,
          trackMuted: track.muted,
          contextState,
        });
        if (next === MIC_STATE.OS_MUTED && state !== MIC_STATE.OS_MUTED) {
          logger.warn('audio: lobby mic os-muted', { label });
        }
        if (next === MIC_STATE.SILENT && !silentWarned) {
          silentWarned = true;
          logger.warn('audio: lobby mic silent', { label, msSinceUnmuted: now - silenceSince, peak, trackMuted: track.muted });
        }
        state = next;
        onUpdate?.({ state, level, label, settings });
      };

      const onLevel = (level) => {
        if (stopped || meterDead) return;
        lastLevel = level;
        if (level > peak) peak = level;
        if (level > SILENT_LEVEL) soundSeen = true;
        if (level > SPEAKING_THRESHOLD) everHeard = true;
        recompute(level);
      };

      // The OS mute is an event, not a reading: the line changes the moment Chromium notices,
      // not on the next meter tick -- and not at all if the meter could not be built.
      onSourceMuteChange = (event) => {
        if (stopped || state === MIC_STATE.FAILED) return;
        logger.info(`audio: lobby mic track ${event.type}`, { label, muted: track.muted });
        recompute(track.muted ? 0 : lastLevel);
      };
      track.addEventListener('mute', onSourceMuteChange);
      track.addEventListener('unmute', onSourceMuteChange);

      const onState = (meterState) => {
        contextState = meterState.contextState;
        logger.info('audio: lobby meter state', {
          health: meterState.health,
          contextState: meterState.contextState,
          trackMuted: meterState.trackMuted,
          reason: meterState.reason,
        });
        if (!meterState.dead || meterDead || stopped) return;
        meterDead = true;
        logger.warn('audio: lobby meter dead', { label, reason: meterState.reason, rebuilds: meterRebuilds });

        // Only the meter's own clone ended, and the track the room would receive is still
        // live: a fresh meter on the same track carries on. Deferred so the dying meter
        // finishes its last words (its final zero is swallowed by `meterDead`) before the
        // replacement starts reporting.
        if (meterState.reason === 'clone-ended' && track.readyState === 'live' && meterRebuilds < MAX_METER_REBUILDS) {
          meterRebuilds++;
          queueMicrotask(() => {
            if (stopped || track.readyState !== 'live') return;
            meterDead = false;
            meter = createLevelMeter(track, onLevel, { onState });
          });
          return;
        }

        // No further reading will ever arrive, so the line must not freeze on "say something"
        // -- or, worse, escalate to the silent copy on the dead meter's zero.
        if (meterState.reason === 'track-ended' || meterState.reason === 'no-track') {
          // The device is gone: unplugged, or seized by another application.
          state = MIC_STATE.FAILED;
          code = ERRORS.MIC_NOT_FOUND;
          onUpdate?.({ state, level: 0, code, label, settings });
          return;
        }
        // The meter could not be built (no AudioContext, setup threw) but the device IS open
        // and the room can still use it; saying it "could not be opened" would be wrong.
        // Acquired and nothing heard is QUIET (or OS_MUTED, which the track itself says); the
        // bar simply cannot move. A dead meter has no running context, so SILENT is impossible.
        recompute(0);
      };

      meter = createLevelMeter(track, onLevel, { onState });
      // A track acquired while the endpoint is already muted says so from its first tick; say
      // it now rather than after the meter's first reading.
      if (track.muted && !stopped && state !== MIC_STATE.FAILED) recompute(0);
    } catch (err) {
      if (stopped) return;
      const mapped = micError(err);
      code = mapped.code;
      state = MIC_STATE.FAILED;
      logger.warn('mic-check: unavailable', { code: mapped.code, name: err?.name, message: err?.message });
      onUpdate?.({ state, level: 0, code: mapped.code });
    }
  })();

  return { stop, takeStream, result };
}
