import { WebSocket } from 'ws';
import { END_REASON, LEAVE_REASON, S2C, shouldInitiate, isPolite } from '../../public/shared/protocol.js';
import { newHostToken, newPeerId, newRoomId } from './ids.js';

export class Peer {
  constructor({ name, socket, joinOrder, now = Date.now() }) { this.id = newPeerId(); this.name = name; this.joinOrder = joinOrder; this.socket = socket; this.micMuted = false; this.joinedAt = now; this.lastSeen = now; }
}
export class Room {
  constructor(id = newRoomId(), now = Date.now()) { this.id = id; this.createdAt = now; this.lastActivity = now; this.hostPeerId = null; this.hostToken = newHostToken(); this.hostGraceUntil = null; this.emptySince = null; this.peers = new Map(); this.joinCounter = 0; this.currentSharer = null; this.shareEpoch = 0; this.pendingClaim = null; this.endedAt = null; }
  addPeer(name, socket, now = Date.now()) { const peer = new Peer({ name, socket, joinOrder: ++this.joinCounter, now }); this.peers.set(peer.id, peer); this.emptySince = null; this.lastActivity = now; return peer; }
  evictDead(onEvict) { for (const peer of [...this.peers.values()]) if (peer.socket.readyState !== WebSocket.OPEN) onEvict?.(peer); }
  lowestPeer() { return [...this.peers.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0] ?? null; }
  participant(peer, self) { return { id: peer.id, name: peer.name, joinOrder: peer.joinOrder, micMuted: peer.micMuted, youInitiate: shouldInitiate(self.joinOrder, peer.joinOrder), polite: isPolite(self.joinOrder, peer.joinOrder) }; }
}

export class RoomRegistry {
  constructor(config) { this.config = config; this.rooms = new Map(); }
  create(now = Date.now()) { if (this.rooms.size >= this.config.rooms.maxRooms) return null; let room; do room = new Room(newRoomId(), now); while (this.rooms.has(room.id)); this.rooms.set(room.id, room); return room; }
  get(id) { return this.rooms.get(id); }
  removePeer(room, peer, { reason = LEAVE_REASON.DISCONNECTED, intentional = false, send, broadcast, now = Date.now() } = {}) {
    if (!room.peers.delete(peer.id)) return;
    room.lastActivity = now; if (room.currentSharer === peer.id) { const pending = room.pendingClaim; clearTimeout(pending?.timer); const claimant = pending && room.peers.get(pending.claimantId); room.currentSharer = claimant?.id ?? null; room.pendingClaim = null; room.shareEpoch++; broadcast?.(room, S2C.SHARE_STATE, claimant ? { sharerId: claimant.id, sharerName: claimant.name, epoch: room.shareEpoch } : { sharerId: null, epoch: room.shareEpoch }); }
    else if (room.pendingClaim?.claimantId === peer.id) { clearTimeout(room.pendingClaim.timer); room.pendingClaim = null; }
    broadcast?.(room, S2C.PEER_LEFT, { id: peer.id, reason });
    if (room.hostPeerId === peer.id) {
      room.hostPeerId = null;
      if (intentional) this.promote(room, { send, broadcast }); else room.hostGraceUntil = now + this.config.rooms.hostGraceMs;
    }
    if (room.peers.size === 0) room.emptySince = now;
  }
  promote(room, { send, broadcast } = {}) { const peer = room.lowestPeer(); if (!peer) return null; room.hostPeerId = peer.id; room.hostToken = newHostToken(); room.hostGraceUntil = null; send?.(peer.socket, S2C.HOST_TOKEN, { hostToken: room.hostToken }); broadcast?.(room, S2C.HOST_CHANGED, { hostPeerId: peer.id, reason: 'promoted' }); return peer; }
  expireHostGrace(room, helpers, now = Date.now()) { if (!room.hostPeerId && room.hostGraceUntil !== null && now >= room.hostGraceUntil) return this.promote(room, helpers); return null; }
  sweep({ now = Date.now(), endRoom } = {}) { for (const room of [...this.rooms.values()]) { if (room.emptySince !== null && now - room.emptySince >= this.config.rooms.emptyRoomGraceMs) endRoom?.(room, END_REASON.EMPTY); else if (now - room.lastActivity >= this.config.rooms.idleRoomTimeoutMs) endRoom?.(room, END_REASON.IDLE); } }
}
