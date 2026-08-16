import test from 'node:test';
import assert from 'node:assert/strict';

import { C2S, S2C, ERRORS } from '../../public/shared/protocol.js';
import { startHarness } from '../helpers/server-harness.js';

async function room(harness, names) {
  const clients = [];
  let roomId = null;

  for (const [index, name] of names.entries()) {
    const client = await harness.connect();
    await client.waitFor(S2C.WELCOME);

    if (index === 0) {
      client.send(C2S.CREATE_ROOM, { name });
      const created = await client.waitFor(S2C.ROOM_CREATED);
      roomId = created.data.roomId;
      client.selfId = created.data.selfId;
    } else {
      client.send(C2S.JOIN, { roomId, name });
      const joined = await client.waitFor(S2C.JOINED);
      client.selfId = joined.data.selfId;
    }
    clients.push(client);
  }

  // Let every peer-joined settle so later assertions are not racing the roster.
  for (const client of clients.slice(0, -1)) {
    try {
      await client.waitFor(S2C.PEER_JOINED, 300);
    } catch {
      // Already delivered.
    }
  }

  return { roomId, clients };
}

test('a takeover produces exactly one share-state, with no flicker through null', async (t) => {
  // If the release path fell through to the generic "clear the slot" branch, observers would
  // receive share-state{null} and then share-state{B}, and every stage would flash the empty
  // state for a round trip. The whole point of resolving the pending claim atomically is that
  // this never happens.
  const harness = await startHarness({ rooms: { shareRevokeTimeoutMs: 5000 } });
  t.after(() => harness.close());

  const { clients } = await room(harness, ['A', 'B', 'C']);
  const [a, b, c] = clients;

  a.send(C2S.CLAIM_SHARE, { force: false });
  const firstGrant = await c.waitFor(S2C.SHARE_STATE);
  assert.equal(firstGrant.data.sharerId, a.selfId);

  const grantEpoch = firstGrant.data.epoch;

  // B takes over; A confirms promptly, which is the path the timeout exists to survive
  // rather than the path normally taken.
  b.send(C2S.CLAIM_SHARE, { force: true });
  const revoked = await a.waitFor(S2C.SHARE_REVOKED);
  assert.equal(revoked.data.byPeerId, b.selfId);

  a.send(C2S.RELEASE_SHARE, { epoch: revoked.data.epoch });

  const handover = await c.waitFor(S2C.SHARE_STATE);
  assert.equal(handover.data.sharerId, b.selfId, 'ownership should pass straight to B');
  assert.ok(handover.data.epoch > grantEpoch);

  // And nothing else: no intermediate null, no duplicate grant.
  await c.expectNone((m) => m.type === S2C.SHARE_STATE, 300);

  for (const client of clients) client.close();
});

test('a late release cannot evict the peer that now owns the share', async (t) => {
  // A is revoked for B but stops sharing on its own before answering; C claims the freed slot;
  // A's late release finally arrives. Honouring it would tear down a share belonging to
  // someone else, who would keep transmitting while their UI insisted they were live.
  const harness = await startHarness({ rooms: { shareRevokeTimeoutMs: 40 } });
  t.after(() => harness.close());

  const { clients } = await room(harness, ['A', 'B', 'C']);
  const [a, b, c] = clients;

  a.send(C2S.CLAIM_SHARE, { force: false });
  const grant = await c.waitFor(S2C.SHARE_STATE);
  const staleEpoch = grant.data.epoch;

  b.send(C2S.CLAIM_SHARE, { force: true });
  await a.waitFor(S2C.SHARE_REVOKED);

  // A stays silent past the timeout, so B is granted.
  const afterTimeout = await c.waitFor(S2C.SHARE_STATE, 2000);
  assert.equal(afterTimeout.data.sharerId, b.selfId);
  const ownedEpoch = afterTimeout.data.epoch;

  // A's release finally turns up, addressed to a grant that is two owners old.
  a.send(C2S.RELEASE_SHARE, { epoch: staleEpoch });

  await c.expectNone(
    (m) => m.type === S2C.SHARE_STATE && m.data.epoch > ownedEpoch,
    400,
  );

  // Asserted against server state directly: no client can observe `currentSharer`, and the
  // absence of a broadcast alone would not prove the slot was left intact.
  const live = [...harness.registry.rooms.values()][0];
  assert.equal(live.currentSharer, b.selfId, 'B must still own the share');

  for (const client of clients) client.close();
});

