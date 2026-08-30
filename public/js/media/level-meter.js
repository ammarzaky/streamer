/**
 * A microphone level meter.
 *
 * This exists because of a specific failure: a call where the far end could not hear the host,
 * and nothing anywhere in the app could answer "is my microphone picking anything up". The mute
 * button reported the flag it had been given, the stats panel reported video, and the only way to
 * find out was to ask the other person. A moving bar answers it before anyone is waiting.
 *
 * **It meters a clone of the track, not the track itself.** `enabled = false` makes a track
 * deliver silence to every consumer including Web Audio, so metering the real one would read zero
 * whenever you are muted -- exactly when you most want to know the microphone still works. A clone
 * carries its own `enabled` flag and the same underlying source, which keeps the meter alive while
 * muted and makes the "you are talking while muted" hint possible.
 *
 * **It reports its own health.** A meter that reads a flat zero is ambiguous: a silent microphone,
 * a suspended AudioContext, a track whose endpoint Windows has muted, and a track that ended all
 * look identical on the bar. `state()` and the `onState` callback tell them apart, because the
 * third report of "the bar does not move" was the one where nobody could say which of those it was.
 */

/** Above this the bar is meaningfully lit; roughly the level of quiet speech at a normal
 *  distance with automatic gain on. Measured: room tone with noise suppression ≈ 0.002,
 *  Chromium's fake-device tone ≈ 0.055, a single full-scale click ≈ 0.044 (which must NOT
 *  read as speech), ordinary speech 0.08-0.3. */
export const SPEAKING_THRESHOLD = 0.05;

/** Sample cadence. A timer rather than requestAnimationFrame: rAF stops entirely when the window
 *  is hidden or occluded, and a frozen meter is indistinguishable from a dead microphone. */
const TICK_MS = 50;

/** If the context is still not running this long after creation, wait for a gesture. */
const RESUME_GRACE_MS = 1000;

/**
 * Root mean square of a sample buffer, as a 0..1 level.
 *
 * RMS rather than peak: peak jumps to full scale on a keyboard click and then decays, which makes
 * a meter that looks alive while the microphone is dead. RMS tracks sustained energy, which is
 * what "someone is speaking" actually is.
 *
 * Pure and exported so the maths is unit-testable without an AudioContext.
 */
export function rmsLevel(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  // Clamped because a badly behaved source can exceed the nominal range.
  return Math.min(1, Math.max(0, rms));
}

/**
 * Smooth the bar without making it sluggish.
 *
 * Fast attack so speech registers immediately, slow release so the bar does not flicker through
 * the gaps between words -- a meter that strobes is harder to read than no meter.
 */
export function smoothLevel(previous, next, { attack = 0.5, release = 0.12 } = {}) {
  const prior = Number.isFinite(previous) ? previous : 0;
  const factor = next > prior ? attack : release;
  return prior + (next - prior) * factor;
}

/**
 * Reduce a meter's raw state to one word. Pure, so the precedence is testable.
 *
 *   dead          the track (or our clone) has ended -- nothing will ever arrive
 *   source-muted  the track's `muted` flag: the capture endpoint is muted in Windows (Chromium
 *                 polls the OS mute state once a second and mirrors it onto the track)
 *   suspended     the AudioContext is not running, so the bar is frozen regardless of the mic
 *   running       the meter is alive; a zero now means a silent microphone
 */
export function meterHealth({ contextState, trackReadyState, trackMuted, cloneReadyState, cloneMuted, dead } = {}) {
  if (dead || trackReadyState === 'ended' || cloneReadyState === 'ended') return 'dead';
  if (trackMuted || cloneMuted) return 'source-muted';
  if (contextState && contextState !== 'running') return 'suspended';
  return 'running';
}

/**
 * Start metering a microphone track.
 *
 * @param {MediaStreamTrack} track
 * @param {(level: number) => void} onLevel  called ~20x/second with a smoothed 0..1 level
 * @param {{onState?: (state: object) => void}} [options]  called whenever health changes
 * @returns {{stop: () => void, state: () => object}} always safe to call, even if setup failed
 */
