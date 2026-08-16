/** Small pure helpers shared across views. Nothing here touches app state. */

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Trailing debounce. Used for resize and roster re-render, never for user intents. */
export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Leading throttle, for high-frequency events like audio level meters. */
export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Reject after `ms` unless the promise settles first.
 * Used wherever a browser API can hang without ever rejecting -- a permission prompt the
 * user walks away from, for example, would otherwise leave the UI in "starting..." forever.
 */
export function withTimeout(promise, ms, message = 'timed out') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/** A short random id for correlating request/response pairs on the socket. */
export function rid(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Bits per second in the unit a human would use. */
export function fmtBitrate(bps) {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function fmtFps(fps) {
  return Number.isFinite(fps) ? `${Math.round(fps)} fps` : '—';
}

export function fmtResolution(width, height) {
  return width && height ? `${width}×${height}` : '—';
}

/** Elapsed session time as m:ss or h:mm:ss. */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A stable hue for a peer id, so the same person is the same colour on every screen in the
 * room. Derived from the id rather than assigned by join order, which would shuffle colours
 * whenever someone reconnects.
 */
export function hueFromId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Up to two initials for the avatar. */
export function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

/**
 * An exponential moving average.
 *
 * Raw per-second bitrate deltas are noisy enough that an unsmoothed readout is unreadable --
 * the number changes so much between ticks that you cannot tell a trend from jitter. The
 * default alpha keeps it responsive to real changes while damping single-sample spikes.
 */
export function ema(previous, sample, alpha = 0.3) {
  if (!Number.isFinite(previous)) return sample;
  if (!Number.isFinite(sample)) return previous;
  return previous + alpha * (sample - previous);
}
