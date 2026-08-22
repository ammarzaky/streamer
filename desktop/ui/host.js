/**
 * Room details: the invite links, the fingerprint, and the two things that actually stop people
 * connecting — a closed router port and a third-party firewall.
 *
 * It opens by itself when a room is created, because sending the link is the next thing a host
 * does and hunting for a menu item first is friction with no purpose.
 */

const bridge = window.streamer;

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const participants = document.getElementById('participants');
const linksBox = document.getElementById('links');
const fingerprintBox = document.getElementById('fingerprint');
const portLabel = document.getElementById('port');
const upnpToggle = document.getElementById('upnp');
const upnpNote = document.getElementById('upnp-note');
const tunnelToggle = document.getElementById('tunnel');
const tunnelNote = document.getElementById('tunnel-note');
const stopButton = document.getElementById('stop');

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function renderStatus(status) {
  const live = status.hosting;
  dot.classList.toggle('is-live', live);
  statusText.textContent = live ? `Hosting on port ${status.port}` : 'Not hosting';
  portLabel.textContent = status.port ?? '—';

  if (live) {
    const n = status.participants ?? 0;
    participants.textContent = n === 1 ? '1 person here' : `${n} people here`;
  } else {
    participants.textContent = '';
  }

  if (status.fingerprint) fingerprintBox.textContent = status.fingerprint;
  renderUpnp(status.upnp ?? { state: 'off' });
  renderTunnel(status.tunnel ?? { state: 'off' });
}

function renderTunnel(tunnel) {
  if (document.activeElement !== tunnelToggle) {
    tunnelToggle.checked = tunnel.state === 'open' || tunnel.state === 'starting';
  }

  const messages = {
    off: null,
    starting: 'Opening a tunnel…',
    open: `Public link is live at ${tunnel.url}. Anyone can reach this room through it.`,
    failed: tunnel.reason,
  };

  const text = messages[tunnel.state];
  tunnelNote.textContent = text ?? '';
  tunnelNote.hidden = !text;
  tunnelNote.classList.toggle('error', tunnel.state === 'failed');
  tunnelNote.classList.toggle('info', tunnel.state !== 'failed');
}

function renderUpnp(upnp) {
  // Only follow the reported state when the user is not mid-interaction, so a poll landing
  // between click and result cannot flip the checkbox back under them.
  if (document.activeElement !== upnpToggle) {
    upnpToggle.checked = upnp.state === 'open' || upnp.state === 'trying';
  }

  const messages = {
    off: null,
    trying: 'Asking the router…',
    open: upnp.cgnat
      ? `The router opened the port, but it reports ${upnp.externalIp} as its own address — ` +
        'that is a private range, which means your connection is behind carrier-grade NAT and ' +
        'people outside still cannot reach you. Forwarding cannot fix that; only your ISP can.'
      : upnp.externalIp
        ? `Port open. From outside, this machine appears as ${upnp.externalIp}.`
        : 'Port open. The router would not say what your external address is.',
    failed: upnp.reason,
  };

  const text = messages[upnp.state];
  upnpNote.textContent = text ?? '';
  upnpNote.hidden = !text;
  upnpNote.classList.toggle('error', upnp.state === 'failed');
  upnpNote.classList.toggle('info', upnp.state !== 'failed');
}

// ---------------------------------------------------------------------------
// Invite links
// ---------------------------------------------------------------------------

function renderLinks(invites) {
  linksBox.replaceChildren(...invites.links.map(linkCard));
}

