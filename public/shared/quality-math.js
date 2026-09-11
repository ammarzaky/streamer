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
 * slideshow. Lower-resolution 30fps presets favour text; 1080p30 also protects motion
 * for movie playback. Measured still content overrides the hint below.
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
    note: 'Movies / lower data',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrateBps: 3_500_000,
    // Movies must not be treated as text: detail can drop most frames even at 30fps.
    // https://www.w3.org/TR/mst-content-hint/#video-content-hints
    contentHint: 'motion',
    // Watch parties need smooth motion. Under pressure, scale before dropping frames.
    // Measured still content switches back to detail/balanced below.
    degradationPreference: 'maintain-framerate',
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

/**
 * The client-side fallback when the server sends no preset. **Must equal `media.defaultPreset`
 * in config.default.json** -- a unit test asserts it, because a fallback that disagrees with the
 * configured default is a difference nobody notices until one client is on a different rung
 * from the rest of the room.
 *
 * Keep full-HD detail at 30fps for watch parties. 60fps remains available for sports and games.
 */
export const DEFAULT_PRESET_ID = '1080p30';

/** Reserve transport/retransmission headroom and both audio tracks before allocating video.
 * The positive floor keeps maxBitrate valid on extremely small upload budgets; such a link
 * may still be unable to carry the audio alone.
 */
export function videoBudgetBps(uploadBps, participants, audioBps = 128_000) {
  const peers = Math.max(1, participants - 1);
  return Math.max(peers, Math.floor(uploadBps * 0.85) - audioBps * peers);
}

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
// Content mode: still picture, or moving one?
// ---------------------------------------------------------------------------

/**
 * A shared screen is two completely different problems wearing one name.
 *
 * A code editor or a document is a STILL picture that changes occasionally. A desktop capturer
 * only emits frames that changed, so such a surface produces one to three frames per second no
 * matter what the preset asks for -- and a 'motion' hint paired with `maintain-framerate` then
 * spends the whole bitrate protecting a frame rate nobody is producing, in the one currency the
 * viewer can see. That was measured in the field: 1728x1080 arriving at 2 fps and 47 kbps,
 * soft in every direction.
 *
 * Video or a game is the opposite: a genuinely moving picture where a sharp still frame every
 * fifth of a second is a slideshow.
 *
 * Neither preset is wrong -- they are answers to different questions, and only the capture can
 * say which question is being asked. This decides from `media-source.framesPerSecond`, which is
 * the capturer's own rate. Deliberately NOT `outbound-rtp`: telling the encoder the content is
 * still is exactly what makes its frame rate fall, so deciding from the encoded rate would
 * latch on the first reading and never come back.
 */
export const CONTENT_FPS = Object.freeze({
  /**
   * At or below this the surface is not animating. Set from what was measured, in both
   * directions: a code editor being read arrived at 2 fps in the field, and a genuinely moving
   * source that the machine could barely keep up with -- a redrawn canvas under three encoders
   * -- still produced 5. The first version sat at 8 and called the second one a document.
   * Erring high mislabels moving content, which is the costly mistake; erring low only leaves
   * a still screen on the settings it always had.
   */
  still: 3,
  /** Above this it is moving. The gap between the two is the hysteresis. */
  moving: 10,
  /** Consecutive samples (one per second) required to change the answer. Eight, because the
   *  wrong answer here is expensive and a still picture is in no hurry. */
  samples: 8,
});

export function createContentTracker() {
  return { mode: null, stillRun: 0, movingRun: 0 };
}

/**
 * Fold one source-frame-rate reading into the tracker. Returns the mode to use now:
 * 'still' | 'moving' | null (not yet decided -- use the preset's own settings).
 *
 * Pure apart from mutating the tracker it is given, so every rule here is a unit test.
 */
export function trackContentMode(tracker, sourceFps) {
  // A reading of zero is not a still picture, it is an absent one: a capture that has just
  // started, or one whose stats report caught it mid-restart. Measured -- a synthetic 60fps
  // canvas reported `framesPerSecond: 0` with its frame counter reset to 1 for one sample, and
  // four seconds later the tracker had declared it a document. Even a completely static screen
  // emits the occasional frame; a sustained literal zero means nothing is being captured.
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    // No reading is not evidence either way, and must not decay a decision already made.
    return tracker.mode;
  }

  if (sourceFps <= CONTENT_FPS.still) {
    tracker.stillRun += 1;
    tracker.movingRun = 0;
  } else if (sourceFps > CONTENT_FPS.moving) {
    tracker.movingRun += 1;
    tracker.stillRun = 0;
  } else {
    // Between the two thresholds: ambiguous, so it neither builds nor breaks a run.
    return tracker.mode;
  }

  if (tracker.stillRun >= CONTENT_FPS.samples) tracker.mode = 'still';
  else if (tracker.movingRun >= CONTENT_FPS.samples) tracker.mode = 'moving';
  return tracker.mode;
}

/**
 * The encoder settings a preset should actually run with, given what the capture is doing.
 *
 * `still` overrides both levers together, because they are one decision: hint the encoder that
 * detail matters, and stop it protecting a frame rate the source is not producing.
 * `degradationPreference` becomes 'balanced' rather than 'maintain-resolution' -- measured,
 * three peers encoding 1080p with resolution pinned produced no decodable frame in 25 seconds,
 * and a still picture that never arrives is worse than a slightly smaller one that does.
 */
export function encoderSettingsFor(preset, mode) {
  if (mode === 'still') return { contentHint: 'detail', degradationPreference: 'balanced' };
  return { contentHint: preset.contentHint, degradationPreference: preset.degradationPreference };
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
