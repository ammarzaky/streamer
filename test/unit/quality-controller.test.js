import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualityController } from '../../public/js/media/quality.js';
import { videoBudgetBps } from '../../public/shared/quality-math.js';

function setup(overrides = {}, participants = 2) {
  let height = 1080;
  let params = { encodings: [{}] };
  const track = { kind: 'video', contentHint: '', getSettings: () => ({ height }) };
  const sender = {
    track,
    getParameters: () => structuredClone(params),
    setParameters: async (value) => { params = value; },
  };
  const changes = [];
  const suggestions = [];
  const quality = createQualityController({
    config: { media: { adaptWarmupMs: 0, adaptCooldownMs: 0,
      stepDownSamplesBandwidth: 1, ...overrides } },
    mesh: { participantCount: () => participants,
      videoSenders: () => [{ sender }], audioSenders: () => [] },
    onChange: (change) => changes.push(change),
    onSuggestRaise: (preset) => suggestions.push(preset),
  });
  quality.setLocalVideoTrack(track);
  return { quality, track, changes, suggestions, params: () => params,
    resize: (value) => { height = value; } };
}

test('upload budget leaves room for transport and each peer audio', () => {
  assert.equal(videoBudgetBps(4_000_000, 2), 3_272_000);
  assert.equal(videoBudgetBps(4_000_000, 4), 3_016_000);
  assert.equal(videoBudgetBps(100_000, 4), 3);
});

test('encoder cap fits total upload after audio and transport reservation', async () => {
  const t = setup({ uploadBudgetKbps: 4000 }, 4);
  await t.quality.apply();
  const cap = t.params().encodings[0].maxBitrate;
  assert.ok(cap * 3 + 128_000 * 3 <= 4_000_000 * 0.85);
  assert.equal(t.quality.isMeshLimited, true);
});

test('automatic downgrade updates track hint and retains the reason after applying', async () => {
  const t = setup({ defaultPreset: '1080p60' });
  assert.equal(t.track.contentHint, 'motion');
  t.track.contentHint = 'text'; // An obsolete hint must be replaced on automatic changes too.
  t.quality.observe([{ qualityLimitationReason: 'bandwidth', availableOutgoingBitrate: 1_000_000 }]);
  await t.quality.apply();
  assert.equal(t.quality.presetId, '1080p30');
  assert.equal(t.track.contentHint, 'motion');
  assert.equal(t.params().encodings[0].maxFramerate, 30);
  assert.equal(t.changes.at(-1).limitedBy, 'bandwidth');
});

test('a resized capture is scaled using its current dimensions', async () => {
  const t = setup();
  await t.quality.apply();
  t.resize(2160);
  t.quality.observe([{ qualityLimitationReason: 'none' }]);
  await t.quality.apply();
  assert.equal(t.params().encodings[0].scaleResolutionDownBy, 2);
});

test('stale stats after stopping a share cannot downgrade the next session', async () => {
  const t = setup();
  t.quality.setLocalVideoTrack(null);
  t.quality.observe([{ qualityLimitationReason: 'bandwidth', availableOutgoingBitrate: 1 }]);
  await t.quality.apply();
  assert.equal(t.quality.presetId, '1080p30');
});

test('invalid upload input cannot poison encoder parameters', async () => {
  const t = setup();
  const cap = t.quality.effectiveCapBps;
  for (const value of [NaN, Infinity, -1, 0, 'invalid']) t.quality.setUploadBudgetKbps(value);
  await t.quality.apply();
  assert.equal(t.params().encodings[0].maxBitrate, cap);
});

test('healthy peers never prompt a raise beyond the shared upload budget', () => {
  const t = setup({ defaultPreset: '720p30', uploadBudgetKbps: 2000 });
  for (let i = 0; i < 25; i++) {
    t.quality.observe([{ qualityLimitationReason: 'none', availableOutgoingBitrate: 20_000_000 }]);
  }
  assert.equal(t.suggestions.length, 0);
});
