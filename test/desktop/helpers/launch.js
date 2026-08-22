import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Launch the app the way a user would, but isolated.
 *
 * Two isolations matter. A fresh `--user-data-dir` per test means certificates are generated from
 * scratch rather than inherited, which is the state a new install is actually in -- and it keeps
 * a test from writing into the developer's real profile. A port distinct from the dev server's
 * means a suite run does not fight whatever is already listening on 8443.
 */
export async function launchApp({ port, env: extra = {} } = {}) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'streamer-e2e-'));

  // ELECTRON_RUN_AS_NODE is set inside some editor-hosted terminals, and it makes electron.exe
  // behave as a bare Node binary -- no app, no window, and an error that names neither.
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  env.STREAMER_DESKTOP_TEST = '1';
  env.STREAMER_LOG_LEVEL = env.STREAMER_LOG_LEVEL ?? 'warn';
  if (port) env.STREAMER_PORT = String(port);
  // The plain-HTTP redirect listener needs its own free port too, or hosting fails on a bind
  // conflict that has nothing to do with the test.
  if (port) env.STREAMER_HTTP_PORT = String(port - 363);

  const app = await electron.launch({
    args: [path.join(ROOT, 'desktop/main.js'), `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env,
  });

  app.on('close', () => rmSync(userDataDir, { recursive: true, force: true }));
  return app;
}

/** The Home screen window, once it has finished loading. */
export async function homeWindow(app) {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return window;
}

/** Read main-process state without reaching into internals from the renderer. */
export const mainEval = (app, fn, arg) => app.evaluate(fn, arg);
