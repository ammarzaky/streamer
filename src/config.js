import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PRESET_IDS } from '../public/shared/quality-math.js';
import { LIMITS } from '../public/shared/protocol.js';
import { deepFreeze, deepMerge, stripDocumentation } from './util/deepMerge.js';

export class ConfigError extends Error { constructor(message) { super(`config: ${message}`); this.name = 'ConfigError'; } }

const overrides = {
  STREAMER_PORT: ['server.port', Number], STREAMER_HOST: ['server.host', String],
  STREAMER_HTTP_PORT: ['server.httpRedirect.port', Number],
  STREAMER_MAX_PARTICIPANTS: ['rooms.maxParticipants', Number],
  STREAMER_ACCESS_CODE: ['rooms.accessCode', String],
  STREAMER_TURN_ENABLED: ['webrtc.turn.enabled', bool],
  STREAMER_TURN_URLS: ['webrtc.turn.urls', list],
  STREAMER_TURN_USERNAME: ['webrtc.turn.username', String],
  STREAMER_TURN_CREDENTIAL: ['webrtc.turn.credential', String],
  STREAMER_LOG_LEVEL: ['logging.level', String], STREAMER_E2E: ['e2e', bool],
  STREAMER_HOST_GRACE_MS: ['rooms.hostGraceMs', Number],
  STREAMER_SHARE_REVOKE_TIMEOUT_MS: ['rooms.shareRevokeTimeoutMs', Number],
  STREAMER_EMPTY_ROOM_GRACE_MS: ['rooms.emptyRoomGraceMs', Number],
};
function bool(v) { return v === '1' || v.toLowerCase() === 'true'; }
function list(v) { return v.split(',').map((x) => x.trim()).filter(Boolean); }
function setPath(obj, dotted, value) { const parts = dotted.split('.'); const last = parts.pop(); let at = obj; for (const p of parts) at = at[p] ??= {}; at[last] = value; }

export async function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const defaults = JSON.parse(await readFile(path.join(cwd, 'config.default.json'), 'utf8'));
  let local = {};
  try { local = JSON.parse(await readFile(path.join(cwd, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = deepMerge(defaults, local);
  for (const [name, [key, convert]] of Object.entries(overrides)) if (env[name] !== undefined) setPath(config, key, convert(env[name]));
  if (config.e2e === undefined) config.e2e = false;
  const clean = stripDocumentation(config);
  validateConfig(clean);
  return deepFreeze(clean);
}

function integer(config, key, min, max) { const v = get(config, key); if (!Number.isInteger(v) || v < min || v > max) fail(key, `must be an integer between ${min} and ${max}, got ${v}`); }
function get(obj, key) { return key.split('.').reduce((v, p) => v?.[p], obj); }
function fail(key, message) { throw new ConfigError(`${key} ${message}`); }

export function validateConfig(config) {
  integer(config, 'server.port', 0, 65535); integer(config, 'server.httpRedirect.port', 0, 65535);
  if (config.server.port === config.server.httpRedirect.port) fail('server.httpRedirect.port', 'must differ from server.port');
  integer(config, 'rooms.roomIdBytes', 12, 1024);
  integer(config, 'rooms.maxParticipants', 2, 8); integer(config, 'rooms.hardMaxParticipants', 2, 8);
  if (config.rooms.maxParticipants > config.rooms.hardMaxParticipants) fail('rooms.maxParticipants', 'must not exceed rooms.hardMaxParticipants');
  if (!PRESET_IDS.includes(config.media.defaultPreset)) fail('media.defaultPreset', `must be one of ${PRESET_IDS.join(', ')}, got ${config.media.defaultPreset}`);
  if (!(Number.isFinite(config.media.uploadBudgetKbps) && config.media.uploadBudgetKbps > 0)) fail('media.uploadBudgetKbps', `must be greater than 0, got ${config.media.uploadBudgetKbps}`);
  const scheme = /^(stun|stuns|turn|turns):/;
  config.webrtc.iceServers.forEach((server, i) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    urls.forEach((url, j) => { if (typeof url !== 'string' || !scheme.test(url)) fail(`webrtc.iceServers[${i}].urls[${j}]`, `has an invalid scheme, got ${url}`); });
  });
  if (config.webrtc.turn.enabled && (!config.webrtc.turn.urls.length || !config.webrtc.turn.username || !config.webrtc.turn.credential)) fail('webrtc.turn', 'requires non-empty urls, username, and credential when enabled');
  if (!(config.rooms.emptyRoomGraceMs > config.rooms.hostGraceMs)) fail('rooms.emptyRoomGraceMs', 'must be greater than rooms.hostGraceMs');
}

export function toClientConfig(config) {
  const iceServers = config.webrtc.iceServers.map((x) => ({ ...x }));
  if (config.webrtc.turn.enabled) iceServers.push({ urls: config.webrtc.turn.urls, username: config.webrtc.turn.username, credential: config.webrtc.turn.credential });
  return { iceServers, maxParticipants: config.rooms.maxParticipants, defaultPreset: config.media.defaultPreset,
    uploadBudgetKbps: config.media.uploadBudgetKbps, autoAdapt: config.media.autoAdapt,
    oneSharerAtATime: config.rooms.oneSharerAtATime, limits: { maxNameChars: LIMITS.MAX_NAME_CHARS } };
}
