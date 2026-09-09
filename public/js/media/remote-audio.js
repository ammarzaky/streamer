/**
 * Per-participant volume for incoming audio.
 *
 * `HTMLMediaElement.volume` is clamped to 1 by the specification, so "louder than the person
 * actually recorded" is not reachable through the element at all. It needs a Web Audio graph,
 * and this is that graph -- kept out of `room-view.js` because it is the only part of playback
 * that is arithmetic rather than DOM, and arithmetic is worth unit tests.
 *
 * **It engages lazily, per peer.** A participant nobody has adjusted keeps playing through the
 * plain `<audio>` element exactly as before: same element, same `play()` handling, same
 * diagnostics. Only a peer whose slider has been moved is routed through here, and once routed
 * they stay routed for the session. Two reasons, both learned the hard way in this file's
 * neighbours: a path that only some people take must be the path that is *added*, never the one
 * that replaces a working default; and switching a live element between two playback paths at
 * the moment a slider crosses 100% would put a click in the middle of a drag.
 *
 * A source node per TRACK, not per stream. A peer's microphone and their shared system audio
 * arrive as two tracks that `room-view` adds to one MediaStream on one element, and
 * `MediaStreamAudioSourceNode` takes the stream's first audio track and does not follow later
 * additions -- so a per-stream graph would silently drop the shared audio. Both tracks share
 * the peer's single gain value, because the slider is about a person, not a track.
 *
 * No DOM here. The mixed output is handed back as a MediaStream through `onOutput` and the view
 * decides what element plays it and which speaker it goes to.
 */

import { logger } from '../core/logger.js';

export const MIN_GAIN = 0;

/** 500%. Above this the limiter is doing all the work and the extra range is a lie. */
export const MAX_GAIN = 5;

/** The value at which a peer is "not adjusted" and stays on the plain element path. */
export const UNITY_GAIN = 1;

/**
 * A limiter, not a compressor for taste: it exists so that 500% is *loud* rather than *broken*.
 * Boosting an already-healthy stream fivefold puts every peak far past full scale, and a
 * clipped peak is not a loud sound, it is a crunch. Threshold sits below unity so the knee is
 * reached before the ceiling; the fast attack catches transients and the slow release keeps it
 * from pumping on speech.
 */
export const LIMITER = Object.freeze({
  threshold: -6,
  knee: 6,
  ratio: 12,
  attack: 0.003,
  release: 0.15,
});

/** How long to wait before arming a gesture listener for a context the browser started
 *  suspended. Matches `level-meter.js`, for the same autoplay-policy reason. */
const RESUME_GRACE_MS = 1000;

/**
 * Anything outside the range, or not a number at all, becomes unity rather than silence: a bad
 * value must not be indistinguishable from someone being muted.
 *
 * Deliberately not `Number(value)`: that maps `null`, `false` and `''` to 0, so a missing
 * preference would have silenced the person it was missing for. Numeric strings are accepted
 * because they are what a range input and a JSON round trip can produce.
 */
export function clampGain(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return UNITY_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, n));
}

/** Whether a gain value means "leave this peer on the plain element path". */
export function isUnity(value) {
  return clampGain(value) === UNITY_GAIN;
}

/**
 * @param {object} options
 * @param {Function} [options.onOutput] called once with the mixed MediaStream, when the graph
 *   is first built. The caller attaches it to an element and chooses its sink.
 * @param {Function} [options.AudioContextCtor] injectable for tests.
 */
