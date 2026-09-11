/**
 * Encoder control: what actually leaves this machine.
 *
 * The distinction this module exists to enforce: **capture constraints are a request to the
 * capturer; `setParameters` is a command to the encoder.** `getDisplayMedia({1920x1080, 60})`
 * asks the OS for a size and frame rate and gets whatever it feels like giving. Only
 * `RTCRtpSender.setParameters` decides what is encoded and sent, so every quality decision
 * lands here, and the UI reports the measured result rather than the request.
 *
 * Quality is chosen **once for the whole outgoing share**, not per connection. If two peers
 * can sustain 1080p60 and a third can barely hold 720p60, everyone gets 720p60. Per-peer
 * presets would mean N encoders at different resolutions with independent adaptation state,
 * and "the video looked bad" would stop being reproducible. Only `maxBitrate` stays per-link,
 * since a bitrate ceiling is genuinely a property of one connection.
 */

import {
  getPreset,
  stepDown,
  stepUp,
  presetIndex,
  PRESETS,
  DEFAULT_PRESET_ID,
  createContentTracker,
  trackContentMode,
  encoderSettingsFor,
  effectiveCapBps,
  scaleResolutionDownBy,
  isBandwidthGenuinelyShort,
  videoBudgetBps,
} from '../../shared/quality-math.js';
import { logger } from '../core/logger.js';

export const LIMITED_BY = Object.freeze({
  NONE: null,
  CPU: 'cpu',
  BANDWIDTH: 'bandwidth',
  MESH_BUDGET: 'mesh-budget',
});

