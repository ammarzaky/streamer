import test from 'node:test';
import assert from 'node:assert/strict';

import { lobbyMicState, LOBBY_SILENT_MS, MIC_STATE } from '../../public/js/media/mic-check.js';
import { SILENT_LEVEL, HOLD_MS } from '../../public/js/media/audio-health.js';
import { rmsLevel, SPEAKING_THRESHOLD } from '../../public/js/media/level-meter.js';

/**
 * The lobby verdict. Two things it must get right, both measured on a real Windows machine:
 *
 * - A capture endpoint muted in Windows (the keyboard's mic-mute key) IS visible: Chromium
 *   mirrors the OS mute onto `track.muted` -- true from the first tick when acquired muted,
 *   `mute`/`unmute` events within a second otherwise. That is OS_MUTED, immediately.
 * - A capture that delivers real near-zero samples with `muted: false` (an APO or hardware
 *   gate) is NOT visible by any flag, so six seconds of nothing is the fallback: SILENT.
 */

const facts = (over = {}) => ({
  everHeard: false,
  soundSeen: false,
  msSinceUnmuted: 0,
  trackMuted: false,
  contextState: 'running',
  ...over,
});

/** A sine of a given peak amplitude, the shape the level meter is fed. */
const tone = (amplitude, n = 512) =>
  Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * i) / 64));

test('the first six seconds of nothing are QUIET, not SILENT', () => {
  // A person who has not started talking yet is not a fault. The "say something" line stays.
  for (const ms of [0, 1, 1000, LOBBY_SILENT_MS - 1]) {
    assert.equal(lobbyMicState(facts({ msSinceUnmuted: ms })), MIC_STATE.QUIET, `at ${ms} ms`);
  }
});

test('six seconds of nothing from a live, unmuted device is SILENT', () => {
  for (const ms of [LOBBY_SILENT_MS, LOBBY_SILENT_MS + 1, 60_000]) {
    assert.equal(lobbyMicState(facts({ msSinceUnmuted: ms })), MIC_STATE.SILENT, `at ${ms} ms`);
  }
});

test('the moment speech is heard it is HEARING, and it stays there', () => {
  // everHeard is a latch: a pause between words must not flip a working microphone back.
  for (const ms of [0, LOBBY_SILENT_MS, 60_000]) {
    assert.equal(lobbyMicState(facts({ everHeard: true, msSinceUnmuted: ms })), MIC_STATE.HEARING, `at ${ms} ms`);
  }
  // Speech outranks every fact except the OS mute.
  assert.equal(
    lobbyMicState(facts({ everHeard: true, soundSeen: true, contextState: 'suspended', msSinceUnmuted: 60_000 })),
    MIC_STATE.HEARING,
  );
});

test('a track Windows has muted is OS_MUTED, whatever else has been seen', () => {
  // `muted: true` is Chromium mirroring the endpoint mute (measured: from the first tick when
  // acquired muted, within a second otherwise). It is certain, so it outranks the latch: a
  // microphone that worked a moment ago and is muted now must not read "working".
  assert.equal(lobbyMicState(facts({ trackMuted: true })), MIC_STATE.OS_MUTED);
  assert.equal(lobbyMicState(facts({ trackMuted: true, everHeard: true, soundSeen: true })), MIC_STATE.OS_MUTED);
  assert.equal(lobbyMicState(facts({ trackMuted: true, msSinceUnmuted: 60_000 })), MIC_STATE.OS_MUTED);
  assert.equal(lobbyMicState(facts({ trackMuted: true, contextState: 'suspended' })), MIC_STATE.OS_MUTED);
});

