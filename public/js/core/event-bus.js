/**
 * A tiny synchronous event bus.
 *
 * It exists to keep one rule enforceable: views never call the RTC or media layers directly.
 * A view emits an intent ("the user clicked mute"), and the room's composition root is the
 * only place that translates intents into peer-connection and media calls. Without that
 * split, mute logic ends up duplicated across three views and drifts.
 */

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  return {
    /** Subscribe. Returns an unsubscribe function. */
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },

    /** Subscribe for exactly one occurrence. */
    once(event, handler) {
      const off = this.on(event, (payload) => {
        off();
        handler(payload);
      });
      return off;
    },

    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    /**
     * Publish. Handlers run synchronously in subscription order.
     *
     * A throwing handler is logged and skipped rather than allowed to abort the rest: one
     * broken view must not prevent the media layer from tearing down a peer connection.
     */
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[bus] handler for "${event}" threw:`, err);
        }
      }
    },

    clear() {
      listeners.clear();
    },
  };
}

export const bus = createBus();

/**
 * Every event name in the app, so a typo is a lint error rather than a listener that never
 * fires. Intents are things the user asked for; facts are things that happened.
 */
export const EVENTS = Object.freeze({
  // Intents, emitted by views.
  INTENT_TOGGLE_MIC: 'intent:toggle-mic',
  INTENT_START_SHARE: 'intent:start-share',
  INTENT_STOP_SHARE: 'intent:stop-share',
  INTENT_TAKE_OVER_SHARE: 'intent:take-over-share',
  INTENT_SET_QUALITY: 'intent:set-quality',
  INTENT_LEAVE: 'intent:leave',
  INTENT_END_SESSION: 'intent:end-session',
  INTENT_COPY_LINK: 'intent:copy-link',
  INTENT_TOGGLE_STATS: 'intent:toggle-stats',
  INTENT_JOIN: 'intent:join',

  // Audio diagnostics. All of them exist because "nobody can hear me" was undiagnosable
  // three times running; see docs/DIAGNOSTICS.md.
  INTENT_SET_MIC_DEVICE: 'intent:set-mic-device',
  INTENT_SET_MIC_PROCESSING: 'intent:set-mic-processing',
  INTENT_TOGGLE_MIC_MENU: 'intent:toggle-mic-menu',
  INTENT_MIC_SELFTEST: 'intent:mic-selftest',
  INTENT_AUDIO_CHECK: 'intent:audio-check',
  INTENT_COPY_DIAGNOSTICS: 'intent:copy-diagnostics',
  INTENT_TOGGLE_INCOMING_AUDIO_TEST: 'intent:toggle-incoming-audio-test',
  INTENT_RESUME_AUDIO: 'intent:resume-audio',
  INTENT_RELEASE_MIC_TEST: 'intent:release-mic-test',
  INTENT_REQUEST_PEER_DIAGNOSTICS: 'intent:request-peer-diagnostics',

  // Playback: which speaker, and how loud each person is. Both are purely local -- nothing
  // here reaches the wire, and nobody else can tell you turned them down.
  INTENT_SET_SPEAKER_DEVICE: 'intent:set-speaker-device',
  INTENT_SET_PEER_VOLUME: 'intent:set-peer-volume',

  // Facts, emitted by the engine.
  SIGNALING_STATUS: 'signaling:status',
  ROOM_STATE: 'room:state',
  PEER_TRACK: 'peer:track',
  PEER_STATE: 'peer:state',
  STATS_TICK: 'stats:tick',
  QUALITY_CHANGED: 'quality:changed',
  SHARE_CHANGED: 'share:changed',
  ERROR: 'app:error',
  TOAST: 'app:toast',
  FATAL: 'app:fatal',
  /** A remote <audio> element refused to play (autoplay policy, usually). */
  AUDIO_PLAYBACK_BLOCKED: 'audio:playback-blocked',
});
