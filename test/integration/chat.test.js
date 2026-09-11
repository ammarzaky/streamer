import test from 'node:test';
import assert from 'node:assert/strict';
import { C2S, S2C, ERRORS, LIMITS } from '../../public/shared/protocol.js';
import { startHarness } from '../helpers/server-harness.js';

async function room(h, name) {
  const client = await h.connect();
  client.send(C2S.CREATE_ROOM, { name });
  const created = await client.waitFor(S2C.ROOM_CREATED);
  return { client, ...created.data };
}

test('chat echoes accepted messages with authenticated identity and stays inside the room', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const a = await room(h, 'Alice');
  const b = await h.connect();
  b.send(C2S.JOIN, { name: 'Bob', roomId: a.roomId });
  await b.waitFor(S2C.JOINED);
  const outside = await room(h, 'Outside');
  const none = outside.client.expectNone((m) => m.type === S2C.CHAT, 200);
  a.client.send(C2S.CHAT, { text: '  أهلاً 👋 <script>alert(1)</script>  ' }, 'chat-1');
  const echo = await a.client.waitFor(S2C.CHAT);
  const received = await b.waitFor(S2C.CHAT);
  assert.deepEqual(echo.data, received.data);
  assert.equal(echo.ref, 'chat-1');
  assert.equal(echo.data.peerId, a.selfId);
  assert.equal(echo.data.name, 'Alice');
  assert.equal(echo.data.text, 'أهلاً 👋 <script>alert(1)</script>');
  assert.ok(echo.data.id && Number.isFinite(echo.data.sentAt));
  await none;
  const late = await h.connect();
  late.send(C2S.JOIN, { name: 'Late', roomId: a.roomId });
  await late.waitFor(S2C.JOINED);
  await late.expectNone((m) => m.type === S2C.CHAT);
});

test('chat rejects unjoined clients, blank, oversized and spoofed payloads', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const client = await h.connect();
  client.send(C2S.CHAT, { text: 'hello' });
  assert.equal((await client.waitFor(S2C.ERROR)).data.code, ERRORS.WRONG_STATE);
  client.send(C2S.CREATE_ROOM, { name: 'Alice' });
  await client.waitFor(S2C.ROOM_CREATED);
  for (const data of [{ text: ' \n ' }, { text: 'x'.repeat(LIMITS.MAX_CHAT_CHARS + 1) },
    { text: 'hello', name: 'Someone else' }, { text: 'hello', to: 'another-room' }]) {
    client.send(C2S.CHAT, data);
    assert.equal((await client.waitFor(S2C.ERROR)).data.code, ERRORS.INVALID_PAYLOAD);
  }
  client.send(C2S.CHAT, { text: 'x'.repeat(LIMITS.MAX_CHAT_CHARS) });
  assert.equal((await client.waitFor(S2C.CHAT)).data.text.length, LIMITS.MAX_CHAT_CHARS);
});

test('chat flood is limited without consuming call-control tokens or disconnecting', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const a = await room(h, 'Alice');
  for (let i = 0; i < 20; i++) a.client.send(C2S.CHAT, { text: String(i) });
  assert.equal((await a.client.waitFor(S2C.ERROR)).data.code, ERRORS.RATE_LIMITED);
  a.client.send(C2S.PING);
  await a.client.waitFor(S2C.PONG);
  assert.equal(a.client.socket.readyState, 1);
});