test('the silence budget does not run while muted, and restarts from the unmute', () => {
  // The caller measures msSinceUnmuted from the last unmute, so what the helper must promise
  // is: muted for any length of time is OS_MUTED, never SILENT; and right after the unmute the
  // count is small, so the answer is QUIET (or HEARING if speech was heard before the mute).
  assert.equal(lobbyMicState(facts({ trackMuted: true, msSinceUnmuted: 60_000 })), MIC_STATE.OS_MUTED);
  assert.equal(lobbyMicState(facts({ trackMuted: false, msSinceUnmuted: 0 })), MIC_STATE.QUIET);
  assert.equal(lobbyMicState(facts({ trackMuted: false, msSinceUnmuted: LOBBY_SILENT_MS - 1 })), MIC_STATE.QUIET);
  assert.equal(lobbyMicState(facts({ trackMuted: false, everHeard: true, msSinceUnmuted: 0 })), MIC_STATE.HEARING);
  // And only once the budget has run out from the unmute does it escalate.
  assert.equal(lobbyMicState(facts({ trackMuted: false, msSinceUnmuted: LOBBY_SILENT_MS })), MIC_STATE.SILENT);
});

test('sound above the silence floor but below speech keeps it QUIET however long it takes', () => {
  // Room tone above 0.01 is a device that delivers something; that is "say something", not
  // "nothing has arrived", and the silent copy would be wrong for it.
  assert.equal(lobbyMicState(facts({ soundSeen: true, msSinceUnmuted: 60_000 })), MIC_STATE.QUIET);
});

test('a suspended audio engine reads zero through no fault of the device', () => {
  // (`undefined` is the omitted-argument default, 'running' -- see the test below.)
  for (const contextState of ['suspended', 'interrupted', 'closed', null]) {
    assert.equal(
      lobbyMicState(facts({ contextState, msSinceUnmuted: 60_000 })),
      MIC_STATE.QUIET,
      `contextState ${contextState}`,
    );
  }
});

test('an unknown unmute time cannot conclude silence', () => {
  for (const msSinceUnmuted of [NaN, undefined, null, Infinity]) {
    assert.equal(lobbyMicState(facts({ msSinceUnmuted })), MIC_STATE.QUIET, `msSinceUnmuted ${msSinceUnmuted}`);
  }
});

test('the defaults assume a live, unmuted, running meter', () => {
  // Callers that only know the three latches get the strict reading.
  assert.equal(lobbyMicState({ everHeard: false, soundSeen: false, msSinceUnmuted: LOBBY_SILENT_MS }), MIC_STATE.SILENT);
});

test('the thresholds match the measured signatures', () => {
  // Measured on the reporter's machine. A capture gated below the endpoint (APO/hardware) with
  // `muted: false` delivers one 16-bit LSB (peak ≈ 3.3e-5); a live but quiet microphone with
  // NS+AGC reads peak 6e-5..1e-4. Both must sit far below SILENT_LEVEL, or the fallback
  // escalation would never fire for the case it is for.
  assert.ok(rmsLevel(tone(3.3e-5)) < SILENT_LEVEL / 100, 'a gated capture is silence');
  assert.ok(rmsLevel(tone(1e-4)) < SILENT_LEVEL / 10, 'a quiet live microphone is silence too');
  // Speech on the same path peaks at 0.1..0.2, which the meter must read as speech.
  assert.ok(rmsLevel(tone(0.1)) > SPEAKING_THRESHOLD, 'speech clears the speaking threshold');
  assert.ok(SILENT_LEVEL < SPEAKING_THRESHOLD, 'the silence floor sits below the speech threshold');
});

test('the lobby speaks before the room would', () => {
  // The whole point of the lobby check is fixing things before anyone is waiting, so its
  // escalation must come sooner than the in-room CAPTURE_SILENT hold.
  assert.ok(LOBBY_SILENT_MS < HOLD_MS.CAPTURE_SILENT, `${LOBBY_SILENT_MS} < ${HOLD_MS.CAPTURE_SILENT}`);
  assert.equal(MIC_STATE.SILENT, 'silent');
  assert.equal(MIC_STATE.OS_MUTED, 'os-muted');
  assert.ok(Object.isFrozen(MIC_STATE));
});
