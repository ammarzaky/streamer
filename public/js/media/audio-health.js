/**
 * The verdict: one sentence about whether anyone can hear you, and why not.
 *
 * Everything else in the audio diagnostics produces numbers. This turns them into the answer a
 * person needs, in a fixed order of precedence, with hold-times so the banner does not flicker
 * between two truths on alternate seconds.
 *
 * Pure and table-driven so every rule is a unit test. The caller keeps the `tracker` object
 * between calls; it holds the timestamps a rule needs to say "for the last N seconds".
 */

import { SPEAKING_THRESHOLD } from './level-meter.js';

export const HEALTH = Object.freeze({
  MIC_ERROR: 'MIC_ERROR',
  ENGINE_SUSPENDED: 'ENGINE_SUSPENDED',
  TRACK_ENDED: 'TRACK_ENDED',
  SOURCE_MUTED: 'SOURCE_MUTED',
  CAPTURE_SILENT: 'CAPTURE_SILENT',
  NOT_ATTACHED: 'NOT_ATTACHED',
  UNHEARD_PLAYBACK: 'UNHEARD_PLAYBACK',
  UNHEARD_TRANSPORT: 'UNHEARD_TRANSPORT',
  TALKING_WHILE_MUTED: 'TALKING_WHILE_MUTED',
  HEARD: 'HEARD',
  OK: 'OK',
});

export const SEVERITY = Object.freeze({
  [HEALTH.MIC_ERROR]: 'danger',
  [HEALTH.ENGINE_SUSPENDED]: 'warn',
  [HEALTH.TRACK_ENDED]: 'danger',
  [HEALTH.SOURCE_MUTED]: 'danger',
  [HEALTH.CAPTURE_SILENT]: 'warn',
  [HEALTH.NOT_ATTACHED]: 'danger',
  [HEALTH.UNHEARD_PLAYBACK]: 'danger',
  [HEALTH.UNHEARD_TRANSPORT]: 'danger',
  [HEALTH.TALKING_WHILE_MUTED]: 'warn',
  [HEALTH.HEARD]: 'ok',
  [HEALTH.OK]: null,
});

const RANK = { danger: 3, warn: 2, ok: 1, null: 0 };

/** Below this an RMS level is "no sound". Calibrated against the fake device (tone ≈ 0.3) and a
 *  headset with noise suppression on (room tone ≈ 0.001-0.004). */
export const SILENT_LEVEL = 0.01;

/** How long a condition must persist before it is worth a banner. */
export const HOLD_MS = Object.freeze({
  CAPTURE_SILENT: 8000,
  NOT_ATTACHED: 5000,
  UNHEARD: 4000,
  TALKING_WHILE_MUTED: 2000,
  /** A shown verdict is kept at least this long unless something more severe appears. */
  SHOW: 3000,
  /** A remote report older than this says nothing about now. */
  REPORT_FRESH: 8000,
  /** "Recently speaking" for the unheard rules. */
  SPEAKING_RECENT: 2500,
  /**
   * "Recently heard" -- the latch that stops CAPTURE_SILENT firing during a conversation.
   *
   * A peer's report carries the level they heard from us in the LAST SECOND, so it drops to
   * zero every time we stop talking to listen. Without a latch the suppression evaporated on
   * the first ordinary pause and the banner appeared mid-conversation. Somebody who heard us
   * within the last half minute is evidence that the microphone works; going quiet is not
   * evidence that it stopped.
   */
  HEARD_RECENT: 30000,
});

export function createHealthTracker() {
  return {
    silentSince: null,
    notAttachedSince: null,
    unheardSince: null,
    talkingMutedSince: null,
    lastSpokeAt: null,
    lastHeardAt: null,
    shownCode: null,
    shownAt: null,
    shownParams: null,
  };
}

/**
 * @param {object} snapshot
 *   self: { micMuted, micAvailable, micError, micEnded, micSourceMuted, micLabel, lobbyPeak }
 *   meter: { contextState, dead, reason, level } | null
 *   peers: [{ id, name, pcState, hasMicSender, micRms, hearsMe: {level, playing, at} | null }]
 *
 * `peers[].micRms` is OUR OWN microphone as the encoder on that connection saw it
 * (`media-source.totalAudioEnergy`), not the peer's. It is a second, independent witness to
 * the same question the meter answers, and it does not go through the meter's clone -- which
 * is the whole reason it matters here.
 * @param {object} tracker  from createHealthTracker(); mutated
 * @param {number} nowMs
 * @returns {{ code: string, severity: string|null, params: object, changed: boolean }}
 */
