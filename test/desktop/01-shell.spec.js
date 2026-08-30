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

test('the Debug menu offers the Windows microphone status item', async () => {
  // The OS mute check lives behind Core Audio, so the menu item only exists on Windows. The
  // check itself is not exercised here: the suite runs with a fake capture device and must not
  // depend on, or change, the mute state of the machine it runs on.
  test.skip(process.platform !== 'win32', 'the Windows mute check is Windows only');

  const app = await launchApp({ port: PORT });
  await homeWindow(app);

  const labels = await app.evaluate(({ Menu }) => {
    const debug = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Debug');
    return debug?.submenu?.items.map((item) => item.label) ?? [];
  });
  expect(labels).toContain('Windows microphone status…');
  expect(labels).toContain('Open log folder');

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

test('fullscreen works inside the desktop app, not just in a browser', async () => {
  // This test exists because of a bug it would have caught and the browser suite could not.
  //
  // Chromium treats requestFullscreen() as a *permission*. The main process installs a
  // setPermissionRequestHandler that allow-lists only what the app needs, and 'fullscreen' was
  // missing from that list -- so every attempt was denied in silence. No error, no rejected
  // promise worth reading, just a button that did nothing.
  //
  // The browser E2E asserted the same behaviour and passed the whole time, because a plain
  // browser has no Electron permission handler to deny it. A feature gated by main-process
  // policy has to be tested where that policy actually runs.
  const app = await launchApp({ port: PORT });
  const home = await homeWindow(app);

  await home.getByTestId('host-button').click();
  await home.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 45_000 });
  await home.getByLabel('Your name').fill('Host');
  await home.getByRole('button', { name: /create room/i }).click();
  await home.waitForURL(new RegExp(`^https://localhost:${PORT}/r/[A-Za-z0-9_-]{8,}$`), {
    timeout: 30_000,
  });

  await home.getByTestId('fullscreen-toggle').click();

  await expect
    .poll(() => home.evaluate(() => document.fullscreenElement?.id ?? null), {
      timeout: 15_000,
      message: 'the fullscreen permission is denied by the main process',
    })
    .toBe('stage');

  // Leaving must work from the overlay, since the real control bar is off-screen in fullscreen.
  await home.getByTestId('overlay-exit').click();
  await expect
    .poll(() => home.evaluate(() => document.fullscreenElement?.id ?? null), { timeout: 15_000 })
    .toBe(null);

  await app.close();
});

/**
 * The window whose page URL contains `fragment`, once it has loaded.
 *
 * Polled from `app.windows()` rather than `app.waitForEvent('window')`: the event only reports
 * windows that open *after* the wait begins, and the app opens windows unprompted -- the host
 * panel appears by itself the moment a room id exists -- so an event-based wait either misses
 * the window or catches the wrong one.
 */
async function windowLoading(app, fragment) {
  let found;
  await expect
    .poll(
      () => {
        found = app.windows().find((page) => page.url().includes(fragment));
        return Boolean(found);
      },
      { timeout: 30_000, message: `no window is loading ${fragment}` },
    )
    .toBe(true);
  await found.waitForLoadState('domcontentloaded');
  return found;
}

/** Host and create a room, returning the room window once it is on the real room URL. */
async function hostRoom(app) {
  const home = await homeWindow(app);
  await home.getByTestId('host-button').click();
  await home.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 45_000 });
  await home.getByLabel('Your name').fill('Host');
  await home.getByRole('button', { name: /create room/i }).click();
  await home.waitForURL(new RegExp(`^https://localhost:${PORT}/r/[A-Za-z0-9_-]{8,}$`), {
    timeout: 30_000,
  });
  // The host panel opens by itself on that navigation. Wait for it here so a test that opens a
  // window of its own next is not racing against it.
  await windowLoading(app, 'host.html');
  return home;
}

test('the picker offers a system-audio checkbox that is on by default', async () => {
  // Loopback capture only exists on Windows (desktop/capture.js), so the checkbox is only
  // meaningful there. Elsewhere the test would be asserting a UI for a feature that cannot run.
  test.skip(process.platform !== 'win32', 'system-audio loopback is Windows only');

  const app = await launchApp({ port: PORT });
  const home = await hostRoom(app);

  await home.getByTestId('share-toggle').click();
  const picker = await windowLoading(app, 'picker.html');

  // Default on: sharing a screen without its sound is the surprise, not the other way round.
  const systemAudio = picker.getByTestId('picker-system-audio');
  await expect(systemAudio).toBeVisible();
  await expect(systemAudio).toBeChecked();

  // And the choice is honoured: untick it and the room must not end up with a display-audio
  // track, or the "share audio" toggle is decoration.
  await systemAudio.uncheck();
  await expect(systemAudio).not.toBeChecked();

  const sources = picker.getByTestId('picker-source');
  await expect(sources.first()).toBeVisible({ timeout: 20_000 });
  await sources.first().click();
  await expect(picker.getByTestId('picker-share')).toBeEnabled();
  await picker.getByTestId('picker-share').click();

  await expect
    .poll(() => home.evaluate(() => window.__app.share().sharerId === window.__app.selfId()), {
      timeout: 20_000,
      message: 'the share should start',
    })
    .toBe(true);
  await expect
    .poll(() => home.evaluate(() => window.__app.hasDisplayAudio()), {
      timeout: 20_000,
      message: 'unticking system audio must leave the share without an audio track',
    })
    .toBe(false);

  await app.close();
});

test('the room shows the level bar and the mic device label in the desktop app', async () => {
  // The level bar and the device label both depend on getUserMedia succeeding under Electron's
  // permission handler -- the same class of main-process policy the fullscreen test guards.
  // The browser suite cannot tell us whether the desktop app actually got a microphone.
  const app = await launchApp({ port: PORT });
  const home = await hostRoom(app);

  await expect(home.getByTestId('room-meter')).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(() => home.evaluate(() => window.__app.micSettings()?.label ?? ''), {
      timeout: 20_000,
      message: 'the microphone label should be known once the mic is acquired',
    })
    .not.toBe('');

  await app.close();
});
