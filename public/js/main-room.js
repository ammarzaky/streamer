/**
 * Room composition root.
 *
 * The only place that turns user intents into RTC and media calls, and the only place that
 * routes signaling messages. Everything else is a pure renderer or a self-contained engine.
 *
 * The audio diagnostics live here too, because they are the one feature that touches every
 * engine at once: the meter (media), the stats (rtc), the peer reports (data channel), the
 * verdict (pure), and the banner (view). See docs/DIAGNOSTICS.md for what each piece answers.
 */

import { C2S, S2C, ERRORS, CLOSE, END_REASON, LEAVE_REASON } from '../shared/protocol.js';
import { DEFAULT_PRESET_ID, getPreset } from '../shared/quality-math.js';

import { store } from './state/room-store.js';
import { createChat } from './ui/chat.js';
import { createFileChat } from './ui/file-chat.js';
import { bus, EVENTS } from './core/event-bus.js';
import { logger } from './core/logger.js';
import { checkEnvironment, isE2E, environmentSummary } from './core/env.js';
import { AppError } from './core/errors.js';
import { h, replace, text as setText } from './core/dom.js';
import {
  errorCopy,
  errorLine,
  UI,
  AUDIO_HEALTH,
  AUDIO_HINT,
  BANNER,
  SELFTEST,
  AUDIO_CHECK,
  LOBBY,
  STATS_AUDIO,
  TILE,
  bi,
  resolve,
} from './ui/strings.js';
import { createSignalingClient } from './net/signaling.js';
import { createMesh, MESH_MESSAGE_TYPES } from './rtc/mesh.js';
import {
  buildReport,
  parseReport,
  buildDumpRequest,
  chunkDump,
  parseControl,
  createDumpAssembler,
  DIAG_KIND,
} from './rtc/diag-channel.js';
import { createMediaManager } from './media/media-manager.js';
import { createLevelMeter, SPEAKING_THRESHOLD } from './media/level-meter.js';
import { startMicCheck, MIC_STATE } from './media/mic-check.js';
import { describeDevices, RESERVED_DEVICE_IDS, friendlyDeviceLabel } from './media/mic-constraints.js';
import { runMicSelfTest, SELFTEST_SILENT_PEAK } from './media/mic-selftest.js';
import { deriveAudioHealth, createHealthTracker, HEALTH } from './media/audio-health.js';
import { createQualityController, LIMITED_BY } from './media/quality.js';
import { createStatsCollector } from './stats/stats-collector.js';
import { createRoomView } from './ui/room-view.js';
import { createToasts } from './ui/toast.js';
import {
  confirmDialog,
  wizardDialog,
  textDialog,
  biNode,
  showFatal,
  mountToastContainer,
} from './ui/dialog.js';

// -----------------------------------------------------------------------------
// Route and host token
// -----------------------------------------------------------------------------

const pathMatch = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
const routeRoomId = pathMatch ? pathMatch[1] : null;

/**
 * Whether the NEXT join should create a room.
 *
 * Mutable on purpose. Once a room exists we must never create another, and a socket reconnect
 * re-runs the join path: a host who arrived via /r/new would otherwise send `create-room`
 * again, receive a different room id, and be moved -- alone -- into a brand new room while
 * everyone else stayed behind in the original, with the invite link they were sent no longer
 * matching the host's address bar.
 */
let isCreating = routeRoomId === 'new';

/** The room we belong to, which is only the route for a join and is filled in for a create. */
let activeRoomId = isCreating ? null : routeRoomId;

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

/**
 * The lobby microphone check, held so the device can be handed to the room the moment the
 * user joins.
 *
 * Declared up here rather than beside its functions because boot() is invoked from module top
 * level, above them. Function declarations hoist and are fine; let and const are still in their
 * temporal dead zone, and reaching one throws before the lobby has finished rendering.
 */
let lobbyMicCheck = null;
/** The lobby's live stream, taken over on Join so the room sends the track the bar moved for. */
let lobbyHandoff = null;
/** What the lobby concluded, carried into the room for the verdict and the dump. */
let lobbyMicResult = null;
/** The input the user picked, in memory only. null = the browser's default. */
let chosenMicDeviceId = null;
let lobbyDevicesLoaded = false;

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

  startLobbyMicCheck();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (hasJoined) return;
    void refreshLobbyDevices();
    // A check that failed because the device was not there (or was unplugged while the lobby
    // was open) is worth re-running now that the device list changed: plugging the headset
    // back in should bring the bar back without a reload. A denied permission is not retried;
    // that would fail again without a prompt and teach nothing.
    const result = lobbyMicCheck?.result();
    if (result?.state === MIC_STATE.FAILED && result.code === ERRORS.MIC_NOT_FOUND) {
      logger.info('audio: lobby devices changed after a failed check, retrying');
      stopLobbyMicCheck();
      startLobbyMicCheck();
    }
  });
}

function lobbyStatusNode(state, code, label) {
  switch (state) {
    case MIC_STATE.CHECKING:
      return UI.micCheckChecking;
    case MIC_STATE.HEARING:
      return label ? biNode(resolve(LOBBY.hearingDevice, { label })) : UI.micCheckHearing;
    case MIC_STATE.QUIET:
      return label ? biNode(resolve(LOBBY.quietDevice, { label })) : UI.micCheckQuiet;
    case MIC_STATE.OS_MUTED:
      return biNode(resolve(LOBBY.osMutedDevice, { label }));
    case MIC_STATE.SILENT:
      return biNode(resolve(LOBBY.silentDevice, { label }));
    case MIC_STATE.FAILED:
      return errorLine(code ?? ERRORS.MIC_FAILED);
    default:
      return '';
  }
}

/** How the lobby line is coloured. OS_MUTED is red because it is certain (the track says so)
 *  and nobody will hear a word until it is fixed; SILENT is amber because it is an inference.
 *  Neither is a wall: the device is open, and the Create/Join button stays enabled -- the
 *  person can still watch and share. A function rather than a const table because `boot()`
 *  runs above this point in the module and a `const` would still be in its temporal dead zone
 *  on the first update. */
function lobbySeverity(state) {
  if (state === MIC_STATE.SILENT) return 'warn';
  if (state === MIC_STATE.OS_MUTED || state === MIC_STATE.FAILED) return 'danger';
  return null;
}

function startLobbyMicCheck() {
  // The meter paints on every tick; the line is rebuilt only when its copy would differ.
  // The bilingual copy is a Node, and replacing it twenty times a second would collapse any
  // selection the person is making on the very instructions they are trying to read. Local to
  // the call so a restart (device switch) renders from scratch.
  let lastStatusKey = null;
  lobbyMicCheck = startMicCheck(
    ({ state, level, code, label }) => {
      // Amber while Windows has the endpoint muted: the same colour the room uses for "the
      // microphone is fine but nothing is being sent", which is what an OS mute is.
      view.setLobbyMicLevel(level, { dead: state === MIC_STATE.FAILED, muted: state === MIC_STATE.OS_MUTED });
      const statusKey = `${state}|${code ?? ''}|${label ?? ''}`;
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        view.setLobbyMicStatus(lobbyStatusNode(state, code, label), { severity: lobbySeverity(state) });
      }
      // Labels only exist once a capture has been granted, so this is the first moment the
      // device list is worth showing.
      const acquired =
        state === MIC_STATE.HEARING ||
        state === MIC_STATE.QUIET ||
        state === MIC_STATE.OS_MUTED ||
        state === MIC_STATE.SILENT;
      if (!lobbyDevicesLoaded && acquired) {
        lobbyDevicesLoaded = true;
        void refreshLobbyDevices();
      }
    },
    { deviceId: chosenMicDeviceId },
  );
}

function stopLobbyMicCheck() {
  lobbyMicCheck?.stop();
  lobbyMicCheck = null;
}

/** The lobby has no media manager yet, so it lists devices itself. */
async function refreshLobbyDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = describeDevices(await navigator.mediaDevices.enumerateDevices());
    store.setAudio({ devices });
    view.setLobbyDevices(devices, chosenMicDeviceId);
    logger.info('audio: lobby devices', {
      inputs: devices.inputs.map((d) => d.label || '(no label)'),
      defaultMatchesCommunications: devices.defaultMatchesCommunications,
    });
  } catch (err) {
    logger.warn('audio: lobby enumerateDevices failed', { name: err?.name });
  }
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

/**
 * Create (or re-create) the engine.
 *
 * `welcome` arrives on EVERY connection, including every reconnect, so this must be safe to
 * call more than once. Building blindly the second time left the previous mesh open and still
 * sending, the previous stats poller running forever against dead connections, and the
 * previous media manager still holding the microphone -- while a second `getUserMedia` opened
 * another one, so the operating system's microphone indicator never cleared.
 *
 * The media manager is deliberately kept across a rebuild: re-acquiring would re-prompt for
 * permission and double-capture. Everything tied to peer connections is replaced.
 */
