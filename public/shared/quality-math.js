/**
 * Quality presets and the arithmetic behind them.
 *
 * This module is imported by BOTH the Node server (to validate config) and the browser
 * (to drive the encoder), so it must not touch `window`, `process`, or any DOM or Node API.
 * The lint config enforces that by giving this directory no globals at all.
 *
 * Everything here is pure. That is deliberate: the mesh bandwidth arithmetic is the kind of
 * code where an off-by-one produces a quality controller that is subtly wrong in every
 * session and obviously wrong in none, so it is isolated where it can be unit-tested
 * exhaustively rather than inferred from a laggy video call.
 */

/**
 * The preset ladder, ordered low to high by bitrate.
 *
 * Ordering by bitrate rather than by pixel count keeps the ladder monotonic in the resource
 * that actually runs out (uplink and encoder time), so stepping down always helps. It does
 * mean 1080p30 sits above 720p60 -- that is intentional, and the labels say plainly what the
 * user is getting.
 *
 * `contentHint` is applied to the track; `degradationPreference` to the sender parameters.
 * For 60fps presets we keep the frame rate and let resolution fall, because shared motion
 * content (video, games, scrolling) degrades far more gracefully that way than into a
 * slideshow. The 30fps presets do the opposite: they are for reading text, where a sharp
 * still frame beats a smooth blurry one.
 */
export const PRESETS = Object.freeze([
  {
    id: '480p30',
    label: '480p 30',
    note: 'Lowest load',
    width: 854,
    height: 480,
    frameRate: 30,
    maxBitrateBps: 800_000,
    contentHint: 'detail',
    degradationPreference: 'balanced',
  },
  {
    id: '720p30',
    label: '720p 30',
    note: 'Clarity',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrateBps: 1_200_000,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
  },
  {
    id: '720p60',
    label: '720p 60',
    note: 'Balanced',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrateBps: 3_000_000,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
  },
  {
    id: '1080p30',
    label: '1080p 30',
    note: 'Sharp text',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrateBps: 3_500_000,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
  },
  {
    id: '1080p60',
    label: '1080p 60',
    note: 'Best quality',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrateBps: 6_000_000,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
  },
]);

export const PRESET_IDS = Object.freeze(PRESETS.map((p) => p.id));
export const DEFAULT_PRESET_ID = '1080p60';

export function getPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`unknown quality preset "${id}" (expected one of ${PRESET_IDS.join(', ')})`);
  }
  return preset;
}

export function presetIndex(id) {
  const i = PRESETS.findIndex((p) => p.id === id);
  if (i === -1) throw new Error(`unknown quality preset "${id}"`);
  return i;
}

/** One rung down, or the same preset if already at the bottom. */
export function stepDown(id) {
  return PRESETS[Math.max(0, presetIndex(id) - 1)];
}

/** One rung up, or the same preset if already at the top. */
export function stepUp(id) {
  return PRESETS[Math.min(PRESETS.length - 1, presetIndex(id) + 1)];
}

// ---------------------------------------------------------------------------
// Mesh bandwidth
// ---------------------------------------------------------------------------

/**
 * How much uplink each remote peer may be given.
 *
 * In a mesh you send a separate encoded copy to every OTHER participant, so the divisor is
 * the number of remote peers -- participantCount - 1 -- not the participant count. Dividing
 * by the participant count reserves a share of your uplink for sending to yourself, which
 * silently under-provisions every peer by a factor of N/(N-1): at 4 participants that is
 * 5 Mbps instead of 6.67, which is exactly the difference between 1080p60 working and not.
 *
 * This matters beyond the arithmetic: WebRTC computes `availableOutgoingBitrate` per
 * RTCPeerConnection, and each one is blind to the others sharing the same uplink. Without a
 * global budget, three connections each conclude they have the whole link available and then
 * fail together in a way that looks like a network fault.
 */
export function perPeerBudgetBps(uploadBudgetBps, participantCount) {
  const remotePeers = Math.max(1, participantCount - 1);
  return Math.floor(uploadBudgetBps / remotePeers);
}

