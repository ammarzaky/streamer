/**
 * Every user-facing string in the app.
 *
 * Centralised for two reasons. First, tests assert against these constants rather than copied
 * literals, so the product and its tests cannot drift apart. Second, error copy is the entire
 * user experience of a failure: this app promises no silent failures, and a failure the user
 * cannot act on is only marginally better than a silent one.
 *
 * Copy rules followed throughout:
 *   - Say what happened, then what to do about it. Never only the first.
 *   - Name the thing that failed, not the layer it failed in. "Can't reach the server" beats
 *     "WebSocket closed unexpectedly".
 *   - No blame, no exclamation marks, no apologies.
 */

import { ERRORS } from '../../shared/protocol.js';

export const UI = {
  appName: 'Streamer',
  tagline: 'Private screen sharing for a small group.',

  // -- Landing --
  createRoom: 'Create a room',
  createRoomHint: 'Start a session and get a link to share.',
  joinRoom: 'Join',
  joinDivider: 'or join an existing one',
  linkPlaceholder: 'Paste a room link',
  linkInvalid: "That doesn't look like a room link.",

  // -- Lobby --
  lobbyTitle: 'Ready to join?',
  lobbyCreateTitle: 'Start a new room',
  yourName: 'Your name',
  namePlaceholder: 'How others will see you',
  nameRequired: 'Enter a name so people know who you are.',
  micLabel: 'Microphone',
  micDefault: 'Default microphone',
  joinNow: 'Join room',
  createNow: 'Create room',
  joining: 'Joining…',
  creating: 'Creating…',

  // -- Room --
  participants: 'Participants',
  you: 'You',
  host: 'Host',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  waitingForShare: 'No one is sharing a screen yet.',
  waitingForShareHint: 'Press Share screen below to start.',
  sharingLabel: (name) => `${name} is sharing`,
  youAreSharing: 'You are sharing your screen',
  live: 'LIVE',
  copyLink: 'Copy link',
  linkCopied: 'Link copied',
  copyFailed: 'Could not copy. Select the link and copy it manually.',
  sessionTime: 'Session time',

  // -- Controls --
  mute: 'Mute',
  unmute: 'Unmute',
  micOn: 'Mic on',
  micOff: 'Mic off',
  share: 'Share screen',
  stopShare: 'Stop sharing',
  stats: 'Stats',
  leave: 'Leave',
  endSession: 'End session',
  quality: 'Quality',

  // -- Dialogs --
  takeOverTitle: 'Take over sharing?',
  takeOverBody: (name) => `${name} is sharing right now. Taking over will stop their share.`,
  takeOverConfirm: 'Take over',
  cancel: 'Cancel',

  endSessionTitle: 'End the session for everyone?',
  endSessionBody: 'Everyone will be disconnected and the room link will stop working.',
  endSessionConfirm: 'End session',

  leaveTitle: 'Leave this room?',
  leaveBody: 'You can rejoin with the same link.',
  leaveConfirm: 'Leave',

  // -- Ended states --
  endedByHost: 'The host ended the session.',
  youLeft: 'You left the room.',
  backToStart: 'Back to start',

  // -- Notices --
  peerJoined: (name) => `${name} joined`,
  peerLeft: (name) => `${name} left`,
  peerDisconnected: (name) => `${name} lost connection`,
  hostChanged: (name) => `${name} is now the host`,
  youAreHost: 'You are now the host',
  shareStoppedByBrowser: 'Screen sharing stopped.',
  shareTakenOver: (name) => `${name} took over sharing.`,
  qualityLoweredCpu: (preset) => `Quality lowered to ${preset} — this device is at its limit.`,
  qualityLoweredNetwork: (preset) => `Quality lowered to ${preset} — not enough upload speed.`,
  qualityRaiseSuggestion: (preset) => `Network looks good. Try ${preset}?`,

  // -- Stats panel --
  statsTarget: 'Target',
  statsActual: 'Actual',
  statsSending: 'Sending',
  statsReceiving: 'Receiving',
  statsFrames: 'Frames',
  statsDropped: 'Dropped',
  statsResolution: 'Resolution',
  statsConnection: 'Connection',
  statsLimitedBy: 'Limited by',
  statsPacketLoss: 'Packet loss',
  statsRoundTrip: 'Round trip',

  connLocal: 'Local network (direct)',
  connDirect: 'Direct (via STUN)',
  connRelay: 'Relayed (TURN)',
  connUnknown: 'Establishing…',

  limitedNone: 'Nothing',
  limitedCpu: 'This device (CPU)',
  limitedBandwidth: 'Upload speed',
  limitedMeshBudget: 'Upload shared across peers',

  // -- Generic --
  retry: 'Retry',
  dismiss: 'Dismiss',
  copyDiagnostics: 'Copy diagnostics',
};

/**
 * Error code → { message, hint }.
 *
 * `message` states what happened; `hint` states what the user can do. A unit test asserts this
 * table's key set matches the code set exported from protocol.js in BOTH directions, so a new
 * code cannot ship without copy, and stale copy cannot linger for a code that no longer exists.
 */
