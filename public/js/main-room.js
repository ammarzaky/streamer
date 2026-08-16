/**
 * Room composition root.
 *
 * The only place that turns user intents into RTC and media calls, and the only place that
 * routes signaling messages. Everything else is a pure renderer or a self-contained engine.
 */

import { C2S, S2C, ERRORS, CLOSE, END_REASON } from '../shared/protocol.js';
import { DEFAULT_PRESET_ID } from '../shared/quality-math.js';

import { store } from './state/room-store.js';
import { bus, EVENTS } from './core/event-bus.js';
import { logger } from './core/logger.js';
import { checkEnvironment, isE2E, environmentSummary } from './core/env.js';
import { AppError } from './core/errors.js';
import { errorCopy, errorLine, UI } from './ui/strings.js';
import { createSignalingClient } from './net/signaling.js';
import { createMesh, MESH_MESSAGE_TYPES } from './rtc/mesh.js';
import { createMediaManager } from './media/media-manager.js';
import { createQualityController } from './media/quality.js';
import { createStatsCollector } from './stats/stats-collector.js';
import { createRoomView } from './ui/room-view.js';
import { createToasts } from './ui/toast.js';
import { confirmDialog, showFatal, mountToastContainer } from './ui/dialog.js';

// -----------------------------------------------------------------------------
// Route and host token
// -----------------------------------------------------------------------------

const pathMatch = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
const routeRoomId = pathMatch ? pathMatch[1] : null;
const isCreating = routeRoomId === 'new';

/**
 * Where the host token lives, and why it is not in the URL.
 *
 * The token exists so a host who presses F5 gets their role back instead of handing it to
 * someone else. That requires it to survive a reload, and this app stores nothing, so the URL
 * fragment is the obvious home: never sent to the server, readable after a reload.
 *
 * It is the wrong home for THIS application. The most common thing a host does here is share
 * their entire screen or a browser window, and either renders the address bar -- token
 * included -- live, at full resolution, to every participant, where it is legible and
 * re-readable by anyone recording. `selfBrowserSurface: 'exclude'` hides only the current tab,
 * never the window or the monitor. Stripping the fragment after load and writing it back on
 * `pagehide` does not work either: the browser has already captured the URL to reload by the
 * time that handler runs.
 *
 * So the token goes in `sessionStorage`, keyed by room. That is a real qualification of "no
 * storage", stated plainly in the README, and it is the *less* persistent option: it is
 * per-tab, it dies with the tab, and it never enters the browser history that a URL fragment
 * would be written into on disk anyway. Nothing else is ever stored.
 */
const TOKEN_KEY_PREFIX = 'streamer:host:';

/**
 * Keyed by the REAL room id, which is not known yet when creating.
 *
 * A room is created at /r/new and only then learns its id, so a token stored under "new"
 * would be invisible to the reload that looks it up under the real id -- the reclaim would
 * silently never fire. The key is therefore rewritten as soon as `room-created` arrives.
 */
const tokenKey = (roomId) => `${TOKEN_KEY_PREFIX}${roomId}`;

function readHostToken() {
  try {
    return sessionStorage.getItem(tokenKey(routeRoomId));
  } catch {
    // Storage can be blocked entirely. Losing the token only costs a reloading host their
    // role; the room itself is unaffected.
    return null;
  }
}

function rememberHostToken(token, roomId = store.state.room.id ?? routeRoomId) {
  hostToken = token;
  try {
    // One token at a time: a stale key from a previous room in this tab is dead weight.
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(TOKEN_KEY_PREFIX)) sessionStorage.removeItem(key);
    }
    if (token && roomId) sessionStorage.setItem(tokenKey(roomId), token);
  } catch {
    // Non-fatal, as above.
  }
}

function forgetHostToken() {
  hostToken = null;
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(TOKEN_KEY_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Non-fatal.
  }
}

let hostToken = readHostToken();

