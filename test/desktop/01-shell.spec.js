import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';

test.describe.configure({ mode: 'serial' });

const PORT = 8501;

test('the app launches and shows the Home screen @smoke', async () => {
  const app = await launchApp({ port: PORT });
  const home = await homeWindow(app);

  await expect(home.getByTestId('host-card')).toBeVisible();
  await expect(home.getByTestId('join-card')).toBeVisible();
  await expect(home.getByTestId('host-button')).toBeEnabled();

  // Join stays disabled until there is a link to act on, so the button cannot be pressed into
  // an error that the input could have prevented.
  await expect(home.getByTestId('join-button')).toBeDisabled();

  await app.close();
});

test('the link box validates as you type, before anything is pressed', async () => {
  const app = await launchApp({ port: PORT });
  const home = await homeWindow(app);

  const input = home.getByTestId('join-input');
  const preview = home.getByTestId('join-preview');
  const joinButton = home.getByTestId('join-button');

  await input.fill('total nonsense');
  await expect(preview).toContainText(/does not look like a link/i);
  await expect(joinButton).toBeDisabled();

  // A well-formed desktop invite says plainly that it can be pinned.
  const fp = 'a'.repeat(64);
  await input.fill(`streamer://join?h=192.168.1.34:8443&r=AbCd1234efgh&fp=${fp}`);
  await expect(preview).toContainText('192.168.1.34:8443');
  await expect(preview).toContainText(/pinned/i);
  await expect(joinButton).toBeEnabled();

  // A pasted https link works, and says out loud that it cannot be pinned -- the difference is
  // the entire point of the desktop link, so it must not be presented as equivalent.
  await input.fill('https://192.168.1.34:8443/r/AbCd1234efgh');
  await expect(preview).toContainText(/no fingerprint/i);
  await expect(joinButton).toBeEnabled();

  await app.close();
});

test('hosting starts a real server and opens a real room', async () => {
  const app = await launchApp({ port: PORT });
  const home = await homeWindow(app);

  await home.getByTestId('host-button').click();

  // The window navigates itself to the room on our own server. Waiting on the URL rather than a
  // fixed delay also proves the server answered.
  await home.waitForURL(new RegExp(`^https://localhost:${PORT}/r/`), { timeout: 45_000 });

  // And it is the real web client, not a placeholder or an error page: the name prompt is what
  // room.html renders before joining.
  await expect(home.getByLabel('Your name')).toBeVisible({ timeout: 20_000 });

  const status = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { url: win.webContents.getURL() };
  });
  expect(status.url).toContain(`https://localhost:${PORT}/r/`);

  await app.close();
});

test('the room page is told it is inside the desktop app, and gets nothing else', async () => {
  // The preload runs in the room page too, and that page is served by whichever machine is
  // hosting -- possibly someone else's. It must receive the flag and none of the control surface.
  const app = await launchApp({ port: PORT });
  const home = await homeWindow(app);

  await home.getByTestId('host-button').click();
  await home.waitForURL(new RegExp(`^https://localhost:${PORT}/r/`), { timeout: 45_000 });
  await expect(home.getByLabel('Your name')).toBeVisible({ timeout: 20_000 });

  const exposed = await home.evaluate(() => ({
    desktopFlag: window.__DESKTOP__,
    hasControlBridge: typeof window.streamer !== 'undefined',
  }));

  expect(exposed.desktopFlag).toBe(true);
  expect(
    exposed.hasControlBridge,
    'a remote page must not be able to start servers or read fingerprints',
  ).toBe(false);

  await app.close();
});
