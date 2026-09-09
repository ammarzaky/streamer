/**
 * Electron main process.
 *
 * The shape of this app in one sentence: **it is a browser that trusts the right certificate and
 * has a better screen picker.** The window loads the same `public/**` client over the same
 * `https://host:port/r/<id>` origin a browser would, because that client derives its WebSocket
 * URL from `location` and relies on the secure-context and CSP guarantees of a real https origin.
 * Serving it from `file://` or a custom scheme would mean re-deriving all of that by hand and
 * re-testing it, in exchange for nothing.
 *
 * What the main process adds is the three things a browser cannot:
 *   - certificate pinning, so nobody installs a CA or clicks through a warning (`certs.js`)
 *   - an in-app source picker with real system audio (`capture.js`)
 *   - the ability to run the signaling server itself, from `src/index.js`, unmodified
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import * as paths from './paths.js';
import * as certs from './certs.js';
import * as upnp from './upnp.js';
import * as tunnel from './tunnel.js';
import * as updater from './updater.js';
import { installCapture, setCaptureLogger } from './capture.js';
import { readMicStatus, unmuteMic, setMicStatusLogger } from './mic-status.js';
import { isLocalPageUrl } from './local-page.js';
import { formatInvite, browserInvite, parseInvite, roomUrl, InviteError } from './shared/invite.js';

// ---------------------------------------------------------------------------
// Main-process log
// ---------------------------------------------------------------------------

/**
 * A small append-only log under userData, for the decisions only the main process sees:
 * permission grants and denials, what the picker chose and whether it carried system audio.
 * Every one of those has been the invisible half of an audio bug report. Never SDP, never
 * addresses, never the fingerprint.
 */
let logFile = null;

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function desktopLog(event, detail = {}) {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
  console.log(`[desktop] ${event}`, detail);
  try {
    if (!logFile) {
      mkdirSync(logDir(), { recursive: true });
      logFile = path.join(logDir(), 'desktop.log');
    }
    appendFileSync(logFile, line);
  } catch {
    // A log that cannot be written must not take the app down with it.
  }
}

// Remote video must start without a click. The web app relies on the same relaxation in its
// test browser, and a room where the first frame never paints looks like a broken connection.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Test-only switches, opt-in so nothing here weakens a real install.
//
// Two instances on one machine cannot see each other's host candidates while Chromium hides
// local IPs behind mDNS names, and a CI machine has no microphone for getUserMedia to open.
// Both are properties of the test environment rather than of the app.
if (process.env.STREAMER_DESKTOP_TEST === '1') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');

  // Deliberately NOT --use-fake-ui-for-media-stream. It auto-approves display-capture requests
  // and picks a source itself, which silently bypasses setDisplayMediaRequestHandler -- so the
  // picker never opens and a suite using it would be testing Chromium's fallback rather than
  // this app's screen sharing. Permission still resolves without it, through the request handler
  // installed below.
}

/** @type {BrowserWindow|null} */
let win = null;
/** The running server handle from startServer(), or null when not hosting. */
let hosting = null;
/** Where the window currently is, so the renderer and the navigation guard agree. */
let target = null;

// ---------------------------------------------------------------------------
// Single instance: protocol links must reach the app that is already running
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const link = argv.find((arg) => arg.startsWith('streamer://'));
    if (link) void join(link).catch(reportJoinFailure);
  });
}

registerProtocolClient();

// macOS delivers protocol links through an event rather than argv. Windows-only today, but the
// handler costs two lines and its absence would be a silent no-op rather than an error.
app.on('open-url', (event, url) => {
  event.preventDefault();
  void join(url).catch(reportJoinFailure);
});

function registerProtocolClient() {
  // In development the executable is electron.exe and the app is an argument, so the registration
  // has to carry that argument or Windows launches a bare Electron with no app to run.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('streamer', process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient('streamer');
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: paths.preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
    hostPanel?.close();
  });

  // The room id does not exist until the client has opened a socket and been granted one, at
  // which point it rewrites the address in place. That in-page navigation is the first moment
  // there is an invite worth showing, so it is when the panel appears -- unprompted, because
  // sending the link is the very next thing a host wants to do.
  win.webContents.on('did-navigate-in-page', () => {
    if (hosting && currentRoomId()) openHostPanel();
  });

  guardNavigation(win);
  void goHome();
  return win;
}