/**
 * The bitrate ceiling to actually apply to one sender, and whether the mesh budget -- rather
 * than the chosen preset -- is what is limiting it. The UI uses `limited` to explain a
 * quality drop the user did not ask for.
 */
export function effectiveCapBps(presetBps, uploadBudgetBps, participantCount) {
  const share = perPeerBudgetBps(uploadBudgetBps, participantCount);
  return { cap: Math.min(presetBps, share), limited: share < presetBps };
}

/**
 * The highest preset whose bitrate fits the per-peer budget.
 * Returns the lowest preset when nothing fits -- refusing to send at all would be worse than
 * sending something poor, and the stats panel reports the shortfall either way.
 */
export function bestPresetForBudget(uploadBudgetBps, participantCount) {
  const share = perPeerBudgetBps(uploadBudgetBps, participantCount);
  for (let i = PRESETS.length - 1; i >= 0; i--) {
    if (PRESETS[i].maxBitrateBps <= share) return PRESETS[i];
  }
  return PRESETS[0];
}

/**
 * Is a peer's 'bandwidth' limitation a real shortage, or just the encoder's start-up ramp?
 *
 * The two are indistinguishable to the obvious test. `qualityLimitationReason` reads
 * 'bandwidth' during both, and "sending less than the cap allows" is what a ramp *is* -- so
 * requiring both conditions rules out nothing, it states the same fact twice and calls it
 * corroboration.
 *
 * Measured directly: a healthy loopback share at the 1080p60 default reported 'bandwidth' with
 * the send rate at 1.0-1.7 Mbps against a 6 Mbps cap for the first ten seconds, purely because
 * the encoder was climbing 960x540 -> 1280x720 -> 1920x1080. Whether the session then held
 * 60fps or was dropped to 30 for the rest of its life came down to whether that ramp finished
 * before the consecutive-sample counter filled. Two identical runs went opposite ways, which
 * is the signature of a race rather than a policy.
 *
 * `availableOutgoingBitrate` is what separates them: it is the congestion controller's estimate
 * of the *link*, not an observation of our own output, so it does not sag merely because the
 * encoder has not caught up. Across that entire ramp it held steady at 5.04 Mbps -- plain
 * headroom, and invisible to the send-rate test.
 *
 * @param sample one peer's stats: { qualityLimitationReason, availableOutgoingBitrate, actualBitrateBps }
 * @param capBps the bitrate ceiling currently applied to that peer's sender
 */
export function isBandwidthGenuinelyShort(sample, capBps) {
  if (!sample || sample.qualityLimitationReason !== 'bandwidth') return false;

  if (Number.isFinite(sample.availableOutgoingBitrate)) {
    // The estimate itself cannot carry this preset. The margin keeps a link sitting just under
    // the cap from stepping down on measurement noise alone.
    return sample.availableOutgoingBitrate < capBps * 0.8;
  }

  // Firefox does not always expose an estimate. Falling back to the weaker send-rate test is
  // better than never adapting there -- but only here, where nothing better is available.
  return Number.isFinite(sample.actualBitrateBps) && sample.actualBitrateBps < capBps * 0.6;
}

// ---------------------------------------------------------------------------
// Encoder scaling
// ---------------------------------------------------------------------------

/**
 * `scaleResolutionDownBy` for a preset, given what the capture is ACTUALLY producing.
 *
 * The factor must be relative to the real capture height from `track.getSettings()`, not the
 * preset's nominal height: if the user shared a 1440p monitor, hardcoding 1080/720 sends a
 * larger frame than intended. Deriving it live is also what lets quality change instantly --
 * we rescale in the encoder instead of re-prompting the OS picker.
 *
 * Values below 1.0 throw RangeError in the browser, so upscaling is clamped away: a 720p
 * capture asked for 1080p output simply stays at 720p, which the stats panel then reports as
 * the actual resolution.
 */
export function scaleResolutionDownBy(captureHeight, targetHeight) {
  if (!captureHeight || !Number.isFinite(captureHeight) || captureHeight <= 0) return 1;
  const factor = captureHeight / targetHeight;
  if (!Number.isFinite(factor) || factor <= 1) return 1;
  return Math.round(factor * 1000) / 1000;
}
