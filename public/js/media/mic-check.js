/**
 * The lobby microphone check.
 *
 * Runs before joining, which is the whole point: a blocked, missing, or silent microphone is
 * trivial to fix while you are still on the join screen and awkward to fix once four people are
 * waiting. It also moves the permission prompt to the moment the user is expecting one.
 *
 * It acquires its own stream rather than borrowing the media manager's, because the media
 * manager does not exist until `welcome` has arrived and brought the server config with it --
 * which happens after the user has already pressed Join. The stream is released on join, and the
 * real acquisition that follows is instant and silent because permission is already granted.
 */

import { createLevelMeter, SPEAKING_THRESHOLD } from './level-meter.js';
import { micError } from '../core/errors.js';
import { logger } from '../core/logger.js';

/** What the check concluded, as something the UI can render without interpreting errors. */
export const MIC_STATE = Object.freeze({
  CHECKING: 'checking',
  /** Acquired, and picking up sound. */
  HEARING: 'hearing',
  /** Acquired, but nothing above the noise floor yet. Not a fault. */
  QUIET: 'quiet',
  /** Unusable: denied, absent, or held by another application. */
  FAILED: 'failed',
});

/**
 * @param {(update: {state: string, level: number, code?: string}) => void} onUpdate
 * @returns {{stop: () => void}}
 */
export function startMicCheck(onUpdate) {
  let stopped = false;
  let meter = null;
  let stream = null;
  /** Latches once sound is heard, so a natural pause between words does not flip the label
   *  back to "quiet" and make a working microphone look intermittent. */
  let everHeard = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    meter?.stop();
    meter = null;
    // Released so the real acquisition on join is not competing with this one for the device.
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  onUpdate?.({ state: MIC_STATE.CHECKING, level: 0 });

  (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      // The user may have pressed Join while the permission prompt was open.
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = acquired;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no audio track');

      meter = createLevelMeter(track, (level) => {
        if (stopped) return;
        if (level > SPEAKING_THRESHOLD) everHeard = true;
        onUpdate?.({ state: everHeard ? MIC_STATE.HEARING : MIC_STATE.QUIET, level });
      });
    } catch (err) {
      if (stopped) return;
      const mapped = micError(err);
      logger.info('mic-check: unavailable', { code: mapped.code });
      onUpdate?.({ state: MIC_STATE.FAILED, level: 0, code: mapped.code });
    }
  })();

  return { stop };
}
