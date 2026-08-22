import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';

test.describe.configure({ mode: 'serial' });

const PORT = 8505;
const FAKE_URL = 'https://wide-copper-motor-sail.trycloudflare.com';

/**
 * A stand-in for cloudflared.
 *
 * The real thing needs the internet and hands out a different hostname every run, neither of
 * which belongs in a test. What is actually under test here is our side of the contract: that we
 * spawn it, read a URL out of its output, surface that as an invite link, and kill the process
 * afterwards. A stub that prints the real banner shape exercises all of that deterministically.
 *
 * `behaviour` picks what it does: announce a URL, exit with an error, or start and stay silent.
 */
function makeStubCloudflared(behaviour = 'ok') {
  const dir = mkdtempSync(path.join(tmpdir(), 'streamer-cf-'));
  const script = path.join(dir, 'stub.js');

  writeFileSync(
    script,
    behaviour === 'ok'
      ? `process.stderr.write([
           '2026-08-18T12:00:00Z INF +------------------------------------------+',
           '2026-08-18T12:00:00Z INF |  Your quick Tunnel has been created!      |',
           '2026-08-18T12:00:00Z INF |  ${FAKE_URL}  |',
           '2026-08-18T12:00:00Z INF +------------------------------------------+',
           ''
         ].join('\\n'));
         // Hold the process open the way a real tunnel does, so "is it killed on stop" is a
         // question the test can actually ask.
         setInterval(() => {}, 1000);`
      : `process.stderr.write('ERR failed to connect to the Cloudflare edge\\n');
         process.exit(1);`,
  );

  // A .cmd shim, because Windows will not spawn a bare .js file as a program.
  const shim = path.join(dir, 'cloudflared.cmd');
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return { dir, shim, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** How many stub processes are alive, read from the OS rather than from the app. */
function countStubProcesses(dir) {
  // PowerShell's -like treats backslash as an ordinary character, so the path goes in as-is.
  // Escaping it the way a regex would need silently produces a pattern that matches nothing --
  // which reads as "the process is gone" and would make this test pass for the wrong reason.
  const needle = dir.replace(/'/g, "''");
  const script = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*${needle}*' } | Measure-Object).Count`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Host a room and return [main window, host panel]. */
async function host(app) {
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
  return [main, panel];
}

test('switching the tunnel on publishes a public invite link', async () => {
  const stub = makeStubCloudflared('ok');
  const app = await launchApp({ port: PORT, env: { STREAMER_CLOUDFLARED: stub.shim } });

  try {
    const [, panel] = await host(app);

    // Before the tunnel, nothing on offer reaches beyond this machine or this LAN -- which is the
    // gap that would otherwise be discovered mid-call, after the link had already been sent.
    await expect(panel.getByTestId('invite-link').first()).toBeVisible();
    expect(await panel.locator('[data-testid="invite-link"][data-scope="internet"]').count()).toBe(0);

    await panel.getByTestId('tunnel-toggle').click();

    await expect(panel.getByTestId('tunnel-note')).toContainText(FAKE_URL, { timeout: 30_000 });

    // It is listed first, because burying the only address that works abroad under localhost and
    // a 10.x address is how the wrong link gets copied.
    const first = panel.getByTestId('invite-link').first();
    await expect(first).toHaveAttribute('data-scope', 'internet');
    await expect(first).toContainText('wide-copper-motor-sail.trycloudflare.com');

    const [link] = await first.locator('code').allTextContents();
    expect(link).toBe(`${FAKE_URL}/r/${new URL(app.windows()[0].url()).pathname.split('/').pop()}`);
    // No redundant :443, and no fingerprint -- Cloudflare presents its own real certificate, so
    // there is nothing of ours to pin.
    expect(link).not.toContain(':443');
    expect(link).not.toContain('fp=');

    await app.close();
  } finally {
    stub.cleanup();
  }
});

test('the tunnel process is killed when the room ends', async () => {
  // A cloudflared left running keeps a public hostname pointing at a port that no longer answers.
  // It is a process the user never started by hand and will not think to stop.
  //
  // The check is made from outside the app, against the OS process table, rather than by asking
  // the app whether it thinks it cleaned up -- which is precisely the belief that would be wrong
  // in the case worth catching.
  const stub = makeStubCloudflared('ok');
  const app = await launchApp({ port: PORT, env: { STREAMER_CLOUDFLARED: stub.shim } });

  try {
    const [, panel] = await host(app);
    await panel.getByTestId('tunnel-toggle').click();
    await expect(panel.getByTestId('tunnel-note')).toContainText(FAKE_URL, { timeout: 30_000 });

    await expect
      .poll(() => countStubProcesses(stub.dir), { timeout: 20_000 })
      .toBeGreaterThan(0);

    await panel.getByTestId('stop-hosting').click();

    await expect
      .poll(() => countStubProcesses(stub.dir), {
        timeout: 20_000,
        message: 'stopping the room must kill cloudflared',
      })
      .toBe(0);

    await app.close();
  } finally {
    stub.cleanup();
  }
});

test('a cloudflared that fails reports why, and leaves the room running', async () => {
  const stub = makeStubCloudflared('fail');
  const app = await launchApp({ port: PORT, env: { STREAMER_CLOUDFLARED: stub.shim } });

  try {
    const [, panel] = await host(app);
    await panel.getByTestId('tunnel-toggle').click();

    await expect(panel.getByTestId('tunnel-note')).toContainText(/exited|failed/i, { timeout: 30_000 });
    await expect(panel.getByTestId('tunnel-note')).toHaveClass(/error/);

    // The room itself is unaffected -- a tunnel is an addition to it, not a prerequisite.
    await expect(panel.getByTestId('host-status')).toContainText(`port ${PORT}`);
    expect(await panel.locator('[data-testid="invite-link"][data-scope="internet"]').count()).toBe(0);

    await app.close();
  } finally {
    stub.cleanup();
  }
});

test('with cloudflared missing, the message names the fix', async () => {
  // "spawn ENOENT" is a true statement that helps nobody.
  const app = await launchApp({
    port: PORT,
    // An explicit override that points at nothing is authoritative -- it does not fall back to
    // whatever happens to be on PATH, so this stays deterministic on a machine that does have
    // cloudflared installed.
    env: { STREAMER_CLOUDFLARED: path.join(tmpdir(), 'definitely-not-here', 'cloudflared.exe') },
  });

  try {
    const [, panel] = await host(app);
    await panel.getByTestId('tunnel-toggle').click();

    await expect(panel.getByTestId('tunnel-note')).toContainText(/winget install Cloudflare\.cloudflared/, {
      timeout: 30_000,
    });

    await app.close();
  } finally {
    // nothing to clean up
  }
});