// A fragment is still accepted once, for links shared before this changed, and is removed
// from the address bar immediately.
if (!hostToken && location.hash.includes('host=')) {
  const match = location.hash.match(/(?:^|[#&])host=([A-Za-z0-9_-]+)/);
  if (match) hostToken = match[1];
}
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

const toasts = createToasts(mountToastContainer());
const view = createRoomView({ store, bus, EVENTS });

if (isE2E()) logger.setLevel('debug');

if (!routeRoomId) {
  showFatal({
    title: errorCopy(ERRORS.ROOM_NOT_FOUND).message,
    hint: errorCopy(ERRORS.ROOM_NOT_FOUND).hint,
    actionLabel: UI.backToStart,
    onAction: () => location.assign('/'),
  });
} else {
  boot();
}

function boot() {
  const env = checkEnvironment({ requireDisplayMedia: true });
  if (!env.ok) {
    const { message, hint } = errorCopy(env.error.code);
    // Blocking, because nothing downstream can work: over http:// the capture APIs are not
    // merely restricted, they are absent.
    showFatal({ title: message, hint, actionLabel: UI.backToStart, onAction: () => location.assign('/') });
    return;
  }

  view.setLobbyMode({ creating: isCreating });
  store.setRoom({ id: isCreating ? null : routeRoomId });
  view.renderAll();
  view.el.name.focus();
}

// -----------------------------------------------------------------------------
// Engine wiring (created on join)
// -----------------------------------------------------------------------------

let signaling = null;
let mesh = null;
let media = null;
let quality = null;
let stats = null;
let serverConfig = null;
let leaving = false;

function buildEngine() {
  mesh = createMesh({
    send: (type, data) => signaling.send(type, data),
    config: serverConfig,
    onTrack: handleRemoteTrack,
    onPeerState: ({ peerId, state }) => store.updatePeer(peerId, { pcState: state }),
    onPeerFailed: (peerId, err) => {
      const peer = store.peer(peerId);
      toasts.error(`${errorCopy(err.code).message} (${peer?.name ?? peerId})`);
    },
  });

  media = createMediaManager({
    config: serverConfig,
    onShareEnded: (reason) => void stopSharing(reason),
    onDisplaySettingsChanged: (settings) => quality?.setCaptureHeight(settings.height),
  });

  quality = createQualityController({
    config: serverConfig,
    mesh,
    onChange: (patch) => store.setQuality(patch),
    onSuggestRaise: (preset) => toasts.info(UI.qualityRaiseSuggestion(preset.label)),
  });

  stats = createStatsCollector({
    mesh,
    config: serverConfig,
    onSample: handleStatsSample,
  });
}

/**
 * Remote video tracks, kept by peer so the stage can be re-derived at any time.
 *
 * Transceivers are pre-allocated, so `ontrack` fires during the initial negotiation -- long
 * before anyone starts sharing. Attaching only at that moment means the stage stays black
 * forever, because the track arrived while `sharerId` was still null and nothing ever looked
 * at it again. Ownership and media arrive independently, so the stage is a function of both
 * rather than a side effect of whichever happened last.
 */
const remoteVideoTracks = new Map();

function handleRemoteTrack({ peerId, role, track }) {
  if (role === 'video') {
    remoteVideoTracks.set(peerId, track);
    track.addEventListener('ended', () => {
      remoteVideoTracks.delete(peerId);
      syncStage();
    });
    syncStage();
    return;
  }
  view.attachRemoteAudio(peerId, track);
}

/** Put whatever the current sharer is sending on the stage, from whichever side it comes. */
function syncStage() {
  const { sharerId } = store.state.share;

  if (!sharerId) {
    view.clearRemoteVideo();
    return;
  }

  if (sharerId === store.state.self.id) {
    // Local preview. A sharer looking at a black rectangle cannot tell a working share from a
    // broken one, and this is the only feedback that the right window was picked.
    const local = media?.displayVideoTrack;
    if (local) view.attachLocalPreview(local);
    return;
  }

  const track = remoteVideoTracks.get(sharerId);
  if (track) view.attachRemoteVideo(track);
  else view.clearRemoteVideo();
}

function handleStatsSample(samples) {
  for (const sample of samples) store.setPeerStats(sample.peerId, sample);

  // Only the sharer's outbound numbers describe what is being sent.
  if (store.sharerIsSelf()) {
    const outbound = samples.filter((s) => s.hasOutboundVideo);
    if (outbound.length) {
      const worst = outbound[0];
      store.setQuality({
        actual: { width: worst.sendWidth, height: worst.sendHeight, fps: worst.sendFps },
      });
      quality.observe(outbound);
    }
  }
}

// -----------------------------------------------------------------------------
// Joining
// -----------------------------------------------------------------------------

bus.on(EVENTS.INTENT_JOIN, ({ name, accessCode }) => {
  view.setLobbyBusy(true, isCreating ? UI.creating : UI.joining);
  store.setSelf({ name });

  signaling = createSignalingClient({
    onMessage: routeMessage,
    onStatus: handleSignalingStatus,
  });

  pendingJoin = { name, accessCode };
  signaling.connect();
});

let pendingJoin = null;
let hasJoined = false;

function handleSignalingStatus({ status, attempt }) {
  store.setSignaling({ status, attempt });
  logger.debug('signaling status', { status, attempt });

  switch (status) {
    case 'open':
      // The welcome message arrives first and carries the config; the join is sent from
      // there so ICE servers are known before any peer connection exists.
      break;

    case 'reconnecting':
      if (hasJoined) view.showBanner('warn', `${errorCopy(ERRORS.SIGNALING_DOWN).message} (${attempt})`);
      break;

    case 'dead':
      if (hasJoined) {
        view.showBanner('danger', errorLine(ERRORS.SIGNALING_DEAD));
      } else {
        view.setLobbyBusy(false, isCreating ? UI.createNow : UI.joinNow);
        view.showLobbyError(ERRORS.SIGNALING_DEAD);
      }
      break;

    case 'closed-terminal':
      // A deliberate close. Whatever terminal screen is already showing is the true one.
      break;

    default:
      break;
  }
}

function sendJoin() {
  if (!pendingJoin) return;
  const { name, accessCode } = pendingJoin;

  if (isCreating) {
    signaling.send(C2S.CREATE_ROOM, { name });
  } else {
    signaling.send(C2S.JOIN, {
      roomId: routeRoomId,
      name,
      ...(hostToken ? { hostToken } : {}),
      ...(accessCode ? { accessCode } : {}),
    });
  }
}

// -----------------------------------------------------------------------------
// Message routing
// -----------------------------------------------------------------------------

function routeMessage(message) {
  const { type, data } = message;

  if (MESH_MESSAGE_TYPES.has(type)) {
    mesh?.handleMessage(message);
    return;
  }

  switch (type) {
    case S2C.WELCOME:
      onWelcome(data);
      return;
    case S2C.ROOM_CREATED:
      onRoomCreated(data);
      return;
    case S2C.JOINED:
      onJoined(data);
      return;
    case S2C.PEER_JOINED:
      onPeerJoined(data);
      return;
    case S2C.PEER_LEFT:
      onPeerLeft(data);
      return;
    case S2C.PEER_MUTE_STATE:
      store.updatePeer(data.peerId, { micMuted: Boolean(data.micMuted) });
      return;
    case S2C.HOST_CHANGED:
      onHostChanged(data);
      return;
    case S2C.HOST_TOKEN:
      // Directed to us alone. Never present in the broadcast above.
      rememberHostToken(data.hostToken);
      return;
    case S2C.SHARE_STATE:
      onShareState(data);
      return;
    case S2C.SHARE_REVOKED:
      onShareRevoked(data);
      return;
    case S2C.ROOM_ENDED:
      onRoomEnded(data);
      return;
    case S2C.ERROR:
      onServerError(data);
      return;
    case S2C.PONG:
      return;
    default:
      logger.warn('unhandled message type', { type });
  }
}

function onWelcome(data) {
  serverConfig = {
    iceServers: data.iceServers ?? [],
    media: {
      defaultPreset: data.defaultPreset ?? DEFAULT_PRESET_ID,
      uploadBudgetKbps: data.uploadBudgetKbps,
      autoAdapt: data.autoAdapt,
      audio: data.audio,
      includeDisplayAudio: data.includeDisplayAudio,
      statsPollIntervalMs: data.statsPollIntervalMs,
      stepDownSamplesCpu: data.stepDownSamplesCpu,
      stepDownSamplesBandwidth: data.stepDownSamplesBandwidth,
      adaptCooldownMs: data.adaptCooldownMs,
    },
    bundlePolicy: data.bundlePolicy,
    iceTransportPolicy: data.iceTransportPolicy,
    oneSharerAtATime: data.oneSharerAtATime,
  };

  store.setRoom({ maxParticipants: data.maxParticipants ?? 4 });
  buildEngine();
  store.setQuality({ presetId: serverConfig.media.defaultPreset });
  sendJoin();
}

function onRoomCreated(data) {
  // Keyed by the real id explicitly: the store still says /r/new at this point, and a token
  // filed under "new" would be invisible to the reload that looks it up by room id.
  rememberHostToken(data.hostToken ?? null, data.roomId);
  history.replaceState(null, '', `/r/${data.roomId}`);
  applyJoinedIdentity({ ...data, isHost: true, participants: [], share: { sharerId: null, epoch: 0 } });
}

function onJoined(data) {
  applyJoinedIdentity(data);
}

function applyJoinedIdentity(data) {
  hasJoined = true;
  leaving = false;

  store.setSelf({
    id: data.selfId,
    joinOrder: data.joinOrder,
    isHost: Boolean(data.isHost),
  });
  store.setRoom({
    id: data.roomId,
    status: 'connected',
    hostPeerId: data.hostPeerId ?? (data.isHost ? data.selfId : null),
    maxParticipants: data.maxParticipants ?? store.state.room.maxParticipants,
    link: `${location.origin}/r/${data.roomId}`,
  });

  // The invite link is built from the room id, never from location.href -- the fragment must
  // never travel with a shared link.
  view.setShareLink(`${location.origin}/r/${data.roomId}`);

  // Snapshots, not change notifications: without these a mid-session joiner would render
  // "nobody is sharing" while video arrives, and earlier mutes would be invisible.
  store.initShare({
    sharerId: data.share?.sharerId ?? null,
    sharerName: data.share?.sharerName ?? null,
    epoch: data.share?.epoch ?? 0,
  });

  for (const participant of data.participants ?? []) store.addPeer(participant);

  view.enterRoom();
  view.renderAll();
  installE2EHook();

  void startLocalMedia();

  for (const participant of data.participants ?? []) mesh.addPeer(participant);
  stats.start();
}

async function startLocalMedia() {
  try {
    const track = await media.startMic();
    // Muted on arrival: joining a call and being live before you have said anything is a
    // small privacy failure people notice.
    media.setMicMuted(true);
    store.setSelf({ micMuted: true });
    signaling.send(C2S.MUTE_STATE, { micMuted: true });
    if (track) await mesh.setLocalTrack('mic', track);
    await quality.apply();
  } catch (err) {
    const appError = err instanceof AppError ? err : new AppError(ERRORS.MIC_FAILED, { cause: err });
    // Not fatal: a participant with no microphone can still watch and share.
    toasts.warn(errorLine(appError.code));
    store.setSelf({ micMuted: true });
  }
}

function onPeerJoined(data) {
  const peer = data.peer ?? data;
  store.addPeer(peer);
  mesh.addPeer(peer);
  void quality.apply(); // the per-peer budget depends on how many people are here
  toasts.info(UI.peerJoined(peer.name));
}

function onPeerLeft(data) {
  const peer = store.peer(data.id);
  mesh.removePeer(data.id);
  stats.forget(data.id);
  view.removePeerMedia(data.id);
  store.removePeer(data.id);
  void quality.apply();

  if (peer) {
    toasts.info(
      data.reason === 'left' ? UI.peerLeft(peer.name) : UI.peerDisconnected(peer.name),
    );
  }
}

function onHostChanged(data) {
  store.setRoom({ hostPeerId: data.hostPeerId });
  const isSelf = data.hostPeerId === store.state.self.id;
  store.setSelf({ isHost: isSelf });

  if (isSelf) toasts.info(UI.youAreHost);
  else {
    const peer = store.peer(data.hostPeerId);
    if (peer) toasts.info(UI.hostChanged(peer.name));
  }
}

// -----------------------------------------------------------------------------
// Share ownership
// -----------------------------------------------------------------------------

function onShareState(data) {
  const applied = store.setShare(data);
  if (!applied) {
    logger.debug('ignoring stale share-state', data);
    return;
  }

  const selfIsSharer = store.sharerIsSelf();

  if (selfIsSharer && pendingCapture) {
    // Our claim succeeded: attach what we already captured.
    void attachCapture(pendingCapture);
    pendingCapture = null;
  } else if (!selfIsSharer && pendingCapture) {
    // Someone else won. Release the capture we optimistically took.
    releaseCapture(pendingCapture);
    pendingCapture = null;
    toasts.warn(errorCopy(ERRORS.SHARE_IN_PROGRESS).message);
  }

  if (!selfIsSharer && media?.isSharing) {
    // Ownership moved away while we were still sending.
    void stopSharing('lost');
  }

  syncStage();
  view.renderAll();
}

function onShareRevoked(data) {
  logger.info('share revoked', { by: data.byName, reason: data.reason });
  void stopSharing('revoked', data.epoch);
  toasts.warn(UI.shareTakenOver(data.byName ?? 'Someone'));
}

/** The capture we took before the server told us we could keep it. */
let pendingCapture = null;

/**
 * Start sharing.
 *
 * getDisplayMedia runs FIRST, synchronously inside the click handler, because transient user
 * activation does not survive an await -- and on the takeover path the server may take up to
 * shareRevokeTimeoutMs plus a round trip to answer. Capturing after the reply would put the
 * call outside the activation window in Chrome and Firefox, and outside Safari's model
 * entirely, so the Share button would fail with an unmapped InvalidStateError whenever the
 * server was slow. We capture first and release if the claim is refused.
 */
function startSharing({ force = false } = {}) {
  if (!media || pendingCapture) return;

  let capture;
  try {
    capture = media.captureDisplay(); // called synchronously; the promise is handled below
  } catch (err) {
    toasts.error(errorLine(err.code ?? ERRORS.SHARE_FAILED));
    return;
  }

  capture
    .then((stream) => {
      pendingCapture = stream;
      signaling.send(C2S.CLAIM_SHARE, { force });
    })
    .catch((err) => {
      // Cancelling the picker is a normal action, not an error worth alarming about.
      if (err?.code === ERRORS.SHARE_CANCELLED) return;
      toasts.error(errorLine(err?.code ?? ERRORS.SHARE_FAILED));
    });
}

async function attachCapture(stream) {
  const { video, audio } = media.adoptDisplayStream(stream);

  const settings = media.displaySettings();
  if (settings?.height) quality.setCaptureHeight(settings.height);

  await mesh.setLocalTrack('video', video);
  if (audio) await mesh.setLocalTrack('shareAudio', audio);

  store.setSelf({ sharing: true, displayAudioActive: media.hasDisplayAudio });
  // Encoder parameters reset on renegotiation, so they are re-applied after every track swap.
  await quality.apply();
  // The local track only exists now, so the preview can only be attached at this point --
  // the share-state that granted ownership arrived before there was anything to show.
  syncStage();
  view.renderAll();
}

function releaseCapture(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

/**
 * Stop sharing. Reachable from the browser's own stop control, our button, a takeover
 * revoke, room-ended, and teardown, so it must be idempotent.
 */
async function stopSharing(reason, epoch = store.state.share.epoch) {
  if (!media?.isSharing) return;

  media.stopShare(reason);
  await mesh.setLocalTrack('video', null);
  await mesh.setLocalTrack('shareAudio', null);
  store.setSelf({ sharing: false, displayAudioActive: false });

  // The room is already gone on this path; a release would only produce an error toast
  // layered over the ended screen.
  if (reason !== 'room-ended' && reason !== 'teardown' && signaling?.isOpen) {
    signaling.send(C2S.RELEASE_SHARE, { epoch });
  }

  if (reason === 'native') toasts.info(UI.shareStoppedByBrowser);
  view.renderAll();
}

// -----------------------------------------------------------------------------
// Intents
// -----------------------------------------------------------------------------

bus.on(EVENTS.INTENT_TOGGLE_MIC, () => {
  if (!media) return;
  const muted = media.setMicMuted(!store.state.self.micMuted);
  // Optimistic: a mute button that waits for the network feels broken.
  store.setSelf({ micMuted: muted });
  signaling.send(C2S.MUTE_STATE, { micMuted: muted });
});

bus.on(EVENTS.INTENT_START_SHARE, () => startSharing({ force: false }));

bus.on(EVENTS.INTENT_STOP_SHARE, () => void stopSharing('user'));

bus.on(EVENTS.INTENT_TAKE_OVER_SHARE, async ({ currentName }) => {
  const confirmed = await confirmDialog({
    title: UI.takeOverTitle,
    body: UI.takeOverBody(currentName ?? 'Someone'),
    confirmLabel: UI.takeOverConfirm,
  });
  if (!confirmed) return;
  // Note: the capture below is no longer inside the original gesture. Browsers accept a
  // <dialog> button press as a fresh activation, which is why the confirmation is a real
  // click rather than an auto-dismissing prompt.
  startSharing({ force: true });
});

bus.on(EVENTS.INTENT_SET_QUALITY, ({ presetId }) => {
  void quality.setPreset(presetId);
});

bus.on(EVENTS.INTENT_TOGGLE_STATS, () => {
  store.setUI({ statsOpen: !store.state.ui.statsOpen });
});

bus.on(EVENTS.INTENT_COPY_LINK, async () => {
  // Built from the room id, never location.href: the host token must never leave with a
  // shared link.
  const link = `${location.origin}/r/${store.state.room.id}`;
  try {
    await navigator.clipboard.writeText(link);
    toasts.ok(UI.linkCopied);
  } catch {
    toasts.warn(UI.copyFailed);
  }
});

bus.on(EVENTS.INTENT_LEAVE, async () => {
  const confirmed = await confirmDialog({
    title: UI.leaveTitle,
    body: UI.leaveBody,
    confirmLabel: UI.leaveConfirm,
    danger: true,
  });
  if (confirmed) leaveRoom();
});

bus.on(EVENTS.INTENT_END_SESSION, async () => {
  const confirmed = await confirmDialog({
    title: UI.endSessionTitle,
    body: UI.endSessionBody,
    confirmLabel: UI.endSessionConfirm,
    danger: true,
  });
  if (!confirmed) return;
  signaling.send(C2S.END, {});
});

// -----------------------------------------------------------------------------
// Ending
// -----------------------------------------------------------------------------

function onRoomEnded(data) {
  teardown();
  const byHost = data.reason === END_REASON.HOST_ENDED;
  showFatal({
    title: byHost ? UI.endedByHost : errorCopy(ERRORS.ROOM_ENDED).message,
    detail: byHost ? null : `Reason: ${data.reason}`,
    actionLabel: UI.backToStart,
    onAction: () => location.assign('/'),
  });
}

function onServerError(data) {
  const { code } = data;
  logger.warn('server error', { code, detail: data.message });

  // Ordinary during teardown: a relay aimed at someone who just left.
  if (code === ERRORS.PEER_NOT_FOUND) return;

  if (code === ERRORS.SHARE_IN_PROGRESS) {
    if (pendingCapture) {
      releaseCapture(pendingCapture);
      pendingCapture = null;
    }
    toasts.warn(errorCopy(code).message);
    return;
  }

  if (!hasJoined) {
    view.setLobbyBusy(false, isCreating ? UI.createNow : UI.joinNow);
    if (code === ERRORS.ACCESS_CODE_REQUIRED || code === ERRORS.ACCESS_CODE_INVALID) {
      view.el.accessField.hidden = false;
    }
    view.showLobbyError(code);
    return;
  }

  toasts.error(errorLine(code));
}

function leaveRoom() {
  leaving = true;
  signaling?.send(C2S.LEAVE, {});
  teardown();
  showFatal({
    title: UI.youLeft,
    actionLabel: UI.backToStart,
    onAction: () => location.assign('/'),
  });
}

function teardown() {
  // The token has no purpose once the session is over, and leaving it behind would be the
  // only thing this app ever persisted past a session.
  forgetHostToken();
  stats?.stop();
  void stopSharing('teardown');
  mesh?.closeAll();
  media?.stopAll();
  view.destroy();
  signaling?.close(leaving ? CLOSE.LEFT : CLOSE.NORMAL);
}

/*
 * Deliberately NO `leave` on pagehide.
 *
 * A reload and a tab close are indistinguishable from inside the page, and `leave` means
 * something specific to the server: a deliberate exit, which promotes the next host
 * immediately with no grace window. Sending it on every unload therefore breaks the one thing
 * the host token exists for -- pressing F5 would hand your room to someone else before the
 * reloaded page could ask for it back.
 *
 * Nothing is lost by omitting it. Closing a tab closes the socket, the server sees that at
 * once, and peers get `peer-left` just as quickly.
 */

// -----------------------------------------------------------------------------
// E2E introspection hook
// -----------------------------------------------------------------------------

/**
 * Read-only accessors for the test suite, installed only under the E2E flag the server
 * injects. Asserting on real getStats output beats asserting on pixels, and everything here
 * is already reachable from the page's own objects -- this exposes no new capability.
 */
function installE2EHook() {
  if (!isE2E()) return;

  window.__app = {
    selfId: () => store.state.self.id,
    roomId: () => store.state.room.id,
    isHost: () => store.state.self.isHost,
    peers: () => mesh.snapshot(),
    connections: () => mesh.snapshot().map((p) => p.connectionState),
    share: () => ({ ...store.state.share }),
    quality: () => ({ ...store.state.quality }),
    micMuted: () => store.state.self.micMuted,
    micTrackEnabled: () => media?.micTrack?.enabled ?? null,
    hasDisplayAudio: () => media?.hasDisplayAudio ?? false,
    /** Senders tagged with their role, so a test can tell the microphone apart from the
     *  shared system audio -- both are kind 'audio', and the distinction is the whole point
     *  of the mute behaviour. */
    senders: (peerId) => {
      const peer = mesh.peer(peerId ?? mesh.peerIds()[0]);
      return (peer?.taggedSenders() ?? []).map(({ role, mid, kind, sender }) => ({
        role,
        mid,
        kind,
        hasTrack: Boolean(sender.track),
        trackEnabled: sender.track?.enabled ?? null,
      }));
    },
    encodings: async (peerId) => {
      const peer = mesh.peer(peerId ?? mesh.peerIds()[0]);
      const sender = peer?.sender('video');
      return sender ? sender.getParameters().encodings : null;
    },
    stats: async (peerId) => {
      const peer = mesh.peer(peerId);
      if (!peer) return null;
      const report = await peer.getStats();
      return [...report.values()];
    },
    signalingStatus: () => store.state.signaling.status,
    /** Drop the signaling socket with a non-terminal code, to exercise the reconnect path.
     *  A test cannot produce a genuine 1006 from inside the page, and 4004 travels the same
     *  branch: shouldReconnect() is true for both. */
    dropSocket: () => signaling?.close && signalingDrop(),
    env: environmentSummary,
    diagnostics: () => logger.dump({ env: environmentSummary() }),
  };
}

/** Close the current socket without marking the session as intentionally over. */
function signalingDrop() {
  const client = signaling;
  if (!client?.isOpen) return false;
  client.forceDrop(CLOSE.SERVER_SHUTDOWN);
  return true;
}
