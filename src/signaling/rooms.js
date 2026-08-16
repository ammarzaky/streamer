import { WebSocket } from 'ws';
import {
  END_REASON,
  HOST_CHANGE_REASON,
  LEAVE_REASON,
  S2C,
  shouldInitiate,
  isPolite,
} from '../../public/shared/protocol.js';
import { newHostToken, newPeerId, newRoomId } from './ids.js';

export class Peer {
  constructor({ name, socket, joinOrder, now = Date.now() }) {
    this.id = newPeerId();
    this.name = name;
    this.joinOrder = joinOrder;
    this.socket = socket;
    this.micMuted = false;
    this.joinedAt = now;
    this.lastSeen = now;
  }
}

export class Room {
  constructor(id = newRoomId(), now = Date.now()) {
    this.id = id;
    this.createdAt = now;
    this.lastActivity = now;
    this.hostPeerId = null;
    this.hostToken = newHostToken();
    this.hostGraceUntil = null;
    this.emptySince = null;
    this.peers = new Map();
    // Monotonic and never reused, even after a peer leaves: the negotiation role derives
    // from it, and reuse would make two peers compute conflicting roles.
    this.joinCounter = 0;
    this.currentSharer = null;
    this.shareEpoch = 0;
    this.pendingClaim = null;
    this.endedAt = null;
  }

  addPeer(name, socket, now = Date.now()) {
    const peer = new Peer({ name, socket, joinOrder: ++this.joinCounter, now });
    this.peers.set(peer.id, peer);
    this.emptySince = null;
    this.lastActivity = now;
    return peer;
  }

  /**
   * Peers whose connection is gone, whether or not the socket knows it yet.
   *
   * `readyState` alone is not enough, and relying on it makes this function a no-op in the
   * one case it exists for. Every path that flips `readyState` also fires the socket's close
   * event, which removes the peer already. What it cannot see is a SILENT death -- Wi-Fi
   * dropping, a laptop lid closing, a NAT rebind, a browser crash -- where no FIN or RST ever
   * arrives and `readyState` stays OPEN until the heartbeat gives up tens of seconds later.
   *
   * That silent case is exactly the one that matters: it is why someone reloading after a
   * Wi-Fi blip gets ROOM_FULL from their own room, and why a host reloading fast is refused
   * their own host role. So staleness is judged by the heartbeat clock as well.
   */
  deadPeers(now, heartbeatTimeoutMs) {
    return [...this.peers.values()].filter(
      (peer) =>
        peer.socket.readyState !== WebSocket.OPEN || now - peer.lastSeen > heartbeatTimeoutMs,
    );
  }

  lowestPeer() {
    return [...this.peers.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0] ?? null;
  }

  participant(peer, self) {
    return {
      id: peer.id,
      name: peer.name,
      joinOrder: peer.joinOrder,
      micMuted: peer.micMuted,
      // Shipped as data so clients never recompute the rule. Independent derivation is where
      // asymmetry bugs come from: compare numbers on one side and strings on the other and
      // you get either two offers or none.
      youInitiate: shouldInitiate(self.joinOrder, peer.joinOrder),
      polite: isPolite(self.joinOrder, peer.joinOrder),
    };
  }

  hasLiveHostGrace(now) {
    return this.hostGraceUntil !== null && now < this.hostGraceUntil;
  }
}

