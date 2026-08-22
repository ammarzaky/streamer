import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';
import { parseInvite, formatInvite } from '../../desktop/shared/invite.js';

test.describe.configure({ mode: 'serial' });

const PORT = 8503;

/** Host a room and return the window, the panel, and the app invite link. */
async function openRoom(app) {
  const main = await homeWindow(app);
  await main.getByTestId('host-button').click();
  await main.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 45_000 });

  await main.getByLabel('Your name').fill('Host');
  await main.getByRole('button', { name: /create room/i }).click();
  await main.waitForURL(new RegExp(`^https://localhost:${PORT}/r/[A-Za-z0-9_-]{8,}$`), {
    timeout: 30_000,
  });

  const panel = await app.waitForEvent('window', { timeout: 30_000 });
  await panel.waitForLoadState('domcontentloaded');

  // The localhost entry is the one a second instance on this machine can actually reach.
  const card = panel.getByTestId('invite-link').filter({ hasText: 'localhost' }).first();
  const [link] = await card.locator('code').allTextContents();
  return { main, panel, link };
}

test('two app instances join the same room through a pinned invite @smoke', async () => {
  // The whole product in one test: one machine hosts, another opens the link it was sent, and
  // nobody installs a certificate or dismisses a warning on the way.
  const hostApp = await launchApp({ port: PORT });
  const { main: hostWin, link } = await openRoom(hostApp);

  expect(parseInvite(link).pinned, 'the invite must carry a fingerprint').toBe(true);

  const guestApp = await launchApp();
  const guestHome = await homeWindow(guestApp);

  const rejections = [];
  guestHome.on('console', (message) => {
    if (/certificate/i.test(message.text())) rejections.push(message.text());
  });

  await guestHome.getByTestId('join-input').fill(link);
  await expect(guestHome.getByTestId('join-preview')).toContainText(/pinned/i);
  await guestHome.getByTestId('join-button').click();

  // Reaching the lobby at all proves the TLS handshake succeeded against a self-signed
  // certificate with no CA installed and no interstitial -- which is the entire feature.
  await guestHome.waitForURL(new RegExp(`^https://localhost:${PORT}/r/`), { timeout: 45_000 });
  await expect(guestHome.getByLabel('Your name')).toBeVisible({ timeout: 20_000 });

  await guestHome.getByLabel('Your name').fill('Guest');
  await guestHome.getByRole('button', { name: /join room/i }).click();

  // Both sides agree there are two people, which means the WebSocket is up in both directions.
  await expect(hostWin.getByTestId('participants-count')).toHaveText('2', { timeout: 30_000 });
  await expect(guestHome.getByTestId('participants-count')).toHaveText('2', { timeout: 30_000 });

  expect(rejections, 'no certificate should have been refused').toEqual([]);

  await guestApp.close();
  await hostApp.close();
});

test('an invite whose fingerprint does not match is refused, not warned about', async () => {
  // The security assertion. A browser would show an interstitial here and let the user click
  // past it; the app must simply not connect, and must say why in a way that does not read as
  // an ordinary network hiccup.
  const hostApp = await launchApp({ port: PORT });
  const { link } = await openRoom(hostApp);

  const real = parseInvite(link);
  const tampered = formatInvite({
    host: real.host,
    port: real.port,
    roomId: real.roomId,
    // A valid, well-formed digest of the wrong certificate.
    fingerprint: 'b'.repeat(64),
  });

  const guestApp = await launchApp();
  const guestHome = await homeWindow(guestApp);

  await guestHome.getByTestId('join-input').fill(tampered);
  await guestHome.getByTestId('join-button').click();

  // The navigation fails and the app says so in its own words.
  await expect(guestHome.getByTestId('home-error')).toBeVisible({ timeout: 30_000 });
  await expect(guestHome.getByTestId('home-error')).toContainText(/certificate/i);

  // And it did not quietly end up in the room anyway.
  expect(guestHome.url()).toContain('home.html');

  await guestApp.close();
  await hostApp.close();
});

test('the in-app picker shares a real screen, with no browser dialog', async () => {
  const hostApp = await launchApp({ port: PORT });
  const { main: hostWin } = await openRoom(hostApp);

  await hostWin.getByTestId('share-toggle').click();

  // Our own window, not Chrome's dialog.
  const picker = await hostApp.waitForEvent('window', { timeout: 30_000 });
  await picker.waitForLoadState('domcontentloaded');
  await expect(picker.getByTestId('picker-grid')).toBeVisible();

  const sources = picker.getByTestId('picker-source');
  await expect(sources.first()).toBeVisible({ timeout: 20_000 });

  await sources.first().click();
  await expect(picker.getByTestId('picker-share')).toBeEnabled();
  await picker.getByTestId('picker-share').click();

  // Real frames reach the sharer's own preview, which is the only proof the chosen source became
  // a live track rather than a black rectangle.
  await expect
    .poll(
      () =>
        hostWin.evaluate(() => {
          const video = document.querySelector('[data-testid="stage-video"]');
          return video && !video.paused ? video.videoWidth : 0;
        }),
      { timeout: 45_000, message: 'the chosen source should be painting frames' },
    )
    .toBeGreaterThan(0);

  await hostApp.close();
});

test('cancelling the picker leaves the app usable rather than stuck', async () => {
  // getDisplayMedia never resolving would leave the Share button dead with no way back, and the
  // failure would look like a hang rather than a cancellation.
  const hostApp = await launchApp({ port: PORT });
  const { main: hostWin } = await openRoom(hostApp);

  await hostWin.getByTestId('share-toggle').click();
  const picker = await hostApp.waitForEvent('window', { timeout: 30_000 });
  await picker.waitForLoadState('domcontentloaded');
  await picker.getByTestId('picker-cancel').click();

  // The button comes back, and a second attempt opens a fresh picker.
  await expect(hostWin.getByTestId('share-toggle')).toBeEnabled({ timeout: 20_000 });
  await hostWin.getByTestId('share-toggle').click();

  const second = await hostApp.waitForEvent('window', { timeout: 30_000 });
  await second.waitForLoadState('domcontentloaded');
  await expect(second.getByTestId('picker-grid')).toBeVisible();

  await hostApp.close();
});
