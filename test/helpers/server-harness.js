import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, SUBPROTOCOL } from '../../public/shared/protocol.js';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/index.js';

export async function startHarness(overrides = {}) {
  const base = await loadConfig({ cwd: process.cwd(), env: {} }); const config = structuredClone(base);
  config.server.host = '127.0.0.1'; config.server.port = 0; config.server.httpRedirect.enabled = false;
  Object.assign(config.rooms, overrides.rooms); Object.assign(config.signaling, overrides.signaling); config.e2e = overrides.e2e ?? false;
  const app = await startServer({ config }); const port = app.port; const url = `https://127.0.0.1:${port}`; const wsUrl = `wss://127.0.0.1:${port}${config.signaling.path}`;
  return { url, wsUrl, port, registry: app.registry, config, close: app.close, connect: () => connect(wsUrl, url) };
}

export async function connect(wsUrl, origin) {
  const socket = new WebSocket(wsUrl, SUBPROTOCOL, { rejectUnauthorized: false, origin }); const inbox = []; const waiters = []; const consumed = new Set();
  socket.on('message', (raw) => { const message = JSON.parse(raw); inbox.push(message); for (const waiter of [...waiters]) if (waiter.type === message.type) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } });
  await once(socket, 'open');
  return { socket, inbox, send(type, data = {}, id) { socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, data, ...(id ? { id } : {}) })); }, waitFor(type, timeoutMs = 1000) { const found = inbox.find((x) => x.type === type && !consumed.has(x)); if (found) { consumed.add(found); return Promise.resolve(found); } return new Promise((resolve, reject) => { const waiter = { type, resolve: (message) => { consumed.add(message); resolve(message); }, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`timed out waiting for ${type}`)); }, timeoutMs) }; waiters.push(waiter); }); }, async expectNone(predicate, ms = 100) { const start = inbox.length; await new Promise((resolve) => { setTimeout(resolve, ms); }); const found = inbox.slice(start).find(predicate); if (found) throw new Error(`unexpected message: ${JSON.stringify(found)}`); }, close() { socket.close(); } };
}
