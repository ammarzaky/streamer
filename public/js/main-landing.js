/**
 * Landing page.
 *
 * Deliberately does no networking at all. The obvious design -- ask the server for a room id
 * here, then navigate to it -- destroys the WebSocket during navigation and leaves a room
 * whose host never arrives. So "Create a room" is a pure client-side navigation to /r/new,
 * and room.html opens the socket and creates the room once it is the page that will keep it.
 */

import { need, show, text } from './core/dom.js';
import { checkEnvironment } from './core/env.js';
import { errorCopy } from './ui/strings.js';
import { h } from './core/dom.js';

const createButton = need('#create');
const joinForm = need('#join-form');
const joinInput = need('#join-link');
const joinError = need('#join-error');
const envBanner = need('#env-banner');

// -----------------------------------------------------------------------------
// Environment
// -----------------------------------------------------------------------------

// Checked before anything is clickable. Over http:// `navigator.mediaDevices` is undefined,
// and every later call fails with a message about a missing property rather than the actual
// problem, which is the address in the address bar.
const env = checkEnvironment({ requireDisplayMedia: false });
if (!env.ok) {
  const { message, hint } = errorCopy(env.error.code);
  show(envBanner, true);
  envBanner.className = 'banner banner--danger';
  envBanner.replaceChildren(
    h('span', { class: 'banner__text' }, `${message} ${hint}`.trim()),
  );
  createButton.disabled = true;
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

createButton.addEventListener('click', () => {
  location.assign('/r/new');
});

// -----------------------------------------------------------------------------
// Join
// -----------------------------------------------------------------------------

/**
 * Accept anything that plausibly identifies a room: a full link, a path, or a bare id.
 *
 * People paste from chat apps that append punctuation, wrap links in angle brackets, or
 * include surrounding text. Rejecting those with "invalid link" when the id is right there is
 * needless friction, so we extract rather than validate.
 */
export function extractRoomId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const cleaned = raw.replace(/^[<("']+|[>)"'.,]+$/g, '');

  // A full or partial URL containing /r/<id>.
  const inPath = cleaned.match(/\/r\/([A-Za-z0-9_-]+)/);
  if (inPath) return inPath[1] === 'new' ? null : inPath[1];

  // A bare id. Long enough not to be a stray word, and URL-safe.
  if (/^[A-Za-z0-9_-]{8,64}$/.test(cleaned)) return cleaned;

  return null;
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const roomId = extractRoomId(joinInput.value);
  if (!roomId) {
    show(joinError, true);
    text(joinError, "That doesn't look like a room link. Paste the whole link you were sent.");
    joinInput.setAttribute('aria-invalid', 'true');
    joinInput.focus();
    return;
  }

  show(joinError, false);
  joinInput.removeAttribute('aria-invalid');
  location.assign(`/r/${roomId}`);
});

joinInput.addEventListener('input', () => {
  show(joinError, false);
  joinInput.removeAttribute('aria-invalid');
});
