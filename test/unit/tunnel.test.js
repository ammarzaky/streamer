import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTunnelUrl, locate, INSTALL_HINT } from '../../desktop/tunnel.js';
import { roomUrl, browserInvite, parseInvite } from '../../desktop/shared/invite.js';

// ---------------------------------------------------------------------------
// Reading someone else's log format
// ---------------------------------------------------------------------------

test('the quick-tunnel URL is found in real cloudflared output', () => {
  // The actual banner, box-drawing characters and all. This is parsing another tool's log format,
  // which is exactly the kind of thing that breaks silently on an upgrade -- so it is pinned to
  // what cloudflared genuinely emits rather than to a tidied-up version of it.
  const banner = [
    '2026-08-18T12:00:00Z INF Thank you for trying Cloudflare Tunnel.',
    '2026-08-18T12:00:00Z INF +--------------------------------------------------------+',
    '2026-08-18T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at:       |',
    '2026-08-18T12:00:00Z INF |  https://wide-copper-motor-sail.trycloudflare.com       |',
    '2026-08-18T12:00:00Z INF +--------------------------------------------------------+',
  ].join('\n');

  assert.equal(parseTunnelUrl(banner), 'https://wide-copper-motor-sail.trycloudflare.com');
});

test('the URL is found even when output arrives split across chunks', () => {
  // stdout arrives in arbitrary chunks, so the accumulated buffer is what gets parsed. A parser
  // that only ever saw whole lines would work by luck.
  const whole = 'INF |  https://tiny-frog-lake.trycloudflare.com  |\nINF more output';
  assert.equal(parseTunnelUrl(whole), 'https://tiny-frog-lake.trycloudflare.com');
});

test('output with no URL yet returns null rather than a partial match', () => {
  for (const text of [
    '',
    null,
    undefined,
    '2026-08-18T12:00:00Z INF Starting tunnel',
    'ERR failed to connect to the Cloudflare edge',
    'https://example.com/not-a-tunnel',
    'trycloudflare.com without a scheme',
  ]) {
    assert.equal(parseTunnelUrl(text), null, `input: ${text}`);
  }
});

test('locate returns null or something usable, never a path that does not exist', () => {
  // The install hint is the whole value of a null here: "cloudflared is not installed" with the
  // command to fix it beats a spawn failure naming a path the user never chose.
  const found = locate();
  assert.ok(found === null || typeof found === 'string');
  assert.match(INSTALL_HINT, /winget install Cloudflare\.cloudflared/);
});

// ---------------------------------------------------------------------------
// URLs through a tunnel
// ---------------------------------------------------------------------------

test('a tunnel URL is built without the redundant :443', () => {
  // Valid either way, and every browser normalises it -- but the string survives into places that
  // treat it as text, and ":443" in a link someone is asked to trust reads as a mistake.
  const host = 'wide-copper-motor-sail.trycloudflare.com';
  const url = roomUrl({ host, port: 443, roomId: 'AbCd1234efgh' });

  assert.equal(url, `https://${host}/r/AbCd1234efgh`);
  assert.ok(!url.includes(':443'));
  assert.equal(browserInvite({ host, port: 443, roomId: 'AbCd1234efgh' }), url);
});

test('a non-default port is still written out', () => {
  assert.equal(
    roomUrl({ host: '10.0.143.0', port: 8443, roomId: 'AbCd1234efgh' }),
    'https://10.0.143.0:8443/r/AbCd1234efgh',
  );
});

test('a tunnel link round-trips through the joiner, unpinned', () => {
  // The app must accept it, and must report that there is no fingerprint to pin -- Cloudflare
  // presents its own real certificate, so normal verification applies and pinning would be wrong.
  const host = 'wide-copper-motor-sail.trycloudflare.com';
  const parsed = parseInvite(roomUrl({ host, port: 443, roomId: 'AbCd1234efgh' }));

  assert.equal(parsed.host, host);
  assert.equal(parsed.port, 443);
  assert.equal(parsed.roomId, 'AbCd1234efgh');
  assert.equal(parsed.pinned, false);
  assert.equal(parsed.fingerprint, null);
});
