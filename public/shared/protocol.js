/**
 * The signaling contract.
 *
 * This file is the single source of truth shared by the Node server and the browser client.
 * Both trees import from here; neither is allowed to write a message type or error code as a
 * string literal. That rule is the only thing preventing the two halves -- which are built
 * separately and share no other file -- from drifting into a protocol that almost matches.
 *
 * It must run unmodified in both runtimes: no `window`, no `process`, no imports. The lint
 * config gives public/shared/ no globals at all so a violation is caught rather than shipped.
 *
 * It lives under public/ for one blunt reason: the browser can only import what the static
 * server serves. A module doing `import '../../src/shared/protocol.js'` resolves to a URL
 * outside the static root and 404s, and the client would ship with a duplicated copy of these
 * constants -- exactly the drift this file exists to prevent.
 */

export const PROTOCOL_VERSION = 1;

/** Requested by the client on the WebSocket upgrade and echoed by the server. A client on a
 *  different version is rejected during the handshake, before any room state exists. */
export const SUBPROTOCOL = 'streamer.v1';

export const SIGNALING_PATH = '/ws';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** Client to server. */
export const C2S = Object.freeze({
  CREATE_ROOM: 'create-room',
  JOIN: 'join',
  LEAVE: 'leave',
  END: 'end',
  MUTE_STATE: 'mute-state',
  CLAIM_SHARE: 'claim-share',
  RELEASE_SHARE: 'release-share',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  PING: 'ping',
});

/** Server to client. */
export const S2C = Object.freeze({
  WELCOME: 'welcome',
  ROOM_CREATED: 'room-created',
  JOINED: 'joined',
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  PEER_MUTE_STATE: 'peer-mute-state',
  HOST_CHANGED: 'host-changed',

  /**
   * Directed to the promoted peer ONLY, never broadcast.
   *
   * `host-changed` goes to the whole room, so it must not carry the token: putting it in a
   * broadcast hands every participant the ability to reclaim host. Two messages instead of
   * one conditional payload keeps that impossible to get wrong by accident.
   */
  HOST_TOKEN: 'host-token',

  SHARE_STATE: 'share-state',
  SHARE_REVOKED: 'share-revoked',
  ROOM_ENDED: 'room-ended',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  ERROR: 'error',
  PONG: 'pong',
});

export const C2S_TYPES = Object.freeze(Object.values(C2S));
export const S2C_TYPES = Object.freeze(Object.values(S2C));

/**
 * Connection states. One socket carries at most one peer in at most one room for its entire
 * life; `leave` closes the socket rather than returning to UNJOINED. That costs a reconnect
 * (free) and removes every bug where a socket half-belongs to two rooms.
 */
export const STATE = Object.freeze({
  UNJOINED: 'unjoined',
  JOINED: 'joined',
  CLOSED: 'closed',
});

/** Which client messages are legal in which state. A message sent in the wrong state is a
 *  WRONG_STATE error rather than a silently ignored frame, so a confused client fails fast
 *  instead of waiting forever for a reply that is never coming. */
