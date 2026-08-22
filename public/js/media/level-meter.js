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
 */

/** Above this the bar is meaningfully lit; roughly the level of speech at a normal distance. */
export const SPEAKING_THRESHOLD = 0.06;

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
 * Start metering a microphone track.
 *
 * @param {MediaStreamTrack} track
 * @param {(level: number) => void} onLevel  called ~20x/second with a smoothed 0..1 level
 * @returns {{stop: () => void}} always safe to call, even if setup failed
 */
export function createLevelMeter(track, onLevel) {
  let stopped = false;
  let raf = null;
  let context = null;
  let clone = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    // The clone is ours alone, so stopping it cannot affect what is being sent.
    try { clone?.stop(); } catch { /* already ended */ }
    // close() returns a promise that rejects if the context is already closed.
    void context?.close?.().catch(() => {});
    context = null;
  };

  try {
    if (!track || track.readyState === 'ended') return { stop };

    clone = track.clone();
    // The point of the clone: it stays live while the sent track is muted.
    clone.enabled = true;

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) return { stop };

    context = new AudioContextCtor();
    const source = context.createMediaStreamSource(new MediaStream([clone]));
    const analyser = context.createAnalyser();
    // Small window: this is a level meter, not a spectrum, and a large FFT only adds latency.
    analyser.fftSize = 512;
    source.connect(analyser);
    // Deliberately NOT connected to context.destination -- routing the microphone to the
    // speakers would give everyone in the room feedback howl.

    const buffer = new Float32Array(analyser.fftSize);
    let level = 0;
    let lastEmit = 0;

    const tick = (now) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);

      analyser.getFloatTimeDomainData(buffer);
      level = smoothLevel(level, rmsLevel(buffer));

      // The display cannot use 60 updates a second and the DOM writes are not free.
      if (now - lastEmit < 50) return;
      lastEmit = now;
      onLevel?.(level);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    // A meter is a diagnostic aid. Failing to build one must never stop somebody joining a call.
    stop();
  }

  return { stop };
}
