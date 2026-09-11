import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileTransfers, parseFileControl, safeFileName, MAX_FILE_BYTES } from '../../public/js/rtc/file-transfer.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  packets = [];
  send(data) {
    if (this.readyState !== 'open') throw new Error('closed');
    this.packets.push(data);
    queueMicrotask(() => {
      if (this.other.readyState === 'open') this.other.dispatchEvent(new MessageEvent('message', { data }));
    });
  }
  close() {
    this.readyState = 'closed'; this.other.readyState = 'closed';
    this.dispatchEvent(new Event('close')); this.other.dispatchEvent(new Event('close'));
  }
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for transfer state');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}
async function pair(t, budget) {
  const a = new Channel(); const b = new Channel(); a.other = b; b.other = a;
  const sent = new Map(); const received = new Map(); const blobs = new Map();
  let serial = 0;
  const left = createFileTransfers({ onUpdate: (v) => sent.set(v.key, v), rateBytesPerSecond: () => 10_000_000 });
  const right = createFileTransfers({ onUpdate: (v) => received.set(v.key, v), receiveBudgetBytes: budget,
    createUrl: (blob) => { const id = `blob:${++serial}`; blobs.set(id, blob); return id; },
    revokeUrl: (url) => blobs.delete(url) });
  left.attachPeer('b', 'Bob', a); right.attachPeer('a', 'Alice', b);
  t.after(() => { left.clear(); right.clear(); a.close(); });
  await until(() => left.readyPeers().length && right.readyPeers().length);
  return { left, right, a, b, sent, received, blobs };
}

test('files wait for acceptance, arrive byte-for-byte in bounded chunks, and release retained memory', async (t) => {
  const p = await pair(t);
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
  p.left.offerFile(new File([bytes], 'test.bin'));
  await until(() => p.received.size === 1);
  assert.equal(p.a.packets.filter((v) => v instanceof ArrayBuffer).length, 0);
  assert.equal(p.right.reservedBytes, 0);
  const key = [...p.received.keys()][0];
  p.right.accept(key);
  await until(() => [...p.sent.values()][0].state === 'Sent');
  const result = p.received.get(key);
  assert.equal(result.state, 'Received');
  assert.deepEqual(new Uint8Array(await p.blobs.get(result.url).arrayBuffer()), bytes);
  assert.ok(p.a.packets.filter((v) => v instanceof ArrayBuffer).every((v) => v.byteLength <= 12328));
  assert.equal(p.right.reservedBytes, bytes.length);
  p.right.discard(key);
  assert.equal(p.right.reservedBytes, 0);
  assert.equal(p.blobs.size, 0);
});

test('empty files complete and offers can be declined before any bytes are sent', async (t) => {
  const p = await pair(t);
  p.left.offerFile(new File([], 'empty.txt'));
  await until(() => p.received.size === 1);
  p.right.accept([...p.received.keys()][0]);
  await until(() => [...p.sent.values()][0].state === 'Sent');
  assert.equal([...p.blobs.values()][0].size, 0);
  p.left.offerFile(new File(['private content'], 'declined.txt'));
  await until(() => p.received.size === 2);
  p.right.cancel([...p.received.keys()][1]);
  await until(() => [...p.sent.values()][1].state === 'Cancelled');
  assert.equal(p.a.packets.filter((v) => v instanceof ArrayBuffer).length, 0);
});

test('receive memory cap and disconnection cannot leave partial downloadable files', async (t) => {
  const p = await pair(t, 10);
  p.left.offerFile(new File(['x'.repeat(11)], 'too-large.txt'));
  await until(() => p.received.size === 1);
  p.right.accept([...p.received.keys()][0]);
  await until(() => [...p.sent.values()][0].state === 'Cancelled');
  assert.equal(p.right.reservedBytes, 0);
  assert.equal(p.blobs.size, 0);
  p.left.offerFile(new File(['small'], 'pending.txt'));
  await until(() => p.received.size === 2);
  p.a.close();
  assert.match([...p.received.values()][1].state, /Disconnected/);
  assert.equal(p.left.readyPeers().length, 0);
});

test('metadata is bounded and filenames cannot inject paths', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  const raw = (data) => JSON.stringify({ v: 1, kind: 'offer', id, ...data });
  assert.equal(safeFileName('../folder\\document.txt'), 'document.txt');
  assert.equal(parseFileControl(raw({ name: 'a', size: MAX_FILE_BYTES + 1 })), null);
  assert.equal(parseFileControl(raw({ name: 'a', size: -1 })), null);
  assert.equal(parseFileControl(raw({ name: 'a', size: 1.5 })), null);
  assert.equal(parseFileControl(raw({ name: 'a'.repeat(256), size: 1 })), null);
  assert.equal(parseFileControl('garbage'), null);
  assert.equal(parseFileControl(raw({ name: 'a', size: 0 })).size, 0);
});

test('out-of-order bytes cancel the transfer and free the receive reservation', async (t) => {
  const p = await pair(t);
  p.left.offerFile(new File(['expected'], 'test.txt'));
  await until(() => p.received.size === 1);
  const offer = [...p.received.values()][0];
  p.right.accept(offer.key);
  const packet = new Uint8Array(41);
  packet.set(new TextEncoder().encode(offer.id));
  new DataView(packet.buffer).setUint32(36, 3);
  p.a.send(packet.buffer);
  await until(() => p.received.get(offer.key).state === 'Invalid file data');
  assert.equal(p.right.reservedBytes, 0);
  assert.equal(p.blobs.size, 0);
});
