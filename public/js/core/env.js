/**
 * Capability probe, run before anything else on both pages.
 *
 * The point is to fail at the door with a specific explanation rather than midway through
 * joining with a generic one. The commonest real-world case by far is someone opening the app
 * over http:// -- at which point `navigator.mediaDevices` is simply `undefined`, and every
 * downstream call throws "cannot read property getUserMedia of undefined", which tells the
 * user nothing about the actual problem.
 */

import { ERRORS } from '../../shared/protocol.js';
import { AppError } from './errors.js';

/** True when the page can use the capture APIs at all. */
export const isSecure = () => window.isSecureContext === true;

export const hasWebRTC = () =>
  typeof window.RTCPeerConnection === 'function' &&
  typeof RTCPeerConnection.prototype.addTransceiver === 'function';

export const hasUserMedia = () =>
  Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');

export const hasDisplayMedia = () =>
  Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');

/** Perfect negotiation needs implicit rollback, which is what `setRemoteDescription` in
 *  `have-local-offer` relies on. Every browser we support has it; this guards the rest. */
export const hasPerfectNegotiation = () =>
  hasWebRTC() && typeof RTCPeerConnection.prototype.setRemoteDescription === 'function';

export function browserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'unknown';
}

/** Mobile browsers do not implement getDisplayMedia at all, so this is worth naming
 *  separately -- "use a desktop computer" is actionable where "unsupported" is not. */
export const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/**
 * Everything that must hold before the app can run.
 *
 * Returns `{ ok }` or `{ ok: false, error }` with a blocking AppError. Ordered most-specific
 * first: an insecure context also makes every other check fail, so reporting that first is
 * what makes the message useful.
 */
export function checkEnvironment({ requireDisplayMedia = true } = {}) {
  if (!isSecure()) {
    return {
      ok: false,
      error: new AppError(ERRORS.INSECURE_CONTEXT, { fatal: true }),
    };
  }

  if (!hasWebRTC()) {
    return { ok: false, error: new AppError(ERRORS.BROWSER_UNSUPPORTED, { fatal: true }) };
  }

  if (!hasUserMedia()) {
    return { ok: false, error: new AppError(ERRORS.BROWSER_UNSUPPORTED, { fatal: true }) };
  }

  if (requireDisplayMedia && !hasDisplayMedia()) {
    return {
      ok: false,
      error: new AppError(ERRORS.SHARE_UNSUPPORTED, {
        fatal: true,
        detail: isMobile() ? 'mobile browser' : browserName(),
      }),
    };
  }

  return { ok: true };
}

/** A snapshot for the diagnostics dump. No identifiers, no addresses -- just capabilities. */
export function environmentSummary() {
  return {
    secureContext: isSecure(),
    browser: browserName(),
    mobile: isMobile(),
    webrtc: hasWebRTC(),
    userMedia: hasUserMedia(),
    displayMedia: hasDisplayMedia(),
    protocol: location.protocol,
    e2e: window.__E2E__ === true,
  };
}

/**
 * True when the page is running under the E2E harness.
 *
 * The flag is injected server-side into room.html and only when the server was started with
 * STREAMER_E2E=1. It is deliberately not readable from a query parameter: `?e2e=1` would let
 * any visitor swap in the synthetic capture stream and switch on the introspection hook in a
 * live deployment.
 */
export const isE2E = () => window.__E2E__ === true;
