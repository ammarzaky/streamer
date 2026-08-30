/**
 * Client-side logging with a ring buffer behind it.
 *
 * The buffer is what makes "Copy diagnostics" useful: WebRTC failures are usually a sequence
 * (offer, candidates, state transitions) rather than a single event, and by the time a user
 * notices something is wrong the console has already scrolled or was never open.
 *
 * Nothing here is transmitted anywhere. It exists to be read by the person having the problem.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const BUFFER_SIZE = 800;

let threshold = LEVELS.info;
const buffer = [];

/** Keys whose values are never recorded: SDP and candidates describe network topology, and
 *  this app has no reason to retain any of it, even locally. */
const REDACT = new Set(['sdp', 'candidate', 'description', 'hostToken', 'accessCode']);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACT.has(key) ? `[${key} redacted]` : redact(val, depth + 1);
  }
  return out;
}

function record(level, message, detail) {
  if (LEVELS[level] < threshold && level !== 'error') {
    // Errors are always buffered even below the threshold -- they are the reason the buffer
    // gets read at all.
    if (LEVELS[level] < threshold) return;
  }

  const entry = {
    t: new Date().toISOString(),
    level,
    message,
    detail: detail === undefined ? undefined : redact(detail),
  };

  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  if (LEVELS[level] >= threshold) {
    const method = level === 'debug' ? 'log' : level;
    if (detail === undefined) console[method](`[${level}] ${message}`);
    else console[method](`[${level}] ${message}`, detail);
  }
}

export const logger = {
  setLevel(level) {
    threshold = LEVELS[level] ?? LEVELS.info;
  },

  debug: (message, detail) => record('debug', message, detail),
  info: (message, detail) => record('info', message, detail),
  warn: (message, detail) => record('warn', message, detail),

  error(message, detail) {
    // An Error survives JSON.stringify as `{}`, which makes a diagnostics dump useless
    // exactly when it matters most.
    const serialized =
      detail instanceof Error
        ? { name: detail.name, message: detail.message, code: detail.code, stack: detail.stack }
        : detail;
    record('error', message, serialized);
  },

  /**
   * The text behind the "Copy diagnostics" button.
   *
   * `compact` is for the copy that travels to a peer over the data channel, which has a hard
   * size cap: no indentation and only the newest `logLimit` entries.
   */
  dump(extra = {}, { compact = false, logLimit = null } = {}) {
    const log = Number.isInteger(logLimit) && logLimit >= 0 ? buffer.slice(-logLimit) : buffer;
    const body = { generatedAt: new Date().toISOString(), ...extra, log };
    return compact ? JSON.stringify(body) : JSON.stringify(body, null, 2);
  },

  /** The newest `limit` entries, for anything that wants to embed a slice of the buffer. */
  entries(limit = buffer.length) {
    return buffer.slice(-Math.max(0, limit));
  },

  clear() {
    buffer.length = 0;
  },
};
