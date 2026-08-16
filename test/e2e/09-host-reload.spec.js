import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('the host keeps the role across a reload', async ({ browser }) => {
  // The mechanism under test: the host token lives in the URL fragment, is stripped from the
  // address bar immediately, and is written back only as the page unloads -- so a reload can
  // find it while a screen share never renders it.
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  expect(await host.evaluate(() => window.__app.isHost())).toBe(true);
  expect(host.url(), 'the token must not sit in the address bar during the session').not.toContain(
    '#',
  );

  await host.reload();
  await host.getByLabel('Your name').fill('Host');
  await host.getByRole('button', { name: /join room/i }).click();
  await expect(host.getByTestId('participants-count')).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(() => host.evaluate(() => window.__app.isHost()), {
      timeout: 15_000,
      message: 'the host should reclaim the role after a reload',
    })
    .toBe(true);

  // A reconnecting peer gets a new id, so every other client must be told who the host is now
  // -- otherwise their hostPeerId still points at a peer that just left.
  const newHostId = await selfId(host);
  await expect
    .poll(() => guest.evaluate(() => window.__app.isHost()), { timeout: 10_000 })
    .toBe(false);

  // Only the host has the End control.
  await expect(host.getByTestId('end-session')).toBeVisible();
  await expect(guest.getByTestId('end-session')).toBeHidden();

  expect(newHostId).toBeTruthy();
  await hostCtx.close();
  await guestCtx.close();
});

test('the room keeps a host when the original one disappears for good', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(guest, 1);

  await expect(guest.getByTestId('end-session')).toBeHidden();

  // The host vanishes without leaving. The default grace is 30s, which is longer than this
  // test should wait -- so the guarantee asserted here is the one that matters at any
  // timescale: the room never ends up with nobody able to end it.
  await hostCtx.close();

  await expect
    .poll(() => guest.evaluate(() => window.__app.isHost()), {
      timeout: 60_000,
      message: 'the remaining participant should be promoted once the grace window expires',
    })
    .toBe(true);

  await expect(guest.getByTestId('end-session')).toBeVisible();

  await guestCtx.close();
});