function buildEngine() {
  // Tear down anything from a previous connection first.
  stats?.stop();
  stats = null;
  mesh?.closeAll();
  mesh = null;
  remoteVideoTracks.clear();
  dumpAssemblers.clear();

  mesh = createMesh({
    send: (type, data) => signaling.send(type, data),
    config: serverConfig,
    onTrack: handleRemoteTrack,
    onPeerState: ({ peerId, state }) => store.updatePeer(peerId, { pcState: state }),
    onPeerFailed: (peerId, err) => {
      const peer = store.peer(peerId);
      toasts.error(`${errorCopy(err.code).message} (${peer?.name ?? peerId})`);
    },
    // Negotiation resets encoder parameters, so they are re-applied every time one completes.
    onNegotiated: () => void quality?.apply(),
    onDiagMessage: handleDiagMessage,
    onFileChannel: (event) => files.attachPeer(event),
  });

  media ??= createMediaManager({
    config: serverConfig,
    onShareEnded: (reason) => void stopSharing(reason),
    onDisplayAudioEnded: () => {
      // The share continues; only its audio is gone. Drop the dead track and stop claiming
      // otherwise in the UI.
      void mesh?.setLocalTrack('shareAudio', null);
      store.setSelf({ displayAudioActive: false });
    },
    onDisplaySettingsChanged: (settings) => {
      // Width or frame rate can change without the height moving, so the parameters are
      // re-applied regardless of whether setCaptureHeight considers this a change.
      quality?.setCaptureHeight(settings.height);
      void quality?.apply();
    },
    onMicTrackState: handleMicTrackState,
    onDevicesChanged: (devices) => store.setAudio({ devices }),
  });

  quality = createQualityController({
    config: serverConfig,
    mesh,
    onChange: (patch) => {
      store.setQuality(patch);
      // An automatic downgrade is the most disorienting thing this app can do silently: the
      // frame rate halves, the quality button changes underneath the user, and nothing says
      // why -- leaving "I picked 1080p60 and I'm getting 30" with no available explanation.
      // Exactly one toast, naming the reason, on the transition only.
      if (patch.steppedDown) {
        const label = getPreset(patch.presetId).label;
        toasts.warn(
          patch.reason === LIMITED_BY.CPU
            ? UI.qualityLoweredCpu(label)
            : UI.qualityLoweredNetwork(label),
        );
      }
    },
    onSuggestRaise: (preset) => toasts.info(UI.qualityRaiseSuggestion(preset.label)),
  });

  stats = createStatsCollector({
    mesh,
    config: serverConfig,
    onSample: handleStatsSample,
  });
}

/**
 * The BROWSER's word on the microphone source, which the mute button knows nothing about.
 * `mute`/`unmute` is the Windows endpoint mute (Chromium polls it once a second and mirrors it
 * onto the track: the keyboard's mic-mute key, or Sound › Input); `ended` is the device gone.
 * Either used to leave the roster saying "unmuted" over a sender nobody could hear.
 */
function handleMicTrackState({ event, sourceMuted, ended, info, label }) {
  if (ended) {
    // A dead track is a muted microphone as far as the room is concerned: the button must
    // read "Unmute" (which re-acquires) rather than "Mute" over nothing, and the roster must
    // not keep showing us live to people who cannot hear us.
    // Recorded as an ENDED track, not an acquisition error: the copy for it says "reconnect
    // or pick another", and the next unmute re-acquires.
    store.setSelf({
      micMuted: true,
      micAvailable: false,
      micError: null,
      micEnded: true,
      micEndedLabel: label ?? store.state.self.micDevice?.label ?? '',
      micSourceMuted: false,
      micDevice: null,
    });
    sendMuteState(true);
    syncMicMeter();
    toasts.warn(bi(resolve(AUDIO_HEALTH.TRACK_ENDED, { label: label ?? '' })), { ms: 8000 });
    return;
  }
  store.setSelf({ micSourceMuted: Boolean(sourceMuted), micDevice: info ?? store.state.self.micDevice });
  if (event === 'mute') {
    view.setStageMicLevel(0, { dead: true });
    toasts.warn(bi(resolve(BANNER.micSourceMuted, { label: info?.label ?? '' })), { ms: 8000 });
  }
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
  logger.info('audio: remote track attached', { peerId, role, muted: track.muted });
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
    // The explicit clear matters: leaving the previous content up when we own the share but
    // have no track yet would show the PREVIOUS sharer's video labelled as ours.
    if (local) view.attachLocalPreview(local);
    else view.clearRemoteVideo();
    return;
  }

  const track = remoteVideoTracks.get(sharerId);
  if (track) view.attachRemoteVideo(track);
  else view.clearRemoteVideo();
}

function handleStatsSample(samples) {
  for (const sample of samples) store.setPeerStats(sample.peerId, sample);

  // Only the sharer's outbound numbers describe what is being SENT -- and only the sharer's
  // encoder can be adapted, which is why `observe` runs on this branch alone.
  if (store.sharerIsSelf()) {
    const outbound = samples.filter((s) => s.hasOutboundVideo);
    if (outbound.length) {
      const worst = outbound[0];
      store.setQuality({
        actual: { width: worst.sendWidth, height: worst.sendHeight, fps: worst.sendFps },
      });
      quality.observe(outbound);
    }
  } else {
    // A viewer's own preset describes a share they are not sending, so `actual` used to stay
    // null here forever and the control bar advertised "1080p 60" over someone else's picture.
    // The honest number on this side is the one coming out of the decoder.
    const inbound = samples.find((s) => s.peerId === store.state.share.sharerId && s.recvWidth);
    store.setQuality({
      actual: inbound
        ? { width: inbound.recvWidth, height: inbound.recvHeight, fps: inbound.recvFps, inbound: true }
        : null,
    });
  }

  // The audio diagnostics ride on the same tick: one report to each peer, one timeline entry
  // per peer, and the sink states refreshed for the panel.
  for (const sample of samples) {
    sendDiagReport(sample);
    recordTimeline(sample);
  }
  store.setAudio({ sinks: view.allSinkStates() });
  evaluateHealth();
}

// -----------------------------------------------------------------------------
// Joining
// -----------------------------------------------------------------------------

/** Stop a lobby stream that was taken over but never consumed (a failed join). */
function releaseLobbyHandoff() {
  lobbyHandoff?.getTracks().forEach((track) => track.stop());
  lobbyHandoff = null;
}

/** Back to the lobby after a rejected or failed join, with the bar live again for the retry. */
function returnToLobbyAfterFailedJoin() {
  releaseLobbyHandoff();
  view.setLobbyBusy(false, isCreating ? UI.createNow : UI.joinNow);
  if (!lobbyMicCheck) startLobbyMicCheck();
}

bus.on(EVENTS.INTENT_JOIN, ({ name, accessCode }) => {
  // A previous attempt that was rejected (bad access code, room full) leaves its socket open;
  // drop it so only one client is ever pinging and routing messages, and release the stream
  // that attempt took over -- otherwise two captures of one device end up open.
  signaling?.close(CLOSE.NORMAL);
  releaseLobbyHandoff();

  // The lobby's verified stream is taken over rather than stopped: the track the bar moved
  // for is the track peers will receive. Permission is already granted, so if the room does
  // need to re-acquire (different device or processing), it is silent.
  if (lobbyMicCheck) {
    lobbyHandoff = lobbyMicCheck.takeStream();
    lobbyMicResult = lobbyMicCheck.result();
    // The lobby may have fallen back to another device because the chosen one vanished;
    // follow what it actually opened rather than asking again for a device that is not there.
    if (lobbyHandoff && lobbyMicResult && (lobbyMicResult.deviceId ?? null) !== chosenMicDeviceId) {
      logger.info('audio: lobby opened a different device, following it', {
        requested: chosenMicDeviceId,
        opened: lobbyMicResult.deviceId ?? null,
      });
      chosenMicDeviceId = lobbyMicResult.deviceId ?? null;
    }
    logger.info('audio: lobby result', lobbyMicResult);
    store.setAudio({ lobby: lobbyMicResult });
    stopLobbyMicCheck();
  }
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
/**
 * Whether the CURRENT socket has completed a join. `hasJoined` stays true across a reconnect
 * (it means "we belong to a room"), but the server's state for the new socket is UNJOINED
 * until `joined` lands, and a room message sent in that window is a WRONG_STATE error.
 */
let joinedOnThisSocket = false;
let chatAvailable = false;
const chat = createChat({
  send: (...args) => signaling.send(...args),
  canSend: () => joinedOnThisSocket && signaling?.isOpen && !tornDown,
});
const files = createFileChat({
  chat,
  canSend: () => joinedOnThisSocket && signaling?.isOpen && !tornDown,
  // One shared cap across all recipients, using at most 5% of configured upload.
  rateBytesPerSecond: () => Math.min(media?.isSharing ? 32768 : 131072,
    (quality?.uploadBudgetBps ?? 1000000) * 0.05 / 8),
});
/** Set by teardown: nothing may re-open the microphone or touch the mesh after it. */
let tornDown = false;

/** The one place mute-state leaves this page. Silent when the socket has not joined yet. */
function sendMuteState(muted) {
  if (!joinedOnThisSocket || !signaling?.isOpen) return;
  signaling.send(C2S.MUTE_STATE, { micMuted: Boolean(muted) });
}

function handleSignalingStatus({ status, attempt }) {
  files.refresh();
  // Reopening the socket is not membership: wait for ROOM_CREATED/JOINED to enable chat.
  if (status !== 'open') chat.setConnection(false, chatAvailable);
  store.setSignaling({ status, attempt });
  logger.debug('signaling status', { status, attempt });

  switch (status) {
    case 'open':
      // The welcome message arrives first and carries the config; the join is sent from
      // there so ICE servers are known before any peer connection exists.
      break;

    case 'reconnecting':
      if (hasJoined) setBanner('signaling', { kind: 'warn', message: `${errorCopy(ERRORS.SIGNALING_DOWN).message} (${attempt})` });
      break;

    case 'dead':
      if (hasJoined) {
        setBanner('signaling', { kind: 'danger', message: errorLine(ERRORS.SIGNALING_DEAD) });
      } else {
        returnToLobbyAfterFailedJoin();
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
    return;
  }

  signaling.send(C2S.JOIN, {
    // The room we are actually in, not the path we arrived on -- after a create those differ,
    // and a reconnect must return to the same room.
    roomId: activeRoomId ?? routeRoomId,
    name,
    ...(hostToken ? { hostToken } : {}),
    ...(accessCode ? { accessCode } : {}),
  });
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
      if (chat.receive(message)) return;
      onServerError(data);
      return;
    case S2C.CHAT:
      chat.receive(message);
      return;
    case S2C.PONG:
      return;
    default:
      logger.warn('unhandled message type', { type });
  }
}

function onWelcome(data) {
  chatAvailable = data.chatEnabled === true;
  chat.setConnection(false, chatAvailable);
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
      // Was missing from this list, so the server published it and the client never read it:
      // `quality.js` fell back to its own 8000 and the ramp-up guard ran for half the
      // configured time. The kind of omission nothing fails on -- it just adapts too early.
      adaptWarmupMs: data.adaptWarmupMs,
    },
    bundlePolicy: data.bundlePolicy,
    iceTransportPolicy: data.iceTransportPolicy,
    oneSharerAtATime: data.oneSharerAtATime,
  };

  store.setRoom({ maxParticipants: data.maxParticipants ?? 4 });

  // A reconnect gets a NEW peer id, so every queued message is addressed to a session that no
  // longer exists and every peer must be rebuilt from the fresh `joined` snapshot rather than
  // merged with stale state.
  joinedOnThisSocket = false;
  if (hasJoined) {
    logger.info('signaling: reconnected, rebuilding the mesh');
    signaling.dropQueue();
    view.removeAllPeerMedia();
    store.resetForRejoin();
    setBanner('signaling', null);
  }

  buildEngine();
  store.setQuality({ presetId: serverConfig.media.defaultPreset });
  sendJoin();
}

