import net from 'node:net';
import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';
import { parseInvite } from '../../desktop/shared/invite.js';

/**
 * Can this port be bound? Run from the test process rather than inside the app, so it is an
 * independent observation: asking the app whether it has stopped listening is a question it
 * could answer wrongly in exactly the case that matters.
 */
const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });

test.describe.configure({ mode: 'serial' });

const PORT = 8502;

/**
 * Start hosting and return [main window, host panel].
 *
 * "Host" only gets as far as `/r/new`, which is the client's placeholder for "create a room when
 * someone actually arrives" -- the id is issued over the socket after the name is submitted. The
 * panel is keyed to a real room id precisely so it does not appear for a lobby that may be
 * abandoned, so the lobby has to be completed here rather than skipped.
 */
async function host(app, name = 'Host') {
  const main = await homeWindow(app);
  await main.getByTestId('host-button').click();
  await main.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 45_000 });

  await main.getByLabel('Your name').fill(name);
  await main.getByRole('button', { name: /create room/i }).click();
  await main.waitForURL(new RegExp(`^https://localhost:${PORT}/r/[A-Za-z0-9_-]{8,}$`), {
    timeout: 30_000,
  });

  const panel = await app.waitForEvent('window', { timeout: 30_000 });
  await panel.waitForLoadState('domcontentloaded');
  return [main, panel];
}

test('the room panel opens by itself and shows a usable invite', async () => {
  const app = await launchApp({ port: PORT });
  const [, panel] = await host(app);

  await expect(panel.getByTestId('host-status')).toContainText(`port ${PORT}`);
  await expect(panel.getByTestId('participant-count')).toContainText(/person|people/);

  // A real fingerprint, not a placeholder.
  await expect(panel.getByTestId('fingerprint')).toHaveText(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  await expect(panel.getByTestId('invite-link').first()).toBeVisible();

  await app.close();
});

test('the app link parses and pins; the browser link deliberately does not', async () => {
  // The two links are not interchangeable and the difference is the whole feature. This asserts
  // on the actual strings the panel offers, because a link that looks right and carries no
  // fingerprint would silently put every joiner back in front of a certificate warning.
  const app = await launchApp({ port: PORT });
  const [, panel] = await host(app);

  const card = panel.getByTestId('invite-link').first();
  const [appLink, browserLink] = await card.locator('code').allTextContents();

  const parsedApp = parseInvite(appLink);
  expect(parsedApp.pinned).toBe(true);
  expect(parsedApp.port).toBe(PORT);
  expect(parsedApp.fingerprint).toMatch(/^[0-9a-f]{64}$/);

  // And it matches the certificate the panel is displaying.
  const shown = (await panel.getByTestId('fingerprint').textContent()).replace(/:/g, '').toLowerCase();
  expect(parsedApp.fingerprint).toBe(shown);

  const parsedBrowser = parseInvite(browserLink);
  expect(parsedBrowser.pinned).toBe(false);
  expect(browserLink).not.toContain('fp=');
  expect(parsedBrowser.roomId).toBe(parsedApp.roomId);

  await app.close();
});

test('ending the room stops the server and returns to Home', async () => {
  const app = await launchApp({ port: PORT });
  const [main, panel] = await host(app);

  await panel.getByTestId('stop-hosting').click();

  // Back at Home in the main window...
  await expect(main.getByTestId('host-card')).toBeVisible({ timeout: 20_000 });

  // ...and the port is genuinely released, not merely hidden behind a changed screen.
  await expect
    .poll(() => portIsFree(PORT), { timeout: 15_000, message: 'the server should release the port' })
    .toBe(true);

  await app.close();
});

test('quitting while hosting shuts the server down', async () => {
  const app = await launchApp({ port: PORT });
  await host(app);
  await app.close();

  // Nothing is listening once the app is gone. Without the before-quit hook the process can exit
  // with the listener still bound, and the next launch fails on a port conflict that reads as
  // "the app is broken" rather than "the last one did not clean up after itself".
  await expect.poll(() => portIsFree(PORT), { timeout: 15_000 }).toBe(true);
});