/** @type {BrowserWindow|null} */
let hostPanel = null;

function openHostPanel() {
  if (hostPanel && !hostPanel.isDestroyed()) {
    hostPanel.show();
    return hostPanel;
  }

  hostPanel = new BrowserWindow({
    width: 540,
    height: 620,
    parent: win ?? undefined,
    resizable: true,
    minimizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'Room details',
    show: false,
    webPreferences: {
      preload: paths.preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hostPanel.once('ready-to-show', () => hostPanel?.show());
  hostPanel.on('closed', () => {
    hostPanel = null;
  });

  guardNavigation(hostPanel);
  void hostPanel.loadFile(paths.ui('host.html'));
  return hostPanel;
}

/**
 * Keep the window inside the two places it is allowed to be: our own local pages, and the one
 * server we are currently connected to. Anything else -- a link in a chat message rendered by a
 * room page, a redirect from a host we do not control -- opens in the real browser instead, where
 * it gets the user's own protections rather than ours.
 */
function guardNavigation(target_) {
  const contents = target_.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isLocalPage(url)) return;

    // The web client's "Leave" sends the page to the server root, which for a joiner is somebody
    // else's landing page -- a dead end. Bring them back to our own Home screen instead.
    if (target && sameOrigin(url, target.origin) && new URL(url).pathname === '/') {
      event.preventDefault();
      void goHome();
      return;
    }

    if (target && sameOrigin(url, target.origin)) return;

    event.preventDefault();
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
  });
}

const safeProtocol = (url) => {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
};

const safeOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * A Debug menu, hidden behind Alt like the rest of the auto-hidden bar.
 *
 * "Open log folder" is the cheapest way to get the main-process log into a bug report. The
 * Chromium internals pages are the deepest view of audio there is -- media-internals lists the
 * exact capture device and parameters Chromium opened, which no renderer API exposes -- but
 * they render blank in some Electron versions, so each is verified on first use and reported
 * honestly rather than promised.
 */
