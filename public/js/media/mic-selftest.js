/**
 * "Record three seconds and play it back."
 *
 * The one test that needs nobody on the other end. If you hear yourself, the track this app
 * would send carries your voice; if you hear silence, the problem is on this machine and no
 * amount of network debugging will find it. It records a CLONE of the room track with its own
 * `enabled` flag, so it works while you are muted and never touches what peers receive.
 *
 * Outcomes are explicit. A machine without MediaRecorder, a recorder that produces no bytes,
 * or a playback the browser refuses each come back as a named error -- never as a false
 * "recorded silence".
 */

import { createLevelMeter } from './level-meter.js';

export const SELFTEST_PHASE = Object.freeze({
  RECORDING: 'recording',
  PLAYING: 'playing',
  DONE: 'done',
  FAILED: 'failed',
});

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/** Below this peak the recording carried nothing a person would call sound. Deliberately lower
 *  than the speaking threshold: a quiet microphone is a working microphone. */
export const SELFTEST_SILENT_PEAK = 0.02;

/**
 * @param {MediaStreamTrack} track  the live microphone track (may be disabled/muted)
 * @param {{durationMs?: number, onPhase?: (phase: string) => void, onLevel?: (level: number) => void}} opts
 * @returns {Promise<{ok: boolean, peak: number, bytes: number, durationMs: number,
 *   playbackError: string|null, error: string|null, blob: Blob|null, blobUrl: string|null, revoke: () => void}>}
 */
export function runMicSelfTest(track, { durationMs = 3000, onPhase, onLevel } = {}) {
  return new Promise((resolve) => {
    run(resolve);
  });

  function run(resolve) {
    const result = {
      ok: false,
      peak: 0,
      bytes: 0,
      durationMs,
      playbackError: null,
      error: null,
      blob: null,
      blobUrl: null,
      revoke: () => {},
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error) => {
      result.error = error;
      onPhase?.(SELFTEST_PHASE.FAILED);
      finish();
    };

    if (!track || track.readyState !== 'live') return fail('no-track');
    if (typeof MediaRecorder === 'undefined') return fail('no-mediarecorder');

    let clone;
    try {
      clone = track.clone();
      clone.enabled = true;
    } catch {
      return fail('clone-failed');
    }

    const meter = createLevelMeter(clone, (level) => {
      if (level > result.peak) result.peak = level;
      onLevel?.(level);
    });

    const mime = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream([clone]), mime ? { mimeType: mime } : undefined);
    } catch {
      meter.stop();
      clone.stop();
      return fail('recorder-failed');
    }

    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      meter.stop();
      clone.stop();
      fail('recorder-error');
    });
    recorder.addEventListener('stop', () => {
      meter.stop();
      clone.stop();
      if (settled) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      result.bytes = blob.size;
      result.blob = blob;
      if (blob.size === 0) return fail('empty-recording');
      playBack(blob);
    });

    function playBack(blob) {
      const url = URL.createObjectURL(blob);
      result.blobUrl = url;
      result.revoke = () => URL.revokeObjectURL(url);
      const audio = new Audio(url);
      onPhase?.(SELFTEST_PHASE.PLAYING);
      audio.addEventListener('ended', () => {
        result.ok = true;
        onPhase?.(SELFTEST_PHASE.DONE);
        finish();
      });
      audio.addEventListener('error', () => {
        result.playbackError = 'element-error';
        onPhase?.(SELFTEST_PHASE.FAILED);
        finish();
      });
      audio.play().catch((err) => {
        result.playbackError = err?.name ?? 'play-rejected';
        onPhase?.(SELFTEST_PHASE.FAILED);
        finish();
      });
    }

    onPhase?.(SELFTEST_PHASE.RECORDING);
    try {
      recorder.start(250);
    } catch {
      meter.stop();
      clone.stop();
      return fail('recorder-start-failed');
    }
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, durationMs);
  }
}
