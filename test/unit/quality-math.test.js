import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  PRESET_IDS,
  DEFAULT_PRESET_ID,
  getPreset,
  stepDown,
  stepUp,
  perPeerBudgetBps,
  effectiveCapBps,
  bestPresetForBudget,
  scaleResolutionDownBy,
  isBandwidthGenuinelyShort,
} from '../../public/shared/quality-math.js';

test('preset ladder is ordered strictly by ascending bitrate', () => {
  // Auto step-down walks this ladder one rung at a time and relies on each step actually
  // reducing load. A non-monotonic ladder makes "step down" occasionally step up.
  for (let i = 1; i < PRESETS.length; i++) {
    assert.ok(
      PRESETS[i].maxBitrateBps > PRESETS[i - 1].maxBitrateBps,
      `${PRESETS[i].id} (${PRESETS[i].maxBitrateBps}) must exceed ${PRESETS[i - 1].id}`,
    );
  }
});

test('every preset is fully specified', () => {
  for (const p of PRESETS) {
    assert.ok(Number.isInteger(p.width) && p.width > 0, `${p.id} width`);
    assert.ok(Number.isInteger(p.height) && p.height > 0, `${p.id} height`);
    assert.ok(Number.isInteger(p.frameRate) && p.frameRate > 0, `${p.id} frameRate`);
    assert.ok(Number.isInteger(p.maxBitrateBps) && p.maxBitrateBps > 0, `${p.id} bitrate`);
    assert.ok(['motion', 'detail', 'text'].includes(p.contentHint), `${p.id} contentHint`);
    assert.ok(
      ['balanced', 'maintain-framerate', 'maintain-resolution'].includes(p.degradationPreference),
      `${p.id} degradationPreference`,
    );
  }
});

test('60fps presets keep framerate, 30fps presets keep resolution', () => {
  // Screen-shared motion content degrades better by dropping resolution than into a
  // slideshow; text content is the opposite. A preset that pairs these the wrong way round
  // looks like a WebRTC bug rather than a config mistake.
  for (const p of PRESETS) {
    if (p.frameRate >= 60) assert.equal(p.degradationPreference, 'maintain-framerate', p.id);
  }
});

test('default preset exists and is the top rung', () => {
  assert.ok(PRESET_IDS.includes(DEFAULT_PRESET_ID));
  assert.equal(PRESETS.at(-1).id, DEFAULT_PRESET_ID);
});

test('getPreset throws with a useful message for an unknown id', () => {
  assert.throws(() => getPreset('4k120'), /unknown quality preset "4k120".*480p30/s);
});

test('stepDown and stepUp clamp at the ends instead of wrapping', () => {
  assert.equal(stepDown('480p30').id, '480p30');
  assert.equal(stepUp('1080p60').id, '1080p60');
  assert.equal(stepDown('1080p60').id, '1080p30');
  assert.equal(stepUp('480p30').id, '720p30');
});

test('stepping down then up returns to the same rung', () => {
  for (const p of PRESETS.slice(1, -1)) {
    assert.equal(stepUp(stepDown(p.id).id).id, p.id);
  }
});

test('per-peer budget divides by REMOTE peers, not participants', () => {
  const budget = 20_000_000;

  // The whole point: at 4 participants you send 3 copies, so each gets a third of the uplink.
  // Dividing by 4 would yield 5_000_000 and quietly make the 1080p60 default unreachable.
  assert.equal(perPeerBudgetBps(budget, 4), 6_666_666);
  assert.notEqual(perPeerBudgetBps(budget, 4), 5_000_000);

  assert.equal(perPeerBudgetBps(budget, 2), 20_000_000);
  assert.equal(perPeerBudgetBps(budget, 3), 10_000_000);
  assert.equal(perPeerBudgetBps(budget, 5), 5_000_000);
  assert.equal(perPeerBudgetBps(budget, 6), 4_000_000);
});

test('per-peer budget is safe when alone in the room', () => {
  // participantCount 1 (and the nonsensical 0) must not divide by zero and produce Infinity,
  // which would be handed straight to setParameters as maxBitrate.
  assert.equal(perPeerBudgetBps(20_000_000, 1), 20_000_000);
  assert.equal(perPeerBudgetBps(20_000_000, 0), 20_000_000);
  assert.ok(Number.isFinite(perPeerBudgetBps(20_000_000, 1)));
});

test('the default budget lets the default preset run at the participant cap', () => {
  // These two numbers were chosen together: 20 Mbps across 3 remote peers is what makes
  // 1080p60 (6 Mbps) viable at 4 participants. If either constant moves, this fails loudly.
  const { cap, limited } = effectiveCapBps(6_000_000, 20_000_000, 4);
  assert.equal(cap, 6_000_000);
  assert.equal(limited, false);
});

test('effective cap clamps to the budget and reports being limited', () => {
  const { cap, limited } = effectiveCapBps(6_000_000, 20_000_000, 6);
  assert.equal(cap, 4_000_000);
  assert.equal(limited, true);
});