function installDebugMenu() {
  const openInternals = (url) => {
    const page = new BrowserWindow({
      width: 1100,
      height: 800,
      autoHideMenuBar: true,
      title: url,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    guardNavigation(page);
    page.webContents.on('did-fail-load', (_event, code, description) => {
      desktopLog('internals-page-failed', { url, code, description });
    });
    // A WebUI page that "loads" blank is the common failure and fires no error, so the
    // rendered text is measured after load and an empty page is reported as such.
    page.webContents.once('did-finish-load', () => {
      page.webContents
        .executeJavaScript('document.body ? document.body.innerText.trim().length : 0', true)
        .then((textLength) => {
          if (!textLength) {
            desktopLog('internals-page-blank', { url });
            void dialog.showMessageBox(page, {
              type: 'info',
              message: `${url} rendered blank in this Electron build.`,
              detail: 'Use Copy diagnostics in the room instead; it carries the same audio numbers.',
            });
          }
        })
        .catch((error) => desktopLog('internals-page-blank', { url, error: error?.message }));
    });
    void page.loadURL(url).catch((error) => desktopLog('internals-page-failed', { url, error: error?.message }));
  };

  // The default roles are kept: replacing the menu wholesale would also remove Reload, zoom
  // and the other accelerators the packaged app has always had.
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Debug',
      submenu: [
        { label: 'Open log folder', click: () => void shell.openPath(logDir()) },
        { type: 'separator' },
        { label: 'Open WebRTC internals', click: () => openInternals('chrome://webrtc-internals') },
        { label: 'Open media internals (capture devices)', click: () => openInternals('chrome://media-internals') },
        // The OS mute check exists only where Core Audio does.
        ...(process.platform === 'win32'
          ? [
              { type: 'separator' },
              {
                label: 'Windows microphone status…',
                click: () => void showMicStatus().catch((error) => desktopLog('mic-status', { error: describeError(error) })),
              },
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The file:// prefix all of our own pages sit under. The comparison itself is in local-page.js. */
const localPagePrefix = () => pathToFileURL(paths.ui('')).href.replace(/\/$/, '');
const isLocalPage = (url) => isLocalPageUrl(url, localPagePrefix());

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function goHome() {
  target = null;
  certs.clearPins();
  await win?.loadFile(paths.ui('home.html'));
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

/** The in-flight boot, so two starts cannot race. */
let starting = null;

function startHosting() {
  if (hosting) return Promise.resolve(hostStatus());

  // Memoised rather than guarded by a boolean. The check above runs before any await, so two
  // calls arriving together -- a double-clicked button, or a protocol link landing while the
  // user presses Host -- would both pass it, both bind the port, and the second would overwrite
  // the handle, leaving a live server running that nothing holds a reference to and `close()`
  // can never reach.
  starting ??= boot().finally(() => {
    starting = null;
  });
  return starting;
}

async function boot() {
  // Both the generator and the HTTPS server read this one variable, so the directory the
  // certificates are written to can never drift from the one they are served from.
  process.env.STREAMER_CERT_DIR = paths.certDir();

  const { startServer } = await import('../src/index.js');
  const { fingerprint } = await import('../scripts/make-certs.mjs');

  const server = await startServer({
    cwd: paths.appRoot(),
    overridesDir: paths.overridesDir(),
  });
  server.fingerprint = fingerprint();

  // Our own server's certificate is pinned like any other, so the loopback connection takes
  // exactly the same path a remote one does rather than being a trusted special case.
  certs.pin('localhost', server.fingerprint);
  certs.pin('127.0.0.1', server.fingerprint);

  hosting = server;
  keepAwake(true);
  return hostStatus();
}

/**
 * Stop the machine sleeping while it is hosting.
 *
 * A host is a server, and a laptop that suspends takes the room with it -- every participant is
 * disconnected at once, by something the host did not do. Screen sharing already keeps the
 * display awake through the capture API, but only while actually sharing; the gap is a host who
 * is watching someone else share and stops touching the keyboard.
 */
let sleepBlocker = null;

function keepAwake(on) {
  if (on) {
    if (sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    return;
  }
  if (sleepBlocker !== null && powerSaveBlocker.isStarted(sleepBlocker)) {
    powerSaveBlocker.stop(sleepBlocker);
  }
  sleepBlocker = null;
}

async function stopHosting() {
  if (!hosting) return hostStatus();
  const stopping = hosting;
  hosting = null;

  // The tunnel and the router mapping go before the server does. Both are things the user did
  // not start by hand and will not think to stop -- a cloudflared left running keeps a public
  // hostname pointing at a port that no longer answers, and a mapping left open on a router is
  // residue nobody goes looking for.
  await tunnel.stop();
  tunnelState = { state: 'off' };

  await upnp.close();
  upnpState = { state: 'off' };

  await stopping.close();
  keepAwake(false);
  hostPanel?.close();

  // Returning to Home happens here rather than in whichever UI asked to stop. The panel is one
  // of the callers and closing it destroys its renderer mid-call, so a follow-up request from
  // there would simply never arrive -- leaving the main window sitting on a room served by a
  // server that no longer exists.
  if (!quitting) await goHome();

  return hostStatus();
}

// ---------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------

/** @type {{state: 'off'|'starting'|'open'|'failed', url?: string, reason?: string}} */
let tunnelState = { state: 'off' };

/**
 * Requests run one at a time, in the order they were made.
 *
 * Starting a tunnel takes seconds. Two overlapping calls -- an impatient double-click, or a
 * second window -- would otherwise interleave a start and a stop and leave a cloudflared running
 * that nothing holds a reference to, with the UI reporting the opposite of what is true.
 */
let tunnelChain = Promise.resolve();

function setTunnel(enabled) {
  // Read synchronously and passed in, so nothing reads this variable across an await.
  const previousUrl = tunnelState.url;
  const run = () => applyTunnel(enabled, previousUrl);
  tunnelChain = tunnelChain.then(run, run);
  return tunnelChain;
}

async function applyTunnel(enabled, previousUrl) {
  if (!enabled) {
    if (previousUrl) hosting?.forgetOrigin?.(previousUrl);
    await tunnel.stop();
    tunnelState = { state: 'off' };
    return tunnelState;
  }
  if (!hosting) throw new Error('start the room first');

  tunnelState = { state: 'starting' };
  const result = await tunnel.start(hosting.port, {
    // A tunnel that dies mid-session would otherwise leave the panel advertising a public address
    // that no longer resolves -- and the host with no reason to suspect it.
    onExit: ({ reason }) => {
      tunnelState = { state: 'failed', reason };
    },
  });

  if (!result.ok) {
    tunnelState = { state: 'failed', reason: result.reason };
    return tunnelState;
  }

  // The same-origin check compares Origin against the Host header, and through a tunnel both
  // become the public hostname -- which usually matches. Registering it explicitly removes the
  // dependency on cloudflared's Host-forwarding behaviour staying what it is today: if that ever
  // changes, the symptom is a 403 on upgrade and a room that loads but never connects.
  hosting.allowOrigin?.(result.url);

  tunnelState = { state: 'open', url: result.url };
  return tunnelState;
}

// ---------------------------------------------------------------------------
// Router port mapping
// ---------------------------------------------------------------------------

/** @type {{state: 'off'|'trying'|'open'|'failed', externalIp?: string|null, reason?: string, cgnat?: boolean}} */
let upnpState = { state: 'off' };

async function setUpnp(enabled) {
  if (!enabled) {
    await upnp.close();
    upnpState = { state: 'off' };
    return upnpState;
  }
  if (!hosting) throw new Error('start the room first');

  upnpState = { state: 'trying' };
  const result = await upnp.open(hosting.port);

  upnpState = result.ok
    ? {
        state: 'open',
        externalIp: result.externalIp,
        // A router that reports a private address as its "external" one is behind carrier-grade
        // NAT, where a successful mapping still cannot be reached from outside. Saying "open"
        // and nothing else would be technically true and practically a lie.
        cgnat: upnp.isCarrierGrade(result.externalIp),
      }
    : { state: 'failed', reason: result.reason };

  return upnpState;
}

function hostStatus() {
  if (!hosting) return { hosting: false, upnp: upnpState, tunnel: tunnelState };

  const roomId = currentRoomId();
  const room = roomId ? hosting.registry?.get(roomId) : null;

  return {
    hosting: true,
    port: hosting.port,
    fingerprint: hosting.fingerprint,
    roomId,
    participants: room ? room.peers.size : 0,
    upnp: upnpState,
    tunnel: tunnelState,
  };
}

/**
 * Open a room on our own server.
 *
 * `/r/new` is what the web client uses to mean "create a room and rewrite the address" -- the
 * room id does not exist until the page has opened a socket and asked for it, which is what keeps
 * an abandoned landing page from orphaning a room server-side.
 */
async function hostRoom() {
  await startHosting();
  const url = `https://localhost:${hosting.port}/r/new`;
  target = { origin: new URL(url).origin, host: 'localhost', port: hosting.port };
  await win?.loadURL(url);
  return hostStatus();
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

/**
 * Pin the invited certificate, then navigate.
 *
 * The order is the security property: the pin must be in place before any request to that host,
 * or the first connection is verified by Chromium's ordinary rules -- which, for a self-signed
 * certificate, means an interstitial rather than the silent success this feature exists to give.
 */
async function join(linkText) {
  const invite = parseInvite(linkText);

  if (invite.pinned) {
    certs.pin(invite.host, invite.fingerprint);
  } else {
    // A pasted https link carries no digest, so there is nothing to pin and Chromium will show
    // its own warning. That is a worse experience, not a hidden failure -- but it must not be
    // presented as if it were the same thing.
    certs.unpin(invite.host);
  }

  const url = roomUrl(invite);
  target = { origin: new URL(url).origin, host: invite.host, port: invite.port };
  lastRejection = null;

  try {
    await win?.loadURL(url);
  } catch (error) {
    // A failed navigation leaves the window on Chromium's own error page -- a blank slab reading
    // ERR_CERT_AUTHORITY_INVALID with no way back. That is the worst possible outcome for the
    // one case where an explanation matters most, so the user goes back to Home and is told, in
    // this app's words, which of the two things went wrong.
    target = null;
    certs.unpin(invite.host);
    await goHome();
    reportJoinFailure(describeFailure(error, invite));
    throw new Error(describeFailure(error, invite));
  }

  return { ...invite, url };
}

/** The most recent pin mismatch, so a navigation failure can be attributed accurately. */
let lastRejection = null;

/**
 * Why the join failed, in a sentence worth showing.
 *
 * The distinction being drawn is the same one `docs/NETWORK.md` insists on: "I could not reach
 * that machine" and "I reached it and refused to trust it" have nothing to do with each other,
 * and collapsing them into "connection failed" sends people to debug the wrong thing.
 */
function describeFailure(error, invite) {
  if (lastRejection && lastRejection.hostname === invite.host.toLowerCase()) {
    return (
      `Refused to connect to ${invite.host}: it presented a different certificate than the ` +
      `invite promised. Ask whoever is hosting for a fresh link. If it happens again with a ` +
      `link you trust, stop and find out why the certificate changed.`
    );
  }

  const code = error?.code ?? error?.message ?? '';
  if (/ERR_CERT|CERT_AUTHORITY/i.test(code)) {
    return (
      `${invite.host} is using a certificate this app cannot verify, and the link you pasted ` +
      `carries no fingerprint to check it against. Ask for the app link instead of the browser one.`
    );
  }

  return (
    `Could not reach ${invite.host}:${invite.port}. Check that the room is still running, and ` +
    `that you can get to that address from this network at all.`
  );
}

function reportJoinFailure(error) {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof InviteError
        ? error.message
        : 'Could not open that link.';
  win?.webContents.send('join-failed', { message });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Wrap a handler so a thrown error becomes a value the renderer can display. */
const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

handle('host:start', () => hostRoom());
handle('host:stop', () => stopHosting());
handle('host:status', () => hostStatus());
handle('host:panel', () => void openHostPanel());
handle('host:upnp', (enabled) => setUpnp(enabled));
handle('host:tunnel', (enabled) => setTunnel(enabled));
handle('join', (text) => join(text));
handle('home', () => goHome());

handle('invite:preview', (text) => {
  const invite = parseInvite(text);
  return { host: invite.host, port: invite.port, roomId: invite.roomId, pinned: invite.pinned };
});

/**
 * Every address this room can be reached on, with both link forms for each.
 *
 * Only the desktop link carries the fingerprint. The browser link must not: the digest means
 * nothing to a browser and would only be one more thing to mis-copy.
 *
 * The room id is read out of the window's current URL rather than passed in. It does not exist
 * until the page has opened a socket and been granted one, at which point the client rewrites the
 * address with history.replaceState -- so the live URL is the authoritative source, and asking a
 * renderer to report it would just add a way for the two to disagree.
 */
handle('invite:forRoom', () => {
  if (!hosting) throw new Error('not hosting');

  const roomId = currentRoomId();
  if (!roomId) throw new Error('no room is open yet');

  const links = [];

  // The tunnel link comes first because it is the only one that works from another country, and
  // burying it under localhost and a 10.x address is how someone ends up sending a link that
  // could never have resolved -- discovered, at the earliest, mid-call.
  //
  // It carries no fingerprint on purpose: Cloudflare terminates TLS with its own real
  // certificate, so there is nothing of ours to pin, and normal verification applies. The app
  // handles that -- an unpinned host falls through to Chromium's ordinary checks.
  if (tunnelState.state === 'open' && tunnelState.url) {
    const url = new URL(tunnelState.url);
    links.push({
      host: url.hostname,
      scope: 'internet',
      desktop: browserInvite({ host: url.hostname, port: 443, roomId }),
      browser: browserInvite({ host: url.hostname, port: 443, roomId }),
    });
  }

  for (const host of ['localhost', ...lanIPv4s()]) {
    links.push({
      host,
      scope: host === 'localhost' ? 'this machine' : 'same network',
      desktop: formatInvite({ host, port: hosting.port, roomId, fingerprint: hosting.fingerprint }),
      browser: browserInvite({ host, port: hosting.port, roomId }),
    });
  }

  return { port: hosting.port, fingerprint: hosting.fingerprint, links };
});

/** The room id currently open in the window, or null before one has been granted. */
function currentRoomId() {
  try {
    const match = new URL(win?.webContents.getURL() ?? '').pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
    // `/r/new` is the placeholder the client navigates to before the server has issued an id.
    return match && match[1] !== 'new' ? match[1] : null;
  } catch {
    return null;
  }
}

/** Every non-internal IPv4 on this machine, in a stable order. */
function lanIPv4s() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return [...new Set(out)].sort();
}

handle('update:status', () => updater.status());
handle('update:check', () => updater.check());
handle('update:download', () => updater.download());
handle('update:install', () => updater.restartAndInstall());

handle('open-external', (url) => {
  if (!/^https?:$/.test(safeProtocol(url))) throw new Error('refusing to open that link');
  return shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Windows microphone mute
// ---------------------------------------------------------------------------

/**
 * A microphone muted in Windows opens without error and streams silence (see mic-status.js).
 * Chromium does report that mute on the track (`track.muted`, polled once a second), so the page
 * names it first; this is the second line of defence: a definitive Core Audio read that also
 * catches an input volume of 0 -- as silent, and invisible to the track -- and the one place an
 * unmute can be offered with a click. So the first time a page load is granted the microphone --
 * the lobby's getUserMedia; lobby and room are one document, and Join adopts the lobby stream --
 * Windows is asked once about the default endpoint, and told to unmute it on request. Once per
 * document, not per grant: every later getUserMedia of the same page (a mic-menu device switch,
 * a processing toggle, the release-for-3-s test) would otherwise re-open the same box mid-call,
 * and the read is of the Windows default, which need not be the device the page opened. A full
 * navigation (the next room visit) checks again. Skipped under the test flag: the suites run on
 * a fake capture device and must neither depend on nor change the mute state of the machine
 * running them.
 */
const micCheckEnabled = () => process.platform === 'win32' && process.env.STREAMER_DESKTOP_TEST !== '1';

/** The documents already checked this load, and the check in flight, if any. */
const micChecked = new WeakSet();
let micCheck = null;
/** "Don't ask again while the app is open" -- a variable, on purpose. Nothing is persisted. */
let micDialogSuppressed = false;
/** The warning box currently open, so a second grant cannot stack another on top of it. */
let micDialog = null;

/** A window that can still own a dialog, or null -- showMessageBox throws on a destroyed one. */
const alive = (target_) => (target_ && !target_.isDestroyed() ? target_ : null);

const describeError = (error) => error?.message ?? String(error);

/**
 * What the warning is about: the mute flag, or an input volume of 0 -- every bit as silent, but
 * not a mute, so the helper cannot clear it and the box points at Settings instead.
 */
const micProblem = (status) => (status.muted ? 'muted' : status.volume === 0 ? 'volume-zero' : null);

/** One line per endpoint for the Debug box: the default starred, then muted / volume. */
const describeEndpoints = (endpoints) =>
  endpoints.map(
    (endpoint) =>
      `${endpoint.isDefault ? '★' : '•'} ${endpoint.name || '(unnamed)'} — ` +
      `${endpoint.muted ? 'مكتوم / muted' : 'غير مكتوم / not muted'} · ${endpoint.volume}%`,
  );

function checkMicAfterGrant(contents) {
  if (!micCheckEnabled() || micCheck || micChecked.has(contents)) return;
  micChecked.add(contents);
  // Main-frame 'did-navigate' is the next full navigation; in-page navigations do not fire it.
  contents.once('did-navigate', () => micChecked.delete(contents));

  const owner = BrowserWindow.fromWebContents(contents);
  micCheck = readMicStatus()
    .then((status) => (status && micProblem(status) ? offerUnmute(owner, status) : undefined))
    .catch((error) => desktopLog('mic-mute-dialog', { error: describeError(error) }))
    .finally(() => {
      micCheck = null;
    });
}

/**
 * The warning box for a default endpoint that is muted or at volume 0. Resolves once it is
 * closed and any unmute has been tried. "Unmute now" is offered only for the mute flag: a volume
 * of 0 has to be raised by hand in Settings.
 */
function offerUnmute(owner, status) {
  if (micDialogSuppressed) {
    desktopLog('mic-mute-dialog', { choice: 'skipped', suppressed: true });
    return Promise.resolve();
  }
  if (micDialog) return micDialog;

  const parent = alive(owner) ?? alive(win);
  const device = status.name || 'default microphone';
  const problem = micProblem(status);
  const buttons = status.muted ? ['إلغاء الكتم الآن — Unmute now', 'تجاهل — Ignore'] : ['تجاهل — Ignore'];
  micDialog = dialog
    .showMessageBox(parent, {
      type: 'warning',
      title: 'Streamer',
      // Names what was read -- the Windows default -- because the app's mic menu may have opened
      // another device, in which case this is no mute of "your microphone".
      message: status.muted
        ? `ميكروفون ويندوز الافتراضي (${device}) مكتوم — إن كان التطبيق يستخدمه فلن يسمعك أحد\n` +
          `The Windows default microphone (${device}) is muted — if this app is using it, nobody will hear you`
        : `مستوى صوت ميكروفون ويندوز الافتراضي (${device}) صفر — إن كان التطبيق يستخدمه فلن يسمعك أحد\n` +
          `The Windows default microphone (${device}) input volume is 0 — if this app is using it, nobody will hear you`,
      detail: [
        `الجهاز: ${device} — مستوى الصوت ${status.volume}%`,
        ...(status.muted
          ? [
              'لإلغاء الكتم: اضغط زر كتم الميكروفون في صف مفاتيح F (يضيء مصباحه أثناء الكتم)، أو افتح ' +
                'الإعدادات › النظام › الصوت › الإدخال › الجهاز وألغِ الكتم.',
            ]
          : []),
        ...(status.volume === 0
          ? ['مستوى صوت الإدخال صفر؛ يجب رفعه من الإعدادات › النظام › الصوت › الإدخال › الجهاز.']
          : []),
        'إذا اخترت ميكروفونًا مختلفًا داخل التطبيق، فافحص ذلك الميكروفون في الإعدادات.',
        '',
        `Device: ${device} — volume ${status.volume}%`,
        ...(status.muted
          ? [
              'To unmute: press the microphone-mute key on the F row (its light is on while muted), or open ' +
                'Settings › System › Sound › Input › the device and unmute it.',
            ]
          : []),
        ...(status.volume === 0
          ? ['The input volume is 0; it must be raised in Settings › System › Sound › Input › the device.']
          : []),
        'If a different microphone was picked inside the app, check that one in Settings.',
      ].join('\n'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
      checkboxLabel: "لا تسألني مجددًا أثناء تشغيل التطبيق — Don't ask again while the app is open",
      checkboxChecked: false,
    })
    .then(({ response, checkboxChecked }) => {
      micDialogSuppressed = checkboxChecked;
      const choice = status.muted && response === 0 ? 'unmute' : 'ignore';
      desktopLog('mic-mute-dialog', { choice, problem, suppressed: checkboxChecked });
      return choice === 'unmute' ? performUnmute(parent) : undefined;
    })
    .catch((error) => desktopLog('mic-mute-dialog', { error: describeError(error) }))
    .finally(() => {
      micDialog = null;
    });
  return micDialog;
}

/** Clear the flag through the helper (which logs `mic-unmute`) and say so if it did not take. */
async function performUnmute(parent) {
  const after = await unmuteMic();
  if (after && !after.muted) return;
  await dialog.showMessageBox(alive(parent) ?? alive(win), {
    type: 'error',
    title: 'Streamer',
    message: 'تعذّر إلغاء كتم الميكروفون\nCould not unmute the microphone',
    detail: after
      ? 'ما زال مكتومًا في ويندوز. استخدم زر كتم الميكروفون على لوحة المفاتيح، أو الإعدادات › النظام › الصوت › الإدخال.\n' +
        'It is still muted in Windows. Use the microphone-mute key, or Settings › System › Sound › Input.'
      : 'لم يستجب ويندوز؛ السبب في Debug › Open log folder. استخدم زر كتم الميكروفون، أو الإعدادات › النظام › الصوت › الإدخال.\n' +
        'Windows did not answer; the reason is under Debug › Open log folder. Use the microphone-mute key, or Settings › System › Sound › Input.',
  });
}

/** Debug › Windows microphone status…: the same read, on demand, with every endpoint listed. */
async function showMicStatus() {
  const status = await readMicStatus();
  const parent = alive(win);
  if (!status) {
    await dialog.showMessageBox(parent, {
      type: 'error',
      title: 'Streamer',
      message: 'تعذّرت قراءة حالة الميكروفون من ويندوز\nCould not read the Windows microphone status',
      detail: 'السبب مسجّل في desktop.log: Debug › Open log folder.\nThe reason is in desktop.log: Debug › Open log folder.',
    });
    return;
  }
  const { response } = await dialog.showMessageBox(parent, {
    type: micProblem(status) ? 'warning' : 'info',
    title: 'Streamer',
    message: 'حالة الميكروفون في ويندوز\nWindows microphone status',
    detail: [
      `الجهاز الافتراضي / Default device: ${status.name || '(unnamed)'}`,
      `مكتوم / Muted: ${status.muted ? 'نعم / yes' : 'لا / no'}`,
      `مستوى الصوت / Volume: ${status.volume}%`,
      ...(status.volume === 0
        ? [
            'مستوى صوت الإدخال صفر؛ ارفعه من الإعدادات › النظام › الصوت › الإدخال.\n' +
              'The input volume is 0; raise it in Settings › System › Sound › Input.',
          ]
        : []),
      '',
      'كل الميكروفونات النشطة / All active microphones (★ = الافتراضي / default):',
      ...describeEndpoints(status.endpoints),
    ].join('\n'),
    buttons: status.muted ? ['إلغاء الكتم — Unmute', 'إغلاق — Close'] : ['إغلاق — Close'],
    defaultId: 0,
    cancelId: status.muted ? 1 : 0,
    noLink: true,
  });
  if (status.muted && response === 0) await performUnmute(parent);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * `.then()` rather than top-level `await app.whenReady()`, and that is not a style choice.
 *
 * When the main entry point is an ES module, Electron waits for the module to finish evaluating
 * before it emits `ready`. Awaiting `whenReady()` at the top level therefore deadlocks outright:
 * the module blocks on an event that cannot fire until the module stops blocking. The app starts,
 * prints nothing, opens no window, and exits silently with status 0 -- no error anywhere, because
 * nothing threw.
 */
app.whenReady().then(() => {
  // Recorded rather than pushed straight to the renderer: the rejection happens mid-navigation,
  // so the page that would receive it is already being torn down. The join path reads it back to
  // explain the failure once the user is somewhere that can show a message.
  certs.install(session.defaultSession, (event) => {
    lastRejection = { ...event, hostname: event.hostname.toLowerCase() };
  });

  setCaptureLogger(desktopLog);
  setMicStatusLogger(desktopLog);
  installCapture(session.defaultSession, () => win);
  installDebugMenu();

  // Updates are pushed to whichever local page is showing, so the Home screen can react without
  // polling. Checking at launch is safe because nothing downloads without being asked.
  updater.install((state) => {
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) target.webContents.send('update-status', state);
    }
  });
  void updater.check();

  // Logged once at start, so a bug report's desktop.log opens with the answer. Nothing waits on
  // it, and a failure is a log line rather than an exception.
  if (micCheckEnabled()) void readMicStatus();

  // Only our own pages and the server we are connected to may use the microphone or the screen.
  // Electron grants media permissions by default, which would mean any page the window ever ends
  // up on inherits them.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    // 'fullscreen' belongs here: Chromium treats requestFullscreen() as a permission, so
    // leaving it out silently denied every attempt -- the button, the double-click and F all did
    // nothing, with no error anywhere. The browser E2E never caught it because a plain browser
    // has no Electron permission handler to deny it.
    // 'speaker-selection' belongs here for the same reason 'fullscreen' does: Chromium treats
    // choosing an output device as a permission, and an omission here is not an error the page
    // can see -- setSinkId simply rejects and the speaker picker does nothing.
    const allowed = [
      'media',
      'display-capture',
      'clipboard-sanitized-write',
      'fullscreen',
      'speaker-selection',
    ];
    const trusted = isLocalPage(url) || (target && sameOrigin(url, target.origin));
    const granted = Boolean(trusted) && allowed.includes(permission);
    // Every decision is logged, because a denied 'media' request is indistinguishable from a
    // broken microphone from inside the page.
    desktopLog('permission', { permission, origin: safeOrigin(url), trusted: Boolean(trusted), granted });
    callback(granted);
    // The first granted 'media' of a page load is the lobby opening the microphone: the moment
    // to ask Windows whether the default microphone is muted or at volume 0. The page sees the
    // mute too (track.muted); this is the definitive read behind it, and the only place an
    // unmute can be offered. Later grants of the same document are re-acquires and are not
    // checked again.
    if (granted && permission === 'media') checkMicAfterGrant(contents);
  });

  createWindow();

  // A protocol link can be present in argv on the very first launch, before any window exists.
  const initialLink = process.argv.find((arg) => arg.startsWith('streamer://'));
  if (initialLink) {
    win?.webContents.once('did-finish-load', () => void join(initialLink).catch(reportJoinFailure));
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => app.quit());

// Stop the server before the process goes away, so the room is ended cleanly and the port is
// released rather than lingering until the OS reaps it.
let quitting = false;

app.on('before-quit', (event) => {
  if (!hosting || quitting) return;
  quitting = true;
  // Held open just long enough to end the room cleanly and drop the router mapping. Without
  // this the process can exit with the port still bound and, worse, with a mapping left open on
  // the user's router that nothing will ever come back to remove.
  event.preventDefault();
  void stopHosting().finally(() => app.exit(0));
});
