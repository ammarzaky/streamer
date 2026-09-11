import { createFileTransfers } from '../rtc/file-transfer.js';

const ACTIVE = new Set(['Offered', 'Waiting for acceptance', 'Sending', 'Receiving', 'Confirming delivery']);
const sizeLabel = (bytes) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createFileChat({ chat, canSend, rateBytesPerSecond }) {
  const picker = document.querySelector('#chat-file');
  const attach = document.querySelector('#chat-attach');
  const status = document.querySelector('#file-status');
  const rows = new Map();
  const manager = createFileTransfers({ onUpdate: render, onPeersChanged: refresh, rateBytesPerSecond });

  function refresh() { attach.disabled = !canSend() || manager.readyPeers().length === 0; }
  function render(t) {
    let row = rows.get(t.key);
    if (!row) {
      const element = document.createElement('div');
      element.className = 'chat__message file-card';
      element.dataset.testid = 'file-card';
      const person = document.createElement('div');
      person.className = 'chat__meta';
      person.textContent = `${t.direction === 'send' ? 'To' : 'From'} ${t.peerName}`;
      const title = document.createElement('div');
      title.className = 'file-card__name';
      title.dir = 'auto';
      title.textContent = t.name;
      const size = document.createElement('small');
      size.textContent = sizeLabel(t.size);
      const progress = document.createElement('progress');
      progress.max = t.size || 1;
      progress.setAttribute('aria-label', `File transfer: ${t.name}`);
      const state = document.createElement('small');
      state.dataset.testid = 'file-state';
      const actions = document.createElement('div');
      actions.className = 'file-card__actions';
      const button = (label, testid, action) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn--ghost btn--sm';
        b.textContent = label; b.dataset.testid = testid;
        b.addEventListener('click', action); actions.append(b); return b;
      };
      const accept = button('Receive · استلام', 'file-accept', () => manager.accept(t.key));
      const cancel = button('Cancel · إلغاء', 'file-cancel', () => manager.cancel(t.key));
      const download = document.createElement('a');
      download.className = 'btn btn--primary btn--sm';
      download.textContent = 'Download · تنزيل';
      download.dataset.testid = 'file-download';
      download.download = t.name;
      actions.append(download);
      const remove = button('Remove', 'file-remove', () => chat.removeAttachment(element));
      element.append(person, title, size, progress, state, actions);
      row = { element, progress, state, accept, cancel, download, remove };
      rows.set(t.key, row);
      chat.appendAttachment(element, () => { manager.discard(t.key); rows.delete(t.key); }, t.direction === 'receive');
    }
    row.progress.value = t.state === 'Received' || t.state === 'Sent' ? row.progress.max : t.bytes;
    row.state.textContent = `${t.state} · ${Math.round((t.bytes / (t.size || 1)) * 100)}%`;
    row.accept.hidden = t.state !== 'Offered';
    row.cancel.hidden = !ACTIVE.has(t.state);
    row.remove.hidden = ACTIVE.has(t.state);
    row.download.hidden = t.state !== 'Received' || !t.url;
    if (t.url) row.download.href = t.url;
    else row.download.removeAttribute('href');
    refresh();
  }
  attach.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || !canSend()) return;
    try {
      const count = manager.offerFile(file);
      status.textContent = `File offered to ${count} participant(s). Transfer starts when accepted.`;
    } catch (error) { status.textContent = error.message; }
  });
  refresh();
  return {
    refresh,
    attachPeer: ({ peerId, name, channel }) => manager.attachPeer(peerId, name, channel),
    clear() {
      for (const row of [...rows.values()]) chat.removeAttachment(row.element);
      manager.clear();
      picker.value = '';
    },
  };
}
