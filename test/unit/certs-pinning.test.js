import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

import { pin, unpin, clearPins, pinnedFor, digestOf, verify, RESULT } from '../../desktop/certs.js';

function makeCert(commonName) {
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
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  const pem = forge.pki.certificateToPem(cert);
  const x509 = new X509Certificate(pem);
  return {
    // Shaped like Electron's Certificate object.
    electron: { data: pem, fingerprint: `sha256/${createHash('sha256').update(x509.raw).digest('base64')}` },
    sha256: x509.fingerprint256,
  };
}

// Generating RSA keys is the slow part, so the fixtures are built once and shared.
const good = makeCert('streamer.local');
const impostor = makeCert('streamer.local');

test.beforeEach(() => clearPins());

test('a pinned host accepts exactly the certificate it was pinned to', () => {
  pin('192.168.1.34', good.sha256);
  const result = verify({ hostname: '192.168.1.34', certificate: good.electron });
  assert.equal(result, RESULT.TRUST);
});

test('a different certificate for a pinned host is REJECTED, not deferred', () => {
  // The assertion that matters most in this file. Deferring would hand a swapped certificate to
  // Chromium, which answers a self-signed certificate with a click-through interstitial -- so a
  // detected substitution would become a dialog the user has already been trained to dismiss.
  pin('192.168.1.34', good.sha256);

  const rejections = [];
  const result = verify(
    { hostname: '192.168.1.34', certificate: impostor.electron },
    (event) => rejections.push(event),
  );

  assert.equal(result, RESULT.REJECT);
  assert.notEqual(result, RESULT.DEFER_TO_CHROMIUM);
  assert.equal(rejections.length, 1, 'a refusal must be reportable, not silent');
  assert.equal(rejections[0].hostname, '192.168.1.34');
  assert.notEqual(rejections[0].actual, rejections[0].expected);
});

test('an unpinned host falls through to Chromium rather than being trusted', () => {
  // A verify proc that returns "trusted" for anything it does not recognise disables TLS for the
  // whole application, silently. Unknown hosts must get normal verification.
  const result = verify({ hostname: 'example.com', certificate: good.electron });
  assert.equal(result, RESULT.DEFER_TO_CHROMIUM);
  assert.notEqual(result, RESULT.TRUST);
});

test('a pinned host presenting an unparseable certificate is refused', () => {
  pin('192.168.1.34', good.sha256);
  for (const certificate of [{}, { data: 'not a pem' }, null, undefined]) {
    assert.equal(
      verify({ hostname: '192.168.1.34', certificate }),
      RESULT.REJECT,
      `certificate: ${JSON.stringify(certificate)}`,
    );
  }
});

test('the digest is read from the certificate, matching what the host publishes', () => {
  // Both ends must land on the same string: the host prints X509Certificate.fingerprint256 and
  // the joiner recomputes it here. If these ever diverge, every pin fails and the feature looks
  // broken rather than strict.
  assert.equal(digestOf(good.electron), good.sha256.replace(/:/g, '').toLowerCase());

  // Electron's own "sha256/BASE64" spelling of the same certificate agrees.
  assert.equal(digestOf({ fingerprint: good.electron.fingerprint }), digestOf(good.electron));
});

test('hostname matching ignores case and IPv6 brackets', () => {
  pin('[::1]', good.sha256);
  assert.equal(verify({ hostname: '::1', certificate: good.electron }), RESULT.TRUST);

  pin('Streamer.Local', good.sha256);
  assert.equal(verify({ hostname: 'streamer.local', certificate: good.electron }), RESULT.TRUST);
});

test('pins can be inspected and removed', () => {
  pin('host.a', good.sha256);
  assert.equal(pinnedFor('host.a'), good.sha256.replace(/:/g, '').toLowerCase());

  unpin('host.a');
  assert.equal(pinnedFor('host.a'), null);
  assert.equal(verify({ hostname: 'host.a', certificate: good.electron }), RESULT.DEFER_TO_CHROMIUM);
});
