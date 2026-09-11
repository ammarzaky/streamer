import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { C2S, S2C, ERRORS, HOST_CHANGE_REASON } from '../../public/shared/protocol.js';
import { startHarness } from '../helpers/server-harness.js';

/**
 * The host lifecycle, which is the server's most intricate state machine and the one where a
 * regression is least visible. Every test here corresponds to a bug that shipped once.
 */

async function createRoom(harness, name = 'Host') {
  const client = await harness.connect();
  await client.waitFor(S2C.WELCOME);
  client.send(C2S.CREATE_ROOM, { name });
  const created = await client.waitFor(S2C.ROOM_CREATED);
  return { client, roomId: created.data.roomId, hostToken: created.data.hostToken, selfId: created.data.selfId };
}

async function join(harness, roomId, name, extra = {}) {
  const client = await harness.connect();
  await client.waitFor(S2C.WELCOME);
  client.send(C2S.JOIN, { roomId, name, ...extra });
  return client;
}

test('host reclaims the role after an accidental disconnect', async (t) => {
  const harness = await startHarness({ rooms: { hostGraceMs: 5000, emptyRoomGraceMs: 60_000 } });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  const guest = await join(harness, host.roomId, 'Guest');
  await guest.waitFor(S2C.JOINED);

  // Drop the host's socket without a `leave`: this is the reload / Wi-Fi blip case, and it
  // arms the grace window rather than promoting.
  host.client.close();
  await guest.waitFor(S2C.PEER_LEFT);

  // The room must not have promoted anyone yet.
  await guest.expectNone((m) => m.type === S2C.HOST_CHANGED, 150);

  // The host comes back with its token and gets the role back.
  const returning = await join(harness, host.roomId, 'Host', { hostToken: host.hostToken });
  const joined = await returning.waitFor(S2C.JOINED);
  assert.equal(joined.data.isHost, true, 'the returning host should be host again');

  const changed = await guest.waitFor(S2C.HOST_CHANGED);
  assert.equal(changed.data.reason, HOST_CHANGE_REASON.RECLAIMED);
  assert.equal(changed.data.hostPeerId, joined.data.selfId);

  returning.close();
  guest.close();
});

test('the reclaiming host receives its rotated token AFTER joined', async (t) => {
  const harness = await startHarness({ rooms: { hostGraceMs: 5000 } });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  const guest = await join(harness, host.roomId, 'Guest');
  await guest.waitFor(S2C.JOINED);

  host.client.close();
  await guest.waitFor(S2C.PEER_LEFT);

  const returning = await join(harness, host.roomId, 'Host', { hostToken: host.hostToken });
  await returning.waitFor(S2C.JOINED);
  await returning.waitFor(S2C.HOST_TOKEN);

  // Ordering matters: `joined` carries this peer's own id and moves it into the JOINED state.
  // A host-token arriving first is discarded by a client that correctly ignores room traffic
  // until then -- and that frame carries the only copy of the rotated token.
  const joinedIndex = returning.inbox.findIndex((m) => m.type === S2C.JOINED);
  const tokenIndex = returning.inbox.findIndex((m) => m.type === S2C.HOST_TOKEN);
  assert.ok(joinedIndex >= 0 && tokenIndex >= 0);
  assert.ok(tokenIndex > joinedIndex, 'host-token must arrive after joined');

  returning.close();
  guest.close();
});

test('host-changed is a broadcast and never carries the host token', async (t) => {
  const harness = await startHarness({ rooms: { hostGraceMs: 40, janitorIntervalMs: 30 } });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  const guest = await join(harness, host.roomId, 'Guest');
  await guest.waitFor(S2C.JOINED);

  host.client.close();
  await guest.waitFor(S2C.PEER_LEFT);

  const changed = await guest.waitFor(S2C.HOST_CHANGED, 3000);
  assert.equal(changed.data.reason, HOST_CHANGE_REASON.PROMOTED);
  assert.ok(
    !('hostToken' in changed.data),
    'a token in a broadcast hands every participant the ability to reclaim host',
  );

  // The promoted peer gets its token directly instead.
  const token = await guest.waitFor(S2C.HOST_TOKEN, 3000);
  assert.equal(typeof token.data.hostToken, 'string');
  assert.ok(token.data.hostToken.length > 0);

  guest.close();
});