export const ERROR_COPY = {
  // -- Environment --
  [ERRORS.INSECURE_CONTEXT]: {
    message: 'Screen sharing needs a secure connection.',
    hint: 'Open this page over https:// rather than http://. If you typed the address manually, add the s.',
  },
  [ERRORS.BROWSER_UNSUPPORTED]: {
    message: "This browser can't share a screen.",
    hint: 'Use Chrome, Edge, or Firefox on a desktop computer. Screen sharing is not available on phones.',
  },

  // -- Microphone --
  [ERRORS.MIC_DENIED]: {
    message: 'Microphone access was blocked.',
    hint: 'Click the camera or lock icon in the address bar, allow the microphone, then reload the page.',
  },
  [ERRORS.MIC_NOT_FOUND]: {
    message: 'No microphone found.',
    hint: 'Connect one and reload, or continue without audio — you can still see and share screens.',
  },
  [ERRORS.MIC_IN_USE]: {
    message: 'Your microphone is being used by another app.',
    hint: 'Close the other app (a call or recorder, usually) and try again.',
  },
  [ERRORS.MIC_FAILED]: {
    message: "Couldn't start the microphone.",
    hint: 'Reload the page. If it keeps happening, try a different microphone in your system settings.',
  },

  // -- Screen capture --
  [ERRORS.SHARE_CANCELLED]: {
    message: 'Screen sharing was cancelled.',
    hint: '',
  },
  [ERRORS.SHARE_UNSUPPORTED]: {
    message: "This browser can't share a screen.",
    hint: 'Use Chrome, Edge, or Firefox on a desktop computer.',
  },
  [ERRORS.SHARE_FAILED]: {
    message: "Couldn't start screen sharing.",
    hint: 'Try again. On macOS, check that your browser has Screen Recording permission in System Settings → Privacy & Security.',
  },
  [ERRORS.SHARE_REVOKED]: {
    message: 'Someone else took over sharing.',
    hint: '',
  },
  [ERRORS.SHARE_IN_PROGRESS]: {
    message: 'Someone else is sharing right now.',
    hint: 'You can take over from them, which will stop their share.',
  },

  // -- Connectivity --
  [ERRORS.SIGNALING_DOWN]: {
    message: 'Connection to the server lost.',
    hint: 'Trying to reconnect. Your call keeps running while this reconnects.',
  },
  [ERRORS.SIGNALING_DEAD]: {
    message: "Can't reach the server.",
    hint: "Check that the server is running, and that you accepted its certificate warning. If you're joining from outside the host's network, that network has to be reachable from here.",
  },
  [ERRORS.ICE_FAILED]: {
    message: "Couldn't connect directly to this person.",
    hint: 'The server is reachable, but a direct connection between your two networks is not. This is a network restriction, not a problem with the room.',
  },

  // -- Rooms --
  [ERRORS.ROOM_NOT_FOUND]: {
    message: "This room doesn't exist, or it has already ended.",
    hint: 'Ask for a new link.',
  },
  [ERRORS.ROOM_FULL]: {
    message: 'This room is full.',
    hint: 'Wait for someone to leave, or ask the host to start a new room.',
  },
  [ERRORS.ROOM_ENDED]: {
    message: 'The host ended the session.',
    hint: '',
  },
  [ERRORS.ROOM_LIMIT]: {
    message: 'The server is hosting too many rooms.',
    hint: 'Try again in a few minutes.',
  },
  [ERRORS.NOT_HOST]: {
    message: 'Only the host can do that.',
    hint: '',
  },
  [ERRORS.PEER_NOT_FOUND]: {
    message: 'That person has already left.',
    hint: '',
  },
  [ERRORS.NAME_INVALID]: {
    message: 'That name cannot be used.',
    hint: 'Use at least one ordinary character.',
  },
  [ERRORS.ACCESS_CODE_REQUIRED]: {
    message: 'This room needs an access code.',
    hint: 'Ask the host for the code.',
  },
  [ERRORS.ACCESS_CODE_INVALID]: {
    message: 'That access code is not correct.',
    hint: 'Check it with the host and try again.',
  },

  // -- Protocol and abuse --
  [ERRORS.INVALID_JSON]: {
    message: 'The server rejected a malformed message.',
    hint: 'Reload the page.',
  },
  [ERRORS.INVALID_ENVELOPE]: {
    message: 'The server rejected a malformed message.',
    hint: 'Reload the page.',
  },
  [ERRORS.INVALID_PAYLOAD]: {
    message: 'The server rejected a malformed message.',
    hint: 'Reload the page.',
  },
  [ERRORS.UNKNOWN_TYPE]: {
    message: 'The server did not understand a message from this page.',
    hint: 'Reload the page to get the current version.',
  },
  [ERRORS.UNSUPPORTED_VERSION]: {
    message: 'This page is a different version from the server.',
    hint: 'Reload the page. If that does not help, clear your cache for this site.',
  },
  [ERRORS.WRONG_STATE]: {
    message: 'That action was not possible right now.',
    hint: 'Reload the page.',
  },
  [ERRORS.PAYLOAD_TOO_LARGE]: {
    message: 'A message was too large to send.',
    hint: 'Reload the page.',
  },
  [ERRORS.RATE_LIMITED]: {
    message: 'Too many actions too quickly.',
    hint: 'Wait a moment and try again.',
  },
  [ERRORS.SERVER_BUSY]: {
    message: 'The server is at capacity.',
    hint: 'Try again in a few minutes.',
  },
  [ERRORS.SLOW_CONSUMER]: {
    message: 'This connection could not keep up and was closed.',
    hint: 'Reload the page to rejoin.',
  },
};

/** The last-resort message. Never blank -- a blank toast is a silent failure with extra steps. */
export const UNKNOWN_ERROR = {
  message: 'Something went wrong.',
  hint: 'Reload the page. If it keeps happening, copy the diagnostics and check the server console.',
};

export function errorCopy(code) {
  return ERROR_COPY[code] ?? UNKNOWN_ERROR;
}

/** One line, for toasts and banners where there is no room for a separate hint. */
export function errorLine(code) {
  const { message, hint } = errorCopy(code);
  return hint ? `${message} ${hint}` : message;
}
