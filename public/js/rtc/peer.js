/**
 * One RTCPeerConnection to one remote peer.
 *
 * This is the highest-risk file in the project. Two things here are load-bearing and both
 * fail silently when they are wrong:
 *
 * 1. **Perfect negotiation with a server-assigned role.** Any peer may start sharing at any
 *    moment, so both sides can renegotiate simultaneously. The server tells each side whether
 *    it is polite; nothing is recomputed locally, because independent derivation of the same
 *    rule is where asymmetry bugs come from.
 *
 * 2. **Pre-allocated transceivers.** All three senders (mic, shareAudio, video) exist from the
 *    first negotiation, so starting and stopping a screen share is a `replaceTrack` and never
 *    a renegotiation. Without this, every share and every stop fires `negotiationneeded`, and
 *    the whole "quality changes are instant" property goes with it.
 */

import { ERRORS } from '../../shared/protocol.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

/** Remote candidates that arrive before the remote description is set are queued. The cap
 *  stops a misbehaving or malicious peer growing this without bound. */
const MAX_QUEUED_CANDIDATES = 256;

/** `disconnected` flaps constantly on Wi-Fi and usually recovers on its own. Acting on it
 *  immediately turns an ordinary hiccup into a visible failure. */
const DISCONNECTED_GRACE_MS = 5000;

/** Fixed transceiver order. Both sides depend on this, since the polite peer adopts
 *  transceivers by index from the offer. */
const TRACK_ROLES = ['mic', 'shareAudio', 'video'];

