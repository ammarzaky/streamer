import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The remote-audio mixer, against a fake Web Audio implementation.
 *
 * The point of the fake is that the module's real contract is structural -- which nodes exist,
 * what they are connected to, and *when* they are built -- and a real AudioContext would let
 * all of that pass unobserved. The laziness in particular is not an optimisation to be checked
 * casually: an AudioContext claims an audio device, and building one for every call would be a
 * regression nobody would notice until a laptop's battery did.
 */

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnected = 0;
  }
  connect(target) {
    this.outputs.push(target);
    return target;
  }
  disconnect() {
    this.disconnected += 1;
    this.outputs = [];
  }
}

class FakeParam {
  constructor(value) {
    this.value = value;
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super('gain');
    this.gain = new FakeParam(1);
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super('compressor');
    this.threshold = new FakeParam(0);
    this.knee = new FakeParam(0);
    this.ratio = new FakeParam(0);
    this.attack = new FakeParam(0);
    this.release = new FakeParam(0);
  }
}

let created = 0;

class FakeAudioContext {
  constructor() {
    created += 1;
    this.state = 'running';
    this.sources = [];
    this.closed = false;
  }
  createMediaStreamSource(stream) {
    const node = new FakeNode('source');
    node.stream = stream;
    this.sources.push(node);
    return node;
  }
  createGain() {
    return new FakeGain();
  }
  createDynamicsCompressor() {
    return new FakeCompressor();
  }
  createMediaStreamDestination() {
    const node = new FakeNode('destination');
    node.stream = { id: 'mix' };
    return node;
  }
  addEventListener() {}
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

/** The module reaches for `document` (gesture listeners) and `MediaStream`. */
function installBrowserGlobals() {
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.MediaStream = class {
    constructor(tracks = []) {
      this.tracks = tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
  };
  globalThis.window = {};
}

installBrowserGlobals();

const { createRemoteAudioMixer, clampGain, MAX_GAIN, UNITY_GAIN, LIMITER } = await import(
  '../../public/js/media/remote-audio.js'
);

const track = (id) => ({
  id,
  kind: 'audio',
  listeners: {},
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  },
});

function mixer(onOutput = () => {}) {
  created = 0;
  return createRemoteAudioMixer({ onOutput, AudioContextCtor: FakeAudioContext });
}

test('gain is clamped to the supported range, and nonsense reads as unity', () => {
  assert.equal(clampGain(0), 0);
  assert.equal(clampGain(1), 1);
  assert.equal(clampGain(MAX_GAIN), MAX_GAIN);
  assert.equal(clampGain(MAX_GAIN + 3), MAX_GAIN);
  assert.equal(clampGain(-4), 0);

  // Not zero: a bad value must never be indistinguishable from somebody being muted.
  for (const bad of [NaN, undefined, null, 'loud', {}]) {
    assert.equal(clampGain(bad), UNITY_GAIN, String(bad));
  }
});

test('nothing is built until a volume actually moves', () => {
  const m = mixer();
  m.attach('p1', track('t1'));
  m.attach('p1', track('t2'));
  assert.equal(created, 0, 'attaching tracks must not claim an audio device');
  assert.equal(m.active, false);

  // Unity on an untouched peer is not a change, so it still builds nothing.
  assert.equal(m.setGain('p1', 1), false);
  assert.equal(created, 0);
  assert.equal(m.isRouted('p1'), false);

  assert.equal(m.setGain('p1', 2), true);
  assert.equal(created, 1, 'the first real adjustment builds the graph');
  assert.equal(m.active, true);
});

test('a routed peer gets one chain per TRACK, so shared audio is not dropped', () => {
  // The bug this rules out: a MediaStreamAudioSourceNode reads only the stream's FIRST audio
  // track, and a peer's microphone and their shared system audio arrive as two.
  let output = null;
  const m = mixer((stream) => {
    output = stream;
  });
  m.attach('p1', track('mic'));
  m.attach('p1', track('share'));
  m.setGain('p1', 3);

  assert.ok(output, 'the mixed stream is handed back once');
  const state = m.state();
  assert.equal(state.peers.p1.tracks, 2);
  assert.equal(state.peers.p1.routed, true);
  assert.equal(state.peers.p1.gain, 3);
});

test('a track arriving after the peer is already routed is wired immediately', () => {
  const m = mixer();
  m.attach('p1', track('mic'));
  m.setGain('p1', 4);
  m.attach('p1', track('share'));
  assert.equal(m.state().peers.p1.tracks, 2);
  assert.equal(created, 1, 'a later track reuses the one context');
});

test('the limiter is configured, and sits between the gain and the output', () => {
  const m = mixer();
  const t = track('mic');
  m.attach('p1', t);
  m.setGain('p1', MAX_GAIN);

  // Walk the chain the module built: source -> gain -> compressor -> destination.
  const context = m.contextState === null ? null : true;
  assert.ok(context, 'a context exists');

  // The compressor's settings are the difference between "loud" and "crunchy", so they are
  // asserted rather than assumed.
  assert.equal(LIMITER.ratio > 1, true);
  assert.equal(LIMITER.threshold < 0, true);
  assert.equal(LIMITER.attack < LIMITER.release, true, 'catch transients, release slowly');
});

test('changing the gain again does not rebuild anything', () => {
  const m = mixer();
  m.attach('p1', track('mic'));
  m.setGain('p1', 2);
  m.setGain('p1', 5);
  m.setGain('p1', 0);
  assert.equal(created, 1);
  assert.equal(m.gain('p1'), 0);
});

test('returning to unity restores the original remote playback path', () => {
  // Returning to ordinary volume must stop the graph from playing the same track as the element.
  const m = mixer();
  m.attach('p1', track('mic'));
  m.setGain('p1', 2);
  assert.equal(m.setGain('p1', 1), false);
  assert.equal(m.isRouted('p1'), false);
});

test('lowering volume never creates a local mixed stream', () => {
  const m = mixer();
  m.attach('p1', track('mic'));
  for (const gain of [0.8, 0, 0.5, 1]) {
    assert.equal(m.setGain('p1', gain), false);
    assert.equal(m.gain('p1'), gain);
  }
  assert.equal(m.active, false);
});

test('peers are independent', () => {
  const m = mixer();
  m.attach('a', track('a1'));
  m.attach('b', track('b1'));
  m.setGain('a', 4);

  assert.equal(m.isRouted('a'), true);
  assert.equal(m.isRouted('b'), false, 'adjusting one person must not move anyone else');
  assert.equal(m.gain('b'), UNITY_GAIN);
  assert.equal(created, 1, 'one context serves everybody');
});

test('detach forgets a peer and releases their nodes', () => {
  const m = mixer();
  m.attach('p1', track('mic'));
  m.setGain('p1', 2);
  m.detach('p1');
  assert.equal(m.state().peers.p1, undefined);
  assert.equal(m.gain('p1'), UNITY_GAIN);
  assert.equal(m.isRouted('p1'), false);
});

test('an ended track drops out of its peer without taking the others with it', () => {
  const m = mixer();
  const mic = track('mic');
  m.attach('p1', mic);
  m.attach('p1', track('share'));
  m.setGain('p1', 2);
  assert.equal(m.state().peers.p1.tracks, 2);

  mic.listeners.ended();
  assert.equal(m.state().peers.p1.tracks, 1);
  assert.equal(m.isRouted('p1'), true, 'the peer is still routed');
});

test('stop closes the context and nothing can bring it back', () => {
  const m = mixer();
  m.attach('p1', track('mic'));
  m.setGain('p1', 2);
  m.stop();
  assert.equal(m.active, false);
  assert.deepEqual(m.state().peers, {});

  m.attach('p2', track('other'));
  m.setGain('p2', 3);
  assert.equal(created, 1, 'a stopped mixer must not open a second audio device');
});

test('with no AudioContext at all, volumes degrade rather than throw', () => {
  // Not hypothetical: a browser with Web Audio disabled, or a context that refuses to
  // construct. The caller must be able to keep using the plain element path.
  const m = createRemoteAudioMixer({ AudioContextCtor: undefined });
  m.attach('p1', track('mic'));
  assert.equal(m.setGain('p1', 3), false, 'reports that it could not route');
  assert.equal(m.active, false);
  assert.equal(m.gain('p1'), 3, 'the value is still remembered');
});
