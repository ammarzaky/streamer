/**
 * The Home screen: host a room, or join one from a link.
 *
 * Everything real happens in the main process. This file validates the pasted link as it is
 * typed so the user finds out it is wrong before pressing anything, and turns failures into a
 * sentence rather than a stack trace.
 */

const bridge = window.streamer;

// Bound individually rather than collected into an `el` namespace: these are written to after
// awaits, and a property write through a shared object is exactly the shape require-atomic-updates
// flags -- correctly, in general. Direct bindings make each write obviously local.
const hostButton = document.getElementById('host');
const hostNote = document.getElementById('host-note');
const linkInput = document.getElementById('link');
const joinButton = document.getElementById('join');
const previewLabel = document.getElementById('preview');
const errorBox = document.getElementById('error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function showHostNote(message) {
  hostNote.textContent = message ?? '';
  hostNote.hidden = !message;
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

hostButton.addEventListener('click', async () => {
  showError('');
  hostButton.disabled = true;
  showHostNote('Starting the server…');

  try {
    await bridge.hostRoom();
    // On success the main process navigates this window to the room, so nothing below runs.
  } catch (error) {
    hostButton.disabled = false;
    showHostNote('');
    showError(`Could not start the room. ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

let previewToken = 0;

async function updatePreview() {
  const text = linkInput.value.trim();
  // Typing outruns IPC, so replies can land out of order. Without this the label can end up
  // describing a link the user has already finished editing away from.
  const token = ++previewToken;

  if (!text) {
    joinButton.disabled = true;
    previewLabel.textContent = '';
    return;
  }

  try {
    const invite = await bridge.previewInvite(text);
    if (token !== previewToken) return;

    joinButton.disabled = false;
    previewLabel.textContent = invite.pinned
      ? `${invite.host}:${invite.port} — certificate pinned`
      : `${invite.host}:${invite.port} — no fingerprint in this link, expect a warning`;
    showError('');
  } catch (error) {
    if (token !== previewToken) return;
    joinButton.disabled = true;
    previewLabel.textContent = error.message;
  }
}

linkInput.addEventListener('input', () => void updatePreview());

// Paste-and-press-enter is how this actually gets used.
linkInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !joinButton.disabled) joinButton.click();
});

joinButton.addEventListener('click', async () => {
  showError('');
  joinButton.disabled = true;

  try {
    await bridge.join(linkInput.value.trim());
  } catch (error) {
    joinButton.disabled = false;
    showError(error.message);
  }
});

// ---------------------------------------------------------------------------
// Failures pushed from the main process
// ---------------------------------------------------------------------------

// The main process composes these, because it is the only place that knows whether the host was
// unreachable or was reached and refused -- two failures with nothing in common except the
// moment they happen. The wording is deliberately blunt for the certificate case: it is the one
// message here that might mean someone is being intercepted.
bridge.onJoinFailed(({ message }) => {
  joinButton.disabled = false;
  showError(message);
});

// The window is reused for the room, so coming back should not show a stale spinner.
window.addEventListener('pageshow', () => {
  hostButton.disabled = false;
  showHostNote('');
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Nothing here downloads on its own.
 *
 * This app is used mid-call, and an update that quietly fetches 80 MB and then wants to restart
 * would drop everyone in the room. The check is automatic and free; the download is a decision.
 */
const updateVersion = document.getElementById('update-version');
const updateMsg = document.getElementById('update-msg');
const updateAction = document.getElementById('update-action');

function renderUpdate(status) {
  if (!status) return;
  updateVersion.textContent = `Streamer ${status.currentVersion ?? ''}`.trim();

  const show = (message, label, handler) => {
    updateMsg.textContent = message ?? '';
    updateAction.hidden = !label;
    updateAction.textContent = label ?? '';
    updateAction.onclick = handler ?? null;
    updateAction.classList.toggle('primary', Boolean(handler));
  };

  switch (status.state) {
    case 'checking':
      return show('Checking for updates…', null, null);
    case 'available':
      return show(`Version ${status.version} is available.`, 'Download', () => void bridge.downloadUpdate());
    case 'downloading':
      return show(`Downloading… ${status.percent ?? 0}%`, null, null);
    case 'ready':
      return show(`Version ${status.version} is ready.`, 'Restart and install', () => void bridge.installUpdate());
    case 'current':
      return show('Up to date.', 'Check again', () => void bridge.checkForUpdates());
    case 'unavailable':
      // Said plainly rather than dressed up as "up to date", which would be a different claim
      // and would stop anyone looking for the real reason.
      return show(`Could not check for updates — ${status.reason ?? 'unknown'}.`, 'Retry', () =>
        void bridge.checkForUpdates(),
      );
    default:
      return show('', 'Check for updates', () => void bridge.checkForUpdates());
  }
}

bridge.onUpdateStatus(renderUpdate);
void bridge.updateStatus().then(renderUpdate).catch(() => {});