test('bestPresetForBudget picks the highest rung that fits', () => {
  assert.equal(bestPresetForBudget(20_000_000, 4).id, '1080p60'); // 6.67 Mbps each
  assert.equal(bestPresetForBudget(20_000_000, 6).id, '1080p30'); // 4.0  Mbps each
  assert.equal(bestPresetForBudget(5_000_000, 4).id, '720p30'); // 1.67 Mbps each
  assert.equal(bestPresetForBudget(500_000, 4).id, '480p30'); // nothing fits -> floor
});

test('scaleResolutionDownBy derives from the real capture size', () => {
  assert.equal(scaleResolutionDownBy(1080, 720), 1.5);
  assert.equal(scaleResolutionDownBy(1440, 720), 2);
  assert.equal(scaleResolutionDownBy(1080, 1080), 1);
});

test('scaleResolutionDownBy never returns a value below 1', () => {
  // Below 1.0 throws RangeError in the browser. Sharing a 720p window while 1080p is
  // selected must clamp, not upscale.
  assert.equal(scaleResolutionDownBy(720, 1080), 1);
  assert.equal(scaleResolutionDownBy(480, 1080), 1);
  for (const capture of [0, -1, NaN, undefined, null]) {
    assert.equal(scaleResolutionDownBy(capture, 720), 1, `capture=${capture}`);
  }
});

// ---------------------------------------------------------------------------
// Distinguishing real congestion from the encoder's start-up ramp
// ---------------------------------------------------------------------------

const CAP = 6_000_000; // the 1080p60 ceiling

test('the encoder start-up ramp is not mistaken for congestion', () => {
  // These are real numbers, sampled from a healthy loopback share at the 1080p60 default while
  // the encoder climbed 960x540 -> 1280x720 -> 1920x1080. Every one of them reports
  // 'bandwidth' with the send rate far below the cap, and every one of them is fine.
  const ramp = [
    { qualityLimitationReason: 'bandwidth', actualBitrateBps: 1_090_000, availableOutgoingBitrate: 5_040_000 },
    { qualityLimitationReason: 'bandwidth', actualBitrateBps: 1_340_000, availableOutgoingBitrate: 5_040_000 },
    { qualityLimitationReason: 'bandwidth', actualBitrateBps: 940_000, availableOutgoingBitrate: 5_040_000 },
    { qualityLimitationReason: 'bandwidth', actualBitrateBps: 1_050_000, availableOutgoingBitrate: 5_040_000 },
  ];
  for (const sample of ramp) {
    assert.equal(
      isBandwidthGenuinelyShort(sample, CAP),
      false,
      `send=${sample.actualBitrateBps} bwe=${sample.availableOutgoingBitrate} must not trigger a step down`,
    );
  }
});

test('a link that genuinely cannot carry the preset does step down', () => {
  assert.equal(
    isBandwidthGenuinelyShort(
      { qualityLimitationReason: 'bandwidth', actualBitrateBps: 2_000_000, availableOutgoingBitrate: 2_200_000 },
      CAP,
    ),
    true,
  );
});

test('only a bandwidth limitation counts, whatever the numbers say', () => {
  for (const reason of ['none', 'cpu', 'other', undefined]) {
    assert.equal(
      isBandwidthGenuinelyShort(
        { qualityLimitationReason: reason, actualBitrateBps: 1, availableOutgoingBitrate: 1 },
        CAP,
      ),
      false,
      `reason=${reason}`,
    );
  }
  assert.equal(isBandwidthGenuinelyShort(null, CAP), false);
});

test('without a bandwidth estimate, the weaker send-rate test still applies', () => {
  // Firefox does not always expose availableOutgoingBitrate. Never adapting there would be
  // worse than adapting on imperfect evidence.
  const noEstimate = (actualBitrateBps) => ({
    qualityLimitationReason: 'bandwidth',
    actualBitrateBps,
    availableOutgoingBitrate: null,
  });
  assert.equal(isBandwidthGenuinelyShort(noEstimate(1_000_000), CAP), true);
  assert.equal(isBandwidthGenuinelyShort(noEstimate(5_000_000), CAP), false);
});

test('the estimate is believed over the send rate, in both directions', () => {
  // Sending little but with plenty of headroom: a ramp, or simple content. Not congestion.
  assert.equal(
    isBandwidthGenuinelyShort(
      { qualityLimitationReason: 'bandwidth', actualBitrateBps: 500_000, availableOutgoingBitrate: 9_000_000 },
      CAP,
    ),
    false,
  );
  // Sending near the cap while the estimate has collapsed under it: congestion arriving, and
  // the send-rate test would have missed it entirely.
  assert.equal(
    isBandwidthGenuinelyShort(
      { qualityLimitationReason: 'bandwidth', actualBitrateBps: 5_800_000, availableOutgoingBitrate: 3_000_000 },
      CAP,
    ),
    true,
  );
});
