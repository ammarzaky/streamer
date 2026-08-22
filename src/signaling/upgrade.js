import { SIGNALING_PATH, SUBPROTOCOL } from '../../public/shared/protocol.js';

/**
 * @param extraOrigins additional origins trusted at runtime, beyond the frozen config list.
 *
 * The runtime set exists for tunnelling. A Cloudflare Quick Tunnel's hostname is not known until
 * cloudflared has started and been assigned one, which is long after the config has been loaded
 * and deep-frozen -- so there is no way to put it in `extraAllowedOrigins` up front, and no way to
 * push it in later either. Without this the WebSocket upgrade through the tunnel is rejected 403
 * and the room looks broken for a reason nothing in the UI can explain.
 */
export function acceptsUpgrade(request, config, extraOrigins) {
  let url; try { url = new URL(request.url, 'https://local'); } catch { return false; }
  if (url.pathname !== (config.signaling.path ?? SIGNALING_PATH)) return false;
  const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim()); if (!protocols.includes(SUBPROTOCOL)) return false;
  const origin = request.headers.origin;
  if (!origin) return config.signaling.allowMissingOrigin;
  if (config.signaling.originPolicy !== 'same-origin') return true;
  const expected = `https://${request.headers.host}`;
  if (origin === expected) return true;
  if (config.signaling.extraAllowedOrigins.includes(origin)) return true;
  return Boolean(extraOrigins?.has(origin));
}

export function rejectUpgrade(socket, status = 403) { socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