export const LEGAL_IN_STATE = Object.freeze({
  [C2S.CREATE_ROOM]: [STATE.UNJOINED],
  [C2S.JOIN]: [STATE.UNJOINED],
  [C2S.LEAVE]: [STATE.JOINED],
  [C2S.END]: [STATE.JOINED],
  [C2S.MUTE_STATE]: [STATE.JOINED],
  [C2S.CLAIM_SHARE]: [STATE.JOINED],
  [C2S.RELEASE_SHARE]: [STATE.JOINED],
  [C2S.OFFER]: [STATE.JOINED],
  [C2S.ANSWER]: [STATE.JOINED],
  [C2S.ICE_CANDIDATE]: [STATE.JOINED],
  [C2S.PING]: [STATE.UNJOINED, STATE.JOINED],
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every failure the user can encounter, from either side.
 *
 * Server codes travel in an `error` message. Client codes never reach the wire -- they are
 * produced locally from DOM exceptions and connection state -- but they live here so there
 * is exactly one list to keep in sync with the user-facing strings, and so a test can assert
 * that every code has a message.
 */
export const ERRORS = Object.freeze({
  // -- Protocol and validation (server) --
  INVALID_JSON: 'INVALID_JSON',
  INVALID_ENVELOPE: 'INVALID_ENVELOPE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  WRONG_STATE: 'WRONG_STATE',

  // -- Rooms and membership (server) --
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ENDED: 'ROOM_ENDED',
  ROOM_LIMIT: 'ROOM_LIMIT',
  NOT_HOST: 'NOT_HOST',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  NAME_INVALID: 'NAME_INVALID',
  ACCESS_CODE_REQUIRED: 'ACCESS_CODE_REQUIRED',
  ACCESS_CODE_INVALID: 'ACCESS_CODE_INVALID',

  // -- Screen share ownership (server) --
  SHARE_IN_PROGRESS: 'SHARE_IN_PROGRESS',

  // -- Abuse and capacity (server) --
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_BUSY: 'SERVER_BUSY',
  SLOW_CONSUMER: 'SLOW_CONSUMER',

  // -- Environment (client) --
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  BROWSER_UNSUPPORTED: 'BROWSER_UNSUPPORTED',

  // -- Microphone (client) --
  MIC_DENIED: 'MIC_DENIED',
  MIC_NOT_FOUND: 'MIC_NOT_FOUND',
  MIC_IN_USE: 'MIC_IN_USE',
  MIC_FAILED: 'MIC_FAILED',

  // -- Screen capture (client) --
  SHARE_CANCELLED: 'SHARE_CANCELLED',
  SHARE_UNSUPPORTED: 'SHARE_UNSUPPORTED',
  SHARE_FAILED: 'SHARE_FAILED',
  SHARE_REVOKED: 'SHARE_REVOKED',

  // -- Connectivity (client) --
  SIGNALING_DOWN: 'SIGNALING_DOWN',
  SIGNALING_DEAD: 'SIGNALING_DEAD',
  ICE_FAILED: 'ICE_FAILED',
});

/** Codes the server may put on the wire. Used by a test that proves the client can render
 *  every one of them. */
export const SERVER_ERROR_CODES = Object.freeze([
  ERRORS.INVALID_JSON,
  ERRORS.INVALID_ENVELOPE,
  ERRORS.UNSUPPORTED_VERSION,
  ERRORS.UNKNOWN_TYPE,
  ERRORS.INVALID_PAYLOAD,
  ERRORS.PAYLOAD_TOO_LARGE,
  ERRORS.WRONG_STATE,
  ERRORS.ROOM_NOT_FOUND,
  ERRORS.ROOM_FULL,
  ERRORS.ROOM_ENDED,
  ERRORS.ROOM_LIMIT,
  ERRORS.NOT_HOST,
  ERRORS.PEER_NOT_FOUND,
  ERRORS.NAME_INVALID,
  ERRORS.ACCESS_CODE_REQUIRED,
  ERRORS.ACCESS_CODE_INVALID,
  ERRORS.SHARE_IN_PROGRESS,
  ERRORS.RATE_LIMITED,
  ERRORS.SERVER_BUSY,
  ERRORS.SLOW_CONSUMER,
]);

/** WebSocket close codes. 4000+ is the private-use range. */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  LEFT: 4000,
  ROOM_ENDED: 4001,
  KICKED_RATE_LIMIT: 4002,
  PROTOCOL_ERROR: 4003,
  SERVER_SHUTDOWN: 4004,
  IDLE_TIMEOUT: 4005,
  VERSION_MISMATCH: 4006,
  SLOW_CONSUMER: 4007,
});

