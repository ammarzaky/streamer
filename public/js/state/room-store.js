/**
 * The single source of truth for room state.
 *
 * Views read from here and subscribe to slices; they never hold their own copies. Without
 * that rule the roster, the stage, and the stats panel each end up with their own idea of who
 * is sharing, and the three disagree in ways that look like WebRTC bugs.
 *
 * All mutation goes through the setters below so every change emits exactly one notification.
 */

import { isShareStateFresh } from '../../shared/protocol.js';

export function createStore() {
  const state = {
    self: {
      id: null,
      name: '',
      isHost: false,
      joinOrder: null,
      /** Microphone only. Never conflated with the audio of a shared window -- see below. */
      micMuted: false,
      sharing: false,
      /** Whether the captured display stream actually carried an audio track. The user may
       *  have declined "share audio" in the picker, and the UI must not claim otherwise. */
      displayAudioActive: false,
    },

    room: {
      id: null,
      link: null,
      status: 'idle', // idle | connecting | connected | reconnecting | ended | failed
      maxParticipants: 4,
      hostPeerId: null,
      startedAt: null,
      endedReason: null,
    },

    signaling: {
      status: 'idle', // idle | connecting | open | reconnecting | dead
      attempt: 0,
    },

    /**
     * Share ownership, mirrored from the server. `epoch` is what makes out-of-order
     * broadcasts harmless -- see setShare.
     */
    share: {
      sharerId: null,
      sharerName: null,
      epoch: null,
    },

    /** peerId -> peer record */
    peers: new Map(),

    quality: {
      presetId: null,
      effectiveCapBps: null,
      limitedBy: null, // null | cpu | bandwidth | mesh-budget
      actual: null, // { width, height, fps } measured from getStats
    },

    ui: {
      statsOpen: false,
      qualityMenuOpen: false,
      pinnedPeerId: null,
    },
  };

  const listeners = new Map();

  function emit(slice) {
    for (const handler of listeners.get(slice) ?? []) handler(state);
    for (const handler of listeners.get('*') ?? []) handler(state, slice);
  }

  function subscribe(slice, handler) {
    let set = listeners.get(slice);
    if (!set) listeners.set(slice, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  return {
    get state() {
      return state;
    },
    subscribe,

    // ---- self ----------------------------------------------------------

    setSelf(patch) {
      Object.assign(state.self, patch);
      emit('self');
    },

    // ---- room ----------------------------------------------------------

    setRoom(patch) {
      Object.assign(state.room, patch);
      emit('room');
    },

    setSignaling(patch) {
      Object.assign(state.signaling, patch);
      emit('signaling');
    },

    // ---- peers ---------------------------------------------------------

    addPeer(peer) {
      state.peers.set(peer.id, {
        id: peer.id,
        name: peer.name,
        joinOrder: peer.joinOrder,
        micMuted: Boolean(peer.micMuted),
        youInitiate: Boolean(peer.youInitiate),
        polite: Boolean(peer.polite),
        pcState: 'new', // new | connecting | connected | reconnecting | failed | closed
        speaking: false,
        stats: null,
        ...peer,
      });
      emit('peers');
    },

    updatePeer(id, patch) {
      const peer = state.peers.get(id);
      if (!peer) return; // a late update for someone who already left is not an error
      Object.assign(peer, patch);
      emit('peers');
    },

    removePeer(id) {
      if (!state.peers.delete(id)) return;
      // Ownership is server-authoritative, so we do not clear `share` here; the server
      // broadcasts share-state when a sharer leaves and that is what the UI follows.
      emit('peers');
    },

    clearPeers() {
      state.peers.clear();
      emit('peers');
    },

    peer(id) {
      return state.peers.get(id) ?? null;
    },

    peerList() {
      return [...state.peers.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    },

    /** Participants including self, which is what the roster count means to a user. */
    participantCount() {
      return state.peers.size + (state.self.id ? 1 : 0);
    },

    // ---- share ownership -----------------------------------------------

    /**
     * Apply a share-state broadcast, ignoring stale ones.
     *
     * Broadcasts can arrive out of order, and applying an older one resurrects a share that
     * has already finished -- the stage would show a stream nobody is sending. Returns
     * whether the update was applied so callers can skip the work that follows.
     */
    setShare({ sharerId, sharerName, epoch }) {
      if (!isShareStateFresh(epoch, state.share.epoch)) return false;
      state.share = { sharerId: sharerId ?? null, sharerName: sharerName ?? null, epoch };
      state.self.sharing = sharerId !== null && sharerId === state.self.id;
      emit('share');
      emit('self');
      return true;
    },

    /** Initialise from the `joined` snapshot without the freshness check, which has nothing
     *  to compare against yet. */
    initShare({ sharerId, sharerName, epoch }) {
      state.share = { sharerId: sharerId ?? null, sharerName: sharerName ?? null, epoch };
      state.self.sharing = sharerId !== null && sharerId === state.self.id;
      emit('share');
    },

    isSharing() {
      return state.share.sharerId !== null;
    },

    sharerIsSelf() {
      return state.share.sharerId !== null && state.share.sharerId === state.self.id;
    },

    // ---- quality -------------------------------------------------------

    setQuality(patch) {
      Object.assign(state.quality, patch);
      emit('quality');
    },

    setPeerStats(id, stats) {
      const peer = state.peers.get(id);
      if (!peer) return;
      peer.stats = stats;
      emit('stats');
    },

    // ---- ui ------------------------------------------------------------

    setUI(patch) {
      Object.assign(state.ui, patch);
      emit('ui');
    },

    /** Wipe everything peer-related, for a full mesh rebuild after our own reconnect. */
    resetForRejoin() {
      state.peers.clear();
      state.share = { sharerId: null, sharerName: null, epoch: null };
      state.self.id = null;
      state.self.joinOrder = null;
      emit('peers');
      emit('share');
      emit('self');
    },
  };
}

export const store = createStore();
