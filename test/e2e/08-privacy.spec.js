import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, share, waitConnected, senders, selfId } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('a full session makes no third-party requests and stores nothing', async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const foreign = [];
  ctx.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(baseURL)) return;
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    foreign.push(url);
  });

  const roomUrl = await createRoom(page, 'Host');

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(page, 1);
  await share(page);
  await page.waitForTimeout(2000);

  // No CDN, no fonts, no analytics. Note this covers HTTP-level traffic only -- STUN is UDP
  // and Playwright cannot observe it, which is why the docs state the STUN caveat separately
  // rather than implying this test covers it.
  expect(foreign, 'no third-party HTTP requests').toEqual([]);

  const persisted = await page.evaluate(async () => ({
    local: localStorage.length,
    sessionKeys: Object.keys(sessionStorage),
    cookie: document.cookie,
    idb: (await indexedDB.databases?.())?.length ?? 0,
    caches: (await caches?.keys?.())?.length ?? 0,
  }));

  expect(persisted.local, 'nothing in localStorage').toBe(0);
  expect(persisted.cookie, 'no cookies').toBe('');
  expect(persisted.idb, 'no IndexedDB').toBe(0);
  expect(persisted.caches, 'nothing cached').toBe(0);

  // sessionStorage holds at most two things, both per-tab and both gone when the tab closes:
  // the host token, so a host who reloads gets their role back, and the audio preferences
  // (which speaker, and how loud each participant is). Neither is written until the feature
  // that owns it is used, and this session uses neither speaker picking nor a volume slider --
  // so the audio key is ALLOWED here, not required. The set is asserted exactly rather than
  // waved at, so a third key appearing anywhere fails the build.
  const hostKey = 'streamer:host:' + new URL(roomUrl).pathname.split('/').pop();
  const allowed = new Set([hostKey, 'streamer:audio']);
  for (const key of persisted.sessionKeys) {
    expect(allowed.has(key), `unexpected sessionStorage key: ${key}`).toBe(true);
  }
  expect(persisted.sessionKeys, 'the host token is always there').toContain(hostKey);

  await guestCtx.close();
  await ctx.close();
});

test('the copied invite link never carries the host token', async ({ browser }) => {
  // This is the single point where a mistake would leak host rights, and it leaks them into
  // a chat message where they persist. Worth its own test.
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();

  await createRoom(page, 'Host');
  await page.getByTestId('copy-link').click();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).not.toContain('#');
  expect(copied).toMatch(/^https?:\/\/[^/]+\/r\/[A-Za-z0-9_-]+$/);

  await ctx.close();
});

test('muting the microphone leaves the shared system audio playing', async ({ browser }) => {
  // Both are `kind: 'audio'`, so a test that cannot tell the senders apart proves nothing.
  // The role tag is what makes this assertion meaningful -- and it is exactly the distinction
  // a careless refactor would collapse.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await share(host);
  const guestId = await selfId(guest);

  await expect
    .poll(async () => (await senders(host, guestId)).some((s) => s.role === 'shareAudio' && s.hasTrack), {
      timeout: 15_000,
      message: 'the synthetic share should carry an audio track',
    })
    .toBe(true);

  // Unmute, then mute, so the transition is real rather than the initial state.
  await host.getByTestId('mic-toggle').click();
  await expect.poll(() => host.evaluate(() => window.__app.micMuted())).toBe(false);
  await host.getByTestId('mic-toggle').click();
  await expect.poll(() => host.evaluate(() => window.__app.micMuted())).toBe(true);

  const tagged = await senders(host, guestId);
  const mic = tagged.find((s) => s.role === 'mic');
  const shareAudio = tagged.find((s) => s.role === 'shareAudio');

  expect(mic.trackEnabled, 'the microphone track should be disabled').toBe(false);
  expect(shareAudio.hasTrack, 'the shared audio track must still be attached').toBe(true);
  expect(
    shareAudio.trackEnabled,
    'muting the mic must not silence the audio of what is being shared',
  ).toBe(true);

  await hostCtx.close();
  await guestCtx.close();
});
