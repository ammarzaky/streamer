/**
 * Screen capture, without the browser's picker.
 *
 * The reason this needs no change in `public/**` at all: `setDisplayMediaRequestHandler`
 * intercepts `navigator.mediaDevices.getDisplayMedia`, which the client already calls in
 * `media-manager.js`. The renderer keeps asking the same question; the main process just answers
 * it differently. Cancelling maps onto the existing SHARE_CANCELLED path for free.
 *
 * Two things come out of owning the answer:
 *
 *   - **Real system audio.** On Windows the handler can return `audio: 'loopback'`, capturing
 *     whatever the machine is playing. In a browser the user has to notice and tick "share tab
 *     audio" in a dialog, and the commonest support question about screen sharing is someone
 *     wondering why nobody can hear the video they are showing. The mic stays a separate track on
 *     a separate sender, exactly as the protocol was designed around -- muting one must never
 *     silence the other.
 *   - **A picker that matches the app.** Rendered by us, so it can be styled, labelled, and
 *     dismissed with Escape.
 */

import { BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import * as paths from './paths.js';

const THUMBNAIL = { width: 320, height: 180 };

/** Resolver for the picker window currently open, so IPC can complete the pending request. */
let pending = null;

/**
 * @param {Electron.Session} session
 * @param {() => BrowserWindow|null} getParent  the window the picker should be modal to
 */
export function installCapture(session, getParent) {
  session.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const choice = await pickSource(getParent());
        if (!choice?.source) {
          // No video means "cancelled" to Chromium, which surfaces in the renderer as the same
          // NotAllowedError a dismissed browser picker produces -- already mapped to
          // SHARE_CANCELLED, and already treated as information rather than an error.
          callback({});
          return;
        }
        const audio = choice.systemAudio ? systemAudio() : undefined;
        log('display-capture', { source: choice.source.name, kind: choice.source.id.split(':')[0], audio: audio ?? 'none' });
        // The key is omitted rather than set to undefined: Electron validates the shape of
        // this object, and "no audio" is the absence of the key.
        callback(audio ? { video: choice.source, audio } : { video: choice.source });
      } catch {
        callback({});
      }
    },
    // Without this Electron enables its own loopback audio handling, which conflicts with
    // returning an `audio` value ourselves.
    { useSystemPicker: false },
  );

  ipcMain.on('picker:choose', (_event, id, options) => resolvePicker(id, options));
  ipcMain.on('picker:cancel', () => resolvePicker(null));
  // Same {ok, value, error} envelope every other handler uses, so the preload can unwrap them
  // all through one helper.
  ipcMain.handle('picker:sources', async () => {
    try {
      return { ok: true, value: await listSources() };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });
}

/**
 * Windows can hand us the system mix; macOS and Linux cannot do it this way, and asking anyway
 * makes the whole request fail rather than degrading to video-only.
 *
 * What 'loopback' captures deserves saying plainly, because it is the cause of "I hear my own
 * voice when my friend shares": it is a WASAPI loopback of the default render endpoint -- the
 * WHOLE system mix, including this app's own playback of every other participant. The sharer
 * therefore sends everyone's voices back to them, delayed by a round trip (electron/electron
 * #27337). 'loopbackWithMute' would silence the sharer's own speakers rather than exclude our
 * output, and Chromium's restrictOwnAudio does not apply to this path, so the honest options are
 * the picker's "Share system audio" checkbox and headphones. Both are documented.
 */
const systemAudio = () => (process.platform === 'win32' ? 'loopback' : undefined);

/** Main-process log line, in the same shape the server uses. Never SDP, never addresses. */
let log = (event, detail) => console.log(`[desktop] ${event}`, detail ?? '');
export function setCaptureLogger(fn) {
  log = fn;
}

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL,
    fetchWindowIcons: true,
  });

  return sources
    // A window with no title is almost always an invisible helper window, and offering a list of
    // blank entries makes the picker look broken.
    .filter((source) => source.name && source.name.trim() !== '')
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    }));
}

/**
 * Show the picker and resolve with the chosen source, or null if dismissed.
 * Only one can be open at a time; a second request cancels the first rather than stacking.
 */
function pickSource(parent) {
  resolvePicker(null);

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 780,
      height: 560,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      show: false,
      webPreferences: {
        preload: paths.preload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    pending = {
      resolve: async (id, options = {}) => {
        pending = null;
        if (!picker.isDestroyed()) picker.destroy();
        if (!id) {
          resolve(null);
          return;
        }
        // Re-read the sources rather than caching the objects from the list call: Chromium wants
        // the live source, and between listing and choosing a window can have closed.
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const source = sources.find((entry) => entry.id === id) ?? null;
        resolve(source ? { source, systemAudio: options?.systemAudio !== false } : null);
      },
    };

    picker.once('ready-to-show', () => picker.show());
    // Closing the window by any route -- Escape, the title bar, the parent going away -- has to
    // settle the promise, or getDisplayMedia never returns and the Share button stays stuck.
    picker.on('closed', () => {
      if (pending) {
        pending = null;
        resolve(null);
      }
    });

    void picker.loadFile(paths.ui('picker.html'));
  });
}

function resolvePicker(id, options) {
  const current = pending;
  if (!current) return;
  pending = null;
  void current.resolve(id, options);
}
