/**
 * The desktop invite link.
 *
 * A browser participant gets `https://<host>:<port>/r/<roomId>` and clicks through a
 * certificate warning. A desktop participant gets this instead:
 *
 *   streamer://join?h=<host>:<port>&r=<roomId>&fp=<base64url sha256>
 *
 * The extra field is the whole point. Carrying the certificate's SHA-256 in the invite means the
 * joining app can trust exactly one certificate for exactly one address -- no CA to install, no
 * warning to dismiss, and nothing written to disk, so the project's zero-storage rule survives.
 *
 * It is also strictly stronger than what it replaces: clicking through a browser warning accepts
 * whatever certificate is presented, while a pinned digest accepts one key and refuses every
 * other. The link is not a secret -- the room id already is -- so putting the digest in it costs
 * nothing.
 *
 * Pure module: no Electron, no Node, no DOM. Both the main process and the renderer pages import
 * it, and it is unit-tested directly.
 */

export const PROTOCOL = 'streamer';
export const INVITE_HOSTNAME = 'join';

/** Room ids are the access control for this app, so the shape is checked, not assumed. */
const ROOM_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class InviteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InviteError';
  }
}

/**
 * Normalise a SHA-256 digest to lowercase hex with no separators.
 *
 * Three spellings of the same value are all in circulation: Node's `X509Certificate
 * .fingerprint256` uses colon-separated uppercase hex, Electron's `certificate.fingerprint` uses
 * `sha256/<base64>`, and a person copying from a terminal may paste either with stray spaces.
 * Comparing any two of those as strings silently never matches -- and a pin that never matches
 * is a pin that gets removed by whoever debugs it next.
 */
export function normalizeFingerprint(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InviteError('fingerprint is missing');
  }

  const raw = value.trim();

  // Each form is recognised by its own full shape and only then rewritten. Stripping separators
  // up front looks tidier and is wrong: '-' is a separator in AA-BB-CC hex and a data character
  // in base64url, so a single pre-pass silently corrupts every link-borne digest -- which then
  // fails to match a certificate that is in fact correct.

  // Electron's certificate object: "sha256/BASE64".
  if (/^sha256\//i.test(raw)) return decodeDigest(raw.slice('sha256/'.length));

  // Separated hex, as printed by OpenSSL and Node's fingerprint256.
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){31}$/i.test(raw)) {
    return raw.replace(/[:-]/g, '').toLowerCase();
  }

  // Bare hex.
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();

  // Base64 or base64url, as carried in the link itself.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return decodeDigest(raw);

  throw new InviteError('fingerprint is not a SHA-256 digest');
}

function decodeDigest(encoded) {
  const bytes = base64ToBytes(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  if (bytes.length !== 32) throw new InviteError('fingerprint is not a SHA-256 digest');
  return bytesToHex(bytes);
}

/** The compact base64url spelling used inside the link. */
export function fingerprintToLink(value) {
  return bytesToBase64Url(hexToBytes(normalizeFingerprint(value)));
}

/**
 * Build the invite link.
 * @param {{host: string, port: number, roomId: string, fingerprint: string}} params
 */
export function formatInvite({ host, port, roomId, fingerprint }) {
  const cleanHost = String(host ?? '').trim();
  if (!cleanHost) throw new InviteError('host is missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InviteError(`port ${port} is not a valid port`);
  }
  if (!ROOM_ID.test(String(roomId ?? ''))) throw new InviteError('room id is malformed');

  // Bracket a bare IPv6 literal so host:port stays unambiguous.
  const authority = cleanHost.includes(':') && !cleanHost.startsWith('[')
    ? `[${cleanHost}]:${port}`
    : `${cleanHost}:${port}`;

  const query = new URLSearchParams({
    h: authority,
    r: roomId,
    fp: fingerprintToLink(fingerprint),
  });
  return `${PROTOCOL}://${INVITE_HOSTNAME}?${query.toString()}`;
}

/**
 * Parse an invite link into its parts, throwing InviteError with a message worth showing.
 *
 * Accepts the `streamer://` form and, because chat clients mangle custom protocols into plain
 * text often enough to be the normal case rather than the exception, a pasted `https://` room URL
 * as well. The https form has no fingerprint, which the caller must treat as "cannot pin" rather
 * than "trust anything" -- so it is reported explicitly instead of defaulting to null.
 *
 * @returns {{host: string, port: number, roomId: string, fingerprint: string|null, pinned: boolean}}
 */
export function parseInvite(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new InviteError('the link is empty');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InviteError('that does not look like a link');
  }

  if (url.protocol === `${PROTOCOL}:`) return parseStreamerUrl(url);
  if (url.protocol === 'https:') return parseHttpsUrl(url);

  throw new InviteError(`unsupported link type "${url.protocol.replace(':', '')}"`);
}

