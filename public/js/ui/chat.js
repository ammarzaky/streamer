import { C2S, S2C, LIMITS } from '../../shared/protocol.js';

/** Ephemeral transcript; only server-accepted messages appear as sent. */
export function createChat({ send, canSend }) {
  const panel = document.querySelector('#chat-panel');
  const toggle = panel.querySelector('button');
  const content = document.querySelector('#chat-body');
  let opened = true;
  const log = document.querySelector('#chat-log');
  const form = document.querySelector('#chat-form');
  const input = document.querySelector('#chat-input');
  const button = document.querySelector('#chat-send');
  const status = document.querySelector('#chat-status');
  const unreadBadge = document.querySelector('#chat-unread');
  const empty = document.querySelector('#chat-empty');
  let supported = false;
  let online = false;
  let pending = null;
  let timer = null;
  let unread = 0;
  const ids = new Set();
  const disposers = new Map();
  function trimLog() {
    while (log.children.length > 100) {
      const first = log.firstElementChild;
      ids.delete(first.dataset.messageId);
      disposers.get(first)?.();
      disposers.delete(first);
      first.remove();
    }
  }
  input.maxLength = LIMITS.MAX_CHAT_CHARS;
  function renderControls() {
    input.disabled = !online || !supported || pending !== null;
    button.disabled = input.disabled || !input.value.trim();
  }
  function releasePending(message) {
    clearTimeout(timer);
    pending = null;
    status.textContent = message;
    renderControls();
  }
  function setConnection(connected, available = supported) {
    online = connected;
    supported = available;
    if (!online && pending) releasePending('Delivery not confirmed. Your draft is kept.');
    else {
      status.textContent = !supported ? 'Chat needs an updated room host.'
        : !online ? 'Reconnect to send messages.' : 'Enter to send · Shift+Enter for a new line';
      renderControls();
    }
  }
  function submit(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!online || !supported || pending || !canSend() || !text || text.length > LIMITS.MAX_CHAT_CHARS) return;
    try {
      pending = send(C2S.CHAT, { text }, { correlate: true });
      status.textContent = 'Sending…';
      renderControls();
      timer = setTimeout(() => releasePending('Delivery not confirmed. Your draft is kept.'), 10000);
    } catch { releasePending('Could not send. Your draft is kept.'); }
  }
  function receive(message) {
    if (message.type === S2C.ERROR) {
      if (!pending || message.ref !== pending) return false;
      releasePending('Message not sent. Wait a moment and try again.');
      return true;
    }
    const data = message.data;
    if (typeof data?.id !== 'string' || typeof data.text !== 'string' ||
        data.text.length > LIMITS.MAX_CHAT_CHARS || typeof data.name !== 'string') return true;
    const own = pending !== null && message.ref === pending;
    if (own) {
      input.value = '';
      releasePending('Sent');
      if (opened) input.focus();
    }
    if (ids.has(data.id)) return true;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    ids.add(data.id);
    empty.hidden = true;
    const entry = document.createElement('div');
    entry.className = 'chat__message';
    entry.dataset.messageId = data.id;
    const meta = document.createElement('div');
    meta.className = 'chat__meta';
    const name = document.createElement('bdi');
    name.textContent = data.name;
    const time = document.createElement('time');
    const date = new Date(data.sentAt);
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    meta.append(name, time);
    const body = document.createElement('p');
    body.dir = 'auto';
    body.textContent = data.text;
    entry.append(meta, body);
    log.append(entry);
    trimLog();
    if (atBottom || own) log.scrollTop = log.scrollHeight;
    if (!opened && !own) {
      unreadBadge.textContent = String(++unread);
      unreadBadge.hidden = false;
    }
    return true;
  }
  form.addEventListener('submit', submit);
  input.addEventListener('input', renderControls);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  toggle.addEventListener('click', () => {
    opened = !opened;
    panel.classList.toggle('chat--open', opened);
    toggle.setAttribute('aria-expanded', String(opened));
    content.hidden = !opened;
    if (!opened) return;
    unread = 0;
    unreadBadge.hidden = true;
    log.scrollTop = log.scrollHeight;
  });
  renderControls();
  return {
    receive, setConnection,
    appendAttachment(element, dispose, incoming) {
      empty.hidden = true;
      log.append(element);
      disposers.set(element, dispose);
      trimLog();
      log.scrollTop = log.scrollHeight;
      if (!opened && incoming) {
        unreadBadge.textContent = String(++unread);
        unreadBadge.hidden = false;
      }
    },
    removeAttachment(element) {
      disposers.get(element)?.();
      disposers.delete(element);
      element.remove();
      empty.hidden = log.children.length !== 0;
    },
    clear() {
      online = false;
      releasePending('Room closed.');
      input.value = '';
      for (const dispose of disposers.values()) dispose();
      disposers.clear();
      log.replaceChildren();
      ids.clear();
      empty.hidden = false;
    },
  };
}
