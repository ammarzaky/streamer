/**
 * The mesh: one Peer per remote participant.
 *
 * Everyone connects directly to everyone else, so N participants means N-1 connections each.
 * That is only viable for very small groups, which is the whole premise of this app -- the
 * server never sees a single media packet.
 *
 * This module owns peer lifecycle and message routing. It does not decide quality, capture
 * media, or touch the DOM.
 */

import { C2S, S2C } from '../../shared/protocol.js';
import { createPeer } from './peer.js';
import { logger } from '../core/logger.js';

export function createMesh({ send, config, onTrack, onPeerState, onPeerFailed, onNegotiated, onDiagMessage }) {
  /** peerId -> Peer */
  const peers = new Map();

  /** The tracks we are currently sending, by role. Kept here so a peer that joins later gets
   *  exactly what everyone else is already receiving, without the caller re-deriving it. */
  const localTracks = { mic: null, shareAudio: null, video: null };

  let iceServers = config?.iceServers ?? [];

  function setIceServers(servers) {
    iceServers = servers ?? [];
  }

  /**
   * Bring up a connection to one remote peer.
   *
   * `youInitiate` and `polite` come from the server and are used verbatim. Recomputing them
   * from joinOrder locally would work right up until one side compares numbers and the other
   * compares strings, at which point either nobody offers or both do.
   */
  function addPeer(descriptor) {
    const { id } = descriptor;
    if (peers.has(id)) {
      logger.warn('mesh: peer already present, replacing', { id });
      removePeer(id);
    }

    const peer = createPeer({
      peerId: id,
      name: descriptor.name,
      joinOrder: descriptor.joinOrder,
      polite: descriptor.polite,
      youInitiate: descriptor.youInitiate,
      iceServers,
      config,
      send,
      onTrack,
      onStateChange: onPeerState,
      onFailed: (err) => onPeerFailed?.(id, err),
      onNegotiated,
      onDiagMessage,
    });

    peers.set(id, peer);
    peer.start();

    // Record whatever we are already sending. For the initiator the transceivers exist by
    // now, so the tracks land in the initial offer. For the answerer they do not exist yet,
    // and `setTrack` queues the intent until `adoptTransceivers` runs -- which is what stops
    // a joiner's microphone being silently dropped when local media wins the race against
    // the remote offer.
    applyLocalTracks(peer);

    logger.info('mesh: peer added', {
      id,
      youInitiate: descriptor.youInitiate,
      polite: descriptor.polite,
    });
    return peer;
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.close();
    peers.delete(id);
    logger.info('mesh: peer removed', { id });
  }

  /** Close everything. Used on leave, on room end, and on our own reconnect. */
  function closeAll() {
    for (const peer of peers.values()) peer.close();
    peers.clear();
  }

  function applyLocalTracks(peer) {
    for (const role of ['mic', 'shareAudio', 'video']) {
      if (localTracks[role]) void peer.setTrack(role, localTracks[role]);
    }
  }

  /** Everything currently being sent, so a rebuilt connection can be brought back up to date. */
  function currentLocalTracks() {
    return { ...localTracks };
  }

  /**
   * Set one outgoing track across every peer at once.
   *
   * `replaceTrack` on a pre-allocated sender does not renegotiate, which is what makes
   * starting and stopping a share instant. Passing null clears the track while leaving the
   * sender in place, so the next share reuses the same m-line.
   */
  async function setLocalTrack(role, track) {
    localTracks[role] = track ?? null;
    await Promise.all([...peers.values()].map((peer) => peer.setTrack(role, track ?? null)));
    logger.debug('mesh: local track set', { role, present: Boolean(track), peers: peers.size });
  }

  /** Route a signaling message to the peer it belongs to. */
  function handleMessage(message) {
    const { type, data } = message;
    const from = data.from;

    switch (type) {
      case S2C.OFFER:
      case S2C.ANSWER: {
        const peer = peers.get(from);
        if (!peer) {
          // Ordinary during teardown: the peer left between sending and delivery.
          logger.debug('mesh: description for unknown peer', { from });
          return;
        }
        peer.handleDescription(data.description);
        return;
      }

      case S2C.ICE_CANDIDATE: {
        const peer = peers.get(from);
        if (!peer) return;
        peer.handleCandidate(data.candidate);
        return;
      }

      default:
        return;
    }
  }

  return {
    addPeer,
    removePeer,
    closeAll,
    setLocalTrack,
    setIceServers,
    handleMessage,
    currentLocalTracks,

    peer: (id) => peers.get(id) ?? null,
    peerIds: () => [...peers.keys()],
    list: () => [...peers.values()],

    /** Diagnostics report to one peer, over its data channel. False if it is not open yet. */
    sendDiagTo(id, text) {
      return peers.get(id)?.sendDiag(text) ?? false;
    },
    sendDumpTo(id, frames) {
      return peers.get(id)?.sendDump(frames) ?? false;
    },
    transceivers(id) {
      return peers.get(id)?.transceiverSnapshot() ?? null;
    },
    get size() {
      return peers.size;
    },

    /** Participants including ourselves -- the number the upload budget is divided by. */
    participantCount() {
      return peers.size + 1;
    },

    /** Every video sender across the mesh, for applying encoder parameters. */
    videoSenders() {
      return [...peers.values()]
        .map((peer) => ({ peerId: peer.peerId, sender: peer.sender('video') }))
        .filter((entry) => entry.sender);
    },

    audioSenders(role) {
      return [...peers.values()]
        .map((peer) => ({ peerId: peer.peerId, sender: peer.sender(role) }))
        .filter((entry) => entry.sender);
    },

    /** Snapshot for the E2E hook and diagnostics. */
    snapshot() {
      return [...peers.values()].map((peer) => ({
        peerId: peer.peerId,
        name: peer.name,
        joinOrder: peer.joinOrder,
        polite: peer.polite,
        youInitiate: peer.youInitiate,
        connectionState: peer.connectionState,
        diag: peer.diagState(),
      }));
    },
  };
}

/** Message types this module consumes, so the router can delegate without a second table. */
export const MESH_MESSAGE_TYPES = new Set([S2C.OFFER, S2C.ANSWER, S2C.ICE_CANDIDATE]);

export { C2S };
