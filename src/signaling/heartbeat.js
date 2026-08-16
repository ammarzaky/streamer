import { WebSocket } from 'ws';
import { LEAVE_REASON } from '../../public/shared/protocol.js';
export function startHeartbeat({ wss, config, drop }) { const timer = setInterval(() => { const now = Date.now(); for (const socket of wss.clients) { const meta = socket.meta; if (meta?.peer && now - meta.peer.lastSeen > config.signaling.heartbeatTimeoutMs) { drop(socket, LEAVE_REASON.TIMEOUT); socket.terminate(); } else if (socket.readyState === WebSocket.OPEN) socket.ping(); } }, config.signaling.heartbeatIntervalMs); timer.unref?.(); return () => clearInterval(timer); }
