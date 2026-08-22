import { WebSocket, WebSocketServer } from 'ws';
import {
  C2S,
  CLOSE,
  END_REASON,
  ERRORS,
  LEAVE_REASON,
  LIMITS,
  S2C,
  STATE,
  envelope,
} from '../../public/shared/protocol.js';
import { toClientConfig } from '../config.js';
import { handlers } from './handlers.js';
import { startHeartbeat } from './heartbeat.js';
import { startJanitor } from './janitor.js';
import { createRateLimiter } from './rateLimit.js';
import { RoomRegistry } from './rooms.js';
import { acceptsUpgrade, rejectUpgrade } from './upgrade.js';
import { validateMessage } from './validate.js';

/** Relays are high-volume and get a far larger allowance than control messages. */
const SIGNAL_TYPES = new Set([C2S.OFFER, C2S.ANSWER, C2S.ICE_CANDIDATE]);

export function attachSignaling(server, config, log = console) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_MESSAGE_BYTES });
  const registry = new RoomRegistry(config);
  const limiter = createRateLimiter(config.signaling.rateLimit);

  const send = (socket, type, data = {}, ref) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(
      envelope(type, data, { ...(ref === undefined ? {} : { ref }), ts: Date.now() }),
    );
    // A peer that cannot drain what we are sending it is not going to recover by being sent
    // more; close it rather than growing the buffer without bound.
    if (socket.bufferedAmount > LIMITS.MAX_MESSAGE_BYTES * 4) {
      return socket.close(CLOSE.SLOW_CONSUMER);
    }
    socket.send(raw);
  };

  const broadcast = (room, type, data, options = {}) => {
    for (const peer of room.peers.values()) {
      if (peer.id === options.except) continue;
      send(peer.socket, type, options.perPeer ? options.perPeer(peer) : data);
    }
  };

  const endRoom = (room, reason = END_REASON.HOST_ENDED, closeCode = CLOSE.ROOM_ENDED) => {
    if (!registry.rooms.has(room.id)) return;
    room.endedAt = Date.now();
    registry.rooms.delete(room.id);
    for (const peer of room.peers.values()) {
      send(peer.socket, S2C.ROOM_ENDED, { reason });
      peer.socket.close(closeCode);
    }
    room.peers.clear();
  };

  const drop = (socket, reason = LEAVE_REASON.DISCONNECTED) => {
    const meta = socket.meta;
    if (!meta?.room || !meta.peer || meta.removed) return;
    meta.removed = true;
    registry.removePeer(meta.room, meta.peer, { reason, send, broadcast });
  };

  // Origins trusted at runtime, on top of the frozen config list. Populated when a tunnel is
  // opened, since its hostname does not exist until then.
  const allowedOrigins = new Set();
  const toOrigin = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try { return new URL(value).origin; } catch { return null; }
  };

  const upgrade = (request, socket, head) => {
    if (!acceptsUpgrade(request, config, allowedOrigins)) return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  server.on('upgrade', upgrade);

  wss.on('connection', (socket, request) => {
    socket.meta = {
      state: STATE.UNJOINED,
      room: null,
      peer: null,
      removed: false,
      ip: request.socket.remoteAddress,
    };

    send(socket, S2C.WELCOME, toClientConfig(config));

    socket.on('pong', () => {
      if (socket.meta.peer) socket.meta.peer.lastSeen = Date.now();
    });

    socket.on('message', (buffer, isBinary) => {
      if (isBinary) {
        send(socket, S2C.ERROR, {
          code: ERRORS.INVALID_ENVELOPE,
          message: 'binary frames are not accepted',
        });
        socket.close(CLOSE.PROTOCOL_ERROR);
        return;
      }

      const result = validateMessage(buffer.toString(), socket.meta.state);
      if (!result.ok) {
        send(socket, S2C.ERROR, { code: result.code, message: result.detail }, result.id);
        if (result.code === ERRORS.UNSUPPORTED_VERSION) socket.close(CLOSE.VERSION_MISMATCH);
        return;
      }

      const kind = SIGNAL_TYPES.has(result.message.type) ? 'signal' : 'control';
      const rate = limiter.take(socket, kind);
      if (!rate.ok) {
        send(
          socket,
          S2C.ERROR,
          { code: ERRORS.RATE_LIMITED, message: 'Rate limit exceeded' },
          result.message.id,
        );
        if (rate.disconnect) socket.close(CLOSE.KICKED_RATE_LIMIT);
        return;
      }

      // Any activity counts as liveness, not just pongs -- a peer sending ICE candidates is
      // demonstrably alive even if a pong is still in flight.
      if (socket.meta.peer) socket.meta.peer.lastSeen = Date.now();

      const ctx = {
        socket,
        peer: socket.meta.peer,
        room: socket.meta.room,
        registry,
        config,
        send,
        broadcast,
        log,
        message: result.message,
        endRoom,
        attach(room, peer) {
          socket.meta.room = room;
          socket.meta.peer = peer;
          socket.meta.state = STATE.JOINED;
          socket.meta.removed = false;
        },
      };

      handlers[result.message.type](ctx, result.message);
    });

    socket.on('close', (code) => {
      drop(socket, code === CLOSE.LEFT ? LEAVE_REASON.LEFT : LEAVE_REASON.DISCONNECTED);
      // Buckets are keyed by socket, so without this every connection the process ever
      // accepted leaks two token buckets and a strikes array for its whole lifetime.
      limiter.delete(socket);
    });

    socket.on('error', (error) => log.warn?.('websocket error', { error: error.message }));
  });

  const stopHeartbeat = startHeartbeat({ wss, config, drop });
  // send/broadcast are required: the sweep can promote a host, which has to announce itself.
  const stopJanitor = startJanitor({ registry, config, endRoom, send, broadcast });

  return {
    wss,
    registry,
    /**
     * Trust an origin discovered after startup, such as a tunnel hostname.
     *
     * Normalised to scheme+host, because the caller has a full URL to hand while the Origin header
     * carries only the origin -- comparing those as raw strings would never match, and the failure
     * would look identical to never having called this at all.
     *
     * Unparseable input is ignored rather than thrown: this is fed whatever an external tool
     * reported, and a throw here would surface as a tunnel failure for entirely the wrong reason.
     */
    allowOrigin(origin) {
      const value = toOrigin(origin);
      if (value) allowedOrigins.add(value);
    },
    forgetOrigin(origin) {
      const value = toOrigin(origin);
      if (value) allowedOrigins.delete(value);
    },
    close(code = CLOSE.SERVER_SHUTDOWN) {
      stopHeartbeat();
      stopJanitor();
      server.off('upgrade', upgrade);
      for (const room of [...registry.rooms.values()]) {
        endRoom(room, END_REASON.SERVER_SHUTDOWN, code);
      }
      for (const socket of wss.clients) socket.close(code);
      return new Promise((resolve) => {
        wss.close(resolve);
      });
    },
  };
}