export function createQualityController({ config, mesh, onChange, onSuggestRaise }) {
  const media = config?.media ?? {};

  // The constant, not a second copy of the literal: this fallback drifting from the exported
  // one is the same class of bug as it drifting from config.default.json.
  let presetId = media.defaultPreset ?? DEFAULT_PRESET_ID;
  let uploadBudgetBps = (media.uploadBudgetKbps ?? 10000) * 1000;
  const autoAdapt = media.autoAdapt !== false;

  /** What the capture is actually producing. The scale factor is derived from this, not from
   *  the preset, so sharing a 1440p monitor or a 720p window both behave correctly. */
  let captureHeight = null;

  /** The outgoing video track, kept so the content hint can follow a preset change. */
  let localVideoTrack = null;

  /** 'still' | 'moving' | null, decided from the capture's own frame rate. Null means "not yet
   *  measured", where the preset's own settings stand. */
  let contentMode = null;
  const contentTracker = createContentTracker();

  /** When the current video track started, so adaptation can ignore the ramp-up transient. */
  let videoStartedAt = null;

  // Adaptation counters. Bandwidth reacts sooner than CPU: a saturated uplink degrades
  // everything on the link including the signaling socket and the audio, while a busy CPU
  // only degrades the video.
  let cpuSamples = 0;
  let bandwidthSamples = 0;
  let goodSamples = 0;
  let lastChangeAt = 0;

  const cpuThreshold = media.stepDownSamplesCpu ?? 8;
  const bandwidthThreshold = media.stepDownSamplesBandwidth ?? 6;
  const cooldownMs = media.adaptCooldownMs ?? 10_000;
  const warmupMs = media.adaptWarmupMs ?? 15000;
  let adaptationReason = LIMITED_BY.NONE;

  function videoBudget() {
    const audio = media.audio ?? {};
    return videoBudgetBps(uploadBudgetBps, mesh.participantCount(),
      (audio.micMaxBitrateBps ?? 32_000) + (audio.shareAudioMaxBitrateBps ?? 96_000));
  }

  function preset() {
    return getPreset(presetId);
  }

  function perPeerCap() {
    return effectiveCapBps(preset().maxBitrateBps, videoBudget(), mesh.participantCount());
  }

  // -------------------------------------------------------------------------
  // Applying parameters
  // -------------------------------------------------------------------------

  /**
   * Push the current preset onto one video sender.
   *
   * Three rules are encoded here and all three throw when broken:
   *   - `getParameters()` must be read fresh immediately before `setParameters()`. The object
   *     carries a transactionId and a stale one rejects with InvalidStateError, so the params
   *     object is never cached or reused.
   *   - `encodings.length` must not change between get and set. The transceiver was created
   *     with `sendEncodings: [{}]` precisely so the encoding already exists; if it somehow
   *     does not, we return rather than creating one, because assigning a new array here is
   *     itself a length change.
   *   - `scaleResolutionDownBy` must be >= 1.0. Upscaling is clamped away rather than
   *     attempted.
   */
  async function applyToSender(sender, capBps) {
    if (!sender || sender.track?.kind !== 'video') return false;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      logger.debug('quality: sender has no encodings yet, skipping');
      return false;
    }

    const p = preset();
    const encoding = params.encodings[0];

    encoding.active = true;
    encoding.maxBitrate = capBps;
    encoding.maxFramerate = p.frameRate;
    encoding.scaleResolutionDownBy = scaleResolutionDownBy(
      sender.track.getSettings?.().height ?? captureHeight, p.height);
    encoding.networkPriority = 'high';
    encoding.priority = 'high';

    // Top level, not inside the encoding. Chrome honours it, Firefox ignores it, Safari is
    // partial -- putting it in the wrong place fails silently everywhere.
    //
    // Read through `encoderSettingsFor` rather than off the preset, so that a capture measured
    // to be a still picture gets the setting that suits it. The two levers move together; see
    // `applyContentHint`.
    params.degradationPreference = encoderSettingsFor(p, contentMode).degradationPreference;

    try {
      await sender.setParameters(params);
      return true;
    } catch (err) {
      logger.warn('quality: setParameters failed', { error: err?.message, preset: presetId });
      return false;
    }
  }

  /**
   * Re-apply to every sender, one run at a time.
   *
   * `getParameters()` hands back an object carrying a `transactionId`, and the browser only
   * honours `setParameters` for the most recently returned one. Two overlapping runs both
   * read parameters before either writes, so the older write rejects with
   * InvalidModificationError and that sender silently keeps the previous cap, scale factor
   * and degradation preference. It is a genuine race, not a theoretical one: choosing a
   * preset while a third participant joins triggers it, and starting a share triggers it
   * every single time, because the capture-height update and the post-replaceTrack apply run
   * back to back.
   *
   * Serializing costs nothing at this call rate and removes the whole class.
   */
  let applyChain = Promise.resolve();

  function apply() {
    applyChain = applyChain.then(applyNow, applyNow);
    return applyChain;
  }

  async function applyNow() {
    const { cap, limited } = perPeerCap();
    const senders = mesh.videoSenders();

    await Promise.all(senders.map(({ sender }) => applyToSender(sender, cap)));

    // Audio ceilings, so a spike in shared audio cannot crowd out the video budget.
    const audio = media.audio ?? {};
    await Promise.all([
      ...mesh.audioSenders('mic').map(({ sender }) => setAudioCap(sender, audio.micMaxBitrateBps ?? 32_000)),
      ...mesh
        .audioSenders('shareAudio')
        .map(({ sender }) => setAudioCap(sender, audio.shareAudioMaxBitrateBps ?? 96_000)),
    ]);

    logger.debug('quality: applied', {
      preset: presetId,
      capBps: cap,
      meshLimited: limited,
      contentMode,
      senders: senders.length,
    });

    onChange?.({
      presetId,
      effectiveCapBps: cap,
      contentMode,
      limitedBy: limited ? LIMITED_BY.MESH_BUDGET : adaptationReason,
    });
  }

  async function setAudioCap(sender, maxBitrate) {
    if (!sender || sender.track?.kind !== 'audio') return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = maxBitrate;
    try {
      await sender.setParameters(params);
    } catch {
      // Audio ceilings are an optimisation; failing to set one is not worth surfacing.
    }
  }

  // -------------------------------------------------------------------------
  // Manual selection
  // -------------------------------------------------------------------------

  async function setPreset(id, { manual = true } = {}) {
    if (id === presetId) return false;
    getPreset(id); // throws on an unknown id rather than silently doing nothing
    presetId = id;
    adaptationReason = LIMITED_BY.NONE;
    lastChangeAt = performance.now();
    resetCounters();
    // The hint belongs to the preset, so it moves with it.
    applyContentHint(localVideoTrack);
    await apply();
    logger.info('quality: preset set', { presetId, manual });
    return true;
  }

  function setCaptureHeight(height) {
    if (!height || height === captureHeight) return;
    captureHeight = height;
    logger.debug('quality: capture height', { captureHeight });
    // The scale factor is relative to this, so a source switch must re-apply or the picture
    // silently softens.
    void apply();
  }

  /**
   * Tell the encoder what kind of content this is.
   *
   * `contentHint` is the companion to `degradationPreference`: 'motion' lets the encoder
   * trade per-frame sharpness for frame rate, which is what the 60fps presets are chosen for,
   * while 'detail' does the reverse for text. Setting the preference without the hint gets
   * half the intended behaviour.
   *
   * The preset supplies the default answer; a measured capture overrides it. Someone sharing a
   * code editor and someone sharing a film are asking the encoder for opposite things, and
   * neither of them knows there is a menu.
   */
  function applyContentHint(track) {
    if (!track || track.kind !== 'video') return;
    if (!('contentHint' in track)) return; // Firefox until recently
    const hint = encoderSettingsFor(preset(), contentMode).contentHint;
    if (track.contentHint === hint) return;
    track.contentHint = hint;
    logger.debug('quality: content hint', { hint, contentMode });
  }

  /**
   * Watch what the CAPTURE is doing and re-tune the encoder when the answer changes.
   *
   * Separate from `observe`'s step-down logic on purpose: that one asks "is this link or this
   * machine struggling?" and responds by lowering the preset. This one asks "what kind of
   * picture is this?" and responds by changing how the same preset is encoded. Conflating them
   * would mean a still screen looked like a problem to be solved by sending less.
   */
  function observeContent(samples) {
    // The same warm-up the step-down logic respects, for the same reason. A capture's first
    // seconds report a frame rate that describes the start-up, not the content: measured, a
    // 60fps canvas read 0 then 5 fps immediately after its track was created, which is exactly
    // what a document looks like. Reading the ramp as an answer is the mistake `adaptWarmupMs`
    // was introduced to prevent, and this rule was originally written outside it.
    if (videoStartedAt === null || performance.now() - videoStartedAt < warmupMs) return;

    // A struggling machine also produces few source frames -- the capturer is starved rather
    // than idle -- and answering that with "spend the bitrate on sharpness" makes it worse.
    // When the encoder says CPU, the content question is not the one being asked.
    if (samples.some((s) => s.qualityLimitationReason === 'cpu')) return;

    const reading = samples.map((s) => s.sourceFps).find((fps) => Number.isFinite(fps));
    const before = contentMode;
    contentMode = trackContentMode(contentTracker, reading ?? null);
    if (contentMode === before) return;
    logger.info('quality: content mode', { contentMode, sourceFps: reading ?? null, presetId });
    applyContentHint(localVideoTrack);
    void apply();
  }

  function setUploadBudgetKbps(kbps) {
    if (!Number.isFinite(kbps) || kbps <= 0) return;
    uploadBudgetBps = Math.max(100, kbps) * 1000;
    void apply();
  }

  function resetCounters() {
    cpuSamples = 0;
    bandwidthSamples = 0;
    goodSamples = 0;
  }

  // -------------------------------------------------------------------------
  // Adaptation
  // -------------------------------------------------------------------------

  /**
   * Fold one round of per-peer stats into a single decision.
   *
   * `samples` is one entry per remote peer:
   *   { qualityLimitationReason, actualBitrateBps, availableOutgoingBitrate }
   *
   * The worst peer decides. Stepping down is automatic because a call that is failing needs
   * no permission to degrade; stepping up never is, because an unrequested jump that then
   * collapses is worse than staying put.
   */
  function observe(samples) {
    if (!localVideoTrack || samples.length === 0) return;
    setCaptureHeight(localVideoTrack.getSettings?.().height);

    // Outside the `autoAdapt` switch and the cooldown: this is not a downgrade, it is the
    // encoder being told what it is looking at, and someone who has turned automatic quality
    // changes off has not asked for a still screen to be encoded as if it were a film. It has
    // its own gates -- see `observeContent`.
    observeContent(samples);

    if (!autoAdapt) return;
    if (performance.now() - lastChangeAt < cooldownMs) return;

    // Ignore everything while the encoder is still ramping up.
    //
    // For the first several seconds of a new video track the send rate is legitimately far
    // below the cap and `qualityLimitationReason` reads 'bandwidth' -- not because the link
    // is congested, but because the bandwidth estimator is still probing upward. Adapting on
    // that permanently downgrades a call that was about to be perfectly healthy: measured on
    // this machine, a 1080p60 share reported 'bandwidth' at 960x540 for the first five
    // seconds and then settled at a stable 1920x1080. Stepping down in that window is not a
    // response to a problem, it is a response to a start-up transient.
    if (videoStartedAt !== null && performance.now() - videoStartedAt < warmupMs) return;

    const { cap } = perPeerCap();

    const anyCpu = samples.some((s) => s.qualityLimitationReason === 'cpu');
    const anyBandwidth = samples.some((s) => isBandwidthGenuinelyShort(s, cap));

    cpuSamples = anyCpu ? cpuSamples + 1 : 0;
    bandwidthSamples = anyBandwidth ? bandwidthSamples + 1 : 0;

    if (cpuSamples >= cpuThreshold) return stepDownNow(LIMITED_BY.CPU, { capBps: cap });
    if (bandwidthSamples >= bandwidthThreshold) {
      // The estimate that justified the decision travels with it. An automatic downgrade with no
      // number attached is unfalsifiable after the fact: "it dropped me to 30fps" and "the link
      // really was short of headroom" look identical in a log that records only the outcome.
      const estimates = samples
        .map((s) => s.availableOutgoingBitrate)
        .filter((value) => Number.isFinite(value));
      return stepDownNow(LIMITED_BY.BANDWIDTH, {
        capBps: cap,
        estimateBps: estimates.length ? Math.min(...estimates) : null,
      });
    }

    maybeSuggestRaise(samples);
  }

  function stepDownNow(reason, evidence = {}) {
    adaptationReason = reason;
    const next = stepDown(presetId);
    if (next.id === presetId) {
      // Already at the floor. Report the constraint rather than pretending it is fine.
      onChange?.({ presetId, effectiveCapBps: perPeerCap().cap, limitedBy: reason });
      return;
    }

    logger.info('quality: stepping down', { from: presetId, to: next.id, reason, ...evidence });
    presetId = next.id;
    applyContentHint(localVideoTrack);
    lastChangeAt = performance.now();
    resetCounters();
    void apply();
    onChange?.({
      presetId,
      effectiveCapBps: perPeerCap().cap,
      limitedBy: reason,
      steppedDown: true,
      reason,
    });
  }

  /**
   * Suggest a higher preset when there is real headroom.
   *
   * The comparison is against the **per-peer budget share**, not the preset's own cap.
   * Comparing against the cap would require each connection to independently report far more
   * than its fair share of a link they are all using -- which is the same per-connection
   * bandwidth-estimate blindness the mesh budget exists to correct, and would make the
   * suggestion unreachable at exactly the participant count this app is built for.
   */
  function maybeSuggestRaise(samples) {
    if (presetIndex(presetId) >= PRESETS.length - 1) return;

    const share = Math.floor(videoBudget() / Math.max(1, mesh.participantCount() - 1));
    const next = stepUp(presetId);
    if (next.maxBitrateBps > share) {
      goodSamples = 0;
      return;
    }

    const allHealthy = samples.every(
      (s) =>
        (s.qualityLimitationReason ?? 'none') === 'none' &&
        Number.isFinite(s.availableOutgoingBitrate) &&
        s.availableOutgoingBitrate > Math.min(share, next.maxBitrateBps) * 1.3,
    );

    goodSamples = allHealthy ? goodSamples + 1 : 0;

    if (goodSamples >= 20) {
      goodSamples = 0;
      onSuggestRaise?.(next);
    }
  }

  /** Called whenever the outgoing video track changes, including when it is cleared. */
  function setLocalVideoTrack(track) {
    localVideoTrack = track ?? null;
    captureHeight = track?.getSettings?.().height ?? null;
    adaptationReason = LIMITED_BY.NONE;
    // A new capture is a new question. Carrying "that was a still picture" from the window that
    // was just stopped into a film that was just started is worse than having no answer at all,
    // so the measurement restarts with the track.
    contentMode = null;
    contentTracker.mode = null;
    contentTracker.stillRun = 0;
    contentTracker.movingRun = 0;
    applyContentHint(localVideoTrack);
    // A new track means a new ramp-up, so the warm-up window restarts with it.
    videoStartedAt = track ? performance.now() : null;
    resetCounters();
  }

  return {
    apply,
    setPreset,
    setCaptureHeight,
    setLocalVideoTrack,
    setUploadBudgetKbps,
    observe,

    get presetId() {
      return presetId;
    },
    get preset() {
      return preset();
    },
    get effectiveCapBps() {
      return perPeerCap().cap;
    },
    get isMeshLimited() {
      return perPeerCap().limited;
    },
    get captureHeight() {
      return captureHeight;
    },
    /** 'still' | 'moving' | null. Read by the diagnostics dump and the stats panel: "why is my
     *  sharp screen only sending 2 fps" has an answer now. */
    get contentMode() {
      return contentMode;
    },
  };
}
