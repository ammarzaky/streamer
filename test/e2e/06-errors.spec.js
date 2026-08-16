import { test, expect } from '@playwright/test';
import { ERRORS } from '../../public/shared/protocol.js';
import { ERROR_COPY } from '../../public/js/ui/strings.js';
import { createRoom, joinRoom, waitConnected } from './helpers/app.js';

/**
 * Failure paths. Every assertion compares against the imported copy constant rather than a
 * pasted string, so the product and its tests cannot drift apart.
 */

test('joining a room that does not exist explains itself', async ({ page }) => {
  // Well-formed but unknown id: the shape is valid, so this exercises the room lookup rather
  // than the router.
  await page.goto('/r/zzzzzzzzzzzzzzzzzzzzzz');
  await page.getByLabel('Your name').fill('Nobody');
  await page.getByRole('button', { name: /join room/i }).click();

  await expect(page.locator('#lobby-banner')).toContainText(
    ERROR_COPY[ERRORS.ROOM_NOT_FOUND].message,
    { timeout: 15_000 },
  );
});

test('malformed and out-of-range paths are 404, and traversal is refused', async ({ request }) => {
  // Checked over HTTP rather than by navigating: a status assertion should not depend on how
  // the browser renders an error page.
  for (const path of ['/r/bad!', '/r/a/b', '/r/', '/nope.html']) {
    const response = await request.get(path, { failOnStatusCode: false });
    expect(response.status(), `${path} should be 404`).toBe(404);
  }

  // The room id is the access credential and the static root is the only thing serving files,
  // so escaping it must be impossible in both raw and encoded forms.
  for (const path of ['/../config.default.json', '/%2e%2e/config.default.json', '/../../src/index.js']) {
    const response = await request.get(path, { failOnStatusCode: false });
    expect([403, 404], `${path} must not be served`).toContain(response.status());
  }
});

test('a valid room path serves the room document', async ({ request }) => {
  for (const path of ['/r/new', '/r/AbC-123_xyzXYZ0987']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('id="lobby"');
  }
});

test('a full room says so, and says what to do', async ({ browser }) => {
  // maxParticipants is 4 by default; fill it and try a fifth.
  const contexts = [];
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    pages.push(await ctx.newPage());
  }

  const roomUrl = await createRoom(pages[0], 'Host');
  for (let i = 1; i < 4; i++) await joinRoom(pages[i], roomUrl, `Guest${i}`);
  await waitConnected(pages[0], 3, 45_000);

  const extraCtx = await browser.newContext();
  const extra = await extraCtx.newPage();
  await extra.goto(roomUrl);
  await extra.getByLabel('Your name').fill('Fifth');
  await extra.getByRole('button', { name: /join room/i }).click();

  await expect(extra.locator('#lobby-banner')).toContainText(
    ERROR_COPY[ERRORS.ROOM_FULL].message,
    { timeout: 15_000 },
  );

  await extraCtx.close();
  for (const ctx of contexts) await ctx.close();
});

test('a dropped signaling socket reconnects on its own', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await createRoom(page, 'Host');

  await expect.poll(() => page.evaluate(() => window.__app.signalingStatus())).toBe('open');

  // Drop it with a non-terminal code -- the branch a genuine network failure takes.
  await page.evaluate(() => window.__app.dropSocket());

  // The user is told, rather than left looking at a frozen page.
  await expect(page.getByTestId('room-banner')).toBeVisible({ timeout: 10_000 });

  // And it comes back without any intervention.
  await expect
    .poll(() => page.evaluate(() => window.__app.signalingStatus()), {
      timeout: 30_000,
      message: 'the client should reconnect after a non-terminal close',
    })
    .toBe('open');

  await ctx.close();
});

test('every server error code has user-facing copy', async () => {
  // A code with no message renders as a blank toast, which in an app that promises no silent
  // failures is itself a silent failure.
  const { SERVER_ERROR_CODES } = await import('../../public/shared/protocol.js');
  for (const code of SERVER_ERROR_CODES) {
    expect(ERROR_COPY[code], `no copy for ${code}`).toBeTruthy();
    expect(ERROR_COPY[code].message.length, `empty message for ${code}`).toBeGreaterThan(0);
  }
});