export class RoomRegistry {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
  }

  create(now = Date.now()) {
    if (this.rooms.size >= this.config.rooms.maxRooms) return null;
    let room;
    do {
      room = new Room(newRoomId(), now);
    } while (this.rooms.has(room.id));
    this.rooms.set(room.id, room);
    return room;
  }

  get(id) {
    return this.rooms.get(id);
  }

  /** Remove every peer whose connection is gone. Returns how many were removed. */
  reapDead(room, { send, broadcast, now = Date.now() } = {}) {
    const dead = room.deadPeers(now, this.config.signaling.heartbeatTimeoutMs);
    for (const peer of dead) {
      this.removePeer(room, peer, { reason: LEAVE_REASON.TIMEOUT, send, broadcast, now });
    }
    return dead.length;
  }

  removePeer(
    room,
    peer,
    { reason = LEAVE_REASON.DISCONNECTED, intentional = false, send, broadcast, now = Date.now() } = {},
  ) {
    if (!room.peers.delete(peer.id)) return;
    room.lastActivity = now;

    if (room.currentSharer === peer.id) {
      // The sharer vanished. If a takeover was already pending, hand the slot straight to the
      // claimant in ONE broadcast rather than clearing it and granting it again -- an
      // intermediate {sharerId: null} makes every stage flicker to the empty state.
      const pending = room.pendingClaim;
      clearTimeout(pending?.timer);
      const claimant = pending && room.peers.get(pending.claimantId);
      room.currentSharer = claimant?.id ?? null;
      room.pendingClaim = null;
      room.shareEpoch++;
      broadcast?.(
        room,
        S2C.SHARE_STATE,
        claimant
          ? { sharerId: claimant.id, sharerName: claimant.name, epoch: room.shareEpoch }
          : { sharerId: null, epoch: room.shareEpoch },
      );
    } else if (room.pendingClaim?.claimantId === peer.id) {
      clearTimeout(room.pendingClaim.timer);
      room.pendingClaim = null;
    }

    broadcast?.(room, S2C.PEER_LEFT, { id: peer.id, reason });

    if (room.hostPeerId === peer.id) {
      room.hostPeerId = null;
      if (intentional) {
        // A deliberate exit gets no grace window: waiting 30s would leave the room with
        // nobody able to end the session.
        this.promote(room, { send, broadcast });
      } else {
        room.hostGraceUntil = now + this.config.rooms.hostGraceMs;
      }
    }

    if (room.peers.size === 0) room.emptySince = now;
  }

  /**
   * Hand the host role to the longest-present participant.
   *
   * Clearing `hostGraceUntil` even when there is nobody to promote is deliberate: leaving a
   * stale deadline behind means the room can never resolve its own hostless state, because
   * both the reclaim and the expiry branches key off that field.
   */
  promote(room, { send, broadcast, reason = HOST_CHANGE_REASON.PROMOTED } = {}) {
    room.hostGraceUntil = null;

    const peer = room.lowestPeer();
    if (!peer) {
      room.hostPeerId = null;
      return null;
    }

    room.hostPeerId = peer.id;
    room.hostToken = newHostToken();

    send?.(peer.socket, S2C.HOST_TOKEN, { hostToken: room.hostToken });
    broadcast?.(room, S2C.HOST_CHANGED, { hostPeerId: peer.id, reason });
    return peer;
  }

  /**
   * Promote if the grace deadline has passed.
   *
   * Driven from the janitor as well as from `join`. Without the janitor, a room whose host
   * disappeared and where nobody happens to join again stays hostless for the rest of its
   * life -- `end` returns NOT_HOST to everyone and the room lingers until the idle timeout.
   */
  expireHostGrace(room, helpers, now = Date.now()) {
    if (room.hostPeerId) return null;
    if (room.hostGraceUntil === null || now < room.hostGraceUntil) return null;
    return this.promote(room, helpers);
  }

  sweep({ now = Date.now(), endRoom, send, broadcast } = {}) {
    for (const room of [...this.rooms.values()]) {
      if (room.endedAt) continue;

      // Reap silently-dead sockets first so the checks below see the real membership.
      this.reapDead(room, { send, broadcast, now });
      this.expireHostGrace(room, { send, broadcast }, now);

      if (room.emptySince !== null && now - room.emptySince >= this.config.rooms.emptyRoomGraceMs) {
        endRoom?.(room, END_REASON.EMPTY);
      } else if (now - room.lastActivity >= this.config.rooms.idleRoomTimeoutMs) {
        endRoom?.(room, END_REASON.IDLE);
      }
    }
  }
}
