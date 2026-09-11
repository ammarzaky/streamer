/** Reliable, ordered WebRTC file transport. No file bytes go through signaling.
 * Small frames and a shared upload pacer keep SCTP buffers bounded alongside video.
 * https://www.w3.org/TR/webrtc/#rtcdatachannel
 */
export const FILE_CHANNEL = 'room-files-v1';
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 12 * 1024;
const HEADER_BYTES = 40;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function safeFileName(value) {
  const base = String(value).split(/[\\/]/).at(-1);
  return [...base].filter((c) => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127)
    .join('').slice(0, 180).trim() || 'download';
}

export function parseFileControl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const m = JSON.parse(raw);
    if (m?.v !== 1) return null;
    if (m.kind === 'hello') return { kind: 'hello' };
    if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return null;
    if (m.kind === 'offer') {
      if (typeof m.name !== 'string' || !m.name || m.name.length > 255 ||
          !Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE_BYTES) return null;
      return { kind: m.kind, id: m.id, name: safeFileName(m.name), size: m.size };
    }
    return ['accept', 'cancel', 'end', 'complete'].includes(m.kind) ? { kind: m.kind, id: m.id } : null;
  } catch { return null; }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createFileTransfers({ onUpdate, onPeersChanged = () => {},
  rateBytesPerSecond = () => 32 * 1024, receiveBudgetBytes = 200 * 1024 * 1024,
  createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url),
} = {}) {
  const peers = new Map();
  const transfers = new Map();
  let reservedBytes = 0;
  let nextSendAt = 0;

  function update(t) {
    if (!transfers.has(t.key)) return;
    onUpdate?.({ key: t.key, id: t.id, peerId: t.peer.id, peerName: t.peer.name,
      name: t.name, size: t.size, bytes: t.bytes, direction: t.direction, state: t.state, url: t.url });
  }
  function control(peer, kind, data = {}) {
    if (peer.channel.readyState !== 'open') return false;
    try { peer.channel.send(JSON.stringify({ v: 1, kind, ...data })); return true; }
    catch { return false; }
  }
  function active(t) { return !t.ended && transfers.has(t.key); }
  function releaseMemory(t) {
    if (t.reserved) { reservedBytes -= t.size; t.reserved = false; }
    t.chunks = [];
    if (t.url) { revokeUrl(t.url); t.url = null; }
  }
  function finish(t, state, notify = true) {
    if (!active(t)) return;
    t.ended = true;
    t.state = state;
    clearTimeout(t.timer);
    t.abort.abort();
    t.file = null;
    if (state !== 'Received') releaseMemory(t);
    if (notify) update(t);
  }
  function cancel(t, state = 'Cancelled') {
    if (!active(t)) return;
    control(t.peer, 'cancel', { id: t.id });
    finish(t, state);
  }
  function touch(t) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => cancel(t, 'Timed out — send again'), 180000);
  }
  function busy(peer, direction) {
    return [...transfers.values()].some((t) => t.peer === peer && t.direction === direction && active(t));
  }
  function make(peer, id, name, size, direction, file = null) {
    const t = { peer, id, name, size, direction, file, key: `${peer.id}:${direction}:${id}`,
      bytes: 0, state: direction === 'send' ? 'Waiting for acceptance' : 'Offered',
      chunks: [], reserved: false, url: null, ended: false, abort: new AbortController() };
    transfers.set(t.key, t);
    touch(t);
    update(t);
    return t;
  }
  async function pump(t) {
    try {
      while (active(t) && t.bytes < t.size) {
        const offset = t.bytes;
        const part = await t.file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer();
        if (!active(t)) return;
        const rate = Math.max(1024, Number(rateBytesPerSecond()) || 32768);
        const now = performance.now();
        const wait = Math.max(0, nextSendAt - now);
        nextSendAt = Math.max(now, nextSendAt) + ((part.byteLength + HEADER_BYTES) / rate) * 1000;
        await delay(wait, t.abort.signal);
        while (t.peer.channel.bufferedAmount > 64 * 1024) await delay(50, t.abort.signal);
        if (!active(t) || t.peer.channel.readyState !== 'open') throw new Error('Disconnected');
        const packet = new Uint8Array(HEADER_BYTES + part.byteLength);
        packet.set(encoder.encode(t.id));
        new DataView(packet.buffer).setUint32(36, offset);
        packet.set(new Uint8Array(part), HEADER_BYTES);
        t.peer.channel.send(packet.buffer);
        t.bytes += part.byteLength;
        touch(t);
        update(t);
      }
      if (!active(t)) return;
      t.state = 'Confirming delivery';
      if (!control(t.peer, 'end', { id: t.id })) throw new Error('Disconnected');
      update(t);
    } catch { if (active(t)) cancel(t, 'Transfer interrupted — send again'); }
  }
  function receive(peer, data) {
    if (peers.get(peer.id) !== peer) return;
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < HEADER_BYTES || data.byteLength > HEADER_BYTES + FILE_CHUNK_BYTES) return;
      const id = decoder.decode(new Uint8Array(data, 0, 36));
      const t = transfers.get(`${peer.id}:receive:${id}`);
      if (!t || t.peer !== peer || !active(t) || t.state !== 'Receiving') return;
      const size = data.byteLength - HEADER_BYTES;
      if (!size || new DataView(data).getUint32(36) !== t.bytes || t.bytes + size > t.size) {
        cancel(t, 'Invalid file data'); return;
      }
      t.chunks.push(data.slice(HEADER_BYTES));
      t.bytes += size;
      touch(t);
      update(t);
      return;
    }
    const m = parseFileControl(data);
    if (!m) return;
    if (m.kind === 'hello') { peer.ready = true; onPeersChanged(); return; }
    if (!peer.ready) return;
    if (m.kind === 'offer') {
      if (busy(peer, 'receive')) { control(peer, 'cancel', { id: m.id }); return; }
      // IDs cannot replace an existing completed download or create unlimited duplicate cards.
      if (transfers.has(`${peer.id}:receive:${m.id}`)) return;
      make(peer, m.id, m.name, m.size, 'receive');
      return;
    }
    const direction = ['accept', 'complete'].includes(m.kind) ? 'send' : 'receive';
    let t = transfers.get(`${peer.id}:${direction}:${m.id}`);
    if (m.kind === 'cancel') t ??= transfers.get(`${peer.id}:send:${m.id}`);
    if (!t || t.peer !== peer || !active(t)) return;
    if (m.kind === 'cancel') { finish(t, 'Cancelled'); return; }
    if (m.kind === 'accept' && t.state === 'Waiting for acceptance') {
      t.state = 'Sending'; touch(t); update(t); void pump(t);
    } else if (m.kind === 'complete' && t.state === 'Confirming delivery') finish(t, 'Sent');
    else if (m.kind === 'end' && t.state === 'Receiving') {
      if (t.bytes !== t.size) { cancel(t, 'Incomplete file'); return; }
      try {
        // Force download; never render received HTML/SVG or execute received content.
        t.url = createUrl(new Blob(t.chunks, { type: 'application/octet-stream' }));
        t.chunks = [];
        finish(t, 'Received');
        control(peer, 'complete', { id: t.id });
      } catch { cancel(t, 'Not enough memory'); }
    }
  }

  function attachPeer(id, name, channel) {
    const peer = { id, name, channel, ready: false };
    peers.set(id, peer);
    channel.binaryType = 'arraybuffer';
    const hello = () => control(peer, 'hello');
    channel.addEventListener('open', hello);
    channel.addEventListener('message', ({ data }) => receive(peer, data));
    channel.addEventListener('close', () => {
      if (peers.get(id) === peer) peers.delete(id);
      for (const t of transfers.values()) if (t.peer === peer && active(t)) finish(t, 'Disconnected — send again');
      onPeersChanged();
    });
    if (channel.readyState === 'open') hello();
  }

  return {
    attachPeer,
    readyPeers: () => [...peers.values()].filter((p) => p.ready && p.channel.readyState === 'open'),
    offerFile(file) {
      if (!file || file.size > MAX_FILE_BYTES) throw new Error('Maximum file size is 100 MB.');
      let offered = 0;
      for (const peer of peers.values()) {
        if (!peer.ready || peer.channel.readyState !== 'open' || busy(peer, 'send')) continue;
        const t = make(peer, crypto.randomUUID(), safeFileName(file.name), file.size, 'send', file);
        if (control(peer, 'offer', { id: t.id, name: t.name, size: t.size })) offered++;
        else finish(t, 'Could not send');
      }
      if (!offered) throw new Error('No available recipient. Wait for a connection or the current transfer.');
      return offered;
    },
    accept(key) {
      const t = transfers.get(key);
      if (!t || !active(t) || t.state !== 'Offered') return;
      if (reservedBytes + t.size > receiveBudgetBytes) { cancel(t, 'Remove earlier files to free memory'); return; }
      t.reserved = true;
      reservedBytes += t.size;
      t.state = 'Receiving';
      touch(t); update(t);
      if (!control(t.peer, 'accept', { id: t.id })) finish(t, 'Disconnected — send again');
    },
    cancel(key) { const t = transfers.get(key); if (t) cancel(t); },
    discard(key) {
      const t = transfers.get(key);
      if (!t) return;
      if (active(t)) { control(t.peer, 'cancel', { id: t.id }); finish(t, 'Removed', false); }
      releaseMemory(t);
      transfers.delete(key);
    },
    clear() {
      for (const key of [...transfers.keys()]) this.discard(key);
      peers.clear(); nextSendAt = 0; onPeersChanged();
    },
    get reservedBytes() { return reservedBytes; },
  };
}