/**
 * Close codes after which the client must NOT reconnect.
 *
 * This set is load-bearing. `leave` closes the socket and `room-ended` closes every socket,
 * so a reconnector with no rule for distinguishing intentional closes from accidental ones
 * happily re-opens, re-joins a room that no longer exists, gets ROOM_NOT_FOUND, and replaces
 * the correct "The host ended the session" screen with a wrong "This room doesn't exist."
 * The terminal state the user was shown is the true one; reconnecting destroys it.
 */
export const TERMINAL_CLOSE_CODES = Object.freeze([
  CLOSE.NORMAL,
  CLOSE.LEFT,
  CLOSE.ROOM_ENDED,
  CLOSE.KICKED_RATE_LIMIT,
  CLOSE.PROTOCOL_ERROR,
  CLOSE.VERSION_MISMATCH,
]);

export function shouldReconnect(closeCode) {
  return !TERMINAL_CLOSE_CODES.includes(closeCode);
}

/** Why a peer disappeared, carried on `peer-left`. The UI wording differs: someone who left
 *  deliberately is not the same event as someone whose connection died. */
export const LEAVE_REASON = Object.freeze({
  LEFT: 'left',
  DISCONNECTED: 'disconnected',
  TIMEOUT: 'timeout',
  ROOM_ENDED: 'room-ended',
});

/** Why a room ended. */
export const END_REASON = Object.freeze({
  HOST_ENDED: 'host-ended',
  EMPTY: 'empty',
  IDLE: 'idle',
  SERVER_SHUTDOWN: 'server-shutdown',
});

/** Why an active share was taken away from its owner. */
export const REVOKE_REASON = Object.freeze({
  TAKEOVER: 'takeover',
  ROOM_ENDED: 'room-ended',
});

// ---------------------------------------------------------------------------
// Wire limits
// ---------------------------------------------------------------------------

/** Enforced by the server on every inbound frame, and applied by the client before sending
 *  so an oversized name is a form error rather than a disconnect. */
export const LIMITS = Object.freeze({
  MAX_MESSAGE_BYTES: 65_536,
  MAX_SDP_BYTES: 32_768,
  MAX_CANDIDATE_BYTES: 4_096,
  MAX_NAME_CHARS: 32,
  MAX_CORRELATION_ID_CHARS: 32,
  MAX_ROOM_ID_CHARS: 64,
  MAX_PEER_ID_CHARS: 64,
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Every frame in both directions:
 *   { v: 1, type: "join", id?: "c-7", ref?: "c-7", ts?: 1699999999999, data: {} }
 *
 * `id` is an optional client correlation id echoed back as `ref` on the direct reply and on
 * any error, which is what lets a client match a failure to the request that caused it.
 */
export function envelope(type, data = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, type, data, ...extra };
}

/**
 * Parse and structurally validate an inbound frame.
 * Returns `{ ok: true, message }` or `{ ok: false, code, detail }` -- never throws, because
 * every caller is a socket handler that must answer with an error frame rather than die.
 */
export function parseEnvelope(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, code: ERRORS.INVALID_ENVELOPE, detail: 'binary frames are not accepted' };
  }
  if (raw.length > LIMITS.MAX_MESSAGE_BYTES) {
    return { ok: false, code: ERRORS.PAYLOAD_TOO_LARGE, detail: 'message exceeds size limit' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: ERRORS.INVALID_JSON, detail: 'not valid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: ERRORS.INVALID_ENVELOPE, detail: 'envelope must be an object' };
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ERRORS.UNSUPPORTED_VERSION,
      detail: `expected protocol version ${PROTOCOL_VERSION}, got ${parsed.v}`,
    };
  }
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) {
    return { ok: false, code: ERRORS.INVALID_ENVELOPE, detail: 'type must be a non-empty string' };
  }

  // A missing `data` is treated as {}, but an array or primitive is a mistake worth naming.
  const data = parsed.data === undefined ? {} : parsed.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: ERRORS.INVALID_PAYLOAD, detail: 'data must be an object' };
  }

  if (parsed.id !== undefined) {
    if (typeof parsed.id !== 'string' || parsed.id.length > LIMITS.MAX_CORRELATION_ID_CHARS) {
      return { ok: false, code: ERRORS.INVALID_ENVELOPE, detail: 'id must be a short string' };
    }
  }

  return { ok: true, message: { v: parsed.v, type: parsed.type, id: parsed.id, data } };
}