function linkCard(entry) {
  const card = document.createElement('div');
  card.className = 'link';
  card.dataset.testid = 'invite-link';
  card.dataset.host = entry.host;
  card.dataset.scope = entry.scope ?? '';

  const head = document.createElement('div');
  head.className = 'link__head';

  const host = document.createElement('span');
  host.className = 'link__host';
  host.textContent = entry.host;
  head.append(host);

  // Naming the reach of every address prevents the classic failure of sending someone a localhost
  // or 10.x link and both people wondering why it resolves to nothing.
  const tag = document.createElement('span');
  tag.className = 'link__tag';
  tag.textContent = entry.scope ?? '';
  if (entry.scope === 'internet') {
    tag.classList.add('link__tag--good');
    tag.textContent = 'anywhere — send this one abroad';
  }
  head.append(tag);
  card.append(head);

  // Through the tunnel both forms are the same https URL, so offering it twice under two labels
  // would just be two buttons that copy identical text.
  if (entry.desktop === entry.browser) {
    card.append(row('link', entry.desktop, 'copy-desktop'));
  } else {
    card.append(row('App', entry.desktop, 'copy-desktop'));
    card.append(row('Browser', entry.browser, 'copy-browser'));
  }
  return card;
}

function row(label, value, testid) {
  const wrap = document.createElement('div');
  wrap.className = 'link__row';

  const text = document.createElement('code');
  text.className = 'mono link__value';
  text.textContent = value;
  text.title = value;

  const button = document.createElement('button');
  button.textContent = `Copy ${label.toLowerCase()}`;
  button.dataset.testid = testid;
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(value);
    const previous = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  });

  wrap.append(text, button);
  return wrap;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Router requests run one at a time, in the order they were made.
 *
 * Talking to a router takes seconds, so a second toggle easily arrives while the first is still
 * in flight. Running both concurrently would let the replies land out of order and leave the
 * checkbox disagreeing with the actual mapping. Serialising rather than dropping means the last
 * thing the user asked for is what they end up with.
 */
let upnpChain = Promise.resolve();

upnpToggle.addEventListener('change', () => {
  const toggle = upnpToggle;
  const wanted = toggle.checked;
  const run = () => applyUpnp(toggle, wanted);
  upnpChain = upnpChain.then(run, run);
});

async function applyUpnp(toggle, wanted) {
  toggle.disabled = true;
  renderUpnp({ state: wanted ? 'trying' : 'off' });

  try {
    renderUpnp(await bridge.setUpnp(wanted));
  } catch (error) {
    renderUpnp({ state: 'failed', reason: error.message });
    toggle.checked = false;
  } finally {
    toggle.disabled = false;
  }
}

// Serialised for the same reason as UPnP: starting a tunnel takes seconds, and two overlapping
// requests would leave the checkbox and the actual process disagreeing.
let tunnelChain = Promise.resolve();

tunnelToggle.addEventListener('change', () => {
  const toggle = tunnelToggle;
  const wanted = toggle.checked;
  const run = () => applyTunnel(toggle, wanted);
  tunnelChain = tunnelChain.then(run, run);
});

async function applyTunnel(toggle, wanted) {
  toggle.disabled = true;
  renderTunnel({ state: wanted ? 'starting' : 'off' });

  try {
    const state = await bridge.setTunnel(wanted);
    renderTunnel(state);
    // A new public address is a new set of invite links, and the poll only rebuilds them when the
    // room id changes -- which it has not.
    if (state.state === 'open' || !wanted) await refreshLinks(true);
  } catch (error) {
    renderTunnel({ state: 'failed', reason: error.message });
    toggle.checked = false;
  } finally {
    toggle.disabled = false;
  }
}

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  try {
    // No follow-up call to go Home: stopping closes this window, so anything queued after this
    // await would be issued by a renderer that no longer exists. The main process handles it.
    await bridge.stopHosting();
  } catch {
    stopButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let lastRoomId = null;

/** Rebuild the invite list. `force` is for when the addresses changed but the room did not. */
async function refreshLinks(force = false) {
  const status = await bridge.hostStatus();
  if (!status.hosting || !status.roomId) return;
  if (!force && status.roomId === lastRoomId) return;
  lastRoomId = status.roomId;
  renderLinks(await bridge.roomInvites());
}

async function refresh() {
  try {
    renderStatus(await bridge.hostStatus());
    // The links only change when the room does, and rebuilding them every second would reset a
    // selection the user is in the middle of making.
    await refreshLinks();
  } catch {
    dot.classList.add('is-error');
    statusText.textContent = 'Lost contact with the server';
  }
}

void refresh();
setInterval(() => void refresh(), 1000);
