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
});

export function createHealthTracker() {
  return {
    silentSince: null,
    notAttachedSince: null,
    unheardSince: null,
    talkingMutedSince: null,
    lastSpokeAt: null,
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
 * @param {object} tracker  from createHealthTracker(); mutated
 * @param {number} nowMs
 * @returns {{ code: string, severity: string|null, params: object, changed: boolean }}
 */
export function deriveAudioHealth(snapshot, tracker, nowMs) {
  const self = snapshot.self ?? {};
  const meter = snapshot.meter ?? null;
  const peers = snapshot.peers ?? [];
  const level = Number.isFinite(meter?.level) ? meter.level : 0;
  const connected = peers.filter((p) => p.pcState === 'connected');
  const label = self.micLabel || '';

  if (level > SPEAKING_THRESHOLD) tracker.lastSpokeAt = nowMs;
  const speakingRecently =
    tracker.lastSpokeAt !== null && nowMs - tracker.lastSpokeAt <= HOLD_MS.SPEAKING_RECENT;

  // -- Timers: each condition's start is recorded while it holds and cleared when it stops. --

  const unmutedAndSilent = !self.micMuted && self.micAvailable !== false && level < SILENT_LEVEL;
  tracker.silentSince = unmutedAndSilent ? (tracker.silentSince ?? nowMs) : null;

  const detached = connected.find((p) => p.hasMicSender === false) ?? null;
  tracker.notAttachedSince = detached ? (tracker.notAttachedSince ?? nowMs) : null;

  const talkingMuted = Boolean(self.micMuted) && level > SPEAKING_THRESHOLD;
  tracker.talkingMutedSince = talkingMuted ? (tracker.talkingMutedSince ?? nowMs) : null;

  const fresh = (p) =>
    p.hearsMe && Number.isFinite(p.hearsMe.at) && nowMs - p.hearsMe.at <= HOLD_MS.REPORT_FRESH;
  const reporting = connected.filter(fresh);
  const heardBy =
    reporting.find((p) => Number.isFinite(p.hearsMe.level) && p.hearsMe.level >= SILENT_LEVEL) ?? null;
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
    // Only when nobody on the far end contradicts it: a peer whose report says they hear us
    // outranks a local meter that reads zero (a broken clone is not a broken microphone).
    if (!heardBy) {
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
