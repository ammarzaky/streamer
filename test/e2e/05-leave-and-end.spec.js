import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('leaving removes the tile from everyone else', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const guestId = await selfId(guest);
  await expect(host.getByTestId(`participant-${guestId}`)).toBeVisible();

  await guest.getByTestId('leave').click();
  await guest.getByTestId('dialog-confirm').click();

  await expect(host.getByTestId(`participant-${guestId}`)).toBeHidden({ timeout: 15_000 });
  await expect(host.getByTestId('participants-count')).toHaveText('1');
  expect(await host.evaluate(() => window.__app.connections().length)).toBe(0);

  await hostCtx.close();
  await guestCtx.close();
});

test('an abruptly closed tab is cleaned up too', async ({ browser }) => {
  // The graceful path sends `leave`; this one proves the server also copes when the page just
  // disappears, which is what actually happens most of the time.
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const guestId = await selfId(guest);
  await guestCtx.close();

  await expect(host.getByTestId(`participant-${guestId}`)).toBeHidden({ timeout: 20_000 });
  await expect(host.getByTestId('participants-count')).toHaveText('1');

  await hostCtx.close();
});

test('the host ending the session ends it for everyone', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(guest, 1);

  // Only the host has the control at all.
  await expect(host.getByTestId('end-session')).toBeVisible();
  await expect(guest.getByTestId('end-session')).toBeHidden();

  await host.getByTestId('end-session').click();
  await host.getByTestId('dialog-confirm').click();

  // Both sides land on the ended screen -- and the guest must NOT be shown "this room does
  // not exist", which is what a reconnect after room-ended would produce.
  for (const page of [host, guest]) {
    await expect(page.locator('.fatal')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.fatal')).toContainText(/ended the session/i);
    await expect(page.locator('.fatal')).not.toContainText(/doesn't exist/i);
  }

  // And the link is dead afterwards.
  const rejoin = await browser.newContext();
  const page = await rejoin.newPage();
  await page.goto(roomUrl);
  await page.getByLabel('Your name').fill('Late');
  await page.getByRole('button', { name: /join room/i }).click();
  await expect(page.locator('.banner--danger, .fatal')).toContainText(/doesn't exist|already ended/i, {
    timeout: 15_000,
  });

  await rejoin.close();
  await hostCtx.close();
  await guestCtx.close();
});
