import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIAG_VERSION,
  DIAG_KIND,
  MAX_DIAG_BYTES,
  MAX_DUMP_BYTES,
  DUMP_CHUNK_BYTES,
  buildReport,
  parseReport,
  buildDumpRequest,
  chunkDump,
  parseControl,
  createDumpAssembler,
} from '../../public/js/rtc/diag-channel.js';

const fullInput = () => ({
  t: 1234,
  self: {
    micMuted: true,
    micState: 'live',
    micRms: 0.25,
    micLevel: 0.5,
    micPacketsPerSec: 50,
    meter: { contextState: 'running', dead: false },
  },
  hearing: {
    mic: { level: 0.1, rms: 0.2, packetsPerSec: 49, concealedPerSec: 1, trackMuted: false },
    shareAudio: { level: 0.3, rms: 0.4, packetsPerSec: 48, concealedPerSec: 0, trackMuted: true },
  },
  sink: { paused: false, readyState: 4, muted: false, volume: 0.9, playError: 'NotAllowedError' },
  incomingMutedForTest: true,
});

const chunk = (over = {}) =>
  JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.DUMP, id: 'x', i: 0, n: 1, data: 'd', ...over });

test('buildReport then parseReport round-trips every field', () => {
  const input = fullInput();
  const parsed = parseReport(buildReport(input));
  assert.deepEqual(parsed, input);
  assert.equal('v' in parsed, false);
  assert.equal('kind' in parsed, false);
});

test('buildReport stamps version and kind on the wire', () => {
  const raw = JSON.parse(buildReport());
  assert.equal(raw.v, DIAG_VERSION);
  assert.equal(raw.kind, DIAG_KIND.REPORT);
});

test('buildReport with no arguments yields a fixed shape of defaults', () => {
  const parsed = parseReport(buildReport());
  assert.deepEqual(parsed, {
    t: 0,
    self: {
      micMuted: false,
      micState: 'unknown',
      micRms: null,
      micLevel: null,
      micPacketsPerSec: null,
      meter: { contextState: null, dead: null },
    },
    hearing: { mic: null, shareAudio: null },
    sink: null,
    incomingMutedForTest: false,
  });
});

test('parseReport returns null for non-string, empty, and oversized input', () => {
  assert.equal(parseReport(undefined), null);
  assert.equal(parseReport(null), null);
  assert.equal(parseReport(42), null);
  assert.equal(parseReport({}), null);
  assert.equal(parseReport(''), null);
  const padded = JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.REPORT, pad: 'x'.repeat(MAX_DIAG_BYTES) });
  assert.ok(padded.length > MAX_DIAG_BYTES);
  assert.equal(parseReport(padded), null);
});

test('parseReport returns null for invalid JSON, arrays, and JSON primitives', () => {
  assert.equal(parseReport('{not json'), null);
  assert.equal(parseReport('[]'), null);
  assert.equal(parseReport('[1,2]'), null);
  assert.equal(parseReport('"report"'), null);
  assert.equal(parseReport('null'), null);
  assert.equal(parseReport('7'), null);
});

test('parseReport returns null for the wrong version or kind', () => {
  assert.equal(parseReport(JSON.stringify({ v: 2, kind: DIAG_KIND.REPORT })), null);
  assert.equal(parseReport(JSON.stringify({ v: '1', kind: DIAG_KIND.REPORT })), null);
  assert.equal(parseReport(JSON.stringify({ kind: DIAG_KIND.REPORT })), null);
  assert.equal(parseReport(JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.DUMP })), null);
  assert.equal(parseReport(JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.DUMP_REQUEST })), null);
  assert.equal(parseReport(JSON.stringify({ v: DIAG_VERSION })), null);
});

test('parseReport clamps unit values into [0,1] and nulls non-finite ones', () => {
  const frame = JSON.stringify({
    v: DIAG_VERSION,
    kind: DIAG_KIND.REPORT,
    self: { micRms: 5, micLevel: -3 },
    hearing: { mic: { level: 1.5, rms: -0.5 }, shareAudio: { level: 'x', rms: null } },
    sink: { volume: 99 },
  });
  const r = parseReport(frame);
  assert.equal(r.self.micRms, 1);
  assert.equal(r.self.micLevel, 0);
  assert.equal(r.hearing.mic.level, 1);
  assert.equal(r.hearing.mic.rms, 0);
  assert.equal(r.hearing.shareAudio.level, null);
  assert.equal(r.hearing.shareAudio.rms, null);
  assert.equal(r.sink.volume, 1);
});

