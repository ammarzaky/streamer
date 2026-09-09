/**
 * Diagnostics between peers, over an RTCDataChannel -- never over signaling.
 *
 * The question "can he hear me?" can only be answered by the other side, and the other side is
 * a non-expert who is not going to paste a diagnostics blob into a chat. So each peer sends a
 * small report once a second on a data channel that rides the same peer connection as the media:
 * what it is receiving from us, and whether its audio element is actually playing. The host's
 * "Copy diagnostics" can also ask a peer for its whole dump and embed it.
 *
 * Deliberately not a signaling message: the control-message bucket refills at one token a
 * second (config.default.json signaling.rateLimit), and telemetry has no business in a protocol
 * whose every type is validated, documented and audited. The message inventory in
 * public/shared/protocol.js is unchanged by this file.
 *
 * Everything received here is untrusted input from another browser. `parseReport` and the dump
 * assembler are strict: wrong version, wrong shape, oversized, non-finite -- all of it is null.
 *
 * Pure: no RTCPeerConnection here. peer.js owns the channels; this file owns the wire format.
 */

export const DIAG_LABEL = 'diag';
export const DUMP_LABEL = 'diag-dump';
export const DIAG_VERSION = 1;

/** One report, one frame. Anything larger is dropped rather than read. */
export const MAX_DIAG_BYTES = 2048;
/** A whole diagnostics dump, reassembled. */
export const MAX_DUMP_BYTES = 65_536;
/** SCTP is happiest with frames well under 16 KB. */
export const DUMP_CHUNK_BYTES = 12_000;

export const DIAG_KIND = Object.freeze({ REPORT: 'report', DUMP_REQUEST: 'dump-request', DUMP: 'dump' });

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
const nonNegative = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
/** Playback gain: 0..5, the range the volume slider offers. */
const gainValue = (value) => (Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : null);
const shortString = (value, max = 32) => (typeof value === 'string' ? value.slice(0, max) : null);
const bool = (value) => (typeof value === 'boolean' ? value : null);

function hearingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    level: clamp01(entry.level),
    rms: clamp01(entry.rms),
    packetsPerSec: nonNegative(entry.packetsPerSec),
    concealedPerSec: nonNegative(entry.concealedPerSec),
    trackMuted: bool(entry.trackMuted),
  };
}

function normalizeReport(raw) {
  const self = raw.self && typeof raw.self === 'object' ? raw.self : {};
  const hearing = raw.hearing && typeof raw.hearing === 'object' ? raw.hearing : {};
  const sink = raw.sink && typeof raw.sink === 'object' ? raw.sink : null;
  return {
    v: DIAG_VERSION,
    kind: DIAG_KIND.REPORT,
    t: Number.isFinite(raw.t) ? raw.t : 0,
    self: {
      micMuted: Boolean(self.micMuted),
      micState: shortString(self.micState) ?? 'unknown',
      micRms: clamp01(self.micRms),
      micLevel: clamp01(self.micLevel),
      micPacketsPerSec: nonNegative(self.micPacketsPerSec),
      meter: {
        contextState: shortString(self.meter?.contextState),
        dead: bool(self.meter?.dead),
      },
    },
    hearing: {
      mic: hearingEntry(hearing.mic),
      shareAudio: hearingEntry(hearing.shareAudio),
    },
    sink: sink
      ? {
          paused: bool(sink.paused),
          readyState: Number.isFinite(sink.readyState) ? sink.readyState : null,
          muted: bool(sink.muted),
          volume: clamp01(sink.volume),
          // A separate field with its own ceiling, NOT folded into `volume`: the element's
          // volume is 0..1 by specification and clamping a 5x boost into it would report "1"
          // for both "as they sent it" and "five times louder", which is the one distinction a
          // reader of this report would want.
          gain: gainValue(sink.gain),
          outputVia: sink.outputVia === 'webaudio' ? 'webaudio' : 'element',
          playError: shortString(sink.playError),
        }
      : null,
    incomingMutedForTest: Boolean(raw.incomingMutedForTest),
  };
}

