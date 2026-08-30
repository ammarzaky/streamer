import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { startMicCheck, MIC_STATE, LOBBY_SILENT_MS } from '../../public/js/media/mic-check.js';
import { ERRORS } from '../../public/shared/protocol.js';
import { logger } from '../../public/js/core/logger.js';

// The check narrates every step; the assertions below are the narration that matters.
logger.setLevel('error');

/**
 * The lobby check's life after acquisition: what it says when the device it opened goes away.
 *
 * The bug this guards against: the meter died (headset unplugged, or only its clone ended),
 * delivered one last zero, and the check took that zero as a reading from a live device --
 * escalating to the Windows-mute copy for a microphone that was no longer there, and then
 * freezing on it forever because no further tick ever arrived.
 *
 * And the other thing the lobby must get right, measured on a real Windows machine: a capture
 * endpoint muted in Windows shows up as `track.muted` -- true from the first tick when the
 * track is acquired muted, `mute`/`unmute` events within a second otherwise. The check must
 * say OS_MUTED the moment the flag flips (not on the next meter tick), never run the silence
 * budget while muted, and start the budget over from the unmute.
 *
 * Runs against a fake browser: a track that can be ended or muted on demand, an AudioContext
 * whose analyser reads whatever `fakeSample` is (zeros by default), and a getUserMedia that
 * hands the track over.
 */

let trackSeq = 0;
/** What the fake analyser fills its buffer with: 0 is silence, 0.3 reads as speech. */
let fakeSample = 0;

class FakeTrack extends EventTarget {
  constructor(label) {
    super();
    this.id = `track-${++trackSeq}`;
    this.kind = 'audio';
    this.label = label;
    this.muted = false;
    this.enabled = true;
    this.readyState = 'live';
    this.clones = [];
  }

  getSettings() {
    return { deviceId: 'dev-1', sampleRate: 48000 };
  }

  clone() {
    const copy = new FakeTrack(this.label);
    this.clones.push(copy);
    return copy;
  }

  stop() {
    this.readyState = 'ended';
  }