function parseStreamerUrl(url) {
  // `streamer://join?...` is not a special-scheme URL, so the WHATWG parser puts "join" in
  // `hostname` and leaves `pathname` empty -- but some environments hand back "//join" instead.
  // Accepting either keeps the check meaningful without being brittle about it.
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== INVITE_HOSTNAME) throw new InviteError(`unknown action "${action}"`);

  const params = url.searchParams;
  const authority = params.get('h');
  const roomId = params.get('r');
  const fp = params.get('fp');

  if (!authority) throw new InviteError('the link has no address');
  if (!roomId) throw new InviteError('the link has no room');
  if (!fp) throw new InviteError('the link has no certificate fingerprint');

  const { host, port } = splitAuthority(authority);
  if (!ROOM_ID.test(roomId)) throw new InviteError('the room id in the link is malformed');

  return { host, port, roomId, fingerprint: normalizeFingerprint(fp), pinned: true };
}

function parseHttpsUrl(url) {
  const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new InviteError('that https link does not point at a room');

  return {
    host: stripBrackets(url.hostname),
    port: url.port ? Number(url.port) : 443,
    roomId: match[1],
    fingerprint: null,
    pinned: false,
  };
}

function splitAuthority(authority) {
  // Bracketed IPv6 first, since an unbracketed split on ':' would shred it.
  const bracketed = authority.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };

  const index = authority.lastIndexOf(':');
  if (index === -1) throw new InviteError('the address in the link has no port');

  const host = authority.slice(0, index);
  const port = Number(authority.slice(index + 1));
  if (!host) throw new InviteError('the address in the link has no host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InviteError('the address in the link has an invalid port');
  }
  return { host: stripBrackets(host), port };
}

const stripBrackets = (host) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/**
 * The page URL an invite points at. Kept here so the format is defined in exactly one place.
 *
 * The default port is omitted rather than written out. `https://host:443/...` is valid and every
 * browser normalises it away, but it survives into anything that treats the string as text -- a
 * link someone reads out, a chat preview -- looking like a mistake. It also matters for the
 * WebSocket same-origin check, which compares an Origin header the browser has already normalised
 * against a Host header we would rather not have to normalise ourselves.
 */
export function roomUrl({ host, port, roomId }) {
  const authority = host.includes(':') ? `[${host}]` : host;
  const suffix = Number(port) === 443 ? '' : `:${port}`;
  return `https://${authority}${suffix}/r/${roomId}`;
}

/** The plain link to hand to someone joining from a browser. */
export function browserInvite({ host, port, roomId }) {
  return roomUrl({ host, port, roomId });
}

// ---------------------------------------------------------------------------
// Encoding helpers, written without Buffer or atob so this stays runtime-neutral
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(input) {
  const clean = input.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new InviteError('fingerprint is not valid base64');

  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (chunk[0] << 16) | ((chunk[1] ?? 0) << 8) | (chunk[2] ?? 0);
    const glyphs = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63];
    const keep = chunk[1] === undefined ? 2 : chunk[2] === undefined ? 3 : 4;
    out += glyphs.slice(0, keep).map((g) => B64[g]).join('');
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

const bytesToHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
