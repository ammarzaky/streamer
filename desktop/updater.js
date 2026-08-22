/**
 * Updates from GitHub releases.
 *
 * The friction this removes: a new build currently means re-sending an 80 MB installer over a
 * chat app and talking someone through SmartScreen again. With a public repository behind it,
 * `electron-updater` reads the release feed with no credentials at all -- nothing is embedded in
 * the app, so there is no token to leak by shipping it.
 *
 * Three rules shape everything here:
 *
 *   1. **Nothing downloads on its own.** An update that arrives quietly and then wants to restart
 *      the app is a worse bug than any it fixes -- this app is used mid-call, where a restart
 *      drops everyone in the room. The check is automatic; the download is a decision.
 *   2. **Every failure is silent and non-fatal.** No network, a rate limit, no release published
 *      yet, or running unpackaged in development: none of these are why someone opened the app,
 *      and none of them should produce an error in their face.
 *   3. **The running version is always visible**, so "which build are you on" is never a
 *      question that has to be asked over chat.
 */

import { app } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/** @type {{state: string, version?: string, notes?: string, percent?: number, reason?: string}} */
let state = { state: 'idle' };
let notify = () => {};

export const STATE = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  CURRENT: 'current',
  /** Could not check. Deliberately distinct from "you are up to date", which would be a lie. */
  UNAVAILABLE: 'unavailable',
});

function set(next) {
  state = next;
  try {
    notify(status());
  } catch {
    // The window may already be gone.
  }
}

export function status() {
  return { ...state, currentVersion: app.getVersion(), supported: app.isPackaged };
}

export function install(onChange) {
  notify = onChange ?? (() => {});

  // We drive the download ourselves so the user chooses when 80 MB starts moving.
  autoUpdater.autoDownload = false;
  // Installing on quit would surprise someone who just closed the app; the restart is explicit.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ state: STATE.CHECKING }));
  autoUpdater.on('update-available', (info) =>
    set({ state: STATE.AVAILABLE, version: info?.version, notes: releaseNotes(info) }),
  );
  autoUpdater.on('update-not-available', () => set({ state: STATE.CURRENT }));
  autoUpdater.on('download-progress', (progress) =>
    set({ state: STATE.DOWNLOADING, percent: Math.round(progress?.percent ?? 0) }),
  );
  autoUpdater.on('update-downloaded', (info) => set({ state: STATE.READY, version: info?.version }));
  autoUpdater.on('error', (error) => set({ state: STATE.UNAVAILABLE, reason: explain(error) }));
}

/**
 * Ask GitHub whether there is a newer release.
 *
 * Returns a status rather than throwing. An update check that can take the caller down with it
 * is worse than no update check.
 */
export async function check() {
  if (!app.isPackaged) {
    // electron-updater needs the packaging metadata that only exists in a built app. Saying so
    // beats a stack trace about a missing app-update.yml.
    set({ state: STATE.UNAVAILABLE, reason: 'updates only work in an installed build' });
    return status();
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    set({ state: STATE.UNAVAILABLE, reason: explain(error) });
  }
  return status();
}

export async function download() {
  if (state.state !== STATE.AVAILABLE) return status();
  try {
    set({ state: STATE.DOWNLOADING, percent: 0, version: state.version });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    set({ state: STATE.UNAVAILABLE, reason: explain(error) });
  }
  return status();
}

/**
 * Restart into the new version.
 *
 * `isSilent: false` on purpose -- the installer is unsigned, so letting it run visibly means the
 * user sees what is happening rather than watching the app vanish and hoping.
 */
export function restartAndInstall() {
  if (state.state !== STATE.READY) return false;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

function releaseNotes(info) {
  const notes = info?.releaseNotes;
  if (typeof notes === 'string') return notes.slice(0, 2000);
  if (Array.isArray(notes)) return notes.map((n) => n?.note ?? '').join('\n').slice(0, 2000);
  return '';
}

function explain(error) {
  const message = error?.message ?? String(error ?? 'unknown error');
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(message)) return 'no internet connection';
  if (/404/.test(message)) return 'no releases published yet';
  if (/rate limit/i.test(message)) return 'GitHub rate limit reached — try later';
  return message;
}
