import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  C2S,
  CLAIM_OUTCOME,
  CLOSE,
  END_REASON,
  ERRORS,
  HOST_CHANGE_REASON,
  LEAVE_REASON,
  REVOKE_REASON,
  S2C,
  canTimeoutGrant,
  isReleaseAuthorized,
  resolveClaim,
} from '../../public/shared/protocol.js';

function error(ctx, code, message, data = {}) { ctx.send(ctx.socket, S2C.ERROR, { code, message, data }, ctx.message.id); }
function shareData(room) { const peer = room.peers.get(room.currentSharer); return peer ? { sharerId: peer.id, sharerName: peer.name, epoch: room.shareEpoch } : { sharerId: null, epoch: room.shareEpoch }; }
function grant(room, peer, ctx) { room.currentSharer = peer.id; room.pendingClaim = null; room.shareEpoch++; ctx.broadcast(room, S2C.SHARE_STATE, shareData(room)); }

function createRoom(ctx, message) {
  const room = ctx.registry.create(); if (!room) return error(ctx, ERRORS.ROOM_LIMIT, 'Room limit reached');
  const peer = room.addPeer(message.data.name, ctx.socket); room.hostPeerId = peer.id;
  ctx.attach(room, peer); ctx.send(ctx.socket, S2C.ROOM_CREATED, { roomId: room.id, selfId: peer.id, joinOrder: peer.joinOrder, hostToken: room.hostToken }, message.id);
}
function join(ctx, message) {
  const room = ctx.registry.get(message.data.roomId);
  if (!room || room.endedAt) return error(ctx, ERRORS.ROOM_NOT_FOUND, 'Room not found');

  const required = ctx.config.rooms.accessCode;
  if (required && message.data.accessCode === undefined) {
    return error(ctx, ERRORS.ACCESS_CODE_REQUIRED, 'Access code required');
  }
  if (required && message.data.accessCode !== required) {
    return error(ctx, ERRORS.ACCESS_CODE_INVALID, 'Invalid access code');
  }

  const now = Date.now();

  // Clear out sockets that are gone but have not been noticed yet, so a peer reloading after
  // a Wi-Fi blip is not refused entry to its own room by its own ghost.
  ctx.registry.reapDead(room, { send: ctx.send, broadcast: ctx.broadcast, now });

  if (room.peers.size >= ctx.config.rooms.maxParticipants) {
    return error(ctx, ERRORS.ROOM_FULL, 'Room is full');
  }

  const existing = [...room.peers.values()];
  const peer = room.addPeer(message.data.name, ctx.socket, now);

  // Decide the host outcome now, but announce it only after `joined` has been sent. `joined`
  // is what carries this peer's own id and moves it into the JOINED state; a `host-token`
  // arriving before it would be discarded by a client that correctly ignores room traffic
  // until then -- and that frame carries the only copy of a freshly rotated token.
  let hostOutcome = null;

  if (
    !room.hostPeerId &&
    room.hasLiveHostGrace(now) &&
    typeof message.data.hostToken === 'string' &&
    message.data.hostToken.length > 0 &&
    message.data.hostToken === room.hostToken
  ) {
    // The original host came back in time and proved it.
    room.hostPeerId = peer.id;
    room.hostGraceUntil = null;
    hostOutcome = HOST_CHANGE_REASON.RECLAIMED;
  } else if (!room.hostPeerId && !room.hasLiveHostGrace(now)) {
    // Hostless with no live grace window: either the deadline passed, or the previous host
    // left deliberately when the room was empty. Either way this joiner takes the role --
    // without this the room stays hostless for the rest of its life and nobody can end it.
    hostOutcome = HOST_CHANGE_REASON.PROMOTED;
  }

  ctx.attach(room, peer);

  ctx.send(
    ctx.socket,
    S2C.JOINED,
    {
      roomId: room.id,
      selfId: peer.id,
      // Our own joinOrder, so the client can explain negotiation roles in its diagnostics
      // without recomputing them. room-created carries it too.
      joinOrder: peer.joinOrder,
      isHost: room.hostPeerId === peer.id || hostOutcome === HOST_CHANGE_REASON.PROMOTED,
      hostPeerId: hostOutcome === HOST_CHANGE_REASON.PROMOTED ? peer.id : room.hostPeerId,
      maxParticipants: ctx.config.rooms.maxParticipants,
      // Snapshots, not change notifications: without them a mid-session joiner renders
      // "nobody is sharing" while video arrives, and earlier mutes are invisible.
      share: shareData(room),
      participants: existing.map((p) => room.participant(p, peer)),
    },
    message.id,
  );

  ctx.broadcast(room, S2C.PEER_JOINED, { peer: null }, {
    except: peer.id,
    perPeer: (recipient) => ({ peer: room.participant(peer, recipient) }),
  });

  // Now it is safe to announce the host change.
  if (hostOutcome === HOST_CHANGE_REASON.PROMOTED) {
    ctx.registry.promote(room, { ...ctx, reason: HOST_CHANGE_REASON.PROMOTED });
  } else if (hostOutcome === HOST_CHANGE_REASON.RECLAIMED) {
    ctx.send(ctx.socket, S2C.HOST_TOKEN, { hostToken: room.hostToken });
    ctx.broadcast(room, S2C.HOST_CHANGED, {
      hostPeerId: peer.id,
      reason: HOST_CHANGE_REASON.RECLAIMED,
    });
  }
}
function leave(ctx) { ctx.registry.removePeer(ctx.room, ctx.peer, { reason: LEAVE_REASON.LEFT, intentional: true, send: ctx.send, broadcast: ctx.broadcast }); ctx.socket.close(CLOSE.LEFT); }
function end(ctx) { if (ctx.room.hostPeerId !== ctx.peer.id) return error(ctx, ERRORS.NOT_HOST, 'Only the host can end the room'); ctx.endRoom(ctx.room, END_REASON.HOST_ENDED); }
function mute(ctx, message) { ctx.peer.micMuted = message.data.micMuted; ctx.broadcast(ctx.room, S2C.PEER_MUTE_STATE, { peerId: ctx.peer.id, micMuted: ctx.peer.micMuted }, { except: ctx.peer.id }); }
function chat(ctx, message) {
  const data = { id: randomUUID(), peerId: ctx.peer.id, name: ctx.peer.name,
    text: message.data.text.trim(), sentAt: Date.now() };
  // Identity comes from membership, never from a client-supplied name or destination.
  // Echo to the sender only after accepting; no persistence or message logging.
  ctx.send(ctx.socket, S2C.CHAT, data, message.id);
  ctx.broadcast(ctx.room, S2C.CHAT, data, { except: ctx.peer.id });
}
function relay(ctx, message) { const target = ctx.room.peers.get(message.data.to); if (!target || target.socket.readyState !== WebSocket.OPEN) return error(ctx, ERRORS.PEER_NOT_FOUND, 'Peer not found'); const data = { ...message.data, from: ctx.peer.id }; delete data.to; const type = message.type === C2S.OFFER ? S2C.OFFER : message.type === C2S.ANSWER ? S2C.ANSWER : S2C.ICE_CANDIDATE; ctx.send(target.socket, type, data); }
function claim(ctx, message) {
  const result = resolveClaim({ claimantId: ctx.peer.id, force: message.data.force }, ctx.room);
  if (result.outcome === CLAIM_OUTCOME.NOOP) return;
  if (result.outcome === CLAIM_OUTCOME.REJECT) return error(ctx, result.code, 'Another participant is sharing');
  if (result.outcome === CLAIM_OUTCOME.GRANT) return grant(ctx.room, ctx.peer, ctx);
  const pending = { claimantId: ctx.peer.id, revokedId: result.revokedId }; ctx.room.pendingClaim = pending;
  const revoked = ctx.room.peers.get(result.revokedId); if (revoked) ctx.send(revoked.socket, S2C.SHARE_REVOKED, { byPeerId: ctx.peer.id, byName: ctx.peer.name, reason: REVOKE_REASON.TAKEOVER, epoch: ctx.room.shareEpoch });
  pending.timer = setTimeout(() => { if (ctx.room.pendingClaim !== pending) return; if (canTimeoutGrant(ctx.room, pending)) { const claimant = ctx.room.peers.get(pending.claimantId); if (claimant) grant(ctx.room, claimant, ctx); } else ctx.room.pendingClaim = null; }, ctx.config.rooms.shareRevokeTimeoutMs);
  pending.timer.unref?.();
}
function release(ctx, message) {
  if (!isReleaseAuthorized({ senderId: ctx.peer.id, currentSharerId: ctx.room.currentSharer, epoch: message.data.epoch, currentEpoch: ctx.room.shareEpoch })) return;
  const pending = ctx.room.pendingClaim; if (pending?.revokedId === ctx.peer.id) { clearTimeout(pending.timer); const claimant = ctx.room.peers.get(pending.claimantId); if (claimant) return grant(ctx.room, claimant, ctx); ctx.room.pendingClaim = null; }
  ctx.room.currentSharer = null; ctx.room.shareEpoch++; ctx.broadcast(ctx.room, S2C.SHARE_STATE, shareData(ctx.room));
}

export const handlers = Object.freeze({ [C2S.CHAT]: chat, [C2S.CREATE_ROOM]: createRoom, [C2S.JOIN]: join, [C2S.LEAVE]: leave, [C2S.END]: end, [C2S.MUTE_STATE]: mute, [C2S.CLAIM_SHARE]: claim, [C2S.RELEASE_SHARE]: release, [C2S.OFFER]: relay, [C2S.ANSWER]: relay, [C2S.ICE_CANDIDATE]: relay, [C2S.PING]: (ctx, message) => ctx.send(ctx.socket, S2C.PONG, {}, message.id) });