export function createLevelMeter(track, onLevel, { onState } = {}) {
  let stopped = false;
  let timer = null;
  let context = null;
  let clone = null;
  let level = 0;
  let peak = 0;
  let ticks = 0;
  let lastTickAt = null;
  let dead = false;
  let reason = null;
  let lastHealth = null;
  let lastContextState = null;
  let gestureListener = null;
  const startedAt = Date.now();

  const state = () => {
    const snapshot = {
      contextState: context?.state ?? null,
      sampleRate: context?.sampleRate ?? null,
      trackReadyState: track?.readyState ?? null,
      trackMuted: track?.muted ?? null,
      cloneReadyState: clone?.readyState ?? null,
      cloneMuted: clone?.muted ?? null,
      level,
      peak,
      ticks,
      lastTickAt,
      dead,
      reason,
      uptimeMs: Date.now() - startedAt,
    };
    snapshot.health = meterHealth(snapshot);
    return snapshot;
  };

  const report = () => {
    // A stopped meter has been replaced; its last words must not overwrite its successor's.
    if (!onState || stopped) return;
    const snapshot = state();
    if (snapshot.health === lastHealth && snapshot.contextState === lastContextState) return;
    lastHealth = snapshot.health;
    lastContextState = snapshot.contextState;
    try {
      onState(snapshot);
    } catch {
      // A diagnostics listener must never break the meter it is observing.
    }
  };

  const removeGestureListener = () => {
    if (!gestureListener) return;
    document.removeEventListener('pointerup', gestureListener, true);
    document.removeEventListener('keydown', gestureListener, true);
    gestureListener = null;
  };

  const onTrackEnded = () => die('track-ended');
  const onCloneEnded = () => {
    if (!stopped) die('clone-ended');
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    timer = null;
    removeGestureListener();
    // Listeners come off the ORIGINAL track too: it outlives this meter, and a stale
    // listener would keep reporting into a replacement meter's state.
    track?.removeEventListener('mute', report);
    track?.removeEventListener('unmute', report);
    track?.removeEventListener('ended', onTrackEnded);
    clone?.removeEventListener('mute', report);
    clone?.removeEventListener('unmute', report);
    clone?.removeEventListener('ended', onCloneEnded);
    context?.removeEventListener('statechange', report);
    // The clone is ours alone, so stopping it cannot affect what is being sent.
    try { clone?.stop(); } catch { /* already ended */ }
    // close() returns a promise that rejects if the context is already closed.
    void context?.close?.().catch(() => {});
    context = null;
  };

  const die = (why) => {
    dead = true;
    reason = why;
    level = 0;
    // Health first, then the final zero: a consumer that reads the level before it hears the
    // meter is dead would take one last silent tick from a device that has just been unplugged
    // as "live but silent" -- and blame the Windows mute key for a headset that is not there.
    report();
    onLevel?.(0);
    stop();
  };

  try {
    if (!track || track.readyState === 'ended') {
      dead = true;
      reason = track ? 'track-ended' : 'no-track';
      report();
      return { stop, state };
    }

    clone = track.clone();
    // The point of the clone: it stays live while the sent track is muted.
    clone.enabled = true;

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) {
      dead = true;
      reason = 'no-audiocontext';
      report();
      return { stop, state };
    }

    context = new AudioContextCtor();
    const source = context.createMediaStreamSource(new MediaStream([clone]));
    const analyser = context.createAnalyser();
    // Small window: this is a level meter, not a spectrum, and a large FFT only adds latency.
    analyser.fftSize = 512;
    source.connect(analyser);
    // Deliberately NOT connected to context.destination -- routing the microphone to the
    // speakers would give everyone in the room feedback howl.

    // Browsers may create the context suspended (autoplay policy). Ask once, and if that is
    // refused, ask again on the next gesture -- a bar frozen by policy must not read as a
    // dead microphone.
    context.addEventListener('statechange', report);
    const tryResume = () => {
      if (stopped || !context || context.state === 'running') return;
      void context.resume().catch(() => {});
    };
    tryResume();
    setTimeout(() => {
      if (stopped || !context || context.state === 'running') return;
      // pointerup rather than pointerdown: a touch pointerdown does not grant activation, and
      // the listener stays armed until the context actually runs rather than after one try.
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

    // Source-level events. `mute` means Windows muted the capture endpoint (the mic-mute key,
    // or Sound › Input); `ended` means the device is gone for good.
    track.addEventListener('mute', report);
    track.addEventListener('unmute', report);
    track.addEventListener('ended', onTrackEnded, { once: true });
    clone.addEventListener('mute', report);
    clone.addEventListener('unmute', report);
    clone.addEventListener('ended', onCloneEnded, { once: true });

    const buffer = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (stopped) return;
      analyser.getFloatTimeDomainData(buffer);
      level = smoothLevel(level, rmsLevel(buffer));
      if (level > peak) peak = level;
      ticks++;
      lastTickAt = Date.now();
      onLevel?.(level);
    };
    timer = setInterval(tick, TICK_MS);
    report();
  } catch {
    // A meter is a diagnostic aid. Failing to build one must never stop somebody joining a call.
    dead = true;
    reason = reason ?? 'setup-failed';
    report();
    stop();
  }

  return { stop, state };
}
