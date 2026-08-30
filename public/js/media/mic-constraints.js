/**
 * One place that decides how the microphone is asked for.
 *
 * The lobby check and the room used to build their constraints separately -- `{audio: true}`
 * in one and an explicit processing set in the other -- so the lobby validated a different
 * capture chain from the one that was actually sent, and "the bar moved on the join screen
 * but nobody can hear me" was possible by construction. Both now go through here.
 *
 * Pure: no DOM, no navigator. Everything is unit-testable, and the defaults are asserted to
 * match config.default.json so the client-side fallback cannot drift from the server's.
 */

/** Must equal `media.audio` in config.default.json (a unit test asserts it). */
export const CLIENT_AUDIO_DEFAULTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
});

/** The processing flags a user can toggle at runtime. `channelCount` is not one of them. */
export const PROCESSING_KEYS = Object.freeze(['echoCancellation', 'noiseSuppression', 'autoGainControl']);

/** Chromium's two reserved input ids. On Windows they can be different physical devices:
 *  'default' is the console-role endpoint and 'communications' the one Windows marks as the
 *  Default Communication Device, which is where a headset usually is. */
export const RESERVED_DEVICE_IDS = Object.freeze({ DEFAULT: 'default', COMMUNICATIONS: 'communications' });

/**
 * Build the `audio` member of a getUserMedia constraint set.
 *
 * `deviceId` is `exact` on purpose: an `ideal` id lets the browser silently fall back to the
 * device we were trying to get away from, which is the failure the picker exists to fix.
 */
export function micConstraints(audioConfig = {}, { deviceId = null } = {}) {
  const cfg = audioConfig ?? {};
  const constraints = {
    echoCancellation: cfg.echoCancellation ?? CLIENT_AUDIO_DEFAULTS.echoCancellation,
    noiseSuppression: cfg.noiseSuppression ?? CLIENT_AUDIO_DEFAULTS.noiseSuppression,
    autoGainControl: cfg.autoGainControl ?? CLIENT_AUDIO_DEFAULTS.autoGainControl,
    channelCount: cfg.channelCount ?? CLIENT_AUDIO_DEFAULTS.channelCount,
  };
  if (typeof deviceId === 'string' && deviceId.length > 0) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

/**
 * Whether two settings objects agree on the processing flags.
 *
 * A flag the browser does not report (Firefox omits some) is treated as agreeing: re-acquiring
 * the device over a value nobody can read would cost a permission round trip for nothing.
 */
export function sameProcessing(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  return PROCESSING_KEYS.every((key) => {
    if (left[key] === undefined || right[key] === undefined) return true;
    return Boolean(left[key]) === Boolean(right[key]);
  });
}

/** The subset of `track.getSettings()` worth logging and showing. */
export function pickSettings(settings) {
  const s = settings ?? {};
  return {
    deviceId: s.deviceId ?? null,
    groupId: s.groupId ?? null,
    sampleRate: s.sampleRate ?? null,
    channelCount: s.channelCount ?? null,
    echoCancellation: s.echoCancellation ?? null,
    noiseSuppression: s.noiseSuppression ?? null,
    autoGainControl: s.autoGainControl ?? null,
    latency: s.latency ?? null,
  };
}

/**
 * Turn an enumerateDevices() result into what the picker and the log need.
 *
 * Also works out which physical group the two reserved ids resolve to, because the single
 * most useful fact on Windows is whether "default" and "communications" are the same device.
 */
export function describeDevices(devices = []) {
  const inputs = [];
  const outputs = [];
  for (const d of devices ?? []) {
    const entry = { deviceId: d.deviceId ?? '', groupId: d.groupId ?? '', label: d.label ?? '' };
    if (d.kind === 'audioinput') inputs.push(entry);
    else if (d.kind === 'audiooutput') outputs.push(entry);
  }
  const defaultEntry = inputs.find((d) => d.deviceId === RESERVED_DEVICE_IDS.DEFAULT) ?? null;
  const commsEntry = inputs.find((d) => d.deviceId === RESERVED_DEVICE_IDS.COMMUNICATIONS) ?? null;
  const defaultGroup = defaultEntry?.groupId || null;
  const communicationsGroup = commsEntry?.groupId || null;
  return {
    inputs,
    outputs,
    defaultGroup,
    communicationsGroup,
    // null when the platform does not expose a communications device at all.
    defaultMatchesCommunications:
      defaultGroup && communicationsGroup ? defaultGroup === communicationsGroup : null,
  };
}

/** Chromium prefixes reserved entries ("Default - Headset (...)"); strip that for display. */
export function friendlyDeviceLabel(entry) {
  if (!entry) return '';
  const label = entry.label || '';
  return label.replace(/^(Default|Communications)\s+-\s+/i, '');
}