function onRoomCreated(data) {
  // Keyed by the real id explicitly: the store still says /r/new at this point, and a token
  // filed under "new" would be invisible to the reload that looks it up by room id.
  rememberHostToken(data.hostToken ?? null, data.roomId);

  // The room now exists, so every later join -- including after a reconnect -- must be a
  // join, never another create.
  isCreating = false;
  activeRoomId = data.roomId;

  history.replaceState(null, '', `/r/${data.roomId}`);
  applyJoinedIdentity({ ...data, isHost: true, participants: [], share: { sharerId: null, epoch: 0 } });
}

function onJoined(data) {
  applyJoinedIdentity(data);
}

function applyJoinedIdentity(data) {
  hasJoined = true;
  joinedOnThisSocket = true;
  chat.setConnection(true, chatAvailable);
  files.refresh();
  leaving = false;

  store.setSelf({
    id: data.selfId,
    joinOrder: data.joinOrder ?? null,
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
  installIntrospection();
  // Before the peer connections, so a remembered speaker is already in force when the first
  // remote element is created rather than being retro-fitted onto it a moment later.
  restoreAudioPrefs();

  void restoreLocalMedia();

  for (const participant of data.participants ?? []) mesh.addPeer(participant);
  stats.start();
  startHealthLoop();
  syncStage();
}

/**
 * Put our outgoing media back on the new mesh.
 *
 * On a first join this acquires the microphone. On a rejoin after a reconnect the microphone
 * is already open -- re-acquiring would prompt again and leave two captures running -- so the
 * existing tracks are simply re-attached to the freshly built peer connections.
 */
async function restoreLocalMedia() {
  // The microphone and the screen share are restored independently.
  //
  // They used to be nested -- the share was only re-attached inside `if (existingMic)` -- which
  // meant anyone without a working microphone silently lost their screen share on every
  // reconnect, and a reconnect is exactly what a change of network causes. Two unrelated pieces
  // of state should not share a conditional.
  const existingMic = media?.micTrack;

  if (existingMic) {
    await mesh.setLocalTrack('mic', existingMic);
  } else {
    // No track yet, or the last attempt failed. Try again rather than spending the rest of the
    // session unable to speak.
    await startLocalMedia({ announce: false });
  }

  // Peers cannot observe `enabled`, so our mute state has to be restated to a room that has
  // never heard it. Unconditional: an unmute pressed while the socket was down was dropped with
  // the rest of the outbound queue, so this is the only thing that puts the room right.
  sendMuteState(store.state.self.micMuted);

  if (media?.isSharing) {
    const video = media.displayVideoTrack;
    const audio = media.displayAudioTrack;
    if (video) await mesh.setLocalTrack('video', video);
    if (audio) await mesh.setLocalTrack('shareAudio', audio);
    // Ownership did not survive our disconnection: the server released the slot when our socket
    // died. Ask for it back, and stop if somebody else has taken it -- otherwise two people
    // would be transmitting screens at once.
    signaling.send(C2S.CLAIM_SHARE, { force: false });
  }

  await quality.apply();
}

/**
 * Acquire the microphone and attach it.
 *
 * Two separate failures, reported separately. Acquisition failing means there is no
 * microphone, and the button must say so. Attaching to the mesh failing means the microphone
 * is fine and the connection is not -- reporting that as MIC_FAILED sent people to check their
 * headset for a WebRTC problem, and hid the meter that would have shown the mic working.
 */
async function startLocalMedia({ announce = true } = {}) {
  if (tornDown || !media) return false;
  let track;
  try {
    const handoff = lobbyHandoff;
    lobbyHandoff = null;
    track = await media.startMic({ stream: handoff, deviceId: chosenMicDeviceId });
    if (tornDown) return false;
    if (!track) throw new AppError(ERRORS.MIC_NOT_FOUND);

    // Muted on arrival: joining a call and being live before you have said anything is a
    // small privacy failure people notice.
    media.setMicMuted(true);
    const info = media.micInfo();
    store.setSelf({
      micMuted: true,
      micAvailable: true,
      micError: null,
      micEnded: false,
      micEndedLabel: null,
      micSourceMuted: Boolean(track.muted),
      micDevice: info,
    });
    store.setAudio({ processing: info?.settings ?? null });
    if (announce) sendMuteState(true);
    // The meter starts the moment there is a track, before the connection has anything to say.
    syncMicMeter();
  } catch (err) {
    const appError = err instanceof AppError ? err : new AppError(ERRORS.MIC_FAILED, { cause: err });
    // Not fatal: a participant with no microphone can still watch and share. But it must be
    // recorded, because the mute button has to stop pretending afterwards.
    toasts.warn(errorLine(appError.code));
    logger.warn('audio: mic acquisition failed', { code: appError.code, detail: appError.detail ?? null });
    store.setSelf({ micMuted: true, micAvailable: false, micError: appError.code, micDevice: null });
    if (announce) sendMuteState(true);
    return false;
  }

  try {
    await mesh.setLocalTrack('mic', track);
    await quality.apply();
  } catch (err) {
    logger.error('audio: mesh attach failed', { name: err?.name, message: err?.message });
    toasts.error(bi(BANNER.meshAttachFailed));
  }
  return true;
}

function onPeerJoined(data) {
  const peer = data.peer ?? data;
  store.addPeer(peer);
  mesh.addPeer(peer);
  void quality.apply(); // the per-peer budget depends on how many people are here
  // Their id is new but they are not: a volume set for this name earlier in the session --
  // before their reconnect, or before they last left -- applies again.
  restoreVolumeFor(peer.id);
  toasts.info(UI.peerJoined(peer.name));
}

function onPeerLeft(data) {
  const peer = store.peer(data.id);
  mesh.removePeer(data.id);
  stats.forget(data.id);
  view.removePeerMedia(data.id);
  store.removeSink(data.id);
  // The id is dead; the preference is not. It lives on under their NAME in the session, so
  // dropping it from the live map here is bookkeeping, not forgetting.
  if (data.id in store.state.audio.volumes) {
    const volumes = { ...store.state.audio.volumes };
    delete volumes[data.id];
    store.setAudio({ volumes });
  }
  dumpAssemblers.delete(data.id);
  // Not left to the track's `ended` event: Chrome fires it when the connection closes but
  // Firefox historically does not, and a missed delete keeps a live MediaStreamTrack and its
  // closure referenced for the life of the page.
  remoteVideoTracks.delete(data.id);
  store.removePeer(data.id);
  syncStage();
  void quality.apply();

  if (peer) {
    toasts.info(
      data.reason === LEAVE_REASON.LEFT ? UI.peerLeft(peer.name) : UI.peerDisconnected(peer.name),
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
  // Clear the stage immediately rather than waiting for the claimant's grant to come back.
  // For that round trip the store still names us as sharer, so without this the last frozen
  // frame of a share we no longer own sits on screen under a "You are sharing" label.
  remoteVideoTracks.delete(store.state.self.id);
  view.clearRemoteVideo();
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
      if (!joinedOnThisSocket || tornDown) {
        // The socket is mid-reconnect (or the room is over): a claim now is a WRONG_STATE
        // error, and the capture would sit open with nothing to attach it to.
        releaseCapture(stream);
        return;
      }
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
  quality.setLocalVideoTrack(video);

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
  quality.setLocalVideoTrack(null);
  await mesh.setLocalTrack('video', null);
  await mesh.setLocalTrack('shareAudio', null);
  store.setSelf({ sharing: false, displayAudioActive: false });

  // The room is already gone on this path; a release would only produce an error toast
  // layered over the ended screen.
  if (reason !== 'room-ended' && reason !== 'teardown' && joinedOnThisSocket && signaling?.isOpen) {
    signaling.send(C2S.RELEASE_SHARE, { epoch });
  }

  // The stage is showing our own preview, and the track behind it has just been stopped. The
  // server's share-state confirming the release is a round trip away, so clear now rather
  // than leaving a frozen final frame up in the meantime.
  view.clearRemoteVideo();

  if (reason === 'native') toasts.info(UI.shareStoppedByBrowser);
  view.renderAll();
}

// -----------------------------------------------------------------------------
// Intents
// -----------------------------------------------------------------------------

bus.on(EVENTS.INTENT_TOGGLE_MIC, () => void toggleMic());

/**
 * Mute and unmute, without ever claiming to be live when nothing is being sent.
 *
 * The optimistic update is right for muting -- a button that waits for a round trip feels
 * broken -- and wrong for unmuting when there is no track behind it. `setMicMuted(false)` is
 * `if (track) track.enabled = true`, so with no track it does nothing at all while the button
 * flips to "Mute" and the roster shows you unmuted to everyone else. That is the app telling
 * both ends a falsehood, and it is unfalsifiable from either screen.
 *
 * Unmuting is also the natural moment to retry acquisition: it is when the user has actually
 * asked to speak, and it recovers the cases where permission was granted, a headset was plugged
 * in, or another application released the device after this one joined. `media.micTrack` is
 * null for an ended track, so a microphone that died mid-call is re-acquired here too.
 */
async function toggleMic() {
  if (!media) return;

  const wantLive = store.state.self.micMuted;

  if (!wantLive) {
    announceMic(media.setMicMuted(true));
    return;
  }

  if (!media.micTrack) {
    const acquired = await startLocalMedia({ announce: false });
    // startLocalMedia has already explained the failure and left us muted. Saying nothing more
    // is deliberate: two messages for one cause reads like two problems.
    if (!acquired) {
      announceMic(true);
      return;
    }
  }

  announceMic(media.setMicMuted(false));
}

/**
 * The in-room level meter.
 *
 * Rebuilt whenever the live track changes -- a reconnect or a retried acquisition produces a
 * different track object, and a meter left pointing at the old one reads a flat zero forever,
 * which is precisely the wrong answer to "is my microphone working".
 */
let micMeter = null;
let meteredTrack = null;
let meterState = null;
let meterLevel = 0;
let meterStartedAt = 0;
let meterFirstSoundLogged = false;
let meterNoSoundWarnedAt = 0;

function syncMicMeter() {
  const track = media?.micTrack ?? null;
  if (track === meteredTrack) return;

  micMeter?.stop();
  micMeter = null;
  meteredTrack = track;
  meterState = null;
  meterLevel = 0;
  meterFirstSoundLogged = false;
  meterNoSoundWarnedAt = 0;
  meterStartedAt = Date.now();
  // No track after a failure is a dead bar (red), not an idle one.
  view.setStageMicLevel(0, { dead: !track && store.state.self.micAvailable === false });
  store.setAudio({ meter: null });

  if (!track) return;
  micMeter = createLevelMeter(
    track,
    (level) => {
      meterLevel = level;
      view.setStageMicLevel(level, { dead: Boolean(meterState?.dead) });
      if (!meterFirstSoundLogged && level > SPEAKING_THRESHOLD) {
        meterFirstSoundLogged = true;
        logger.info('audio: meter first sound', { msSinceAcquire: Date.now() - meterStartedAt });
      }
    },
    {
      onState: (state) => {
        meterState = state;
        store.setAudio({ meter: state });
        logger.info('audio: meter state', {
          health: state.health,
          contextState: state.contextState,
          trackMuted: state.trackMuted,
          reason: state.reason,
        });
        if (state.dead) view.setStageMicLevel(0, { dead: true });
      },
    },
  );
  meterState = micMeter.state();
  store.setAudio({ meter: meterState });
}

function announceMic(muted) {
  store.setSelf({ micMuted: muted, micAvailable: Boolean(media?.micTrack) });
  sendMuteState(muted);
  syncMicMeter();
}

// -----------------------------------------------------------------------------
// Audio diagnostics: devices, processing, tests
// -----------------------------------------------------------------------------

bus.on(EVENTS.INTENT_SET_MIC_DEVICE, ({ deviceId, lobby }) => {
  chosenMicDeviceId = deviceId || null;
  logger.info('audio: device chosen', { deviceId: chosenMicDeviceId, lobby: Boolean(lobby) });
  if (!hasJoined) {
    // Restart the lobby check on the new device; the handoff on Join carries it into the room.
    stopLobbyMicCheck();
    startLobbyMicCheck();
    return;
  }
  void switchMic({ deviceId: chosenMicDeviceId });
});

bus.on(EVENTS.INTENT_SET_MIC_PROCESSING, ({ patch }) => {
  logger.info('audio: processing change requested', patch);
  void switchMic({ processing: patch });
});

bus.on(EVENTS.INTENT_TOGGLE_MIC_MENU, () => {
  const open = !store.state.ui.micMenuOpen;
  store.setUI({ micMenuOpen: open, qualityMenuOpen: false });
  if (open) void media?.refreshDevices('menu');
});

// -----------------------------------------------------------------------------
// Playback: the speaker, and how loud each person is
// -----------------------------------------------------------------------------

/**
 * Both of these are LOCAL. Nothing here reaches the wire, no peer is told they were turned
 * down, and the protocol does not change -- which is why neither needed a message.
 *
 * They are remembered for the tab in `sessionStorage`, alongside the host token and under the
 * same rules: per-tab, gone when the tab closes, never `localStorage`. Choosing your headphones
 * again after every reload is the kind of small friction that makes people stop using a
 * feature, and it is not worth a durable record on someone's disk to fix.
 */
const AUDIO_PREFS_KEY = 'streamer:audio';

function readAudioPrefs() {
  try {
    const raw = sessionStorage.getItem(AUDIO_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Blocked storage, or something else wrote nonsense under this key. Defaults are fine.
    return {};
  }
}

function writeAudioPrefs(patch) {
  try {
    const next = { ...readAudioPrefs(), ...patch };
    sessionStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the choice still applies for this session, it just will not survive a reload.
  }
}

/**
 * Volumes are remembered by NAME, not by peer id.
 *
 * A peer id is per-connection: it changes on their reconnect and on ours. Keyed by id, "turn
 * Ammar down" would silently lapse the moment his socket blinked -- which is precisely when
 * somebody is most likely to be fiddling with volumes.
 */
function rememberVolume(peerId, gain) {
  const name = store.peer(peerId)?.name;
  if (!name) return;
  const byName = { ...(readAudioPrefs().volumes ?? {}) };
  if (gain === 1) delete byName[name];
  else byName[name] = gain;
  writeAudioPrefs({ volumes: byName });
}

/** Re-apply a remembered volume to someone who has just (re)joined. */
function restoreVolumeFor(peerId) {
  const name = store.peer(peerId)?.name;
  const gain = name ? readAudioPrefs().volumes?.[name] : undefined;
  if (!Number.isFinite(gain) || gain === 1) return;
  applyPeerVolume(peerId, gain);
}

function applyPeerVolume(peerId, gain) {
  const routed = view.setPeerVolume(peerId, gain);
  store.setAudio({ volumes: { ...store.state.audio.volumes, [peerId]: gain } });
  logger.info('audio: peer volume', { peerId, gain, via: routed ? 'webaudio' : 'element' });
}

bus.on(EVENTS.INTENT_SET_PEER_VOLUME, ({ peerId, gain }) => {
  applyPeerVolume(peerId, gain);
  rememberVolume(peerId, gain);
});

bus.on(EVENTS.INTENT_SET_SPEAKER_DEVICE, ({ deviceId }) => {
  view.setOutputDevice(deviceId);
  store.setAudio({ speakerDeviceId: deviceId || null });
  writeAudioPrefs({ speakerDeviceId: deviceId || null });
});

/** Apply what this tab remembers. Called once the room is up and devices are known. */
function restoreAudioPrefs() {
  const prefs = readAudioPrefs();
  store.setAudio({ speakerSupported: view.speakerSelectionSupported() });
  if (prefs.speakerDeviceId && view.speakerSelectionSupported()) {
    view.setOutputDevice(prefs.speakerDeviceId);
    store.setAudio({ speakerDeviceId: prefs.speakerDeviceId });
  }
  for (const peer of store.peerList()) restoreVolumeFor(peer.id);
}

/**
 * Switch device or processing flags without renegotiating.
 *
 * Order matters and is the whole point: acquire the new track, put it on every sender with
 * `replaceTrack`, re-apply encoder parameters (negotiation-free swaps still reset them --
 * webrtc-reviewer rule 12), and only then stop the old track.
 */
let micSwitching = false;
let pendingSwitch = null;

/** Switches are coalesced: a second request while one is in flight is merged and run after. */
async function switchMic(opts = {}) {
  if (!media || tornDown) return false;
  if (micSwitching) {
    pendingSwitch = {
      ...(pendingSwitch ?? {}),
      ...opts,
      processing: { ...(pendingSwitch?.processing ?? {}), ...(opts.processing ?? {}) },
    };
    return false;
  }
  micSwitching = true;
  let ok = false;
  try {
    ok = await switchMicNow(opts);
  } finally {
    // Serialized by the flag itself: nothing else assigns it while a switch is in flight.
    // eslint-disable-next-line require-atomic-updates
    micSwitching = false;
  }
  if (pendingSwitch) {
    const next = pendingSwitch;
    pendingSwitch = null;
    if (Object.keys(next.processing).length === 0) delete next.processing;
    void switchMic(next);
  }
  return ok;
}

async function switchMicNow(opts) {
  try {
    if (opts.processing) {
      // The meter holds a CLONE of the track, and a clone keeps the device's source open. A
      // processing change is only honoured by Chromium once every consumer of the old source
      // is gone, so the meter goes first; syncMicMeter() rebuilds it on the new track.
      micMeter?.stop();
      micMeter = null;
      meteredTrack = null;
      meterState = null;
      meterLevel = 0;
      store.setAudio({ meter: null });
    }
    const { track, finish } = await media.restartMic(opts);
    if (tornDown) {
      finish();
      return false;
    }
    if (!track) throw new AppError(ERRORS.MIC_NOT_FOUND);
    await mesh.setLocalTrack('mic', track);
    await quality.apply();
    finish();
    media.setMicMuted(store.state.self.micMuted);
    const info = media.micInfo();
    store.setSelf({
      micAvailable: true,
      micError: null,
      micEnded: false,
      micEndedLabel: null,
      micSourceMuted: Boolean(track.muted),
      micDevice: info,
    });
    store.setAudio({ processing: info?.settings ?? null });
    syncMicMeter();
    announceMic(store.state.self.micMuted);
    logger.info('audio: mic switched', info);
    toasts.ok(bi(resolve(BANNER.micSwitched, { label: info?.label ?? '' })));
    return true;
  } catch (err) {
    logger.warn('audio: mic switch failed', { code: err?.code, message: err?.message });
    toasts.error(bi(BANNER.micSwitchFailed));
    if (tornDown) return false;
    if (!media.micTrack) {
      // A processing change releases the device first; if the re-open failed there is no
      // microphone now, and the room must be told rather than left looking live.
      store.setSelf({ micMuted: true, micAvailable: false, micError: ERRORS.MIC_FAILED, micSourceMuted: false, micDevice: null });
      sendMuteState(true);
      await mesh.setLocalTrack('mic', null);
      view.setStageMicLevel(0, { dead: true });
    }
    // Either way the meter must describe the track that is actually there (or not).
    syncMicMeter();
    return false;
  }
}

bus.on(EVENTS.INTENT_MIC_SELFTEST, () => void runSelfTest());

/** "Record three seconds and play it back" -- the test that needs nobody on the far end. */
/** The previous run's blob URL, released before the next run and on teardown. */
function revokeSelfTestUrl() {
  const url = store.state.audio.selfTest?.blobUrl;
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Already revoked.
  }
}

async function runSelfTest() {
  if (!media || tornDown) return null;
  const busy = store.state.audio.selfTest?.state;
  if (busy === 'recording' || busy === 'playing') return null;
  if (!media.micTrack) {
    const ok = await startLocalMedia({ announce: false });
    if (!ok) return null;
  }
  revokeSelfTestUrl();
  store.setAudio({ selfTest: { state: 'recording', peak: 0 } });
  logger.info('audio: self-test start', { label: media.micInfo()?.label ?? null });
  const result = await runMicSelfTest(media.micTrack, {
    onPhase: (phase) => {
      store.setAudio({ selfTest: { ...store.state.audio.selfTest, state: phase } });
      logger.info('audio: self-test phase', { phase });
    },
  });
  const pair = result.error
    ? resolve(SELFTEST.failed, { error: result.error })
    : result.playbackError
      ? resolve(SELFTEST.playbackFailed, { error: result.playbackError })
      : result.peak < SELFTEST_SILENT_PEAK
        ? SELFTEST.silent
        : resolve(SELFTEST.done, { peak: result.peak });
  store.setAudio({
    selfTest: {
      state: result.ok ? 'done' : 'failed',
      peak: result.peak,
      bytes: result.bytes,
      error: result.error,
      playbackError: result.playbackError,
      blobUrl: result.blobUrl,
      verdict: pair,
    },
  });
  logger.info('audio: self-test result', {
    ok: result.ok,
    peak: result.peak,
    bytes: result.bytes,
    error: result.error,
    playbackError: result.playbackError,
  });
  (result.ok && result.peak >= SELFTEST_SILENT_PEAK ? toasts.ok : toasts.warn)(bi(pair), { ms: 9000 });
  return result;
}

bus.on(EVENTS.INTENT_TOGGLE_INCOMING_AUDIO_TEST, () => {
  const on = !store.state.audio.incomingMutedForTest;
  store.setAudio({ incomingMutedForTest: on });
  view.setIncomingMuted(on);
  logger.info('audio: incoming test-mute', { on });
  // `inline` like every other banner: the strip is one line tall, and a two-line bilingual
  // block inside it is simply half-hidden.
  setBanner('incoming', on ? { kind: 'warn', message: biNode(BANNER.incomingMuted, { inline: true }) } : null);
});

bus.on(EVENTS.INTENT_RESUME_AUDIO, () => {
  view.resumeAllAudio();
  setBanner('playback', null);
});

/**
 * A remote <audio> element refused to play. Almost always autoplay policy in a browser that
 * has not seen a gesture; the fix is a click, so the banner is one and the next gesture
 * anywhere retries as well.
 */
let gestureRetryArmed = false;
bus.on(EVENTS.AUDIO_PLAYBACK_BLOCKED, ({ peerId, name }) => {
  const peer = store.peer(peerId);
  setBanner('playback', {
    kind: 'danger',
    message: biNode(resolve(BANNER.playbackBlocked, { name: peer?.name ?? peerId }), { inline: true }),
    action: { label: bi(BANNER.enableAudio), onClick: () => bus.emit(EVENTS.INTENT_RESUME_AUDIO) },
  });
  logger.warn('audio: playback blocked', { peerId, name });
  if (!gestureRetryArmed) {
    gestureRetryArmed = true;
    const retry = () => {
      gestureRetryArmed = false;
      document.removeEventListener('pointerup', retry, true);
      document.removeEventListener('keydown', retry, true);
      bus.emit(EVENTS.INTENT_RESUME_AUDIO);
    };
    // pointerup, not pointerdown: a touch pointerdown carries no activation for play().
    document.addEventListener('pointerup', retry, true);
    document.addEventListener('keydown', retry, true);
  }
});

bus.on(EVENTS.INTENT_RELEASE_MIC_TEST, () => void releaseMicTest());

const sleep = (ms) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * Release the capture entirely for three seconds, then re-open it.
 *
 * Separates the two kinds of self-hearing: Windows "Listen to this device" plays the mic to
 * the speakers whether or not anything is capturing, while a headset's sidetone often engages
 * only while an app holds the microphone open. App mute cannot tell them apart, because it
 * keeps the capture open.
 */
async function releaseMicTest() {
  if (!media?.micTrack) return;
  const wasMuted = store.state.self.micMuted;
  logger.info('audio: release-mic test start', { wasMuted });
  micMeter?.stop();
  micMeter = null;
  meteredTrack = null;
  media.stopMic();
  await mesh.setLocalTrack('mic', null);
  store.setSelf({ micDevice: null });
  view.setStageMicLevel(0, { dead: true });
  toasts.info(bi(BANNER.micReleased), { ms: 3500 });
  await sleep(3000);
  if (tornDown) {
    logger.info('audio: release-mic test abandoned, session over');
    return;
  }
  const ok = await startLocalMedia({ announce: false });
  if (ok) {
    media.setMicMuted(wasMuted);
    announceMic(wasMuted);
    toasts.info(bi(BANNER.micReacquired));
  } else {
    // Re-acquisition failed: the store is muted/unavailable, but peers still hold whatever we
    // last announced. Mirror toggleMic's failure path.
    announceMic(true);
  }
  logger.info('audio: release-mic test end', { reacquired: ok });
}

// -----------------------------------------------------------------------------
// Audio diagnostics: banners, verdict, timeline
// -----------------------------------------------------------------------------

/**
 * One banner element, several things that want it. Highest priority wins; a lower one is
 * remembered and shown again when the higher clears.
 */
const BANNER_PRIORITY = ['signaling', 'incoming', 'playback', 'health'];
const banners = new Map();

/**
 * What the user has closed by hand, keyed `owner:dedupe`.
 *
 * The dismissal has to be remembered HERE rather than in the view, because the health loop
 * calls `setBanner` again one second later with the same content: a close button whose effect
 * lasts a second is worse than no close button. The key includes the dedupe token so a
 * dismissal covers this condition only -- a different problem still gets to interrupt.
 *
 * Only specs that opt in with `dedupe` are dismissible. A dropped signaling connection is not:
 * it is the reason nothing else on the page works, and a user who hides it is left with a room
 * that has silently stopped being a room.
 */
const dismissedBanners = new Set();

const bannerKey = (owner, spec) => (spec?.dedupe ? `${owner}:${spec.dedupe}` : null);

function setBanner(owner, spec) {
  if (spec) banners.set(owner, spec);
  else banners.delete(owner);

  const visible = BANNER_PRIORITY.filter((name) => {
    if (!banners.has(name)) return false;
    const key = bannerKey(name, banners.get(name));
    return key === null || !dismissedBanners.has(key);
  });
  if (visible.length === 0) {
    view.hideBanner();
    return;
  }

  const name = visible[0];
  const current = banners.get(name);
  const key = bannerKey(name, current);
  view.showBanner(
    current.kind,
    current.message,
    current.action,
    key === null
      ? null
      : () => {
          dismissedBanners.add(key);
          logger.debug('ui: banner dismissed', { key });
          setBanner(name, current);
        },
  );
}

const healthTracker = createHealthTracker();
let healthTimer = null;

function startHealthLoop() {
  clearInterval(healthTimer);
  healthTimer = setInterval(evaluateHealth, 1000);
}

function healthSnapshot() {
  const { self } = store.state;
  return {
    self: {
      micMuted: self.micMuted,
      micAvailable: self.micAvailable,
      micError: self.micError,
      micEnded: self.micEnded,
      micSourceMuted: self.micSourceMuted,
      micLabel: self.micDevice?.label ?? self.micEndedLabel ?? '',
      lobbyPeak: lobbyMicResult?.peak ?? null,
    },
    meter: meterState ? { ...meterState, level: meterLevel } : null,
    peers: store.peerList().map((peer) => ({
      id: peer.id,
      name: peer.name,
      pcState: peer.pcState,
      hasMicSender: peer.stats ? peer.stats.hasMicSender : undefined,
      micRms: peer.stats?.micRms ?? null,
      hearsMe: peer.hearsMe,
    })),
  };
}

/**
 * Verdicts that say nothing to interrupt for.
 *
 * `OK` and `HEARD` are good news. `CAPTURE_SILENT` is here because it was wrong too often to
 * keep in the user's face: it rests on the level meter, the meter reads a CLONE of the
 * microphone rather than the track that is actually sent, and a clone that fails on Windows
 * looks exactly like a dead microphone from here. It still appears in the stats panel and in
 * the Audio check -- the two places a person goes when they already suspect something -- but
 * it no longer claims the stage on its own.
 */
const SILENT_VERDICTS = new Set([HEALTH.OK, HEALTH.HEARD, HEALTH.CAPTURE_SILENT]);

/**
 * The verdict, re-derived once a second and shown only when it changes -- where "changes"
 * includes the device or peer it names: the same code raised again for a different device
 * (the built-in array was muted in Windows, the person picked a headset that is muted too)
 * must re-render, or the hint keeps telling them to go and fix a device the room no longer
 * uses. Only the identity params are compared; HEARD's `level` moves every tick and must not
 * repaint the hint once a second.
 */
function evaluateHealth() {
  if (!hasJoined) return;
  const verdict = deriveAudioHealth(healthSnapshot(), healthTracker, Date.now());
  const previous = store.state.audio.health;
  const sameParams =
    previous?.params?.label === verdict.params?.label && previous?.params?.name === verdict.params?.name;
  if (previous && previous.code === verdict.code && !verdict.changed && sameParams) return;
  store.setAudio({ health: verdict });
  if (verdict.changed || !sameParams) {
    logger.info('audio: verdict', { code: verdict.code, params: verdict.params });
  }

  const { self } = store.state;
  const params = { ...verdict.params, errorLine: self.micError ? errorLine(self.micError) : '' };
  const hint = resolve(AUDIO_HINT[verdict.code], params);
  view.setMicHint(
    SILENT_VERDICTS.has(verdict.code) ? null : biNode(hint, { inline: true }),
    verdict.severity ?? null,
  );

  if (SILENT_VERDICTS.has(verdict.code)) {
    setBanner('health', null);
    return;
  }
  // The banner carries the SHORT copy -- one line, the same sentence the hint pill shows. The
  // long explanation is behind the Audio check button rather than printed over the stage.
  setBanner('health', {
    kind: verdict.severity === 'ok' ? 'info' : verdict.severity,
    message: biNode(hint, { inline: true }),
    action: { label: bi(AUDIO_CHECK.title), onClick: () => bus.emit(EVENTS.INTENT_AUDIO_CHECK) },
    dedupe: `${verdict.code}:${verdict.params?.label ?? verdict.params?.name ?? ''}`,
  });
}

/** A rolling record of the audio numbers, so two dumps taken on two machines can be aligned. */
const TIMELINE_MAX = 120;
const audioTimeline = [];

function recordTimeline(sample) {
  const peer = store.peer(sample.peerId);
  const sink = view.audioSinkState(sample.peerId);
  audioTimeline.push({
    t: Date.now(),
    p: Math.round(performance.now()),
    self: store.state.self.id,
    peer: sample.peerId,
    muted: store.state.self.micMuted,
    level: Math.round(meterLevel * 1000) / 1000,
    micRms: sample.micRms,
    micSpeech: sample.micSpeech,
    micKbps: Math.round((sample.micSendBps ?? 0) / 1000),
    hasMicSender: sample.hasMicSender,
    inMic: sample.audioIn?.mic?.rms ?? sample.audioIn?.mic?.level ?? null,
    inShare: sample.audioIn?.shareAudio?.rms ?? sample.audioIn?.shareAudio?.level ?? null,
    hears: peer?.hearsMe?.level ?? null,
    theyPlay: peer?.hearsMe?.playing ?? null,
    sinkPlaying: sink ? sink.paused === false && !sink.playError : null,
    pc: peer?.pcState ?? null,
  });
  if (audioTimeline.length > TIMELINE_MAX) audioTimeline.shift();

  // The one line a person can read straight off the log: our mic went quiet while unmuted.
  if (!store.state.self.micMuted && meteredTrack && meterLevel < 0.01) {
    const now = Date.now();
    if (now - meterStartedAt > 10_000 && now - meterNoSoundWarnedAt > 30_000) {
      meterNoSoundWarnedAt = now;
      logger.warn('audio: no sound for 10 s while unmuted', {
        label: store.state.self.micDevice?.label ?? null,
        meter: meterState?.health ?? null,
        micRms: sample.micRms,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Audio diagnostics: peer reports over the data channel
// -----------------------------------------------------------------------------

const dumpAssemblers = new Map();
/** peerId -> { at, text } of the last diagnostics dump that peer sent us. */
const remoteDumps = new Map();
/** peerId -> timer that reports a request nobody answered. */
const pendingDumpRequests = new Map();
const DUMP_REQUEST_TIMEOUT_MS = 15_000;
/** peerId -> whether they heard us in their last report, to log transitions only. */
const heardBy = new Map();

function sendDiagReport(sample) {
  if (!mesh) return;
  const peerId = sample.peerId;
  const text = buildReport({
    t: Date.now(),
    self: {
      micMuted: store.state.self.micMuted,
      micState: !media?.micTrack ? 'none' : store.state.self.micSourceMuted ? 'source-muted' : 'live',
      micRms: sample.micRms,
      micLevel: meterLevel,
      micPacketsPerSec: sample.micPacketsPerSec,
      meter: { contextState: meterState?.contextState ?? null, dead: Boolean(meterState?.dead) },
    },
    hearing: {
      mic: withReceiverMuted(sample, 'mic'),
      shareAudio: withReceiverMuted(sample, 'shareAudio'),
    },
    sink: view.audioSinkState(peerId),
    incomingMutedForTest: store.state.audio.incomingMutedForTest,
  });
  mesh.sendDiagTo(peerId, text);
}

/** The inbound entry for a role plus whether the receiver track is muted (source not delivering). */
function withReceiverMuted(sample, role) {
  const entry = sample.audioIn?.[role] ?? null;
  if (!entry) return null;
  const transceiver = (sample.transceivers ?? []).find((t) => t.role === role);
  return { ...entry, trackMuted: transceiver?.receiverTrackMuted ?? null };
}

function handleDiagMessage({ peerId, kind, data }) {
  const peer = store.peer(peerId);
  if (kind === 'diag') {
    const report = parseReport(data);
    if (!report) return;
    store.setPeerReport(peerId, report, Date.now());
    const hears = Number.isFinite(peer?.hearsMe?.level) && peer.hearsMe.level >= 0.01;
    const before = heardBy.get(peerId);
    if (before !== hears && !store.state.self.micMuted) {
      heardBy.set(peerId, hears);
      logger.info(`audio: ${peer?.name ?? peerId} ${hears ? 'started' : 'stopped'} hearing us`, {
        level: peer?.hearsMe?.level ?? null,
        playing: peer?.hearsMe?.playing ?? null,
      });
    }
    return;
  }

  if (kind === 'dump') {
    const frame = parseControl(data);
    if (!frame) return;
    if (frame.kind === DIAG_KIND.DUMP_REQUEST) {
      logger.info('audio: diagnostics requested by peer', { peerId });
      // The compact build: no indentation, the newest log lines only, no nested peer dumps.
      let frames = chunkDump(buildDiagnostics({ includeRemote: false, compact: true }), frame.id);
      if (frames.length === 0) {
        logger.warn('audio: diagnostics too large to send, sending a stub', { peerId });
        frames = chunkDump(JSON.stringify({ format: 'streamer-diagnostics/1', error: 'too-large' }), frame.id);
      }
      mesh.sendDumpTo(peerId, frames);
      return;
    }
    let assembler = dumpAssemblers.get(peerId);
    if (!assembler) {
      assembler = createDumpAssembler();
      dumpAssemblers.set(peerId, assembler);
    }
    const complete = assembler.accept(frame);
    if (!complete) return;
    clearTimeout(pendingDumpRequests.get(peerId));
    pendingDumpRequests.delete(peerId);
    remoteDumps.set(peerId, { at: Date.now(), text: complete.text });
    logger.info('audio: diagnostics received from peer', { peerId, bytes: complete.text.length });
    toasts.ok(bi(resolve(BANNER.peerDumpReceived, { name: peer?.name ?? peerId })));
  }
}

bus.on(EVENTS.INTENT_REQUEST_PEER_DIAGNOSTICS, ({ peerId }) => {
  if (!mesh) return;
  const peer = store.peer(peerId);
  const id = `d${Date.now().toString(36)}`;
  const sent = mesh.sendDumpTo(peerId, [buildDumpRequest(id)]);
  logger.info('audio: diagnostics request sent', { peerId, sent });
  if (!sent) {
    toasts.warn(bi(BANNER.peerDumpFailed));
    return;
  }
  toasts.info(bi(resolve(BANNER.peerDumpRequested, { name: peer?.name ?? peerId })));
  clearTimeout(pendingDumpRequests.get(peerId));
  pendingDumpRequests.set(
    peerId,
    setTimeout(() => {
      pendingDumpRequests.delete(peerId);
      logger.warn('audio: diagnostics request unanswered', { peerId });
      toasts.warn(bi(BANNER.peerDumpFailed));
    }, DUMP_REQUEST_TIMEOUT_MS),
  );
});

// -----------------------------------------------------------------------------
// Audio diagnostics: Copy diagnostics and the guided check
// -----------------------------------------------------------------------------

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Everything, in one JSON blob. Never SDP or candidates (logger redacts them).
 *
 * `compact` is the copy sent to a peer over the data channel, which has a 64 KB cap: no
 * indentation, the newest log lines only, a shorter timeline, and no nested peer dumps.
 */
function buildDiagnostics({ includeRemote = true, compact = false } = {}) {
  const { self, room, audio } = store.state;
  const snapshot = mesh?.snapshot() ?? [];
  const peers = store.peerList().map((peer) => ({
    id: peer.id,
    name: peer.name,
    joinOrder: peer.joinOrder,
    // The server-decided negotiation roles, so a reader never has to recompute them.
    youInitiate: peer.youInitiate,
    polite: peer.polite,
    pcState: peer.pcState,
    micMuted: peer.micMuted,
    stats: peer.stats,
    hearsMe: peer.hearsMe,
    report: compact ? null : peer.report,
    transceivers: mesh?.transceivers(peer.id) ?? null,
    diag: snapshot.find((p) => p.peerId === peer.id)?.diag ?? null,
    remoteDump:
      includeRemote && !compact && remoteDumps.has(peer.id)
        ? { at: remoteDumps.get(peer.id).at, dump: safeParse(remoteDumps.get(peer.id).text) }
        : null,
  }));
  const options = compact ? { compact: true, logLimit: 80 } : {};
  return logger.dump({
    format: 'streamer-diagnostics/1',
    env: environmentSummary(),
    room: { id: room.id, joinOrder: self.joinOrder, isHost: self.isHost, participants: store.participantCount() },
    self: {
      id: self.id,
      micMuted: self.micMuted,
      micAvailable: self.micAvailable,
      micError: self.micError,
      micSourceMuted: self.micSourceMuted,
      micDevice: self.micDevice,
    },
    mic: media?.micInfo() ?? null,
    effectiveAudio: media?.effectiveAudio() ?? null,
    lobby: lobbyMicResult,
    meter: micMeter?.state?.() ?? null,
    audio: { ...audio, sinks: view.allSinkStates() },
    peers,
    audioTimeline: compact ? audioTimeline.slice(-40) : audioTimeline,
  }, options);
}

bus.on(EVENTS.INTENT_COPY_DIAGNOSTICS, () => void copyDiagnostics());

async function copyDiagnostics() {
  const text = buildDiagnostics();
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }
  if (copied) toasts.ok(bi(BANNER.diagnosticsCopied));
  else toasts.warn(bi(BANNER.diagnosticsCopyFailed));
  // The text is shown regardless: in the sandboxed desktop renderer the clipboard call can
  // succeed silently or fail silently, and a person about to paste deserves to see the blob.
  await textDialog({
    title: biNode(MIC_MENU_TITLE()),
    hint: copied ? bi(BANNER.diagnosticsCopied) : bi(BANNER.diagnosticsCopyFailed),
    text,
    copyLabel: bi(AUDIO_CHECK.copy),
    closeLabel: bi(AUDIO_CHECK.close),
    onCopy: (ok) => (ok ? toasts.ok(bi(BANNER.diagnosticsCopied)) : toasts.warn(bi(BANNER.diagnosticsCopyFailed))),
  });
}

const MIC_MENU_TITLE = () => ({ ar: 'التشخيص', en: 'Diagnostics' });

bus.on(EVENTS.INTENT_AUDIO_CHECK, () => void openAudioCheck());

/** A live bar for the dialogs, fed from the meter at 100 ms. */
function liveMeter(container) {
  const fill = h('div', { class: 'meter__fill', dataset: { testid: 'audio-check-meter' } });
  container.append(h('div', { class: 'meter diag__meter', role: 'img', 'aria-label': 'Microphone level' }, [fill]));
  const timer = setInterval(() => {
    const shown = Math.min(100, Math.round(Math.sqrt(Math.max(0, meterLevel)) * 130));
    fill.style.width = `${meterState?.dead ? 0 : shown}%`;
    fill.classList.toggle('meter__fill--muted', store.state.self.micMuted);
    fill.classList.toggle('meter__fill--dead', Boolean(meterState?.dead));
  }, 100);
  return () => clearInterval(timer);
}

function deviceSelect() {
  const devices = store.state.audio.devices;
  const current = store.state.self.micDevice?.settings?.deviceId ?? chosenMicDeviceId ?? RESERVED_DEVICE_IDS.DEFAULT;
  const select = h('select', { class: 'input input--sm', dataset: { testid: 'audio-check-device' } });
  for (const entry of devices?.inputs ?? []) {
    let label = friendlyDeviceLabel(entry) || entry.deviceId.slice(0, 8);
    if (entry.deviceId === RESERVED_DEVICE_IDS.DEFAULT) label = `${UI.micSystemDefault} — ${label}`;
    if (entry.deviceId === RESERVED_DEVICE_IDS.COMMUNICATIONS) label = `${UI.micCommunications} — ${label}`;
    select.append(h('option', { value: entry.deviceId, selected: entry.deviceId === current }, label));
  }
  select.addEventListener('change', () => bus.emit(EVENTS.INTENT_SET_MIC_DEVICE, { deviceId: select.value }));
  return select;
}

function sendingStatus() {
  const peers = store.peerList();
  const sample = peers.find((p) => p.stats)?.stats ?? null;
  if (!sample) return STATS_AUDIO.unknown;
  if (!sample.hasMicSender) return { ar: 'الميكروفون مش متوصّل', en: UI.statsMicNotSent };
  if (store.state.self.micMuted) return { ar: 'كاتم — بيبعت صمت', en: UI.statsMicMuted };
  if (sample.micSpeech === true) return resolve(STATS_AUDIO.speech, { level: sample.micRms ?? sample.micAudioLevel });
  if (sample.micSpeech === false) return STATS_AUDIO.silent;
  return STATS_AUDIO.unknown;
}

function hearsStatus(peer) {
  const r = peer.hearsMe;
  if (!r || Date.now() - r.at > 8000) return STATS_AUDIO.unknown;
  if (r.mutedForTest) return TILE.mutedForTest;
  if (Number.isFinite(r.level) && r.level >= 0.01) return resolve(TILE.hearsYou, { level: r.level });
  if (r.playing === false) return TILE.notPlaying;
  return store.state.self.micMuted ? { ar: 'كاتم', en: 'muted' } : TILE.cannotHearYou;
}

/** The guided check: five steps that walk both people through the ladder in the docs. */
async function openAudioCheck() {
  if (!media) return;
  logger.info('audio-check: opened');
  if (!media.micTrack) await startLocalMedia({ announce: false });
  void media.refreshDevices('audio-check');

  const peers = () => store.peerList();
  const firstPeerName = () => peers()[0]?.name ?? '…';

  const steps = [
    {
      title: biNode(AUDIO_CHECK.step1Title, { inline: true }),
      render(container) {
        container.append(biNode(AUDIO_CHECK.step1Body));
        const stopMeter = liveMeter(container);
        const device = h('p', { class: 'diag__proof', dataset: { testid: 'audio-check-device-line' } });
        const status = h('p', { dataset: { testid: 'audio-check-step1-status' } });
        container.append(device, status, deviceSelect());
        const startedAt = Date.now();
        let peak = 0;
        const timer = setInterval(() => {
          peak = Math.max(peak, meterLevel);
          const label = store.state.self.micDevice?.label ?? '';
          setText(device, bi(resolve(AUDIO_CHECK.step1Device, { label })));
          if (peak > SPEAKING_THRESHOLD) replace(status, [biNode(AUDIO_CHECK.step1Moving)]);
          else if (Date.now() - startedAt > 4000) replace(status, [biNode(AUDIO_CHECK.step1Flat)]);
        }, 200);
        return () => {
          clearInterval(timer);
          stopMeter();
          logger.info('audio-check: step 1', { peak, label: store.state.self.micDevice?.label ?? null });
        };
      },
    },
    {
      title: biNode(AUDIO_CHECK.step2Title, { inline: true }),
      render(container) {
        container.append(biNode(AUDIO_CHECK.step2Body));
        const stopMeter = liveMeter(container);
        const proof = h('p', { class: 'diag__proof' });
        const answer = h('div', { dataset: { testid: 'audio-check-step2-answer' } });
        const choices = h('div', { class: 'diag__choices' }, [
          h('button', { class: 'btn btn--secondary', dataset: { testid: 'audio-check-yes' }, onclick: () => decide(true) }, bi(AUDIO_CHECK.yes)),
          h('button', { class: 'btn btn--secondary', dataset: { testid: 'audio-check-no' }, onclick: () => decide(false) }, bi(AUDIO_CHECK.no)),
          h('button', { class: 'btn btn--ghost', dataset: { testid: 'audio-check-release' }, onclick: () => bus.emit(EVENTS.INTENT_RELEASE_MIC_TEST) }, bi(AUDIO_CHECK.step2Release)),
        ]);
        container.append(proof, choices, answer, h('p', { class: 'diag__en' }, bi(AUDIO_CHECK.step2ReleaseNote)));
        const decide = (hearsSelf) => {
          logger.info('audio-check: hears self while muted', { hearsSelf, micMuted: store.state.self.micMuted });
          replace(answer, [biNode(hearsSelf ? AUDIO_CHECK.step2Yes : resolve(AUDIO_CHECK.step2No, { name: firstPeerName() }))]);
        };
        const timer = setInterval(() => {
          const enabled = media.micTrack?.enabled ?? null;
          setText(proof, bi(resolve(AUDIO_CHECK.step2Proof, { enabled: String(enabled), sinks: Object.keys(view.allSinkStates()).length })));
        }, 500);
        return () => {
          clearInterval(timer);
          stopMeter();
        };
      },
    },
    {
      title: biNode(AUDIO_CHECK.step3Title, { inline: true }),
      render(container) {
        container.append(biNode(AUDIO_CHECK.step3Body));
        const stopMeter = liveMeter(container);
        const lines = h('div', { dataset: { testid: 'audio-check-step3' } });
        container.append(lines);
        const timer = setInterval(() => {
          const rows = [h('p', {}, bi(resolve(AUDIO_CHECK.step3Sending, { status: bi(sendingStatus()) })))];
          const list = peers();
          if (list.length === 0) rows.push(h('p', { class: 'diag__en' }, bi(AUDIO_CHECK.noPeers)));
          for (const peer of list) rows.push(h('p', {}, bi(resolve(AUDIO_CHECK.step3Hears, { name: peer.name, status: bi(hearsStatus(peer)) }))));
          replace(lines, rows);
        }, 500);
        return () => {
          clearInterval(timer);
          stopMeter();
          logger.info('audio-check: step 3', { sending: sendingStatus().en, peers: peers().map((p) => ({ name: p.name, hears: hearsStatus(p).en })) });
        };
      },
    },
    {
      title: biNode(AUDIO_CHECK.step4Title, { inline: true }),
      render(container) {
        container.append(biNode(resolve(AUDIO_CHECK.step4Body, { name: firstPeerName() })));
        const lines = h('div', { dataset: { testid: 'audio-check-step4' } });
        container.append(lines);
        const timer = setInterval(() => {
          const list = peers();
          const rows = [];
          if (list.length === 0) rows.push(h('p', { class: 'diag__en' }, bi(AUDIO_CHECK.noPeers)));
          for (const peer of list) {
            const inMic = peer.stats?.audioIn?.mic ?? null;
            const level = inMic?.rms ?? inMic?.level ?? null;
            const hearing = inMic?.speech === true ? resolve(STATS_AUDIO.hearing, { level }) : inMic?.speech === false ? STATS_AUDIO.quiet : STATS_AUDIO.unknown;
            const sink = view.audioSinkState(peer.id);
            const playback = !sink ? STATS_AUDIO.noElement : sink.playError ? resolve(STATS_AUDIO.blocked, { error: sink.playError }) : sink.muted ? TILE.mutedForTest : sink.paused ? STATS_AUDIO.paused : STATS_AUDIO.playing;
            rows.push(h('p', {}, `${peer.name}: ${bi(hearing)} · ${UI.statsPlayback}: ${bi(playback)}`));
          }
          replace(lines, rows);
        }, 500);
        return () => clearInterval(timer);
      },
    },
    {
      title: biNode(AUDIO_CHECK.summaryTitle, { inline: true }),
      render(container) {
        const health = store.state.audio.health;
        const params = { ...(health?.params ?? {}), errorLine: store.state.self.micError ? errorLine(store.state.self.micError) : '' };
        const verdict = health && health.code !== HEALTH.OK ? resolve(AUDIO_HEALTH[health.code], params) : AUDIO_CHECK.summaryNone;
        container.append(
          h('div', { dataset: { testid: 'audio-check-summary' } }, [biNode(verdict)]),
          h('div', { class: 'diag__choices' }, [
            h('button', { class: 'btn btn--primary', dataset: { testid: 'audio-check-copy' }, onclick: () => bus.emit(EVENTS.INTENT_COPY_DIAGNOSTICS) }, bi(AUDIO_CHECK.copy)),
          ]),
        );
        logger.info('audio-check: summary', { code: health?.code ?? null });
      },
    },
  ];

  await wizardDialog({
    title: biNode(AUDIO_CHECK.title, { inline: true }),
    steps,
    labels: { next: bi(AUDIO_CHECK.next), back: bi(AUDIO_CHECK.back), close: bi(AUDIO_CHECK.close) },
    testid: 'audio-check',
  });
  logger.info('audio-check: closed');
}

// -----------------------------------------------------------------------------
// Other intents
// -----------------------------------------------------------------------------

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
    returnToLobbyAfterFailedJoin();
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
  tornDown = true;
  files.clear();
  chat.clear();
  clearInterval(healthTimer);
  healthTimer = null;
  for (const timer of pendingDumpRequests.values()) clearTimeout(timer);
  pendingDumpRequests.clear();
  releaseLobbyHandoff();
  revokeSelfTestUrl();
  store.setAudio({ selfTest: { state: 'idle' } });
  stats?.stop();
  micMeter?.stop();
  micMeter = null;
  meteredTrack = null;
  void stopSharing('teardown');
  mesh?.closeAll();
  media?.stopAll();
  view.setIncomingMuted(false);
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
// Introspection hook
// -----------------------------------------------------------------------------

/**
 * Read-only accessors on `window.__app`.
 *
 * The read-only accessors are installed ALWAYS: they are how a person with the console open, or
 * a support conversation, reads the same numbers the diagnostics panel shows, and they expose
 * nothing that is not already reachable from the page's own objects. Anything that can change
 * state -- dropping the socket, running the self test -- stays behind the E2E flag the server
 * injects.
 */
function installIntrospection() {
  const base = {
    selfId: () => store.state.self.id,
    roomId: () => store.state.room.id,
    isHost: () => store.state.self.isHost,
    peers: () => mesh?.snapshot() ?? [],
    connections: () => (mesh?.snapshot() ?? []).map((p) => p.connectionState),
    share: () => ({ ...store.state.share }),
    quality: () => ({ ...store.state.quality }),
    micMuted: () => store.state.self.micMuted,
    micTrackEnabled: () => media?.micTrack?.enabled ?? null,
    micTrackId: () => media?.micTrack?.id ?? null,
    hasDisplayAudio: () => media?.hasDisplayAudio ?? false,
    /** Senders tagged with their role, so a test can tell the microphone apart from the
     *  shared system audio -- both are kind 'audio', and the distinction is the whole point
     *  of the mute behaviour. */
    senders: (peerId) => {
      const peer = mesh?.peer(peerId ?? mesh.peerIds()[0]);
      return (peer?.taggedSenders() ?? []).map(({ role, mid, kind, sender }) => ({
        role,
        mid,
        kind,
        hasTrack: Boolean(sender.track),
        trackId: sender.track?.id ?? null,
        trackEnabled: sender.track?.enabled ?? null,
      }));
    },
    encodings: async (peerId) => {
      const peer = mesh?.peer(peerId ?? mesh.peerIds()[0]);
      const sender = peer?.sender('video');
      return sender ? sender.getParameters().encodings : null;
    },
    stats: async (peerId) => {
      const peer = mesh?.peer(peerId);
      if (!peer) return null;
      const report = await peer.getStats();
      return [...report.values()];
    },
    signalingState: (peerId) => mesh?.peer(peerId ?? mesh.peerIds()[0])?.pc?.signalingState ?? null,
    signalingStatus: () => store.state.signaling.status,
    audio: () => ({ ...store.state.audio, sinks: view.allSinkStates() }),
    micSettings: () => media?.micInfo() ?? null,
    micLevel: () => meterLevel,
    meterState: () => micMeter?.state?.() ?? null,
    devices: () => store.state.audio.devices,
    audioSinks: () => view.allSinkStates(),
    speakerDevice: () => store.state.audio.speakerDeviceId,
    peerVolumes: () => ({ ...store.state.audio.volumes }),
    /** The Web Audio graph's own view: which peers it is actually carrying, and at what gain. */
    mixer: () => view.mixerState(),
    transceivers: (peerId) => mesh?.transceivers(peerId ?? mesh.peerIds()[0]) ?? null,
    lobby: () => lobbyMicResult,
    health: () => store.state.audio.health,
    peerReports: () => Object.fromEntries(store.peerList().map((p) => [p.id, { hearsMe: p.hearsMe, report: p.report }])),
    audioTimeline: () => [...audioTimeline],
    diagnostics: () => buildDiagnostics(),
    env: environmentSummary,
  };

  if (!isE2E()) {
    window.__app = base;
    return;
  }

  window.__app = {
    ...base,
    /** Drop the signaling socket with a non-terminal code, to exercise the reconnect path.
     *  A test cannot produce a genuine 1006 from inside the page, and 4004 travels the same
     *  branch: shouldReconnect() is true for both. */
    dropSocket: () => signaling?.close && signalingDrop(),
    runSelfTest: () => runSelfTest(),
  };
}

/** Close the current socket without marking the session as intentionally over. */
function signalingDrop() {
  const client = signaling;
  if (!client?.isOpen) return false;
  client.forceDrop(CLOSE.SERVER_SHUTDOWN);
  return true;
}
