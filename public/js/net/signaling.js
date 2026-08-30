/**
 * The WebSocket signaling client.
 *
 * Responsibilities: connect, keep alive, reconnect when it makes sense, and hand parsed
 * messages to a router. It deliberately holds no room state -- that belongs to the store --
 * so that a reconnect is a clean restart rather than a merge of two half-truths.
 */

import {
  C2S,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  SIGNALING_PATH,
  shouldReconnect,
  CLOSE,
  parseEnvelope,
} from '../../shared/protocol.js';
import { rid } from '../core/util.js';
import { logger } from '../core/logger.js';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const PING_INTERVAL_MS = 20_000;
const OPEN_TIMEOUT_MS = 10_000;

export function createSignalingClient({ onMessage, onStatus }) {
  /** @type {WebSocket|null} */
  let socket = null;
  let status = 'idle';
  let attempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let openTimer = null;

  /** Messages composed while the socket was down. Cleared on reconnect -- see flush(). */
  let queue = [];
  let intentionalClose = false;
  let closed = false;

  /**
   * The URL is always derived from `location`, never configured.
   *
   * A certificate accepted for the page's origin does not cover a different host or port, and
   * a rejected WebSocket handshake gives no interstitial and no diagnosable error -- the
   * browser just fires `close`. Same-origin means accepting the page's certificate already
   * covered the socket.
   */
  function url() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}${SIGNALING_PATH}`;
  }

  function setStatus(next, extra = {}) {
    if (status === next && !extra.force) return;
    status = next;
    onStatus?.({ status, attempt, ...extra });
  }

  function connect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    intentionalClose = false;

    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    logger.debug('signaling: connecting', { attempt });

    try {
      socket = new WebSocket(url(), SUBPROTOCOL);
    } catch (err) {
      // Constructor throws only on a malformed URL, which would be a bug rather than a
      // network condition -- retrying will not help, so surface it.
      logger.error('signaling: could not construct socket', err);
      setStatus('dead');
      return;
    }

    // A socket that neither opens nor errors is a real state: it happens when the certificate
    // was never accepted, and it can hang indefinitely without this.
    openTimer = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        logger.warn('signaling: open timed out');
        socket.close();
      }
    }, OPEN_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(openTimer);
      attempt = 0;
      setStatus('open');
      logger.info('signaling: open');
      startPing();
      flush();
    });

    socket.addEventListener('message', (event) => {
      const parsed = parseEnvelope(event.data);
      if (!parsed.ok) {
        // The server is the only thing sending us frames, so this means a version skew.
        logger.error('signaling: unparseable frame from server', parsed);
        return;
      }
      onMessage?.(parsed.message);
    });

    socket.addEventListener('error', () => {
      // The error event carries no useful detail by design (it would leak cross-origin
      // information), so there is nothing to log beyond the fact of it. `close` follows.
      logger.debug('signaling: socket error');
    });

    socket.addEventListener('close', (event) => {
      clearTimeout(openTimer);
      stopPing();
      socket = null;

      const code = event.code;
      logger.info('signaling: closed', { code, intentional: intentionalClose });

      if (closed || intentionalClose) {
        setStatus('idle');
        return;
      }

      // The rule that keeps a terminal state terminal. `leave` and `room-ended` both close the
      // socket; without this check the reconnector re-opens, re-joins a room that no longer
      // exists, receives ROOM_NOT_FOUND, and replaces the correct "the host ended the session"
      // screen with a wrong "this room doesn't exist".
      if (!shouldReconnect(code)) {
        setStatus('closed-terminal', { code, force: true });
        return;
      }

      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (closed) return;

    if (attempt >= RECONNECT_DELAYS_MS.length) {
      // Out of attempts. The distinction matters to the user: the server being unreachable is
      // a different problem, with a different fix, from a peer connection failing.
      setStatus('dead', { force: true });
      return;
    }

    const delay = RECONNECT_DELAYS_MS[attempt];
    attempt++;
    setStatus('reconnecting', { force: true });
    logger.info('signaling: reconnecting', { attempt, delay });
    reconnectTimer = setTimeout(connect, delay);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) send(C2S.PING, {});
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  /**
   * Send queued messages after a reconnect.
   *
   * The queue is dropped rather than replayed when the session identity changed. A
   * reconnecting peer receives a NEW peerId, so every queued message addressed with `to:` is
   * aimed at a connection that no longer exists, and every replayed offer produces
   * PEER_NOT_FOUND. The caller re-derives whatever still matters from the fresh `joined`
   * snapshot.
   */
  function flush() {
    const pending = queue;
    queue = [];
    for (const frame of pending) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }

  function dropQueue() {
    if (queue.length) logger.debug('signaling: dropping stale queue', { count: queue.length });
    queue = [];
  }

  function send(type, data = {}, { correlate = false } = {}) {
    const id = correlate ? rid() : undefined;
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, type, ...(id ? { id } : {}), data });

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(frame);
    } else if (!closed) {
      // Queue only pre-open traffic. Anything queued across a reconnect is discarded by
      // dropQueue() before flush() runs.
      queue.push(frame);
    }
    return id;
  }

  return {
    connect,
    send,
    dropQueue,

    get status() {
      return status;
    },

    get isOpen() {
      return socket?.readyState === WebSocket.OPEN;
    },

    /**
     * Drop the socket WITHOUT marking the session as over, so the reconnect ladder runs.
     * Used only by the E2E harness: a page cannot produce a genuine 1006 for itself, and this
     * travels the identical branch.
     */
    forceDrop(code = CLOSE.SERVER_SHUTDOWN) {
      if (socket?.readyState === WebSocket.OPEN) socket.close(code);
    },

    /** Close deliberately: no reconnect, no terminal-error UI. */
    close(code = CLOSE.NORMAL) {
      intentionalClose = true;
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(openTimer);
      stopPing();
      queue = [];
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close(code);
      socket = null;
      setStatus('idle');
    },
  };
}
