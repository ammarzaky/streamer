/**
 * The Windows mute flag and input volume of the microphones, read from the main process.
 *
 * The bug this answers: "nobody can hear me, the level bar never moves", with the microphone
 * muted in Windows -- the F-row key with the LED, or the switch in Settings > System > Sound >
 * Input. In that state getUserMedia succeeds, RTP flows, and every sample is zero.
 *
 * Chromium does see that mute (measured, Electron 33 / Chrome 130): it polls the endpoint's mute
 * state once a second, a track opened while the endpoint is muted starts with `muted: true`, and
 * muting or unmuting a live endpoint fires `mute` / `unmute` within about a second. The page
 * therefore has a definitive signal and names the Windows mute itself (lobby and room). This
 * module is the second line of defence, not the only one: a direct Core Audio read through the
 * PowerShell helper in `win/mic-endpoint.ps1` (no administrator rights) that also reports the
 * input volume -- a volume of 0 is just as silent and is not a mute -- lists every active
 * capture endpoint, not only the one Chromium opened, and can clear the flag with one click,
 * which no page API can. What neither side can see is an APO or hardware gate that delivers real
 * near-zero samples with `muted: false`; the page's silence timer covers that one.
 *
 * Nothing here throws to a caller and nothing is persisted. Every call logs one line --
 * `mic-status` or `mic-unmute` with the status or the error and how long it took -- through the
 * logger injected by `setMicStatusLogger`, the same way `capture.js` takes its logger.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Add-Type compiles a few lines of C# on every run; that takes a second or two, not fifteen. */
const TIMEOUT_MS = 15_000;

/** The helper caps its list at this many entries; the parser holds it to the same number. */
export const MAX_ENDPOINTS = 32;

let log = (event, detail) => console.log(`[desktop] ${event}`, detail ?? '');
export function setMicStatusLogger(fn) {
  log = fn;
}

/**
 * Where the helper script is, unpacked and packaged alike.
 *
 * The bundle ships without asar (see electron-builder.yml), so this resolves to a real file next
 * to this module in both layouts. Should asar ever be turned on, `asarUnpack` keeps
 * `desktop/win/**` on disk under `app.asar.unpacked`, and the rewrite here points at it --
 * PowerShell cannot read inside an archive.
 */
export const helperPath = () =>
  path.join(HERE, 'win', 'mic-endpoint.ps1').replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');

/**
 * The absolute path of Windows PowerShell, or `{ error }` saying why there is none.
 *
 * The absolute path and never the bare name: `execFile` on Windows searches the current directory
 * before PATH, and the app's working directory is whatever it was launched from -- a bare
 * `powershell.exe` would run whatever file of that name sits there.
 */
function powershellPath() {
  const root = process.env.SystemRoot;
  if (!root) return { error: 'SystemRoot is not set; cannot locate powershell.exe' };
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(exe)) return { error: `powershell.exe is missing at ${exe}` };
  return { exe };
}

const isEndpoint = (entry) =>
  Boolean(entry) &&
  typeof entry === 'object' &&
  !Array.isArray(entry) &&
  Object.keys(entry).sort().join(',') === 'isDefault,muted,name,volume' &&
  typeof entry.name === 'string' &&
  typeof entry.muted === 'boolean' &&
  typeof entry.isDefault === 'boolean' &&
  Number.isInteger(entry.volume) &&
  entry.volume >= 0 &&
  entry.volume <= 100;

/**
 * @typedef {{name: string, muted: boolean, volume: number, isDefault: boolean}} MicEndpoint
 * @typedef {{name: string, muted: boolean, volume: number, endpoints: MicEndpoint[]}} MicStatus
 */

/**
 * Parse the helper's single line of output, strictly.
 *
 * @param {unknown} text
 * @returns {MicStatus | {error: string} | null}
 *   the status, the helper's own error, or null for anything that is not exactly one of those --
 *   a second line, an extra key, a volume outside 0-100, a muted flag that is not a boolean, an
 *   endpoints list that is missing, empty, over the cap, or holds an entry of any other shape.
 */
export function parseMicStatus(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (!line || /[\r\n]/.test(line)) return null;

  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const keys = Object.keys(value).sort().join(',');
  if (keys === 'error') {
    return typeof value.error === 'string' && value.error ? { error: value.error } : null;
  }
  if (keys !== 'endpoints,muted,name,volume') return null;
  if (typeof value.name !== 'string' || typeof value.muted !== 'boolean') return null;
  if (!Number.isInteger(value.volume) || value.volume < 0 || value.volume > 100) return null;
  const { endpoints } = value;
  if (!Array.isArray(endpoints) || endpoints.length === 0 || endpoints.length > MAX_ENDPOINTS) return null;
  if (!endpoints.every(isEndpoint)) return null;

  return {
    name: value.name,
    muted: value.muted,
    volume: value.volume,
    endpoints: endpoints.map(({ name, muted, volume, isDefault }) => ({ name, muted, volume, isDefault })),
  };
}

/** The only two words the helper accepts, and the only two this module ever passes it. */
const COMMANDS = new Set(['get', 'unmute']);

function runHelper(exe, command) {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(), '-Command', command],
      { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
  });
}

async function query(command) {
  const event = command === 'unmute' ? 'mic-unmute' : 'mic-status';
  if (process.platform !== 'win32' || !COMMANDS.has(command)) return null;

  const started = Date.now();
  try {
    const shell = powershellPath();
    if (!shell.exe) {
      log(event, { error: shell.error, ms: Date.now() - started });
      return null;
    }
    const { error, stdout, stderr } = await runHelper(shell.exe, command);
    const parsed = parseMicStatus(stdout);
    if (parsed && !('error' in parsed)) {
      log(event, { status: parsed, endpoints: parsed.endpoints.length, ms: Date.now() - started });
      return parsed;
    }
    const reason =
      parsed?.error ??
      (error?.killed
        ? `helper timed out after ${TIMEOUT_MS} ms`
        : `unreadable helper output: ${(stderr || stdout || error?.message || '').trim().slice(0, 200)}`);
    log(event, { error: reason, ms: Date.now() - started });
    return null;
  } catch (error) {
    log(event, { error: error?.message ?? String(error), ms: Date.now() - started });
    return null;
  }
}

/** The read in flight, shared, so a menu click during a grant-triggered check does not spawn a second shell. */
let reading = null;

/** @returns {Promise<MicStatus | null>} null off Windows or on any failure */
export function readMicStatus() {
  reading ??= query('get').finally(() => {
    reading = null;
  });
  return reading;
}

/** Clear the Windows mute flag on the default endpoint and return the status afterwards; null off Windows or on any failure. */
export function unmuteMic() {
  return query('unmute');
}