/**
 * Build the once-a-second report. Every field is optional on input; the output shape is fixed.
 *
 *   self     what this side is doing with its own microphone
 *   hearing  what this side receives from the peer it is sending to, by role
 *   sink     the state of the <audio> element this side plays that peer through
 */
export function buildReport({ t, self = {}, hearing = {}, sink = null, incomingMutedForTest = false } = {}) {
  return JSON.stringify(normalizeReport({ t, self, hearing, sink, incomingMutedForTest }));
}

/** Parse a report frame from the wire. Null for anything that is not exactly a report. */
export function parseReport(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DIAG_BYTES) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== DIAG_VERSION || raw.kind !== DIAG_KIND.REPORT) return null;
  const report = normalizeReport(raw);
  delete report.v;
  delete report.kind;
  return report;
}

// ---------------------------------------------------------------------------
// Dumps: a whole diagnostics blob, requested by one side and chunked by the other
// ---------------------------------------------------------------------------

export function buildDumpRequest(id) {
  return JSON.stringify({ v: DIAG_VERSION, kind: DIAG_KIND.DUMP_REQUEST, id: shortString(id) ?? '' });
}

/**
 * Split a dump into ordered frames. Returns [] rather than throwing when the dump is too big:
 * a dump that cannot be sent is a diagnostic failure, not an application error.
 */
export function chunkDump(text, id) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DUMP_BYTES) return [];
  const safeId = shortString(id) ?? '';
  const frames = [];
  const n = Math.ceil(text.length / DUMP_CHUNK_BYTES);
  for (let i = 0; i < n; i++) {
    frames.push(
      JSON.stringify({
        v: DIAG_VERSION,
        kind: DIAG_KIND.DUMP,
        id: safeId,
        i,
        n,
        data: text.slice(i * DUMP_CHUNK_BYTES, (i + 1) * DUMP_CHUNK_BYTES),
      }),
    );
  }
  return frames;
}

/** Parse a control frame (dump request or dump chunk). Null for anything else. */
export function parseControl(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > DUMP_CHUNK_BYTES + 512) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== DIAG_VERSION) return null;
  if (raw.kind === DIAG_KIND.DUMP_REQUEST) {
    return { kind: DIAG_KIND.DUMP_REQUEST, id: shortString(raw.id) ?? '' };
  }
  if (raw.kind === DIAG_KIND.DUMP) {
    if (!Number.isInteger(raw.i) || !Number.isInteger(raw.n) || raw.n < 1 || raw.i < 0 || raw.i >= raw.n) {
      return null;
    }
    if (typeof raw.data !== 'string' || raw.data.length > DUMP_CHUNK_BYTES) return null;
    // More chunks than a maximal dump needs is an oversized dump, refused before buffering.
    if (raw.n > Math.ceil(MAX_DUMP_BYTES / DUMP_CHUNK_BYTES)) return null;
    return { kind: DIAG_KIND.DUMP, id: shortString(raw.id) ?? '', i: raw.i, n: raw.n, data: raw.data };
  }
  return null;
}

/**
 * Reassemble dump chunks. One assembler per peer; a new id discards a half-received old one.
 * `accept` returns `{id, text}` when the last chunk lands, otherwise null.
 */
export function createDumpAssembler() {
  let current = null;
  return {
    accept(frame) {
      if (!frame || frame.kind !== DIAG_KIND.DUMP) return null;
      if (!current || current.id !== frame.id || current.n !== frame.n) {
        current = { id: frame.id, n: frame.n, parts: new Array(frame.n).fill(null), received: 0 };
      }
      if (current.parts[frame.i] === null) current.received++;
      current.parts[frame.i] = frame.data;
      if (current.received < current.n) return null;
      const text = current.parts.join('');
      current = null;
      if (text.length > MAX_DUMP_BYTES) return null;
      return { id: frame.id, text };
    },
    reset() {
      current = null;
    },
  };
}