test('a redundant claim from the current owner changes nothing', async (t) => {
  // A double-clicked Share button. Bumping the epoch here would invalidate the client's cached
  // epoch, its later release would fail the guard, and the slot would wedge for the life of
  // the room.
  const harness = await startHarness();
  t.after(() => harness.close());

  const { clients } = await room(harness, ['A', 'B']);
  const [a, b] = clients;

  a.send(C2S.CLAIM_SHARE, { force: false });
  const grant = await b.waitFor(S2C.SHARE_STATE);
  const epoch = grant.data.epoch;

  a.send(C2S.CLAIM_SHARE, { force: false });
  a.send(C2S.CLAIM_SHARE, { force: true });

  await b.expectNone((m) => m.type === S2C.SHARE_STATE, 300);

  const live = [...harness.registry.rooms.values()][0];
  assert.equal(live.shareEpoch, epoch, 'the epoch must not move');
  assert.equal(live.currentSharer, a.selfId);

  for (const client of clients) client.close();
});

test('an unforced claim while someone is sharing is refused', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const { clients } = await room(harness, ['A', 'B']);
  const [a, b] = clients;

  a.send(C2S.CLAIM_SHARE, { force: false });
  await b.waitFor(S2C.SHARE_STATE);

  b.send(C2S.CLAIM_SHARE, { force: false });
  const err = await b.waitFor(S2C.ERROR);
  assert.equal(err.data.code, ERRORS.SHARE_IN_PROGRESS);

  for (const client of clients) client.close();
});

test('joined carries the share snapshot so a mid-session joiner is not wrong', async (t) => {
  // share-state is a change notification, so a peer arriving mid-share receives none. Without
  // the snapshot it renders "nobody is sharing" while video arrives over the mesh.
  const harness = await startHarness();
  t.after(() => harness.close());

  const { roomId, clients } = await room(harness, ['A', 'B']);
  const [a] = clients;

  a.send(C2S.CLAIM_SHARE, { force: false });
  await clients[1].waitFor(S2C.SHARE_STATE);

  const late = await harness.connect();
  await late.waitFor(S2C.WELCOME);
  late.send(C2S.JOIN, { roomId, name: 'Late' });
  const joined = await late.waitFor(S2C.JOINED);

  assert.equal(joined.data.share.sharerId, a.selfId, 'the snapshot should name the sharer');
  assert.equal(joined.data.share.sharerName, 'A');
  assert.ok(Number.isInteger(joined.data.share.epoch));

  late.close();
  for (const client of clients) client.close();
});

test('joined carries each participant mute state, with micMuted polarity', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const { roomId, clients } = await room(harness, ['A', 'B']);
  const [a, b] = clients;

  a.send(C2S.MUTE_STATE, { micMuted: true });
  const fanout = await b.waitFor(S2C.PEER_MUTE_STATE);
  assert.equal(fanout.data.peerId, a.selfId);
  assert.equal(fanout.data.micMuted, true, 'the field is micMuted, not micOn');

  // The sender should not receive its own fan-out.
  await a.expectNone((m) => m.type === S2C.PEER_MUTE_STATE, 200);

  const late = await harness.connect();
  await late.waitFor(S2C.WELCOME);
  late.send(C2S.JOIN, { roomId, name: 'Late' });
  const joined = await late.waitFor(S2C.JOINED);

  const aRecord = joined.data.participants.find((p) => p.id === a.selfId);
  assert.equal(aRecord.micMuted, true, 'an earlier mute must be visible to a later joiner');

  const bRecord = joined.data.participants.find((p) => p.id === b.selfId);
  assert.equal(bRecord.micMuted, false);

  late.close();
  for (const client of clients) client.close();
});

test('exactly one side of each pair is told to initiate', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const { roomId, clients } = await room(harness, ['A', 'B']);
  const [a, b] = clients;

  const late = await harness.connect();
  await late.waitFor(S2C.WELCOME);
  late.send(C2S.JOIN, { roomId, name: 'Late' });
  const joined = await late.waitFor(S2C.JOINED);

  // Everyone already present offers to the newcomer, so the newcomer initiates to nobody.
  for (const participant of joined.data.participants) {
    assert.equal(participant.youInitiate, false);
    assert.equal(participant.polite, true);
  }

  // And each existing peer is told the opposite about the newcomer.
  for (const client of [a, b]) {
    const announced = await client.waitFor(S2C.PEER_JOINED);
    assert.equal(announced.data.peer.youInitiate, true);
    assert.equal(announced.data.peer.polite, false);
  }

  late.close();
  for (const client of clients) client.close();
});
