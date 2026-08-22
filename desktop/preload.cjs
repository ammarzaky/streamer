/**
 * The preload bridge.
 *
 * CommonJS, not ESM, because a sandboxed preload cannot be an ES module -- and the sandbox is
 * worth keeping. The `.cjs` extension is what stops Node treating it as ESM given the package's
 * `"type": "module"`.
 *
 * **What gets exposed depends on where the page came from, and that is the point.** This same
 * preload runs in the room page, which is served by whichever machine is hosting -- possibly a
 * friend's. Handing that page the ability to start servers, read the certificate fingerprint, or
 * open windows would mean the security of this app depended on every host being well behaved.
 *
 * So: local `file://` pages get the control surface, and everything else gets a single boolean
 * telling the web client it is running inside the desktop app. Nothing more.
 */

const { contextBridge, ipcRenderer } = require('electron');

const isLocalPage = window.location.protocol === 'file:';

/** Unwrap the {ok, value, error} envelope the main process wraps every handler in. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok) throw new Error(result?.error ?? 'the desktop app could not complete that');
  return result.value;
}

if (isLocalPage) {
  contextBridge.exposeInMainWorld('streamer', {
    // Hosting
    hostRoom: () => call('host:start'),
    stopHosting: () => call('host:stop'),
    hostStatus: () => call('host:status'),
    openHostPanel: () => call('host:panel'),
    setUpnp: (enabled) => call('host:upnp', enabled),
    setTunnel: (enabled) => call('host:tunnel', enabled),
    roomInvites: () => call('invite:forRoom'),

    // Joining
    join: (text) => call('join', text),
    previewInvite: (text) => call('invite:preview', text),
    goHome: () => call('home'),

    // Screen picker
    listSources: () => call('picker:sources'),
    chooseSource: (id) => ipcRenderer.send('picker:choose', id),
    cancelPicker: () => ipcRenderer.send('picker:cancel'),

    // Updates
    updateStatus: () => call('update:status'),
    checkForUpdates: () => call('update:check'),
    downloadUpdate: () => call('update:download'),
    installUpdate: () => call('update:install'),
    onUpdateStatus: (fn) => ipcRenderer.on('update-status', (_event, payload) => fn(payload)),

    openExternal: (url) => call('open-external', url),

    // Events. The listener is wrapped so a renderer never receives the Electron event object,
    // which would hand it a `sender` it has no business holding.
    onJoinFailed: (fn) => ipcRenderer.on('join-failed', (_event, payload) => fn(payload)),

    platform: process.platform,
  });
} else {
  // The only thing a remote room page learns: that it is inside the desktop app, so it can drop
  // browser-only advice like "install the CA certificate". Read by public/js/core/env.js.
  contextBridge.exposeInMainWorld('__DESKTOP__', true);
}