test('parseReport nulls numbers that arrive as strings or are missing', () => {
  const r = parseReport(
    JSON.stringify({
      v: DIAG_VERSION,
      kind: DIAG_KIND.REPORT,
      t: 'now',
      self: { micRms: 'NaN', micPacketsPerSec: 'Infinity' },
      sink: { readyState: '4' },
    }),
  );
  assert.equal(r.t, 0);
  assert.equal(r.self.micRms, null);
  assert.equal(r.self.micPacketsPerSec, null);
  assert.equal(r.sink.readyState, null);
});

test('parseReport nulls negative rates but keeps zero and large positive rates', () => {
  const r = parseReport(
    JSON.stringify({
      v: DIAG_VERSION,
      kind: DIAG_KIND.REPORT,
      self: { micPacketsPerSec: -1 },
      hearing: { mic: { packetsPerSec: 0, concealedPerSec: -0.001 }, shareAudio: { packetsPerSec: 1e6 } },
    }),
  );
  assert.equal(r.self.micPacketsPerSec, null);
  assert.equal(r.hearing.mic.packetsPerSec, 0);
  assert.equal(r.hearing.mic.concealedPerSec, null);
  assert.equal(r.hearing.shareAudio.packetsPerSec, 1e6);
});

test('parseReport truncates strings to 32 characters and nulls non-strings', () => {
  const long = 'a'.repeat(100);
  const r = parseReport(
    JSON.stringify({
      v: DIAG_VERSION,
      kind: DIAG_KIND.REPORT,
      self: { micState: long, meter: { contextState: long } },
      sink: { playError: long },
    }),
  );
  assert.equal(r.self.micState, 'a'.repeat(32));
  assert.equal(r.self.meter.contextState, 'a'.repeat(32));
  assert.equal(r.sink.playError, 'a'.repeat(32));

  const r2 = parseReport(
    JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.REPORT, self: { micState: 7, meter: { contextState: {} } } }),
  );
  assert.equal(r2.self.micState, 'unknown');
  assert.equal(r2.self.meter.contextState, null);
});

test('parseReport coerces booleans strictly and drops unknown keys', () => {
  const r = parseReport(
    JSON.stringify({
      v: DIAG_VERSION,
      kind: DIAG_KIND.REPORT,
      extra: 1,
      self: { micMuted: 'yes', bogus: true, meter: { dead: 'true', junk: 1 } },
      hearing: { mic: { trackMuted: 1, other: 2 }, video: {} },
      sink: { paused: 0, secret: 'x' },
      incomingMutedForTest: 'no',
    }),
  );
  assert.equal('extra' in r, false);
  assert.equal('bogus' in r.self, false);
  assert.equal('junk' in r.self.meter, false);
  assert.equal('other' in r.hearing.mic, false);
  assert.equal('video' in r.hearing, false);
  assert.equal('secret' in r.sink, false);
  assert.equal(r.self.micMuted, true);
  assert.equal(r.self.meter.dead, null);
  assert.equal(r.hearing.mic.trackMuted, null);
  assert.equal(r.sink.paused, null);
  assert.equal(r.incomingMutedForTest, true);
  assert.deepEqual(Object.keys(r).sort(), ['hearing', 'incomingMutedForTest', 'self', 'sink', 't']);
});

test('parseReport treats non-object self, hearing, and sink as absent', () => {
  const r = parseReport(JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.REPORT, self: 'x', hearing: [], sink: 1 }));
  assert.equal(r.self.micState, 'unknown');
  assert.deepEqual(r.hearing, { mic: null, shareAudio: null });
  assert.equal(r.sink, null);
});

test('buildDumpRequest round-trips through parseControl and truncates the id', () => {
  assert.deepEqual(parseControl(buildDumpRequest('abc')), { kind: DIAG_KIND.DUMP_REQUEST, id: 'abc' });
  assert.deepEqual(parseControl(buildDumpRequest()), { kind: DIAG_KIND.DUMP_REQUEST, id: '' });
  assert.deepEqual(parseControl(buildDumpRequest(123)), { kind: DIAG_KIND.DUMP_REQUEST, id: '' });
  assert.equal(parseControl(buildDumpRequest('z'.repeat(50))).id, 'z'.repeat(32));
  const raw = JSON.parse(buildDumpRequest('q'));
  assert.equal(raw.v, DIAG_VERSION);
  assert.equal(raw.kind, DIAG_KIND.DUMP_REQUEST);
});

