/**
 * A Cloudflare Quick Tunnel, so the room is reachable without touching a router.
 *
 * The problem this exists for is not theoretical. On a guest network -- a building's shared WiFi,
 * a hotel, an office you do not administer -- there is no router to forward a port on, and guest
 * networks generally drop inbound connections anyway. No amount of application code changes that,
 * so the connection has to be made from the inside out.
 *
 * `cloudflared tunnel --url https://localhost:<port>` dials *out* to Cloudflare and is handed a
 * public `https://<random>.trycloudflare.com` hostname. Three things follow, and all of them
 * remove work rather than adding it:
 *
 *   - **No inbound firewall rule is needed at all.** Nothing listens on the public internet, so
 *     Windows Firewall and any third-party antivirus firewall are simply not involved. On this
 *     project that is the single biggest source of lost time, gone.
 *   - **No certificate warning.** Cloudflare terminates TLS with a real, publicly trusted
 *     certificate. Nothing to install, nothing to click through, no fingerprint to compare.
 *   - **Media still never touches Cloudflare.** Only signaling goes through the tunnel -- a few
 *     kilobytes of SDP and ICE. Audio and video stay peer-to-peer, which is the property the whole
 *     architecture exists to protect.
 *
 * The honest cost: a Quick Tunnel's hostname is random and changes on every restart, so the link
 * has to be re-sent each session. A stable one needs a domain, which costs money -- that is the
 * upgrade path, not a requirement.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where cloudflared ends up on Windows, in the order worth trying.
 *
 * `%LOCALAPPDATA%\Streamer` comes first among the real paths because it is the one place a user
 * can put it without administrator rights -- the official MSI needs elevation, and needing an
 * admin password is a poor first step for someone who was sent an installer by a friend. The
 * standalone binary dropped there works identically.
 */
const CANDIDATES = () =>
  [
    process.env.STREAMER_CLOUDFLARED,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Streamer', 'cloudflared.exe'),
    'cloudflared',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Links/cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);

export const INSTALL_HINT =
  'cloudflared is not installed. Get it without admin rights by saving ' +
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe ' +
  'to %LOCALAPPDATA%\\Streamer\\cloudflared.exe — or run: winget install Cloudflare.cloudflared';

/**
 * The quick-tunnel hostname in a line of cloudflared output, or null.
 *
 * Exported and pure because it is the one piece of this module that can be tested without
 * spawning anything, and it is parsing someone else's log format -- which is exactly the kind of
 * thing that breaks quietly on an upgrade.
 */
export function parseTunnelUrl(text) {
  const match = /https:\/\/[a-z0-9][a-z0-9-]*(?:-[a-z0-9]+)*\.trycloudflare\.com/i.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/**
 * The first cloudflared that exists, or null. A bare name is left for PATH to resolve.
 *
 * An explicit `STREAMER_CLOUDFLARED` that points at nothing is treated as authoritative rather
 * than falling through to the other candidates: someone who set that variable meant it, and
 * quietly using a different binary would make a typo in it impossible to diagnose.
 */
export function locate() {
  const override = process.env.STREAMER_CLOUDFLARED;
  if (override) return existsSync(override) ? override : null;

  for (const candidate of CANDIDATES()) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let child = null;

/**
 * How to spawn a binary that might be a batch shim.
 *
 * Node has refused to execute `.cmd` and `.bat` directly since the 2024 argument-injection fix,
 * failing with a bare `EINVAL` that names nothing. It matters because that is exactly how some
 * package managers install cloudflared: winget drops an `.exe` shim, but Chocolatey and Scoop
 * write `.cmd` wrappers. Routing those through cmd.exe with a single pre-quoted command string --
 * and `windowsVerbatimArguments` so Node does not re-quote it -- is the documented way to do this
 * without reintroducing what the fix was for.
 */
function spawnArgs(bin, args) {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  if (!isBatch) return [bin, args, { windowsHide: true }];

  const quoted = [bin, ...args].map((part) => `"${String(part).replace(/"/g, '""')}"`).join(' ');
  return [
    process.env.COMSPEC || 'cmd.exe',
    ['/d', '/s', '/c', `"${quoted}"`],
    { windowsHide: true, windowsVerbatimArguments: true },
  ];
}

/**
 * Start a tunnel to the local HTTPS port.
 *
 * `--no-tls-verify` applies only to the hop between cloudflared and `localhost`, where the
 * certificate is our own self-signed one. It is not a weakening of anything a user is exposed to:
 * the public side is Cloudflare's real certificate, and this hop does not leave the machine.
 *
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: string}>}
 */
export function start(port, { timeoutMs = 30_000, onExit } = {}) {
  if (child) return Promise.resolve({ ok: false, reason: 'a tunnel is already running' });

  const bin = locate();
  if (!bin) return Promise.resolve({ ok: false, reason: INSTALL_HINT });

  return new Promise((resolve) => {
    let settled = false;
    let output = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) void stop();
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: 'cloudflared did not report a URL in time. Check your internet connection.',
        }),
      timeoutMs,
    );

    const args = ['tunnel', '--url', `https://localhost:${port}`, '--no-tls-verify', '--no-autoupdate'];

    let proc;
    try {
      proc = spawn(...spawnArgs(bin, args));
    } catch (error) {
      finish({ ok: false, reason: `could not start cloudflared: ${error.message}` });
      return;
    }

    child = proc;

    // The quick-tunnel banner goes to stderr, not stdout. Both are watched because that is an
    // implementation detail of someone else's tool and not worth depending on.
    const onData = (chunk) => {
      output += chunk.toString();
      const url = parseTunnelUrl(output);
      if (url) finish({ ok: true, url });
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (error) =>
      finish({
        // A bare `cloudflared` is left for PATH to resolve, so "not installed" only becomes
        // apparent here. `spawn cloudflared ENOENT` is true and useless; the install command is
        // the thing the user can act on.
        ok: false,
        reason: error.code === 'ENOENT' ? INSTALL_HINT : `cloudflared failed: ${error.message}`,
      }),
    );

    proc.on('exit', (code) => {
      child = null;
      // Exiting *after* a URL was reported means the tunnel is gone but the invite link still
      // points at it. Nothing else would notice: the panel would go on advertising a public
      // address that stopped resolving, which is worse than never having offered one.
      if (settled) {
        onExit?.({
          reason: `The tunnel closed unexpectedly (cloudflared exited with code ${code}).`,
        });
        return;
      }
      finish({
        ok: false,
        reason: `cloudflared exited (code ${code}) before opening a tunnel.${
          output.trim() ? ` Last output: ${output.trim().split('\n').at(-1)}` : ''
        }`,
      });
    });
  });
}

/**
 * Stop the tunnel. Never throws.
 *
 * A cloudflared left running after the room has ended keeps a public hostname pointing at a port
 * that no longer answers -- harmless, but it is a process the user did not start by hand and
 * therefore will not think to stop.
 */
export function stop() {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    timer.unref?.();

    proc.once('exit', done);

    // The whole tree, not just the process we hold.
    //
    // On Windows killing a parent does not touch its children, so when cloudflared was reached
    // through a batch shim the process actually holding the tunnel open is a grandchild -- and
    // killing the shim would leave it running, still publishing a hostname that now points at a
    // closed port. `taskkill /T` is the only reliable way to end the tree.
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch {
        // Fall through to the ordinary kill below.
      }
    }

    try {
      proc.kill();
    } catch {
      done();
    }
  });
}

export const isRunning = () => child !== null && child.exitCode === null;
