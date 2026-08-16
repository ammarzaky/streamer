import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE, END_REASON, ERRORS, LEAVE_REASON, LIMITS, S2C, STATE, envelope } from '../../public/shared/protocol.js';
import { toClientConfig } from '../config.js';
import { handlers } from './handlers.js';
import { startHeartbeat } from './heartbeat.js';
import { startJanitor } from './janitor.js';
import { createRateLimiter } from './rateLimit.js';
import { RoomRegistry } from './rooms.js';
import { acceptsUpgrade, rejectUpgrade } from './upgrade.js';
import { validateMessage } from './validate.js';

export function attachSignaling(server, config, log = console) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_MESSAGE_BYTES }); const registry = new RoomRegistry(config); const limiter = createRateLimiter(config.signaling.rateLimit);
  const send = (socket, type, data = {}, ref) => { if (socket.readyState !== WebSocket.OPEN) return; const raw = JSON.stringify(envelope(type, data, { ...(ref === undefined ? {} : { ref }), ts: Date.now() })); if (socket.bufferedAmount > LIMITS.MAX_MESSAGE_BYTES * 4) return socket.close(CLOSE.SLOW_CONSUMER); socket.send(raw); };
  const broadcast = (room, type, data, options = {}) => { for (const peer of room.peers.values()) if (peer.id !== options.except) send(peer.socket, type, options.perPeer ? options.perPeer(peer) : data); };
  const endRoom = (room, reason = END_REASON.HOST_ENDED, closeCode = CLOSE.ROOM_ENDED) => { if (!registry.rooms.has(room.id)) return; room.endedAt = Date.now(); registry.rooms.delete(room.id); for (const peer of room.peers.values()) { send(peer.socket, S2C.ROOM_ENDED, { reason }); peer.socket.close(closeCode); } room.peers.clear(); };
  const drop = (socket, reason = LEAVE_REASON.DISCONNECTED) => { const meta = socket.meta; if (!meta?.room || !meta.peer || meta.removed) return; meta.removed = true; registry.removePeer(meta.room, meta.peer, { reason, send, broadcast }); };
  const upgrade = (request, socket, head) => { if (!acceptsUpgrade(request, config)) return rejectUpgrade(socket); wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request)); };
  server.on('upgrade', upgrade);
  wss.on('connection', (socket, request) => {
    socket.meta = { state: STATE.UNJOINED, room: null, peer: null, removed: false, ip: request.socket.remoteAddress };
    send(socket, S2C.WELCOME, toClientConfig(config));
    socket.on('pong', () => { if (socket.meta.peer) socket.meta.peer.lastSeen = Date.now(); });
    socket.on('message', (buffer, isBinary) => {
      if (isBinary) { send(socket, S2C.ERROR, { code: ERRORS.INVALID_ENVELOPE, message: 'binary frames are not accepted' }); socket.close(CLOSE.PROTOCOL_ERROR); return; }
      const raw = buffer.toString(); const result = validateMessage(raw, socket.meta.state);
      if (!result.ok) { send(socket, S2C.ERROR, { code: result.code, message: result.detail }, result.id); if (result.code === ERRORS.UNSUPPORTED_VERSION) socket.close(CLOSE.VERSION_MISMATCH); return; }
      const signal = result.message.type === C2S_PLACEHOLDER.OFFER || result.message.type === C2S_PLACEHOLDER.ANSWER || result.message.type === C2S_PLACEHOLDER.ICE_CANDIDATE;
      const rate = limiter.take(socket, signal ? 'signal' : 'control'); if (!rate.ok) { send(socket, S2C.ERROR, { code: ERRORS.RATE_LIMITED, message: 'Rate limit exceeded' }, result.message.id); if (rate.disconnect) socket.close(CLOSE.KICKED_RATE_LIMIT); return; }
      const ctx = { socket, peer: socket.meta.peer, room: socket.meta.room, registry, config, send, broadcast, log, message: result.message, endRoom,
        attach(room, peer) { socket.meta.room = room; socket.meta.peer = peer; socket.meta.state = STATE.JOINED; socket.meta.removed = false; } };
      handlers[result.message.type](ctx, result.message);
    });
    socket.on('close', (code) => drop(socket, code === CLOSE.LEFT ? LEAVE_REASON.LEFT : LEAVE_REASON.DISCONNECTED));
    socket.on('error', (error) => log.warn?.('websocket error', { error: error.message }));
  });
  const stopHeartbeat = startHeartbeat({ wss, config, drop }); const stopJanitor = startJanitor({ registry, config, endRoom });
  return { wss, registry, close(code = CLOSE.SERVER_SHUTDOWN) { stopHeartbeat(); stopJanitor(); server.off('upgrade', upgrade); for (const room of [...registry.rooms.values()]) endRoom(room, END_REASON.SERVER_SHUTDOWN, code); for (const socket of wss.clients) socket.close(code); return new Promise((resolve) => { wss.close(resolve); }); } };
}

// Aliases avoid writing protocol message values as literals while keeping the hot path compact.
import { C2S as C2S_PLACEHOLDER } from '../../public/shared/protocol.js';
