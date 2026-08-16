import { SIGNALING_PATH, SUBPROTOCOL } from '../../public/shared/protocol.js';

export function acceptsUpgrade(request, config) {
  let url; try { url = new URL(request.url, 'https://local'); } catch { return false; }
  if (url.pathname !== (config.signaling.path ?? SIGNALING_PATH)) return false;
  const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim()); if (!protocols.includes(SUBPROTOCOL)) return false;
  const origin = request.headers.origin;
  if (!origin) return config.signaling.allowMissingOrigin;
  if (config.signaling.originPolicy !== 'same-origin') return true;
  const expected = `https://${request.headers.host}`;
  return origin === expected || config.signaling.extraAllowedOrigins.includes(origin);
}

export function rejectUpgrade(socket, status = 403) { socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