test('chunkDump splits at DUMP_CHUNK_BYTES with correct i and n', () => {
  const text = 'x'.repeat(DUMP_CHUNK_BYTES * 2 + 1);
  const frames = chunkDump(text, 'd1');
  assert.equal(frames.length, 3);
  const parsed = frames.map(parseControl);
  parsed.forEach((f, idx) => {
    assert.equal(f.kind, DIAG_KIND.DUMP);
    assert.equal(f.id, 'd1');
    assert.equal(f.i, idx);
    assert.equal(f.n, 3);
  });
  assert.equal(parsed[0].data.length, DUMP_CHUNK_BYTES);
  assert.equal(parsed[1].data.length, DUMP_CHUNK_BYTES);
  assert.equal(parsed[2].data.length, 1);
  assert.equal(parsed.map((f) => f.data).join(''), text);
});

test('chunkDump produces exactly one frame for a dump that fits in one chunk', () => {
  const frames = chunkDump('x'.repeat(DUMP_CHUNK_BYTES), 'one');
  assert.equal(frames.length, 1);
  const f = parseControl(frames[0]);
  assert.equal(f.i, 0);
  assert.equal(f.n, 1);
  assert.ok(frames[0].length <= DUMP_CHUNK_BYTES + 512);
});

test('chunkDump returns an empty array for empty, non-string, or oversized input', () => {
  assert.deepEqual(chunkDump('', 'a'), []);
  assert.deepEqual(chunkDump(undefined, 'a'), []);
  assert.deepEqual(chunkDump(123, 'a'), []);
  assert.deepEqual(chunkDump('x'.repeat(MAX_DUMP_BYTES + 1), 'a'), []);
  assert.equal(chunkDump('x'.repeat(MAX_DUMP_BYTES), 'a').length, Math.ceil(MAX_DUMP_BYTES / DUMP_CHUNK_BYTES));
});

test('chunkDump sanitizes the id', () => {
  assert.equal(parseControl(chunkDump('abc', 'i'.repeat(40))[0]).id, 'i'.repeat(32));
  assert.equal(parseControl(chunkDump('abc', {})[0]).id, '');
});

test('parseControl returns null for non-string, empty, oversized, invalid JSON, arrays, wrong version, unknown kind', () => {
  assert.equal(parseControl(undefined), null);
  assert.equal(parseControl(''), null);
  assert.equal(parseControl('x'.repeat(DUMP_CHUNK_BYTES + 513)), null);
  assert.equal(parseControl('{'), null);
  assert.equal(parseControl('[]'), null);
  assert.equal(parseControl('null'), null);
  assert.equal(parseControl(JSON.stringify({ v: 2, kind: DIAG_KIND.DUMP_REQUEST })), null);
  assert.equal(parseControl(JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.REPORT })), null);
  assert.equal(parseControl(JSON.stringify({ v: DIAG_VERSION, kind: 'nope' })), null);
});

test('parseControl accepts a well-formed chunk and rejects malformed index and count', () => {
  assert.deepEqual(parseControl(chunk()), { kind: DIAG_KIND.DUMP, id: 'x', i: 0, n: 1, data: 'd' });
  assert.equal(parseControl(chunk({ i: 1 })), null, 'i equal to n');
  assert.equal(parseControl(chunk({ i: 5, n: 2 })), null, 'i greater than n');
  assert.equal(parseControl(chunk({ n: 0 })), null, 'n below 1');
  assert.equal(parseControl(chunk({ i: -1, n: 2 })), null, 'negative i');
  assert.equal(parseControl(chunk({ i: 0.5, n: 2 })), null, 'non-integer i');
  assert.equal(parseControl(chunk({ i: '0' })), null, 'string i');
  assert.equal(parseControl(chunk({ n: '1' })), null, 'string n');
});

test('parseControl rejects chunks whose data is not a string or is too long', () => {
  assert.equal(parseControl(chunk({ data: 5 })), null);
  assert.equal(parseControl(chunk({ data: 'x'.repeat(DUMP_CHUNK_BYTES + 1) })), null);
  assert.notEqual(parseControl(chunk({ data: '' })), null, 'empty data is allowed');
});

test('parseControl rejects chunks whose count implies a dump larger than MAX_DUMP_BYTES', () => {
  const maxN = Math.floor(MAX_DUMP_BYTES / DUMP_CHUNK_BYTES) + 1;
  assert.notEqual(parseControl(chunk({ n: maxN })), null, 'largest acceptable n');
  assert.equal(parseControl(chunk({ n: maxN + 1 })), null, 'n too large');
  assert.equal(parseControl(chunk({ n: 1e9 })), null, 'absurd n');
});

