import test from 'node:test';
import assert from 'node:assert/strict';

import { rmsLevel, smoothLevel, meterHealth, createLevelMeter, SPEAKING_THRESHOLD } from '../../public/js/media/level-meter.js';

/** A sine wave of a given amplitude — a stand-in for someone speaking steadily. */
const tone = (amplitude, n = 512) =>
  Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * i) / 64));

test('silence reads zero', () => {
  assert.equal(rmsLevel(new Float32Array(512)), 0);
  assert.equal(rmsLevel(new Float32Array(0)), 0);
  assert.equal(rmsLevel(null), 0);
  assert.equal(rmsLevel(undefined), 0);
});

test('level rises with amplitude', () => {
  const quiet = rmsLevel(tone(0.02));
  const speech = rmsLevel(tone(0.3));
  const loud = rmsLevel(tone(0.9));

  assert.ok(quiet < speech && speech < loud, `${quiet} < ${speech} < ${loud}`);
  assert.ok(speech > SPEAKING_THRESHOLD, 'ordinary speech must clear the speaking threshold');
  assert.ok(quiet < SPEAKING_THRESHOLD, 'room tone must not read as speech');
});

test('RMS is used rather than peak, so a single click does not look like speech', () => {
  // The distinction this encodes: one loud sample among 512 quiet ones is a keyboard click,
  // not a voice. A peak meter would show full scale and imply a working microphone.
  const click = new Float32Array(512);
  click[0] = 1;

  assert.ok(rmsLevel(click) < SPEAKING_THRESHOLD, `a lone spike read ${rmsLevel(click)}`);
  assert.ok(rmsLevel(tone(0.3)) > rmsLevel(click), 'sustained speech must outrank a click');
});

test('level is clamped to 0..1 even for a misbehaving source', () => {
  const hot = Float32Array.from({ length: 128 }, () => 5);
  assert.equal(rmsLevel(hot), 1);
});

test('smoothing attacks fast and releases slowly', () => {
  // Fast attack so speech registers at once; slow release so the bar does not strobe through
  // the gaps between words, which is harder to read than no meter at all.
  const attacked = smoothLevel(0, 1);
  const released = smoothLevel(1, 0);

  assert.ok(attacked > 0.4, `attack was too slow: ${attacked}`);
  assert.ok(released > 0.8, `release was too fast: ${released}`);
  assert.ok(attacked > 1 - released, 'attack must be faster than release');
});

test('smoothing converges and never escapes the range', () => {
  let level = 0;
  for (let i = 0; i < 60; i++) level = smoothLevel(level, 0.5);
  assert.ok(Math.abs(level - 0.5) < 0.01, `did not converge: ${level}`);

  for (const seed of [NaN, undefined, null]) {
    assert.ok(Number.isFinite(smoothLevel(seed, 0.4)), `seed ${seed} produced a non-number`);
  }
});

// --- meterHealth -------------------------------------------------------------------------------

test('a healthy meter with a running context reports running', () => {
  assert.equal(meterHealth({ contextState: 'running' }), 'running');
});

test('a missing context state is treated as running rather than suspended', () => {
  assert.equal(meterHealth({}), 'running');
  assert.equal(meterHealth(), 'running');
  assert.equal(meterHealth({ contextState: null }), 'running');
});

test('a suspended or closed context reports suspended', () => {
  assert.equal(meterHealth({ contextState: 'suspended' }), 'suspended');
  assert.equal(meterHealth({ contextState: 'closed' }), 'suspended');
});

test('a muted track or clone reports source-muted', () => {
  assert.equal(meterHealth({ contextState: 'running', trackMuted: true }), 'source-muted');
  assert.equal(meterHealth({ contextState: 'running', cloneMuted: true }), 'source-muted');
});

test('the dead flag or an ended track or clone reports dead', () => {
  assert.equal(meterHealth({ contextState: 'running', dead: true }), 'dead');
  assert.equal(meterHealth({ contextState: 'running', trackReadyState: 'ended' }), 'dead');
  assert.equal(meterHealth({ contextState: 'running', cloneReadyState: 'ended' }), 'dead');
  assert.equal(meterHealth({ contextState: 'running', trackReadyState: 'live', cloneReadyState: 'live' }), 'running');
});

test('health precedence is dead over source-muted over suspended over running', () => {
  const everything = { contextState: 'suspended', trackMuted: true, cloneMuted: true, dead: true };
  assert.equal(meterHealth(everything), 'dead');
  assert.equal(meterHealth({ ...everything, dead: false }), 'source-muted');
  assert.equal(meterHealth({ ...everything, dead: false, trackMuted: false, cloneMuted: false }), 'suspended');
  assert.equal(meterHealth({ contextState: 'running' }), 'running');
});

// --- createLevelMeter early return -------------------------------------------------------------

test('creating a meter with no track returns a dead meter without touching the window', () => {
  assert.equal(typeof globalThis.window, 'undefined', 'this test relies on a pure Node environment');
  const reports = [];
  const meter = createLevelMeter(null, () => {}, { onState: (s) => reports.push(s) });

  assert.equal(typeof meter.stop, 'function');
  assert.equal(typeof meter.state, 'function');
  const snapshot = meter.state();
  assert.equal(snapshot.dead, true);
  assert.equal(snapshot.reason, 'no-track');
  assert.equal(snapshot.health, 'dead');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, 'no-track');
  assert.doesNotThrow(() => meter.stop());
  assert.doesNotThrow(() => meter.stop());
});
