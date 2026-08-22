import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, expect, _electron as electron } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGED = path.join(ROOT, 'dist', 'win-unpacked', 'Streamer.exe');
const PORT = 8504;

/**
 * These run against the built application rather than the source tree, and they are skipped when
 * no build is present so `npm test` stays useful without one.
 *
 * What only a packaged run can catch: the application directory is read-only once installed, so
 * anything still resolving paths relative to it fails here and nowhere else -- on someone else's
 * machine, at first launch, with an EACCES that names a directory they did not know existed.
 */
test.describe('packaged application', () => {
  test.skip(!existsSync(PACKAGED), 'no build in dist/ — run `npm run build:dir` first');

  let userDataDir;

  test.beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'streamer-pkg-'));
  });

  test.afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const launch = () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.STREAMER_DESKTOP_TEST = '1';
    env.STREAMER_PORT = String(PORT);
    env.STREAMER_HTTP_PORT = String(PORT - 363);
    env.STREAMER_LOG_LEVEL = 'warn';

    return electron.launch({
      executablePath: PACKAGED,
      args: [`--user-data-dir=${userDataDir}`],
      env,
    });
  };

  test('the built app launches and can host', async () => {
    const app = await launch();
    const home = await app.firstWindow();
    await home.waitForLoadState('domcontentloaded');

    await expect(home.getByTestId('host-card')).toBeVisible();

    await home.getByTestId('host-button').click();
    await home.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 60_000 });
    await expect(home.getByLabel('Your name')).toBeVisible({ timeout: 20_000 });

    await app.close();
  });

  test('certificates are generated into userData, not the read-only app directory', async () => {
    const app = await launch();
    const home = await app.firstWindow();
    await home.waitForLoadState('domcontentloaded');

    await home.getByTestId('host-button').click();
    await home.waitForURL(`https://localhost:${PORT}/r/new`, { timeout: 60_000 });

    const certs = path.join(userDataDir, 'certs');
    expect(existsSync(certs), 'certs/ should be created under userData').toBe(true);
    expect(readdirSync(certs).sort()).toEqual(['ca.crt', 'ca.key', 'server.crt', 'server.key']);

    // And nothing was written next to the executable, which on a real install is not writable.
    expect(existsSync(path.join(ROOT, 'dist', 'win-unpacked', 'certs'))).toBe(false);

    await app.close();
  });
});