test('an expired host grace promotes without anyone having to join', async (t) => {
  // The bug this covers: promotion was only ever driven from a `join`, so a room whose host
  // vanished and where nobody else happened to arrive stayed hostless for the rest of its
  // life -- `end` returned NOT_HOST to everyone.
  const harness = await startHarness({
    rooms: { hostGraceMs: 40, janitorIntervalMs: 30, emptyRoomGraceMs: 60_000 },
  });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  const guest = await join(harness, host.roomId, 'Guest');
  await guest.waitFor(S2C.JOINED);

  host.client.close();
  await guest.waitFor(S2C.PEER_LEFT);

  const changed = await guest.waitFor(S2C.HOST_CHANGED, 3000);
  assert.equal(changed.data.reason, HOST_CHANGE_REASON.PROMOTED);

  const room = harness.registry.get(host.roomId);
  assert.equal(room.hostPeerId, changed.data.hostPeerId);
  assert.equal(room.hostGraceUntil, null, 'a resolved grace window must be cleared');

  guest.close();
});

test('a solo host leaving does not leave the room permanently hostless', async (t) => {
  // When the host leaves deliberately and the room empties, there is nobody to promote. If
  // the grace deadline is left dangling, the next person to open the invite link joins a room
  // that can never have a host again.
  const harness = await startHarness({ rooms: { emptyRoomGraceMs: 60_000 } });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  host.client.send(C2S.LEAVE, {});
  await once(host.client.socket, 'close');

  const room = harness.registry.get(host.roomId);
  assert.ok(room, 'the room should survive its grace window');
  assert.equal(room.peers.size, 0);

  const newcomer = await join(harness, host.roomId, 'Newcomer');
  const joined = await newcomer.waitFor(S2C.JOINED);

  assert.equal(joined.data.isHost, true, 'a joiner into a hostless room becomes the host');
  assert.equal(joined.data.hostPeerId, joined.data.selfId);

  newcomer.close();
});

test('ROOM_FULL is not returned because of a peer whose socket died silently', async (t) => {
  // readyState stays OPEN when a connection dies without a FIN -- Wi-Fi dropping, a lid
  // closing, a browser crash. Judging liveness by readyState alone makes the eviction sweep a
  // no-op and locks someone out of their own room until the heartbeat notices.
  const harness = await startHarness({
    rooms: { maxParticipants: 2, emptyRoomGraceMs: 60_000 },
    // Real TLS handshakes can take longer than 50ms under test load. Keep live peers
    // alive and explicitly age only the peer whose silent loss is under test.
    signaling: { heartbeatTimeoutMs: 30_000 },
  });
  t.after(() => harness.close());

  const host = await createRoom(harness);
  const guest = await join(harness, host.roomId, 'Guest');
  const guestJoined = await guest.waitFor(S2C.JOINED);

  const room = harness.registry.get(host.roomId);
  assert.equal(room.peers.size, 2);

  // The room is full, so a third peer is correctly refused.
  const rejected = await join(harness, host.roomId, 'Third');
  const err = await rejected.waitFor(S2C.ERROR);
  assert.equal(err.data.code, ERRORS.ROOM_FULL);
  rejected.close();

  // Now age the guest past the heartbeat timeout without touching its socket, which is what a
  // silent death looks like from the server's side.
  const guestPeer = room.peers.get(guestJoined.data.selfId);
  guestPeer.lastSeen = Date.now() - 60_000;

  const returning = await join(harness, host.roomId, 'Guest');
  const joined = await returning.waitFor(S2C.JOINED);
  assert.equal(joined.data.roomId, host.roomId, 'the stale peer should have been evicted');

  returning.close();
  host.client.close();
  guest.close();
});