// ---------------------------------------------------------------------------
// Shared field validation
// ---------------------------------------------------------------------------

/**
 * Display names are the only free text in the app.
 *
 * Trimmed, length-capped, and stripped of control characters so a name cannot break the
 * roster layout or smuggle line breaks into it. Filtering by code point rather than by a
 * character-class regex is deliberate: a regex for this range needs literal control
 * characters in the source, where they are invisible to review and trivially mangled by an
 * edit -- this file already had that bug once.
 *
 * Returns null for anything unusable, which callers surface as NAME_INVALID.
 */
export function normalizeName(value) {
  if (typeof value !== 'string') return null;

  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl) cleaned += char;
  }

  cleaned = cleaned.trim();
  if (cleaned.length === 0) return null;
  // Slice by code point, not by UTF-16 unit, so a cap never splits an emoji in half.
  return [...cleaned].slice(0, LIMITS.MAX_NAME_CHARS).join('');
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidRoomId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.MAX_ROOM_ID_CHARS &&
    ID_PATTERN.test(value)
  );
}

export function isValidPeerId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.MAX_PEER_ID_CHARS &&
    ID_PATTERN.test(value)
  );
}

// ---------------------------------------------------------------------------
// Share ownership
// ---------------------------------------------------------------------------

/**
 * Whether a `release-share` should be honoured.
 *
 * Both conditions matter, and the second is the one that is easy to omit. Ownership can time
 * out: if the previous sharer does not confirm a revoke within the timeout, the server hands
 * the share to the claimant anyway. A `release-share` that was in flight during that window
 * arrives late and, without the epoch check, tears down a share that now belongs to somebody
 * else -- who keeps transmitting to nobody while their UI says they are live.
 *
 * The epoch also covers the subtler case of a peer releasing a grant it has since re-acquired.
 */
export function isReleaseAuthorized({ senderId, currentSharerId, epoch, currentEpoch }) {
  return senderId === currentSharerId && epoch === currentEpoch;
}

/**
 * Whether a `share-state` broadcast should be applied by the client.
 * Broadcasts can arrive out of order; applying an older one would resurrect a finished share.
 */
export function isShareStateFresh(incomingEpoch, appliedEpoch) {
  if (!Number.isInteger(incomingEpoch)) return false;
  if (!Number.isInteger(appliedEpoch)) return true;
  return incomingEpoch > appliedEpoch;
}

/**
 * The full set of outcomes for a `claim-share`, resolved server-side.
 *
 * Written as a pure function so every branch is unit-testable without a socket, and so the
 * awkward cases cannot be quietly skipped by an implementation that only handles the two
 * obvious ones.
 *
 * `room` is `{ currentSharer, shareEpoch, pendingClaim }` where `pendingClaim` is
 * `{ claimantId, revokedId } | null`.
 */
export const CLAIM_OUTCOME = Object.freeze({
  GRANT: 'grant', // slot was free -> grant immediately, bump epoch, broadcast
  REVOKE_FIRST: 'revoke-first', // someone else owns it -> send share-revoked, arm the timer
  REJECT: 'reject', // owned and not forced, or a claim is already pending
  NOOP: 'noop', // the claimant already owns it
});