  /** What an unplug looks like: readyState flips and `ended` fires. */
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }

  /** What the Windows mic-mute key looks like to the page: the flag flips and the event fires. */
  setMuted(muted) {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeAudioContext extends EventTarget {
  constructor() {
    super();
    this.state = 'running';
    this.sampleRate = 48000;
  }

  createMediaStreamSource() {
    return { connect() {} };
  }

  createAnalyser() {
    return {
      fftSize: 512,
      getFloatTimeDomainData(buffer) {
        buffer.fill(fakeSample);
      },
    };
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Install the fake browser and return a restorer. */
function installBrowser(track) {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    MediaStream: Object.getOwnPropertyDescriptor(globalThis, 'MediaStream'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    now: Date.now,
  };
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.MediaStream = FakeStream;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => new FakeStream([track]) } },
  });
  return () => {
    for (const name of ['window', 'MediaStream', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
    Date.now = previous.now;
  };
}

const sleep = (ms) => setTimeoutPromise(ms);

/** Start a check (on whatever getUserMedia hands over) and resolve once it has delivered its
 *  first verdict from an acquired device. */
async function startAndSettle(settled = [MIC_STATE.QUIET, MIC_STATE.HEARING]) {
  const updates = [];
  const { promise: firstReading, resolve: sawReading } = Promise.withResolvers();
  const check = startMicCheck((update) => {
    updates.push(update);
    if (settled.includes(update.state)) sawReading();
  });
  await firstReading;
  return { check, updates };
}

/** Wait until the latest update has one of these states. */
async function waitForState(updates, states, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!states.includes(updates.at(-1)?.state)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${states}, last ${updates.at(-1)?.state}`);
    await sleep(20);
  }
}

test('an unplugged device is FAILED with the no-microphone code, not SILENT', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    assert.equal(updates[0].state, MIC_STATE.CHECKING);
    assert.equal(updates.at(-1).state, MIC_STATE.QUIET);
    assert.equal(updates.at(-1).label, 'Headset');

    // The worst case: the unplug lands after the silence budget, so the dying meter's final
    // zero would have read as "live, unmuted, running, nothing for six seconds".
    const realNow = Date.now;
    Date.now = () => realNow() + LOBBY_SILENT_MS + 1000;
    const before = updates.length;
    track.end();

    const after = updates.slice(before);
    assert.equal(after.length, 1, 'exactly one update follows the end of the track');
    assert.deepEqual(
      { state: after[0].state, level: after[0].level, code: after[0].code, label: after[0].label },
      { state: MIC_STATE.FAILED, level: 0, code: ERRORS.MIC_NOT_FOUND, label: 'Headset' },
    );

    // And nothing after it: the meter is stopped, so no tick can revise the verdict.
    await sleep(200);
    assert.equal(updates.length, before + 1, 'no update after FAILED');
    assert.ok(!updates.some((u) => u.state === MIC_STATE.SILENT), 'never SILENT');
    assert.equal(check.result().state, MIC_STATE.FAILED);
    assert.equal(check.result().code, ERRORS.MIC_NOT_FOUND);
    assert.equal(check.result().meter?.dead, true);
    check.stop();
  } finally {
    restore();
  }
});

test('an unplug before the silence budget does not freeze on "say something"', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    track.end();
    assert.equal(updates.at(-1).state, MIC_STATE.FAILED);
    assert.equal(updates.at(-1).level, 0);
    await sleep(120);
    assert.equal(updates.at(-1).state, MIC_STATE.FAILED, 'the verdict stands');
    check.stop();
  } finally {
    restore();
  }
});

test('a clone that ends while the track stays live rebuilds the meter and keeps reading', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    assert.equal(track.clones.length, 1);

    const before = updates.length;
    track.clones[0].end();
    // The rebuild is deferred a microtask so the dying meter's final zero is not a reading.
    await sleep(0);
    assert.equal(track.clones.length, 2, 'a fresh clone for the replacement meter');
    assert.equal(check.result().meter?.dead, false, 'the live meter is the replacement');

    await sleep(150);
    const after = updates.slice(before);
    assert.ok(after.length >= 1, 'readings resume from the replacement meter');
    assert.ok(after.every((u) => u.state === MIC_STATE.QUIET), `only QUIET, got ${after.map((u) => u.state)}`);
    assert.notEqual(check.result().state, MIC_STATE.FAILED);
    check.stop();
  } finally {
    restore();
  }
});

test('a track acquired while Windows has it muted is OS_MUTED at once, and the budget starts at the unmute', async () => {
  const track = new FakeTrack('Headset');
  track.muted = true;
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle([MIC_STATE.OS_MUTED, MIC_STATE.QUIET, MIC_STATE.HEARING]);
    assert.equal(updates[0].state, MIC_STATE.CHECKING);
    // The verdict comes from the flag at acquisition, before the meter has said anything.
    assert.equal(updates[1].state, MIC_STATE.OS_MUTED);
    assert.equal(updates[1].label, 'Headset');
    assert.equal(check.result().state, MIC_STATE.OS_MUTED);
    assert.equal(check.result().trackMuted, true);

    // Muted for longer than the silence budget: still the mute, never the fallback.
    const realNow = Date.now;
    let offset = LOBBY_SILENT_MS + 1000;
    Date.now = () => realNow() + offset;
    await sleep(150);
    assert.ok(updates.every((u) => u.state !== MIC_STATE.SILENT), 'never SILENT while muted');
    assert.equal(updates.at(-1).state, MIC_STATE.OS_MUTED);

    // The key is released. The verdict changes on the event itself, not on the next tick.
    const before = updates.length;
    track.setMuted(false);
    assert.ok(updates.length > before, 'the unmute produced an update synchronously');
    assert.equal(updates.at(-1).state, MIC_STATE.QUIET, 'nothing heard yet: "say something"');

    // The budget runs from the unmute, not from acquisition: seven seconds after acquiring,
    // the device has been unmuted for a moment and must not be called silent yet ...
    await sleep(150);
    assert.equal(updates.at(-1).state, MIC_STATE.QUIET);
    assert.ok(updates.every((u) => u.state !== MIC_STATE.SILENT), 'no stale count inherited from before the mute');
    // ... and six seconds after the unmute, it is.
    offset += LOBBY_SILENT_MS;
    await waitForState(updates, [MIC_STATE.SILENT]);
    assert.equal(check.result().state, MIC_STATE.SILENT);
    check.stop();
  } finally {
    restore();
  }
});

test('a mute mid-check is OS_MUTED without waiting for a tick, and the unmute restores HEARING', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    // The person speaks; the latch sets.
    fakeSample = 0.3;
    await waitForState(updates, [MIC_STATE.HEARING]);
    fakeSample = 0;

    // Windows mutes the endpoint: Chromium flips the flag and fires `mute`.
    const before = updates.length;
    track.setMuted(true);
    assert.ok(updates.length > before, 'the mute produced an update synchronously');
    assert.equal(updates.at(-1).state, MIC_STATE.OS_MUTED, 'the OS mute outranks the HEARING latch');
    assert.equal(updates.at(-1).level, 0);
    await sleep(150);
    assert.equal(updates.at(-1).state, MIC_STATE.OS_MUTED, 'the ticks agree');
    assert.equal(check.result().state, MIC_STATE.OS_MUTED);

    track.setMuted(false);
    assert.equal(updates.at(-1).state, MIC_STATE.HEARING, 'speech was heard before the mute');
    await sleep(150);
    assert.equal(updates.at(-1).state, MIC_STATE.HEARING);
    assert.equal(check.result().state, MIC_STATE.HEARING);
    assert.equal(check.result().heard, true);
    check.stop();
  } finally {
    fakeSample = 0;
    restore();
  }
});

test('a mute event after the device is gone cannot revive the verdict', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    track.end();
    assert.equal(updates.at(-1).state, MIC_STATE.FAILED);
    const before = updates.length;
    track.setMuted(true);
    track.setMuted(false);
    assert.equal(updates.length, before, 'FAILED is final');
    assert.equal(check.result().state, MIC_STATE.FAILED);
    check.stop();
  } finally {
    restore();
  }
});

test('stop() silences the check for good, including a later end of the track', async () => {
  const track = new FakeTrack('Headset');
  const restore = installBrowser(track);
  try {
    const { check, updates } = await startAndSettle();
    check.stop();
    const before = updates.length;
    track.end();
    await sleep(120);
    assert.equal(updates.length, before, 'a stopped check says nothing more');
    assert.equal(track.readyState, 'ended', 'stop() released the track');
  } finally {
    restore();
  }
});
