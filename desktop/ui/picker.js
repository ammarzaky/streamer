/**
 * The source picker.
 *
 * Replaces Chrome's screen-share dialog. The behavioural difference that matters is not
 * cosmetic: on Windows this app captures the system audio mix automatically, where the browser
 * dialog makes you notice and tick a checkbox. "Nobody could hear the video I was sharing" is
 * the single most common complaint about screen sharing, and it is caused by that checkbox.
 */

const bridge = window.streamer;

const el = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  share: document.getElementById('share'),
  cancel: document.getElementById('cancel'),
  audioNote: document.getElementById('audio-note'),
  audioOption: document.getElementById('audio-option'),
  systemAudio: document.getElementById('system-audio'),
  tabs: [...document.querySelectorAll('[role="tab"]')],
};

let sources = [];
let kind = 'screen';
let selectedId = null;

// The checkbox exists because of what "system audio" means on Windows: the whole mix this PC
// plays, INCLUDING the voices of the people in the call, who then hear themselves echoed back.
// Sharing a film wants it on; a voice-only session where people complain of echo wants it off.
el.audioOption.hidden = bridge.platform !== 'win32';
el.audioNote.textContent =
  bridge.platform === 'win32'
    ? 'Includes everything this PC plays — including the voices of the people in this call, who will hear themselves echoed back. Untick it, or use headphones, if they complain. Your microphone stays separate.'
    : 'Audio cannot be captured from the screen on this platform. Your microphone still works.';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const visible = sources.filter((source) => source.kind === kind);

  el.grid.replaceChildren(...visible.map(tile));
  el.empty.hidden = visible.length > 0;

  for (const tab of el.tabs) tab.classList.toggle('is-active', tab.dataset.kind === kind);

  // A selection from the other tab is no longer on screen, so acting on it would share something
  // the user cannot see they picked.
  if (selectedId && !visible.some((source) => source.id === selectedId)) selectedId = null;
  el.share.disabled = !selectedId;
}

function tile(source) {
  const button = document.createElement('button');
  button.className = 'source';
  button.type = 'button';
  button.setAttribute('aria-selected', String(source.id === selectedId));
  button.dataset.sourceId = source.id;
  button.dataset.testid = 'picker-source';

  if (source.thumbnail) {
    const img = document.createElement('img');
    img.className = 'source__thumb';
    img.src = source.thumbnail;
    img.alt = '';
    button.append(img);
  } else {
    const blank = document.createElement('div');
    blank.className = 'source__thumb';
    button.append(blank);
  }

  const name = document.createElement('span');
  name.className = 'source__name';
  if (source.icon) {
    const icon = document.createElement('img');
    icon.className = 'source__icon';
    icon.src = source.icon;
    icon.alt = '';
    name.append(icon);
  }
  name.append(document.createTextNode(source.name));
  name.title = source.name;
  button.append(name);

  button.addEventListener('click', () => {
    selectedId = source.id;
    render();
  });
  button.addEventListener('dblclick', () => {
    selectedId = source.id;
    confirmShare();
  });

  return button;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function confirmShare() {
  if (!selectedId) return;
  bridge.chooseSource(selectedId, { systemAudio: el.systemAudio.checked });
}

el.share.addEventListener('click', confirmShare);
el.cancel.addEventListener('click', () => bridge.cancelPicker());

// Escape must cancel. A picker you cannot dismiss with the keyboard leaves getDisplayMedia
// pending, and the Share button in the room stays stuck with no way back.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') bridge.cancelPicker();
  if (event.key === 'Enter') confirmShare();
});

for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind;
    render();
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

try {
  sources = await bridge.listSources();
  // Open on whichever tab actually has something in it, so sharing a single window on a machine
  // with one screen does not start on a tab the user has to notice is wrong.
  if (!sources.some((source) => source.kind === 'screen')) kind = 'window';
  render();
} catch (error) {
  el.empty.hidden = false;
  el.empty.textContent = `Could not list what is on screen. ${error.message}`;
}