export function resolveClaim({ claimantId, force }, room) {
  // A redundant claim -- a double-clicked Share button -- must NOT bump the epoch. If it did,
  // the client's cached epoch would go stale, its later release-share would fail the epoch
  // guard, and the share slot would stay wedged for the life of the room.
  if (room.currentSharer === claimantId) return { outcome: CLAIM_OUTCOME.NOOP };

  // Only one takeover may be in flight. A second claimant arriving during the revoke window
  // would otherwise be granted the same slot by a second timer.
  if (room.pendingClaim) {
    return { outcome: CLAIM_OUTCOME.REJECT, code: ERRORS.SHARE_IN_PROGRESS };
  }

  if (room.currentSharer === null || room.currentSharer === undefined) {
    // force:true on a free slot is an ordinary claim, not an error.
    return { outcome: CLAIM_OUTCOME.GRANT };
  }

  if (!force) return { outcome: CLAIM_OUTCOME.REJECT, code: ERRORS.SHARE_IN_PROGRESS };

  return { outcome: CLAIM_OUTCOME.REVOKE_FIRST, revokedId: room.currentSharer };
}

/**
 * Whether an expired revoke timer may still hand the share to the waiting claimant.
 *
 * The epoch guard protects the release path; this protects the claim path, and omitting it
 * reintroduces the same bug one message over. Sequence: A is revoked for B, but A stops
 * sharing on its own before the timeout and the slot passes legitimately to C. When the timer
 * finally fires, granting B unconditionally evicts C -- who keeps transmitting while its UI
 * says it is live. The timer may only complete if the slot is still held by the peer it
 * revoked.
 */
export function canTimeoutGrant(room, pendingClaim) {
  return Boolean(pendingClaim) && room.currentSharer === pendingClaim.revokedId;
}

// ---------------------------------------------------------------------------
// ICE candidates
// ---------------------------------------------------------------------------

/**
 * End-of-candidates is encoded as `candidate: null`.
 *
 * Pinning this matters because the obvious alternative -- an object whose `candidate` string
 * is empty -- is what a strict "data.candidate must be an object" validator would demand, and
 * under that rule the final candidate of *every* peer connection is rejected as an invalid
 * payload. That turns a normal, universal part of ICE into an error toast on every connect.
 *
 * The server relays either form verbatim without interpreting it; the client passes
 * `init ?? undefined` to `addIceCandidate`, which is how the browser expects end-of-candidates.
 */
export function isEndOfCandidates(candidate) {
  return candidate === null || candidate === undefined || candidate.candidate === '';
}

export function isValidCandidatePayload(candidate) {
  if (candidate === null) return true; // end-of-candidates
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (typeof candidate.candidate !== 'string') return false;
  return JSON.stringify(candidate).length <= LIMITS.MAX_CANDIDATE_BYTES;
}

// ---------------------------------------------------------------------------
// Negotiation roles
// ---------------------------------------------------------------------------

/**
 * Which side of a pair creates the initial offer.
 *
 * The peer with the lower joinOrder offers -- whoever was already in the room offers to the
 * newcomer. joinOrder is a per-room counter that is never reused, so a tie is impossible.
 *
 * The server sends the answer as data (`youInitiate`, `polite`) rather than letting each
 * client compute it, because independent derivation is where asymmetry bugs come from: a
 * string-versus-numeric comparison on one side and not the other produces either two offers
 * or none, both of which look like a network problem. This function exists so the rule is
 * written down once and can be asserted in tests, not so clients call it at runtime.
 */
export function shouldInitiate(selfJoinOrder, otherJoinOrder) {
  return selfJoinOrder < otherJoinOrder;
}

/**
 * Politeness for Perfect Negotiation, used when both sides renegotiate at once -- which this
 * app can genuinely do, since any peer may start sharing at any moment.
 *
 * The polite peer yields on collision (rolls back and answers); the impolite peer ignores the
 * incoming offer and keeps its own. It is the inverse of the initiator role, so exactly one
 * side of every pair is polite, permanently, for the life of that pair.
 */
export function isPolite(selfJoinOrder, otherJoinOrder) {
  return !shouldInitiate(selfJoinOrder, otherJoinOrder);
}
