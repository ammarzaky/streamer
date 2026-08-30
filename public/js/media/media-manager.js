/**
 * Local media: the microphone, and the screen capture.
 *
 * Two rules shape this module, and both come from failures that are invisible until someone
 * complains:
 *
 * 1. **The microphone and the shared system audio are separate tracks that are never
 *    conflated.** Muting your mic must not silence the film you are sharing. They live on
 *    separate senders and the mute path touches only the mic.
 *
 * 2. **`getDisplayMedia` is called synchronously from the click handler.** It requires
 *    transient user activation, so it cannot be awaited behind a server round trip -- see
 *    `captureDisplay` below.
 *
 * A third rule arrived with the third "nobody can hear me" report: **the microphone is never
 * acquired silently.** Which device the browser opened, what it reports about it, and every
 * later change to it (source muted, ended, devices plugged in) is logged and surfaced, because a
 * track that is `live`, `enabled` and delivering digital silence looks exactly like a working
 * one from every other angle.
 */

import { ERRORS } from '../../shared/protocol.js';
import { micError, shareError, AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { isE2E } from '../core/env.js';
import { makeSyntheticDisplayStream } from './synthetic-stream.js';
import {
  micConstraints,
  pickSettings,
  describeDevices,
  sameProcessing,
  PROCESSING_KEYS,
} from './mic-constraints.js';

export function createMediaManager({
  config,
  onShareEnded,
  onDisplayAudioEnded,
  onDisplaySettingsChanged,
  onMicTrackState,
  onDevicesChanged,
}) {
  /** @type {MediaStream|null} */
  let micStream = null;
  /** In-flight getUserMedia, so concurrent callers share one device request. */
  let micRequest = null;
  /** @type {MediaStream|null} */
  let displayStream = null;

  let micMuted = false;
  let sharing = false;

  /** Guards `stopShare` against re-entry. It is reachable from five paths -- the browser's own
   *  stop button, our Stop button, a takeover revoke, room-ended, and teardown -- and several
   *  of them can fire together. */
  let stoppingShare = false;

  /** The device the user asked for; null means "whatever the browser calls default". Kept in
   *  memory only -- this app stores nothing but the host token. */
  let currentDeviceId = null;
  /** Processing flags changed at runtime (AEC/NS/AGC). Layered over the server config. */
  const processingOverrides = {};
  /** The last enumerateDevices() result, described. */
  let devices = null;
  let acquiredAt = null;
  /** Set by stopAll(): the session is over and nothing may re-open the microphone. */
  let stopped = false;

  /**
   * Every acquisition goes through one chain. Two overlapping getUserMedia calls -- a device
   * switch during a processing switch, an unmute during a restart -- would otherwise both
   * adopt, both replace the senders' track in whatever order they resolved, and leave one
   * capture open for the life of the page with the mute button acting on the other.
   */
  let micChain = Promise.resolve();
  const serial = (fn) => {
    const run = micChain.then(fn, fn);
    micChain = run.catch(() => {});
    return run;
  };

  // -------------------------------------------------------------------------
  // Microphone
  // -------------------------------------------------------------------------

  /** The audio config in force: server config, then anything toggled this session. */
  function effectiveAudio() {
    return { ...(config?.media?.audio ?? {}), ...processingOverrides };
  }

  /**
   * Everything worth knowing about the microphone track, for the log, the UI and the dump.
   * `label` is the one field a person can act on: it names the device Windows actually opened.
   */
  function micInfo() {
    const track = micStream?.getAudioTracks()[0] ?? null;
    if (!track) return null;
    let settings = {};
    try {
      settings = track.getSettings?.() ?? {};
    } catch {
      // Some browsers throw on an ended track.
    }
    return {
      id: track.id,
      label: track.label,
      readyState: track.readyState,
      muted: track.muted,
      enabled: track.enabled,
      requestedDeviceId: currentDeviceId,
      settings: pickSettings(settings),
      acquiredAt,
    };
  }

  /**
   * Watch the source, not just the track. `mute` here is the BROWSER saying the capture endpoint
   * is muted in Windows: Chromium polls the endpoint's mute state once a second and mirrors it
   * onto the track (measured: the event lands within about a second of the keyboard's mic-mute
   * key, and `unmute` follows the moment it is released). It is unrelated to the mute button,
   * and without a listener it is a silent microphone that the roster shows as live.
   */
  function watchMicTrack(track) {
    track.addEventListener('mute', () => {
      logger.warn('audio: mic track mute (endpoint muted in Windows)', { label: track.label });
      onMicTrackState?.({ event: 'mute', sourceMuted: true, info: micInfo() });
    });
    track.addEventListener('unmute', () => {
      logger.info('audio: mic track unmute', { label: track.label });
      onMicTrackState?.({ event: 'unmute', sourceMuted: false, info: micInfo() });
    });
    track.addEventListener(
      'ended',
      () => {
        logger.warn('audio: mic track ended', { label: track.label });
        // An ended track is not a microphone. Dropping the stream here is what makes the next
        // unmute re-acquire instead of flipping the button over a dead sender.
        if (micStream?.getAudioTracks()[0] === track) micStream = null;
        onMicTrackState?.({ event: 'ended', ended: true, info: null, label: track.label });
      },
      { once: true },
    );
  }

  function adopt(stream, source) {
    micStream = stream;
    acquiredAt = Date.now();
    const track = stream.getAudioTracks()[0] ?? null;
    if (!track) {
      logger.warn('audio: stream has no audio track', { source });
      return null;
    }
    track.enabled = !micMuted;
    watchMicTrack(track);
    logger.info('audio: mic acquired', { source, ...micInfo() });
    void refreshDevices('acquired');
    return track;
  }

  async function acquire(deviceId) {
    const constraints = micConstraints(effectiveAudio(), { deviceId });
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (err) {
      // The chosen device went away (unplugged between picking and opening). Fall back to the
      // default rather than leaving the user with no microphone at all -- and say so.
      if (deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        logger.warn('audio: requested device unavailable, falling back to default', {
          deviceId,
          name: err?.name,
        });
        currentDeviceId = null;
        return navigator.mediaDevices.getUserMedia({
          audio: micConstraints(effectiveAudio(), {}),
          video: false,
        });
      }
      throw err;
    }
  }

  /**
   * Acquire the microphone.
   *
   * `stream` is the lobby's already-verified stream: when its device and processing match what
   * the room wants, it is adopted rather than re-acquired, so the track the meter moved for on
   * the join screen is the exact track peers receive. Otherwise it is released and a fresh
   * request is made -- with the reason logged, because "the lobby worked and the room did not"
   * used to be undiagnosable.
   */
  function startMic({ stream = null, deviceId } = {}) {
    if (stopped) {
      stream?.getTracks?.().forEach((track) => track.stop());
      return Promise.resolve(null);
    }
    if (deviceId !== undefined) currentDeviceId = deviceId;
    if (micStream) return Promise.resolve(micStream.getAudioTracks()[0] ?? null);

    // The in-flight promise is memoized rather than guarded by a boolean. getUserMedia is
    // slow -- it may sit on a permission prompt for as long as the user takes to answer --
    // and a second call arriving in that window would otherwise pass the `if (micStream)`
    // check, acquire a second device, and leak the first stream. The lobby and the room can
    // both ask for the microphone, so this is reachable, not theoretical.
    if (micRequest) return micRequest;

    const handed = stream?.getAudioTracks?.()[0] ?? null;
    if (handed && handed.readyState === 'live') {
      const wanted = micConstraints(effectiveAudio(), {});
      let settings = {};
      try {
        settings = handed.getSettings?.() ?? {};
      } catch {
        // Treated as unknown below.
      }
      const deviceOk = !currentDeviceId || settings.deviceId === currentDeviceId;
      if (deviceOk && sameProcessing(settings, wanted)) {
        return Promise.resolve(adopt(stream, 'lobby-handoff'));
      }
      logger.info('audio: lobby stream not adopted, re-acquiring', {
        deviceOk,
        lobby: pickSettings(settings),
        wanted: Object.fromEntries(PROCESSING_KEYS.map((k) => [k, wanted[k]])),
      });
      stream.getTracks().forEach((track) => track.stop());
    }

    micRequest = serial(() => (micStream ? micStream : acquire(currentDeviceId)))
      .then((acquired) => (acquired === micStream ? micStream.getAudioTracks()[0] ?? null : adopt(acquired, 'getUserMedia')))
      .catch((err) => {
        logger.warn('media: getUserMedia failed', {
          name: err?.name,
          message: err?.message,
          deviceId: currentDeviceId,
        });
        throw micError(err);
      })
      .finally(() => {
        micRequest = null;
      });

    return micRequest;
  }

  /**
   * Switch device or processing.
   *
   * For a DEVICE change the new track is acquired first and handed to the caller, who puts it
   * on every sender with `replaceTrack` (no renegotiation) and only then calls `finish()` to
   * stop the old one, so the senders never hold an ended track while a prompt is open.
   *
   * A PROCESSING change (AEC/NS/AGC) cannot overlap. Measured on Chromium 130 and 141: a second
   * capture of a device that is already open is handed the FIRST capture's processing settings
   * regardless of what it asked for, and `applyConstraints()` on the live track resolves
   * without changing them. The only request that is honoured is one made after the device has
   * been released, so the old track is stopped first and the sent audio has a brief gap. If
   * the re-acquisition then fails, the previous settings are restored and tried again rather
   * than leaving the user with no microphone over a checkbox.
   */
  function restartMic(opts = {}) {
    if (stopped) return Promise.reject(micError(new Error('media stopped')));
    return serial(() => restartMicNow(opts));
  }

  async function restartMicNow({ deviceId, processing } = {}) {
    if (deviceId !== undefined) currentDeviceId = deviceId;
    const previous = { ...processingOverrides };
    const before = effectiveAudio();
    let changesProcessing = false;
    if (processing) {
      for (const key of PROCESSING_KEYS) {
        if (typeof processing[key] !== 'boolean') continue;
        if (processing[key] !== Boolean(before[key])) changesProcessing = true;
        processingOverrides[key] = processing[key];
      }
    }

    const old = micStream;
    if (changesProcessing && old) {
      old.getTracks().forEach((t) => t.stop());
      micStream = null;
      logger.info('audio: mic released for processing change', {
        requested: Object.fromEntries(PROCESSING_KEYS.map((k) => [k, effectiveAudio()[k]])),
      });
    }

    let fresh;
    try {
      fresh = await acquire(currentDeviceId);
    } catch (err) {
      logger.warn('audio: mic restart failed', { name: err?.name, message: err?.message });
      if (!changesProcessing) throw micError(err);
      for (const key of PROCESSING_KEYS) {
        if (key in previous) processingOverrides[key] = previous[key];
        else delete processingOverrides[key];
      }
      try {
        fresh = await acquire(currentDeviceId);
        logger.warn('audio: processing change reverted after a failed re-acquisition');
      } catch (err2) {
        throw micError(err2);
      }
    }

    const track = adopt(fresh, 'restart');
    return {
      track,
      finish() {
        // Defensive on purpose: stop everything that is not the CURRENT stream's track, which
        // covers the old one and, should a later switch have superseded this one, this one.
        const current = micStream?.getAudioTracks()[0] ?? null;
        for (const t of old?.getTracks() ?? []) if (t !== current) t.stop();
        if (micStream !== fresh) fresh.getTracks().forEach((t) => t.stop());
      },
    };
  }

  /**
   * Mute or unmute the microphone.
   *
   * `enabled = false` stops real samples being encoded while keeping the RTP session up, so
   * unmuting has no ramp -- the classic complaint about mute is the first half-second of the
   * first word being eaten. It is not equivalent to removing the track: the session and its
   * timing remain observable to peers, only the audio content stops.
   *
   * Because the flow of RTP does not change, the remote's `track.muted` never fires. The peer
   * is structurally unable to detect this, which is why a `mute-state` broadcast accompanies
   * every call.
   */
  function setMicMuted(muted) {
    micMuted = Boolean(muted);
    const track = micStream?.getAudioTracks()[0];
    if (track) track.enabled = !micMuted;
    logger.debug('media: mic muted', { micMuted });
    return micMuted;
  }

  function stopMic() {
    const had = micStream?.getAudioTracks()[0]?.label ?? null;
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
    if (had !== null) logger.info('audio: mic released', { label: had });
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /**
   * What the browser can see. Labels are only populated once a capture has been granted, which
   * is why this runs after every acquisition rather than at boot.
   *
   * The one fact worth logging on Windows is whether "default" and "communications" resolve to
   * the same physical device: when they do not, the headset the user speaks into is not the
   * device the browser opened.
   */
  async function refreshDevices(reason) {
    if (!navigator.mediaDevices?.enumerateDevices) return null;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      devices = describeDevices(list);
      logger.info('audio: devices', {
        reason,
        inputs: devices.inputs.map((d) => d.label || '(no label)'),
        outputs: devices.outputs.map((d) => d.label || '(no label)'),
        defaultGroup: devices.defaultGroup,
        communicationsGroup: devices.communicationsGroup,
        defaultMatchesCommunications: devices.defaultMatchesCommunications,
        current: micInfo()?.label ?? null,
      });
      onDevicesChanged?.(devices);
      return devices;
    } catch (err) {
      logger.warn('audio: enumerateDevices failed', { name: err?.name });
      return null;
    }
  }

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    logger.info('audio: devicechange');
    void refreshDevices('devicechange');
  });

  // -------------------------------------------------------------------------
  // Screen capture
  // -------------------------------------------------------------------------

  /**
   * Capture the screen. **Must be called synchronously from a user gesture handler.**
   *
   * `getDisplayMedia` requires transient user activation, which is consumed by any await in
   * the handler. Capturing after asking the server for permission to share would put this
   * call one round trip -- plus up to `shareRevokeTimeoutMs` on the takeover path -- past the
   * gesture, outside Chrome's and Firefox's activation window and outside Safari's model
   * entirely. So we capture first and claim second, and release the capture if the claim is
   * refused. The cost is a wasted picker in a rare race; the alternative is a Share button
   * that fails with an unmapped InvalidStateError whenever the server is slow.
   *
   * Returns a promise, but the CALL must not be awaited-into.
   */
  function captureDisplay() {
    // The E2E path substitutes a synthetic canvas so the suite does not depend on an OS
    // picker. Everything downstream -- encoder, RTP, DTLS, ICE, decoder -- stays real.
    if (isE2E()) {
      logger.info('media: using synthetic display stream (E2E)');
      return Promise.resolve(makeSyntheticDisplayStream());
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.reject(new AppError(ERRORS.SHARE_UNSUPPORTED));
    }

    const wantAudio = config?.media?.includeDisplayAudio !== false;
    // Chromium 141+ can keep the capturing page's own playback out of a tab/system capture,
    // which is the browser-side cure for "everyone hears their own voice echoed back when I
    // share". It is a no-op where unsupported, and it does NOT apply to the desktop app's
    // Windows loopback path, which bypasses constraints entirely -- see desktop/capture.js.
    const supportsRestrictOwnAudio = Boolean(
      navigator.mediaDevices.getSupportedConstraints?.()?.restrictOwnAudio,
    );
    const audio = wantAudio ? (supportsRestrictOwnAudio ? { restrictOwnAudio: true } : true) : false;

    return navigator.mediaDevices
      .getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        // System/tab audio, if the user opts in at the picker. A second track, never mixed
        // into the microphone.
        audio,
        // Lets Chrome offer "share this tab instead" without ending the stream.
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
      })
      .catch((err) => {
        logger.info('media: getDisplayMedia rejected', { name: err?.name });
        throw shareError(err);
      });
  }

  /**
   * Adopt a captured stream as the active share.
   * Separate from `captureDisplay` because the claim happens between the two.
   */
  function adoptDisplayStream(stream) {
    displayStream = stream;
    sharing = true;
    stoppingShare = false;
    watchDisplayTracks(stream);
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    logger.info('media: sharing started', {
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length,
      // Which audio the share carries matters for echo: a Windows system-mix capture includes
      // the voices of everyone in the call, played back to them with a delay.
      audioLabel: audioTrack?.label ?? null,
      audioSettings: audioTrack ? pickSettings(safeSettings(audioTrack)) : null,
    });
    return {
      video: stream.getVideoTracks()[0] ?? null,
      audio: audioTrack,
    };
  }

  function safeSettings(track) {
    try {
      return track.getSettings?.() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Watch for the share ending outside our UI.
   *
   * The browser's own "Stop sharing" control, and an OS-level revocation, both surface only
   * as an `ended` event on the tracks. Both video and audio need listeners: one ending does
   * not imply the other, and a user who stops only the audio should not look to peers like
   * they stopped sharing entirely.
   */
  function watchDisplayTracks(stream) {
    for (const track of stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          logger.info('media: display track ended', { kind: track.kind });

          if (track.kind === 'video') {
            // Only the video ending means the share is over.
            if (sharing) onShareEnded?.('native');
            return;
          }

          // The audio ending on its own does not stop the share, but it does mean the shared
          // audio is gone -- and leaving a dead track on the sender while the UI still claims
          // audio is live is its own small lie.
          if (sharing) onDisplayAudioEnded?.();
        },
        { once: true },
      );
    }

    // "Share this tab instead" swaps the underlying source while keeping the SAME track
    // object alive -- no `ended`, nothing to tear down -- but the frame size changes. Without
    // re-reading it, the encoder scale factor is computed against the old dimensions and the
    // picture goes soft for everyone.
    //
    // Attached unconditionally: gating on `'onconfigurationchange' in track` skips browsers
    // that dispatch the event without reflecting the IDL attribute, and an unused listener
    // costs nothing while a missing one is a silent quality regression.
    const video = stream.getVideoTracks()[0];
    video?.addEventListener('configurationchange', () => {
      const settings = video.getSettings();
      logger.debug('media: display configuration changed', settings);
      onDisplaySettingsChanged?.(settings);
    });
  }

  /**
   * Stop sharing. Idempotent, because five different paths lead here and more than one can
   * fire for the same stop.
   */
  function stopShare(reason = 'user') {
    if (!sharing || stoppingShare) return false;
    stoppingShare = true;

    displayStream?.getTracks().forEach((track) => track.stop());
    displayStream = null;
    sharing = false;
    stoppingShare = false;

    logger.info('media: sharing stopped', { reason });
    return true;
  }

  /** What the capture is actually producing, which is rarely exactly what was requested. */
  function displaySettings() {
    const track = displayStream?.getVideoTracks()[0];
    if (!track) return null;
    const { width, height, frameRate } = track.getSettings();
    return { width, height, frameRate };
  }

  function stopAll() {
    stopped = true;
    stopShare('teardown');
    stopMic();
  }

  return {
    startMic,
    restartMic,
    stopMic,
    setMicMuted,
    captureDisplay,
    adoptDisplayStream,
    stopShare,
    displaySettings,
    stopAll,
    micInfo,
    refreshDevices,
    effectiveAudio,

    /** The live microphone track, or null. An ended track is reported as absent on purpose:
     *  the unmute path re-acquires when this is null, and a dead track must not stop it. */
    get micTrack() {
      const track = micStream?.getAudioTracks()[0] ?? null;
      return track && track.readyState !== 'ended' ? track : null;
    },
    get micDeviceId() {
      return currentDeviceId;
    },
    get devices() {
      return devices;
    },
    get displayVideoTrack() {
      return displayStream?.getVideoTracks()[0] ?? null;
    },
    get displayAudioTrack() {
      return displayStream?.getAudioTracks()[0] ?? null;
    },
    get isSharing() {
      return sharing;
    },
    get isMicMuted() {
      return micMuted;
    },
    /** Whether the shared stream actually carries audio. The user may decline "share audio"
     *  in the picker, and the UI must not claim otherwise. */
    get hasDisplayAudio() {
      return Boolean(displayStream?.getAudioTracks().length);
    },
  };
}
