import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { SUBPROTOCOL } from '../../public/shared/protocol.js';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/index.js';

/**
 * The WebSocket upgrade is same-origin checked against the Host header
 * (src/signaling/upgrade.js). Through a tunnel both become the public hostname, which normally
 * matches -- but "normally" rests on cloudflared forwarding the original Host, which is someone
 * else's implementation detail. If it ever stops doing that, the symptom is a 403 on upgrade: the
 * page loads perfectly and then nobody can connect, which looks nothing like an origin problem.
 *
 * `allowOrigin()` is the escape hatch, and it has to work at runtime because a quick tunnel's
 * hostname does not exist until cloudflared has been given one -- long after the config has been
 * loaded and deep-frozen.
 */

async function harness() {
  const base = await loadConfig({ cwd: process.cwd(), env: {} });
  const config = structuredClone(base);
  config.server.host = '127.0.0.1';
  config.server.port = 0;
  config.server.httpRedirect.enabled = false;
  config.logging.level = 'error';

  const app = await startServer({ config });
  return {
    app,
    wsUrl: `wss://127.0.0.1:${app.port}${config.signaling.path}`,
    close: app.close,
  };
}

/** Attempt an upgrade with a given Origin. Resolves to 'open' or the rejection status. */
function tryUpgrade(wsUrl, origin) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, SUBPROTOCOL, { rejectUnauthorized: false, origin });
    socket.on('open', () => {
      socket.close();
      resolve('open');
    });
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.on('error', () => resolve('error'));
  });
}

const TUNNEL = 'https://wide-copper-motor-sail.trycloudflare.com';

test('an unknown origin is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal(await tryUpgrade(h.wsUrl, TUNNEL), 403);
});

test('allowOrigin admits a hostname that did not exist at startup', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal(await tryUpgrade(h.wsUrl, TUNNEL), 403, 'refused before being allowed');

  h.app.allowOrigin(TUNNEL);
  assert.equal(await tryUpgrade(h.wsUrl, TUNNEL), 'open', 'admitted after being allowed');

  h.app.forgetOrigin(TUNNEL);
  assert.equal(await tryUpgrade(h.wsUrl, TUNNEL), 403, 'refused again once the tunnel is closed');
});

test('allowOrigin stores an origin, not a URL', async (t) => {
  // The caller has a full tunnel URL to hand, while the Origin header is scheme+host only. If
  // those were compared as raw strings the allowance would never match, and the failure would be
  // indistinguishable from not having called it at all.
  const h = await harness();
  t.after(() => h.close());

  h.app.allowOrigin(`${TUNNEL}/r/SomeRoomId123`);
  assert.equal(await tryUpgrade(h.wsUrl, TUNNEL), 'open');
});

test('allowing one origin does not admit any other', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.app.allowOrigin(TUNNEL);

  for (const other of [
    'https://evil.example',
    'https://wide-copper-motor-sail.trycloudflare.com.evil.example',
    'http://wide-copper-motor-sail.trycloudflare.com',
  ]) {
    assert.equal(await tryUpgrade(h.wsUrl, other), 403, `must refuse ${other}`);
  }
});

test('same-origin still works, and garbage does not throw', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal(await tryUpgrade(h.wsUrl, `https://127.0.0.1:${h.app.port}`), 'open');

  for (const bad of [null, undefined, '', 'not a url']) {
    assert.doesNotThrow(() => h.app.allowOrigin(bad), `allowOrigin(${bad})`);
  }
});
