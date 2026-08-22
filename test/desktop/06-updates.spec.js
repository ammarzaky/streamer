import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';

test.describe.configure({ mode: 'serial' });

/**
 * The rule these tests encode: an update check must never be the reason someone has a bad time.
 *
 * Running unpackaged, having no network, hitting a rate limit, or there being no release yet are
 * all normal, and none of them are why the app was opened. They must produce a quiet line of text
 * and a working app -- never a dialog, never a blocked Home screen, and never a claim of being
 * "up to date" when the truth is that nothing could be checked.
 */

test('the Home screen shows which build is running', async () => {
  // So "which version are you on" is never a question asked over chat.
  const app = await launchApp();
  const home = await homeWindow(app);

  await expect(home.getByTestId('update-version')).toHaveText(/Streamer \d+\.\d+\.\d+/, {
    timeout: 20_000,
  });

  await app.close();
});

test('an update check that cannot run says so, and does not claim to be up to date', async () => {
  // Run from source, so electron-updater has no packaging metadata -- the same shape as a failed
  // check. "Up to date" here would be a different claim entirely, and would stop anyone looking
  // for the real reason.
  const app = await launchApp();
  const home = await homeWindow(app);

  await expect(home.getByTestId('update-status')).toHaveText(/could not check/i, {
    timeout: 25_000,
  });
  await expect(home.getByTestId('update-status')).not.toHaveText(/up to date/i);

  // And it offers a way to try again rather than being a dead end.
  await expect(home.getByTestId('update-action')).toHaveText(/retry/i);

  await app.close();
});

test('a failed update check leaves the app completely usable', async () => {
  // The point of the whole design: hosting and joining must not depend on GitHub being reachable.
  const app = await launchApp({ port: 8506 });
  const home = await homeWindow(app);

  await expect(home.getByTestId('update-status')).toHaveText(/could not check/i, { timeout: 25_000 });

  await expect(home.getByTestId('host-button')).toBeEnabled();
  await home.getByTestId('join-input').fill('streamer://join?h=1.2.3.4:8443&r=AbCd1234efgh&fp=' + 'a'.repeat(64));
  await expect(home.getByTestId('join-button')).toBeEnabled();

  await home.getByTestId('host-button').click();
  await home.waitForURL('https://localhost:8506/r/new', { timeout: 45_000 });

  await app.close();
});
