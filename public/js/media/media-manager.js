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
 */

import { ERRORS } from '../../shared/protocol.js';
import { micError, shareError, AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { isE2E } from '../core/env.js';
import { makeSyntheticDisplayStream } from './synthetic-stream.js';

export function createMediaManager({
  config,
  onShareEnded,
  onDisplayAudioEnded,
  onDisplaySettingsChanged,
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

  // -------------------------------------------------------------------------
  // Microphone
  // -------------------------------------------------------------------------

  /**
   * Acquire the microphone.
   *
   * `echoCancellation` defaults to off: the usual setup here is headphones, and AEC treats
   * the system audio of a shared video as echo and mangles it. It is exposed in config for
   * anyone using speakers.
   */
  function startMic() {
    if (micStream) return Promise.resolve(micStream.getAudioTracks()[0] ?? null);

    // The in-flight promise is memoized rather than guarded by a boolean. getUserMedia is
    // slow -- it may sit on a permission prompt for as long as the user takes to answer --
    // and a second call arriving in that window would otherwise pass the `if (micStream)`
    // check, acquire a second device, and leak the first stream. The lobby and the room can
    // both ask for the microphone, so this is reachable, not theoretical.
    if (micRequest) return micRequest;

    const audio = config?.media?.audio ?? {};
    micRequest = navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: audio.echoCancellation ?? false,
          noiseSuppression: audio.noiseSuppression ?? true,
          autoGainControl: audio.autoGainControl ?? true,
          channelCount: audio.channelCount ?? 1,
        },
        video: false,
      })
      .then((stream) => {
        micStream = stream;
        const track = stream.getAudioTracks()[0] ?? null;
        if (track) track.enabled = !micMuted;
        logger.info('media: microphone started');
        return track;
      })
      .catch((err) => {
        logger.warn('media: getUserMedia failed', { name: err?.name });
        throw micError(err);
      })
      .finally(() => {
        micRequest = null;
      });

    return micRequest;
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
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

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

    return navigator.mediaDevices
      .getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        // System/tab audio, if the user opts in at the picker. A second track, never mixed
        // into the microphone.
        audio: config?.media?.includeDisplayAudio !== false,
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
    logger.info('media: sharing started', {
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length,
    });
    return {
      video: stream.getVideoTracks()[0] ?? null,
      audio: stream.getAudioTracks()[0] ?? null,
    };
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
    stopShare('teardown');
    stopMic();
  }

  return {
    startMic,
    stopMic,
    setMicMuted,
    captureDisplay,
    adoptDisplayStream,
    stopShare,
    displaySettings,
    stopAll,

    get micTrack() {
      return micStream?.getAudioTracks()[0] ?? null;
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
