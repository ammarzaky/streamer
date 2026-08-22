import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

import {
  formatInvite,
  parseInvite,
  normalizeFingerprint,
  fingerprintToLink,
  browserInvite,
  roomUrl,
  InviteError,
} from '../../desktop/shared/invite.js';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ROOM = 'AbCd1234_-xyz';

test('an invite round-trips through format and parse', () => {
  const link = formatInvite({ host: '192.168.1.34', port: 8443, roomId: ROOM, fingerprint: HEX });
  const parsed = parseInvite(link);

  assert.equal(parsed.host, '192.168.1.34');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.roomId, ROOM);
  assert.equal(parsed.fingerprint, HEX);
  assert.equal(parsed.pinned, true);
});

test('all three spellings of a SHA-256 digest normalise to the same value', () => {
  // Node's X509Certificate gives colon-separated uppercase hex; Electron's certificate object
  // gives "sha256/<base64>"; the link carries base64url. Comparing any two of those as strings
  // silently never matches -- and a pin that never matches is a pin someone deletes.
  const colonUpper = HEX.toUpperCase().match(/../g).join(':');
  const base64 = `sha256/${Buffer.from(HEX, 'hex').toString('base64')}`;
  const base64url = fingerprintToLink(HEX);

  assert.equal(normalizeFingerprint(colonUpper), HEX);
  assert.equal(normalizeFingerprint(base64), HEX);
  assert.equal(normalizeFingerprint(base64url), HEX);
  assert.equal(normalizeFingerprint(HEX), HEX);
  assert.equal(normalizeFingerprint(`  ${colonUpper}  `), HEX);
});

test('a digest of the wrong length is rejected rather than padded', () => {
  const short = `sha256/${Buffer.from('00'.repeat(16), 'hex').toString('base64')}`;
  assert.throws(() => normalizeFingerprint(short), InviteError);
  assert.throws(() => normalizeFingerprint('a1b2c3'), InviteError);
  assert.throws(() => normalizeFingerprint(''), InviteError);
  assert.throws(() => normalizeFingerprint(null), InviteError);
});

test('a real certificate fingerprint survives the round trip', () => {
  // Guards the boundary this codec exists for. A hand-written PEM constant would only prove the
  // codec agrees with itself, so this builds a certificate the same way the app does and checks
  // that what Node reports for it comes back byte-identical through the link -- and that it
  // equals an independently computed digest of the DER, not just whatever we put in.
  const cert = new X509Certificate(throwawayCertPem());
  const link = formatInvite({
    host: 'localhost',
    port: 8443,
    roomId: ROOM,
    fingerprint: cert.fingerprint256,
  });

  const expected = createHash('sha256').update(cert.raw).digest('hex');
  assert.equal(parseInvite(link).fingerprint, expected);

  // And Electron's spelling of the same certificate lands on the same value, which is the
  // comparison the pinning check actually performs at runtime.
  const electronForm = `sha256/${createHash('sha256').update(cert.raw).digest('base64')}`;
  assert.equal(normalizeFingerprint(electronForm), expected);
});

test('an IPv6 host survives bracketing in both directions', () => {
  const link = formatInvite({ host: '::1', port: 8443, roomId: ROOM, fingerprint: HEX });
  assert.match(link, /h=%5B%3A%3A1%5D%3A8443/);

  const parsed = parseInvite(link);
  assert.equal(parsed.host, '::1');
  assert.equal(parsed.port, 8443);
});

test('a pasted https room link parses, and reports that it cannot be pinned', () => {
  // Chat clients mangle custom protocols often enough that this is the normal path, not the
  // exception. It must be usable -- and it must say plainly that there is no fingerprint, rather
  // than handing back a null the caller might read as "no pinning required".
  const parsed = parseInvite(`https://192.168.1.34:8443/r/${ROOM}`);

  assert.equal(parsed.host, '192.168.1.34');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.roomId, ROOM);
  assert.equal(parsed.fingerprint, null);
  assert.equal(parsed.pinned, false);
});

test('malformed links fail with a message worth showing', () => {
  const cases = [
    ['', /empty/i],
    ['not a link', /does not look like a link/i],
    ['ftp://host:1/r/x', /unsupported link type/i],
    ['streamer://leave?h=a:1&r=' + ROOM + '&fp=' + HEX, /unknown action/i],
    [`streamer://join?r=${ROOM}&fp=${HEX}`, /no address/i],
    ['streamer://join?h=a:1&fp=' + HEX, /no room/i],
    [`streamer://join?h=a:1&r=${ROOM}`, /no certificate fingerprint/i],
    [`streamer://join?h=a&r=${ROOM}&fp=${HEX}`, /no port/i],
    [`streamer://join?h=a:99999&r=${ROOM}&fp=${HEX}`, /invalid port/i],
    [`streamer://join?h=a:1&r=sh0rt&fp=${HEX}`, /malformed/i],
    ['https://host:8443/', /does not point at a room/i],
  ];

  for (const [input, pattern] of cases) {
    assert.throws(() => parseInvite(input), pattern, `input: ${input}`);
    assert.throws(() => parseInvite(input), InviteError, `input: ${input}`);
  }
});

test('formatInvite refuses to build a link it could not parse back', () => {
  assert.throws(() => formatInvite({ host: '', port: 8443, roomId: ROOM, fingerprint: HEX }), /host/i);
  assert.throws(() => formatInvite({ host: 'h', port: 0, roomId: ROOM, fingerprint: HEX }), /port/i);
  assert.throws(() => formatInvite({ host: 'h', port: 8443, roomId: 'no', fingerprint: HEX }), /room/i);
});

test('the browser invite carries no fingerprint at all', () => {
  // It is handed to people who will open it in a browser, where the digest means nothing and
  // would only be one more thing to mis-copy.
  const link = browserInvite({ host: '192.168.1.34', port: 8443, roomId: ROOM });
  assert.equal(link, `https://192.168.1.34:8443/r/${ROOM}`);
  assert.equal(link, roomUrl({ host: '192.168.1.34', port: 8443, roomId: ROOM }));
  assert.ok(!link.includes('fp'));
});

/** A throwaway self-signed certificate, so this file needs no certs/ directory to run. */
function throwawayCertPem() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.UTC(2025, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2035, 0, 1));
  const attrs = [{ name: 'commonName', value: 'streamer.test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return forge.pki.certificateToPem(cert);
}
