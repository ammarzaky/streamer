/**
 * Certificate pinning.
 *
 * This is what lets the desktop app skip the whole certificate story: no CA to install, no
 * interstitial to click through. The invite link carries the server certificate's SHA-256, and
 * this module tells Chromium to accept that one certificate for that one host and nothing else.
 *
 * It is deliberately stricter than the browser flow it replaces. Clicking "Advanced -> Proceed"
 * accepts whatever certificate is presented, once, with no way to notice it changed later. A pin
 * accepts exactly one key and refuses every other, so a swapped or intercepted certificate is a
 * connection failure rather than a prompt the user has already learned to dismiss.
 *
 * Two rules make that true, and both are easy to get wrong:
 *
 *   1. **Pinned hosts fail closed.** A mismatch is rejected outright. It must never fall through
 *      to "well, ask Chromium then", because Chromium's answer for a self-signed certificate is
 *      an interstitial -- which would turn a detected attack into a dialog.
 *   2. **Unpinned hosts are not trusted.** Anything we have no pin for is handed back to
 *      Chromium's normal verification untouched. A verify proc that returns "trusted" by default
 *      disables TLS for the entire application, and does it silently.
 */

import { X509Certificate } from 'node:crypto';
import { normalizeFingerprint } from './shared/invite.js';

/** Chromium's verify-proc result codes. */
const TRUST = 0;
const REJECT = -2;
const DEFER_TO_CHROMIUM = -3;

/**
 * hostname -> expected SHA-256, lowercase hex.
 *
 * Keyed by hostname alone because that is all Electron gives the verify proc -- `request` carries
 * `hostname`, `certificate`, `verificationResult` and `errorCode`, but no port. In practice one
 * host runs one Streamer server, so this is not a gap worth pretending we have closed; noting it
 * is better than implying a per-port guarantee that does not exist.
 */
const pins = new Map();

/** Trust `fingerprint` for `hostname`. Returns the normalised digest that was stored. */
export function pin(hostname, fingerprint) {
  const host = normalizeHost(hostname);
  const digest = normalizeFingerprint(fingerprint);
  pins.set(host, digest);
  return digest;
}

export function unpin(hostname) {
  pins.delete(normalizeHost(hostname));
}

export function pinnedFor(hostname) {
  return pins.get(normalizeHost(hostname)) ?? null;
}

/** Forget every pin. The app holds these in memory only, so quitting does this anyway. */
export function clearPins() {
  pins.clear();
}

/**
 * The digest Chromium's `Certificate` object represents.
 *
 * Parsed from the PEM with Node rather than read off `certificate.fingerprint`, so that both
 * ends of the comparison are produced by the same function: the host publishes
 * `X509Certificate.fingerprint256` and the joiner recomputes it the same way. `fingerprint` is
 * only consulted if the PEM will not parse, which should not happen but is not worth crashing on.
 */
export function digestOf(certificate) {
  try {
    if (certificate?.data) return normalizeFingerprint(new X509Certificate(certificate.data).fingerprint256);
  } catch {
    // Fall through to Electron's own value.
  }
  try {
    if (certificate?.fingerprint) return normalizeFingerprint(certificate.fingerprint);
  } catch {
    // Nothing usable.
  }
  return null;
}

/**
 * The verify proc itself, exported separately from `install` so it can be unit-tested without
 * an Electron session. Returns a Chromium result code.
 *
 * @param {{hostname: string, certificate: object}} request
 * @param {(event: {hostname: string, expected: string, actual: string|null}) => void} [onReject]
 */
export function verify(request, onReject) {
  const expected = pinnedFor(request?.hostname ?? '');
  if (!expected) return DEFER_TO_CHROMIUM;

  const actual = digestOf(request.certificate);
  if (actual && actual === expected) return TRUST;

  // Fail closed. Reporting is a side effect so the UI can say which host was refused and why,
  // rather than the user seeing a bare "connection failed".
  onReject?.({ hostname: request.hostname, expected, actual });
  return REJECT;
}

/**
 * Attach the verify proc to a session.
 * @param {Electron.Session} session
 * @param {(event: {hostname: string, expected: string, actual: string|null}) => void} [onReject]
 */
export function install(session, onReject) {
  session.setCertificateVerifyProc((request, callback) => {
    callback(verify(request, onReject));
  });
}

/** Lowercased, with an IPv6 literal's brackets removed so it matches what Chromium reports. */
function normalizeHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export const RESULT = Object.freeze({ TRUST, REJECT, DEFER_TO_CHROMIUM });