test('parseControl sanitizes the chunk id', () => {
  assert.equal(parseControl(chunk({ id: 'q'.repeat(40) })).id, 'q'.repeat(32));
  assert.equal(parseControl(chunk({ id: undefined })).id, '');
  assert.equal(parseControl(chunk({ id: 9 })).id, '');
});

test('createDumpAssembler reassembles out-of-order chunks and returns null until complete', () => {
  const text = 'a'.repeat(DUMP_CHUNK_BYTES) + 'b'.repeat(DUMP_CHUNK_BYTES) + 'c'.repeat(10);
  const frames = chunkDump(text, 'dump1').map(parseControl);
  const asm = createDumpAssembler();
  assert.equal(asm.accept(frames[2]), null);
  assert.equal(asm.accept(frames[0]), null);
  assert.deepEqual(asm.accept(frames[1]), { id: 'dump1', text });
});

test('createDumpAssembler ignores duplicate chunks', () => {
  const frames = chunkDump('x'.repeat(DUMP_CHUNK_BYTES + 5), 'dup').map(parseControl);
  const asm = createDumpAssembler();
  assert.equal(asm.accept(frames[0]), null);
  assert.equal(asm.accept(frames[0]), null);
  assert.equal(asm.accept(frames[0]), null);
  assert.equal(asm.accept(frames[1]).text, 'x'.repeat(DUMP_CHUNK_BYTES + 5));
});

test('createDumpAssembler restarts when a chunk with a new id arrives', () => {
  const a = chunkDump('a'.repeat(DUMP_CHUNK_BYTES + 1), 'A').map(parseControl);
  const b = chunkDump('b'.repeat(DUMP_CHUNK_BYTES + 1), 'B').map(parseControl);
  const asm = createDumpAssembler();
  assert.equal(asm.accept(a[0]), null);
  assert.equal(asm.accept(b[1]), null);
  assert.equal(asm.accept(a[1]), null, 'the half-received A was discarded, so this starts a fresh A');
  assert.equal(asm.accept(a[0]).text, 'a'.repeat(DUMP_CHUNK_BYTES + 1));
});

test('createDumpAssembler restarts when the chunk count changes for the same id', () => {
  const asm = createDumpAssembler();
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP, id: 'S', i: 0, n: 2, data: 'p' }), null);
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP, id: 'S', i: 0, n: 3, data: 'q' }), null);
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP, id: 'S', i: 1, n: 3, data: 'r' }), null);
  assert.deepEqual(asm.accept({ kind: DIAG_KIND.DUMP, id: 'S', i: 2, n: 3, data: 's' }), { id: 'S', text: 'qrs' });
});

test('createDumpAssembler ignores non-dump frames and can be reset', () => {
  const asm = createDumpAssembler();
  assert.equal(asm.accept(null), null);
  assert.equal(asm.accept(undefined), null);
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP_REQUEST, id: 'x' }), null);
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP, id: 'R', i: 0, n: 2, data: 'p' }), null);
  asm.reset();
  assert.equal(asm.accept({ kind: DIAG_KIND.DUMP, id: 'R', i: 1, n: 2, data: 'q' }), null, 'reset forgot the first chunk');
  assert.deepEqual(asm.accept({ kind: DIAG_KIND.DUMP, id: 'R', i: 0, n: 2, data: 'p' }), { id: 'R', text: 'pq' });
});

test('createDumpAssembler completes a single-chunk dump immediately and is reusable afterwards', () => {
  const asm = createDumpAssembler();
  assert.deepEqual(asm.accept({ kind: DIAG_KIND.DUMP, id: 'one', i: 0, n: 1, data: 'hello' }), { id: 'one', text: 'hello' });
  assert.deepEqual(asm.accept({ kind: DIAG_KIND.DUMP, id: 'two', i: 0, n: 1, data: 'again' }), { id: 'two', text: 'again' });
});

test('createDumpAssembler returns null when the reassembled dump exceeds MAX_DUMP_BYTES', () => {
  const asm = createDumpAssembler();
  const n = Math.ceil(MAX_DUMP_BYTES / DUMP_CHUNK_BYTES) + 1;
  let out = null;
  for (let i = 0; i < n; i++) {
    out = asm.accept({ kind: DIAG_KIND.DUMP, id: 'big', i, n, data: 'x'.repeat(DUMP_CHUNK_BYTES) });
  }
  assert.equal(out, null);
});