export function createPeer({
  peerId,
  name,
  joinOrder,
  polite,
  youInitiate,
  iceServers,
  config,
  send,
  onTrack,
  onStateChange,
  onFailed,
}) {
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: config?.bundlePolicy ?? 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: config?.iceTransportPolicy ?? 'all',
  });

  /** role -> RTCRtpTransceiver */
  const tx = new Map();

  // Perfect negotiation bookkeeping.
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;

  let pendingCandidates = [];
  let disconnectedTimer = null;
  let restartAttempts = 0;
  let closed = false;

  // -------------------------------------------------------------------------
  // Transceivers
  // -------------------------------------------------------------------------

  /**
   * The initiating side creates all three transceivers up front.
   *
   * `sendEncodings: [{}]` on the video transceiver is not cosmetic: it guarantees
   * `getParameters().encodings[0]` exists after negotiation. Creating the encoding later by
   * assigning `params.encodings = [{}]` changes the array length between get and set, which
   * throws InvalidModificationError -- and only on the path where it is needed.
   */
  function createTransceivers() {
    tx.set('mic', pc.addTransceiver('audio', { direction: 'sendrecv' }));
    tx.set('shareAudio', pc.addTransceiver('audio', { direction: 'sendrecv' }));
    tx.set(
      'video',
      pc.addTransceiver('video', { direction: 'sendrecv', sendEncodings: [{}] }),
    );
    logger.debug('peer: created transceivers', { peerId });
  }

  /**
   * The answering side adopts the transceivers the offer created, by index.
   *
   * The direction assignment is the subtle half. Transceivers created implicitly by
   * setRemoteDescription start as `recvonly`, and `replaceTrack` does NOT promote them to
   * sending. A polite peer that skips this appears completely healthy -- connection state
   * `connected`, no errors anywhere -- and simply never sends any media.
   */
  function adoptTransceivers() {
    const all = pc.getTransceivers();
    TRACK_ROLES.forEach((role, index) => {
      const transceiver = all[index];
      if (!transceiver) return;
      tx.set(role, transceiver);
      if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
        transceiver.direction = 'sendrecv';
      }
    });
    logger.debug('peer: adopted transceivers', { peerId, count: tx.size });
  }

  const sender = (role) => tx.get(role)?.sender ?? null;

  /** Attach or clear a track without renegotiating. */
  async function setTrack(role, track) {
    const s = sender(role);
    if (!s) return false;
    try {
      await s.replaceTrack(track ?? null);
      return true;
    } catch (err) {
      logger.warn('peer: replaceTrack failed', { peerId, role, error: err?.message });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Negotiation
  // -------------------------------------------------------------------------

  pc.addEventListener('negotiationneeded', async () => {
    if (closed) return;
    try {
      makingOffer = true;
      // No argument: the browser composes the offer from current state. Setting an explicit
      // offer here is what breaks rollback.
      await pc.setLocalDescription();
      send('offer', { to: peerId, description: pc.localDescription });
    } catch (err) {
      logger.error('peer: negotiationneeded failed', { peerId, error: err?.message });
    } finally {
      // Must be in a finally. A throw that leaves this true wedges the connection: every
      // subsequent incoming offer is treated as a collision forever.
      makingOffer = false;
    }
  });

  pc.addEventListener('icecandidate', ({ candidate }) => {
    // A null candidate is end-of-candidates and is forwarded as such -- the peer uses it to
    // stop waiting.
    send('ice-candidate', { to: peerId, candidate: candidate ? candidate.toJSON() : null });
  });

  pc.addEventListener('track', (event) => {
    const role = roleForTransceiver(event.transceiver);
    logger.debug('peer: track', { peerId, kind: event.track.kind, role });
    onTrack?.({ peerId, role, track: event.track, streams: event.streams });
  });

  function roleForTransceiver(transceiver) {
    for (const [role, t] of tx) if (t === transceiver) return role;
    // Before adoption the map is empty; fall back to position in the transceiver list.
    const index = pc.getTransceivers().indexOf(transceiver);
    return TRACK_ROLES[index] ?? 'unknown';
  }

  /**
   * Signaling operations are serialized through this chain.
   *
   * Descriptions and candidates arrive from a socket that can deliver two frames in the same
   * task, and `setRemoteDescription` is asynchronous. Running two of them concurrently
   * interleaves the perfect-negotiation flags with the connection's own state transitions, so
   * a collision can be evaluated against a signalingState that has already moved on. One
   * queue removes the whole class of problem, and costs nothing at this message rate.
   */
  let chain = Promise.resolve();

  function enqueue(task) {
    chain = chain.then(task).catch((err) => {
      logger.error('peer: signaling task failed', { peerId, error: err?.message });
    });
    return chain;
  }

  /**
   * Handle an inbound offer or answer, following the perfect negotiation pattern.
   *
   * The collision case is real in this app rather than theoretical: two people clicking
   * "Share" within the same round trip produces exactly it.
   */
  function handleDescription(description) {
    if (closed) return chain;

    return enqueue(async () => {
      if (closed) return;

      const isOffer = description.type === 'offer';
      const readyForOffer =
        !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
      const collision = isOffer && !readyForOffer;

      // The impolite peer wins a collision by ignoring the incoming offer and keeping its own.
      ignoreOffer = !polite && collision;
      if (ignoreOffer) {
        logger.debug('peer: ignoring colliding offer (impolite)', { peerId });
        return;
      }

      isSettingRemoteAnswerPending = !isOffer;
      try {
        // The polite peer rolls back implicitly here -- modern browsers handle it inside
        // setRemoteDescription, which is why no explicit rollback call appears.
        await pc.setRemoteDescription(description);
      } finally {
        // require-atomic-updates warns that this write follows an await and could clobber a
        // concurrent invocation's value. That is exactly the hazard `enqueue` removes: every
        // description is processed on a single serialized chain, so a second invocation
        // cannot be in flight here. The `finally` is mandatory -- leaving this flag true
        // after a rejected setRemoteDescription makes every later offer look like a
        // collision, permanently.
        // eslint-disable-next-line require-atomic-updates
        isSettingRemoteAnswerPending = false;
      }

      if (isOffer) {
        if (tx.size === 0) adoptTransceivers();
        await pc.setLocalDescription();
        send('answer', { to: peerId, description: pc.localDescription });
      }

      await flushCandidates();
    });
  }

  /**
   * Queue a remote candidate until there is a remote description to attach it to.
   *
   * The server gives no ordering guarantee across senders, so a candidate genuinely can beat
   * its own offer. Adding one early throws; dropping it costs a connectivity path and shows up
   * later as an unexplained connection failure.
   */
  function handleCandidate(candidateInit) {
    if (closed) return chain;

    // Queued behind descriptions so a candidate can never be evaluated against a remote
    // description that is still mid-application.
    return enqueue(async () => {
      if (closed) return;

      if (!pc.remoteDescription) {
        if (pendingCandidates.length < MAX_QUEUED_CANDIDATES) {
          pendingCandidates.push(candidateInit);
        } else {
          logger.warn('peer: candidate queue full, dropping', { peerId });
        }
        return;
      }

      await addCandidate(candidateInit);
    });
  }

  async function addCandidate(candidateInit) {
    try {
      // `undefined` is how the browser expects end-of-candidates; `null` is not accepted.
      await pc.addIceCandidate(candidateInit ?? undefined);
    } catch (err) {
      // An ignored offer means the candidates that belong to it are meaningless too, so this
      // is expected rather than exceptional.
      if (!ignoreOffer) {
        logger.warn('peer: addIceCandidate failed', { peerId, error: err?.message });
      }
    }
  }

  async function flushCandidates() {
    if (pendingCandidates.length === 0) return;
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) await addCandidate(candidate);
  }

  // -------------------------------------------------------------------------
  // Connection health
  // -------------------------------------------------------------------------

  pc.addEventListener('connectionstatechange', () => {
    if (closed) return;
    const state = pc.connectionState;
    logger.debug('peer: connectionState', { peerId, state });

    clearTimeout(disconnectedTimer);

    switch (state) {
      case 'connected':
        restartAttempts = 0;
        onStateChange?.({ peerId, state: 'connected' });
        break;

      case 'connecting':
        onStateChange?.({ peerId, state: 'connecting' });
        break;

      case 'disconnected':
        // Report it, but do not act yet -- most of these recover without intervention.
        onStateChange?.({ peerId, state: 'reconnecting' });
        disconnectedTimer = setTimeout(() => {
          if (!closed && pc.connectionState === 'disconnected') recover();
        }, DISCONNECTED_GRACE_MS);
        break;

      case 'failed':
        onStateChange?.({ peerId, state: 'reconnecting' });
        recover();
        break;

      case 'closed':
        onStateChange?.({ peerId, state: 'closed' });
        break;

      default:
        break;
    }
  });

  /**
   * The recovery ladder: one ICE restart, then give up with a specific error.
   *
   * Only the initiating side restarts. Both sides restarting produces duelling offers at the
   * exact moment the connection is least able to cope. Giving up is a real outcome here --
   * two networks that cannot reach each other directly will not start being able to, and
   * saying so beats retrying forever behind a spinner.
   */
  function recover() {
    if (closed) return;

    if (youInitiate && restartAttempts === 0) {
      restartAttempts++;
      logger.info('peer: restarting ICE', { peerId });
      try {
        pc.restartIce();
        return;
      } catch (err) {
        logger.warn('peer: restartIce failed', { peerId, error: err?.message });
      }
    }

    if (pc.connectionState === 'failed' || restartAttempts > 0) {
      onStateChange?.({ peerId, state: 'failed' });
      onFailed?.(new AppError(ERRORS.ICE_FAILED, { detail: `peer ${name}` }));
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function start() {
    // Only the initiator builds the m-lines. The answerer adopts them, so if both sides
    // created transceivers the SDP would carry six.
    if (youInitiate) createTransceivers();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(disconnectedTimer);
    pendingCandidates = [];

    // Stopping transceivers before closing lets the remote see the tracks end promptly rather
    // than waiting for its own connection state to catch up.
    for (const transceiver of pc.getTransceivers()) {
      try {
        transceiver.stop?.();
      } catch {
        // Already stopped, or the connection is further along than we think. Harmless.
      }
    }

    try {
      pc.close();
    } catch {
      // Closing twice is not an error worth reporting.
    }
    tx.clear();
  }

  return {
    peerId,
    name,
    joinOrder,
    polite,
    youInitiate,
    pc,

    start,
    close,
    setTrack,
    sender,
    handleDescription,
    handleCandidate,

    get connectionState() {
      return pc.connectionState;
    },

    /** Senders tagged with their role. The role is what makes the microphone and the shared
     *  system audio distinguishable -- both are `kind: 'audio'`, and a test that cannot tell
     *  them apart cannot prove that muting the mic left the shared audio alone. */
    taggedSenders() {
      return [...tx.entries()].map(([role, transceiver]) => ({
        role,
        mid: transceiver.mid,
        kind: transceiver.receiver.track?.kind ?? (role === 'video' ? 'video' : 'audio'),
        sender: transceiver.sender,
      }));
    },

    getStats: (selector) => pc.getStats(selector),
  };
}