export function createRemoteAudioMixer({
  onOutput,
  AudioContextCtor = window.AudioContext ?? window.webkitAudioContext,
} = {}) {
  /** @type {AudioContext|null} Created on the first boost, never before: an AudioContext is a
   *  real audio device claim and most sessions never move a slider. */
  let context = null;
  let destination = null;
  let gestureListener = null;
  let stopped = false;

  /** peerId -> { gain, routed, tracks: Map<trackId, {track, source, gainNode, limiter}> } */
  const peers = new Map();

  function entry(peerId) {
    let found = peers.get(peerId);
    if (!found) {
      found = { gain: UNITY_GAIN, routed: false, tracks: new Map() };
      peers.set(peerId, found);
    }
    return found;
  }

  function ensureContext() {
    if (context || stopped) return context;
    if (!AudioContextCtor) {
      logger.warn('audio: no AudioContext, per-peer volume unavailable');
      return null;
    }
    try {
      context = new AudioContextCtor();
      destination = context.createMediaStreamDestination();
    } catch (err) {
      logger.warn('audio: could not create the playback graph', { name: err?.name });
      context = null;
      destination = null;
      return null;
    }
    armResume();
    onOutput?.(destination.stream);
    logger.info('audio: playback graph created', { state: context.state });
    return context;
  }

  /**
   * A context created suspended by the autoplay policy is silence that looks like a working
   * graph. Ask once, then again on the next real gesture -- the same shape as the level meter's
   * recovery, and for the same reason.
   */
  function armResume() {
    const tryResume = () => {
      if (stopped || !context || context.state === 'running') return;
      void context.resume().catch(() => {});
    };
    tryResume();
    setTimeout(() => {
      if (stopped || !context || context.state === 'running') return;
      gestureListener = () => {
        if (stopped || !context || context.state === 'running') {
          removeGestureListener();
          return;
        }
        context.resume().then(
          () => {
            if (context?.state === 'running') removeGestureListener();
          },
          () => {},
        );
      };
      document.addEventListener('pointerup', gestureListener, true);
      document.addEventListener('keydown', gestureListener, true);
    }, RESUME_GRACE_MS);
  }

  function removeGestureListener() {
    if (!gestureListener) return;
    document.removeEventListener('pointerup', gestureListener, true);
    document.removeEventListener('keydown', gestureListener, true);
    gestureListener = null;
  }

  /** Build source -> gain -> limiter -> destination for one track. */
  function wire(peer, record) {
    if (record.source || !context || !destination) return;
    try {
      record.source = context.createMediaStreamSource(new MediaStream([record.track]));
      record.gainNode = context.createGain();
      record.gainNode.gain.value = peer.gain;
      record.limiter = context.createDynamicsCompressor();
      record.limiter.threshold.value = LIMITER.threshold;
      record.limiter.knee.value = LIMITER.knee;
      record.limiter.ratio.value = LIMITER.ratio;
      record.limiter.attack.value = LIMITER.attack;
      record.limiter.release.value = LIMITER.release;
      record.source.connect(record.gainNode);
      record.gainNode.connect(record.limiter);
      record.limiter.connect(destination);
    } catch (err) {
      logger.warn('audio: could not route a remote track', { name: err?.name });
      unwire(record);
    }
  }

  function unwire(record) {
    for (const node of [record.source, record.gainNode, record.limiter]) {
      try {
        node?.disconnect();
      } catch {
        // A node belonging to a closed context throws; nothing to do about it and nothing lost.
      }
    }
    record.source = null;
    record.gainNode = null;
    record.limiter = null;
  }

  return {
    /**
     * Register an incoming track. Cheap and side-effect-free unless this peer is already
     * routed, so the view can call it for every track it receives.
     */
    attach(peerId, track) {
      if (stopped || !track) return;
      const peer = entry(peerId);
      if (peer.tracks.has(track.id)) return;
      const record = { track, source: null, gainNode: null, limiter: null };
      peer.tracks.set(track.id, record);
      track.addEventListener(
        'ended',
        () => {
          unwire(record);
          peer.tracks.delete(track.id);
        },
        { once: true },
      );
      if (peer.routed) wire(peer, record);
    },

    /**
     * Set one peer's volume, 0..5. Returns true when this peer is now played through the graph,
     * which is the view's signal to mute their own element so the sound is not heard twice.
     */
    setGain(peerId, value) {
      const gain = clampGain(value);
      const peer = entry(peerId);
      peer.gain = gain;

      // Unity on a peer who has never been touched stays on the plain element: not building a
      // graph is the difference between this feature costing nothing and it costing an
      // AudioContext for everyone in every call.
      if (!peer.routed && gain === UNITY_GAIN) return false;

      if (!peer.routed) {
        if (!ensureContext()) return false;
        peer.routed = true;
        for (const record of peer.tracks.values()) wire(peer, record);
        logger.info('audio: peer routed through the playback graph', { peerId, gain });
      }
      for (const record of peer.tracks.values()) {
        if (record.gainNode) record.gainNode.gain.value = gain;
      }
      return peer.routed;
    },

    gain: (peerId) => peers.get(peerId)?.gain ?? UNITY_GAIN,
    isRouted: (peerId) => peers.get(peerId)?.routed === true,

    /** Forget a peer entirely. Called when they leave, and on teardown. */
    detach(peerId) {
      const peer = peers.get(peerId);
      if (!peer) return;
      for (const record of peer.tracks.values()) unwire(record);
      peers.delete(peerId);
    },

    /** Whether anything is being played through the graph at all. */
    get active() {
      return context !== null;
    },

    get contextState() {
      return context?.state ?? null;
    },

    /** Try to start a context the autoplay policy suspended. Call from a gesture handler. */
    resume() {
      if (!context || context.state === 'running') return Promise.resolve(false);
      return context.resume().then(
        () => context?.state === 'running',
        () => false,
      );
    },

    /** Read-only, for the diagnostics dump and the stats panel. */
    state() {
      return {
        active: context !== null,
        contextState: context?.state ?? null,
        peers: Object.fromEntries(
          [...peers.entries()].map(([id, peer]) => [
            id,
            { gain: peer.gain, routed: peer.routed, tracks: peer.tracks.size },
          ]),
        ),
      };
    },

    stop() {
      stopped = true;
      removeGestureListener();
      for (const peerId of [...peers.keys()]) this.detach(peerId);
      const closing = context;
      context = null;
      destination = null;
      try {
        void closing?.close?.();
      } catch {
        // Closing an already-closed context throws; harmless.
      }
    },
  };
}