export function deriveAudioHealth(snapshot, tracker, nowMs) {
  const self = snapshot.self ?? {};
  const meter = snapshot.meter ?? null;
  const peers = snapshot.peers ?? [];
  // A missing meter is UNKNOWN, not silent. It used to read as 0, which meant a meter that
  // failed to build -- or was torn down for a device switch -- looked exactly like a dead
  // microphone and could raise the banner on its own.
  const level = Number.isFinite(meter?.level) ? meter.level : null;
  const connected = peers.filter((p) => p.pcState === 'connected');
  const label = self.micLabel || '';

  // The encoder's own view of the microphone, from whichever connection reports the most
  // energy. Independent of the meter's clone, so the two can only agree by actually agreeing.
  const encoderRms = peers.reduce(
    (best, p) => (Number.isFinite(p.micRms) && (best === null || p.micRms > best) ? p.micRms : best),
    null,
  );

  if (level !== null && level > SPEAKING_THRESHOLD) tracker.lastSpokeAt = nowMs;
  const speakingRecently =
    tracker.lastSpokeAt !== null && nowMs - tracker.lastSpokeAt <= HOLD_MS.SPEAKING_RECENT;

  // -- Timers: each condition's start is recorded while it holds and cleared when it stops. --

  // Both witnesses must agree before the clock starts. Either one reading null is a MISSING
  // witness, not a quiet one, and a missing witness never convicts -- which is why being alone
  // in the room (no encoder report at all) cannot raise this verdict. That is deliberate: with
  // nobody to hear you, the claim has no consequence, and the lobby check already covers the
  // moment before joining.
  const meterSilent = level !== null && level < SILENT_LEVEL;
  const encoderSilent = encoderRms !== null && encoderRms < SILENT_LEVEL;
  const unmutedAndSilent =
    !self.micMuted && self.micAvailable !== false && meterSilent && encoderSilent;
  tracker.silentSince = unmutedAndSilent ? (tracker.silentSince ?? nowMs) : null;

  const detached = connected.find((p) => p.hasMicSender === false) ?? null;
  tracker.notAttachedSince = detached ? (tracker.notAttachedSince ?? nowMs) : null;

  const talkingMuted = Boolean(self.micMuted) && level !== null && level > SPEAKING_THRESHOLD;
  tracker.talkingMutedSince = talkingMuted ? (tracker.talkingMutedSince ?? nowMs) : null;

  const fresh = (p) =>
    p.hearsMe && Number.isFinite(p.hearsMe.at) && nowMs - p.hearsMe.at <= HOLD_MS.REPORT_FRESH;
  const reporting = connected.filter(fresh);
  const heardBy =
    reporting.find((p) => Number.isFinite(p.hearsMe.level) && p.hearsMe.level >= SILENT_LEVEL) ?? null;
  // Latched, mirroring `lastSpokeAt`. `heardBy` is a statement about the last second and drops
  // out the instant you stop talking; `heardRecently` is the one the silence rule needs, or the
  // suppression collapses in every conversational pause. The UNHEARD rules deliberately keep
  // using the instantaneous `heardBy`: "I am speaking and they do not hear me right now" is a
  // real condition even if they heard me a moment ago.
  if (heardBy) tracker.lastHeardAt = nowMs;
  const heardRecently =
    tracker.lastHeardAt !== null && nowMs - tracker.lastHeardAt <= HOLD_MS.HEARD_RECENT;
  const unheardBy =
    !self.micMuted && speakingRecently && reporting.length > 0 && !heardBy
      ? (reporting.find((p) => Number.isFinite(p.hearsMe.level) && p.hearsMe.level < SILENT_LEVEL) ?? null)
      : null;
  tracker.unheardSince = unheardBy ? (tracker.unheardSince ?? nowMs) : null;

  // -- Rules, first match wins. --

  let code = HEALTH.OK;
  let params = {};

  if (self.micError && self.micAvailable === false) {
    code = HEALTH.MIC_ERROR;
    params = { error: self.micError };
  } else if (meter && meter.contextState && meter.contextState !== 'running' && !meter.dead) {
    code = HEALTH.ENGINE_SUSPENDED;
  } else if (self.micEnded || meter?.dead || meter?.reason === 'track-ended') {
    // `micEnded` is the composition root's record of an `ended` event; by the time the verdict
    // runs the dead meter has already been torn down, so the meter alone cannot say it.
    code = HEALTH.TRACK_ENDED;
    params = { label };
  } else if (self.micSourceMuted || meter?.reason === 'source-muted' || meter?.health === 'source-muted') {
    code = HEALTH.SOURCE_MUTED;
    params = { label };
  } else if (tracker.silentSince !== null && nowMs - tracker.silentSince >= HOLD_MS.CAPTURE_SILENT) {
    // Only when nobody on the far end contradicts it: a peer who has heard us recently
    // outranks a local meter that reads zero (a broken clone is not a broken microphone).
    if (!heardRecently) {
      code = HEALTH.CAPTURE_SILENT;
      params = {
        label,
        lobbyWorked: Number.isFinite(self.lobbyPeak) && self.lobbyPeak > SPEAKING_THRESHOLD,
      };
    }
  }

  if (code === HEALTH.OK && detached && nowMs - tracker.notAttachedSince >= HOLD_MS.NOT_ATTACHED) {
    code = HEALTH.NOT_ATTACHED;
    params = { name: detached.name };
  }
  if (code === HEALTH.OK && unheardBy && nowMs - tracker.unheardSince >= HOLD_MS.UNHEARD) {
    code = unheardBy.hearsMe.playing === false ? HEALTH.UNHEARD_PLAYBACK : HEALTH.UNHEARD_TRANSPORT;
    params = { name: unheardBy.name };
  }
  if (code === HEALTH.OK && talkingMuted && nowMs - tracker.talkingMutedSince >= HOLD_MS.TALKING_WHILE_MUTED) {
    code = HEALTH.TALKING_WHILE_MUTED;
  }
  if (code === HEALTH.OK && !self.micMuted && heardBy) {
    code = HEALTH.HEARD;
    params = { name: heardBy.name, level: heardBy.hearsMe.level };
  }

  // -- Hold: keep what is shown for a moment unless something more severe arrived. --
  const severity = SEVERITY[code];
  if (
    tracker.shownCode &&
    tracker.shownCode !== code &&
    tracker.shownAt !== null &&
    nowMs - tracker.shownAt < HOLD_MS.SHOW &&
    RANK[severity] <= RANK[SEVERITY[tracker.shownCode]]
  ) {
    return {
      code: tracker.shownCode,
      severity: SEVERITY[tracker.shownCode],
      params: tracker.shownParams ?? {},
      changed: false,
    };
  }

  const changed = tracker.shownCode !== code;
  if (changed) {
    tracker.shownCode = code;
    tracker.shownAt = nowMs;
  }
  tracker.shownParams = params;
  return { code, severity, params, changed };
}
