import { C2S, C2S_TYPES, ERRORS, LEGAL_IN_STATE, LIMITS, normalizeName, parseEnvelope, isValidCandidatePayload, isValidPeerId, isValidRoomId } from '../../public/shared/protocol.js';

const empty = (d) => Object.keys(d).length === 0;
const exact = (d, keys) => Object.keys(d).every((k) => keys.includes(k));
const validators = {
  [C2S.CREATE_ROOM]: (d) => exact(d, ['name']) && normalizeName(d.name) !== null,
  [C2S.JOIN]: (d) => exact(d, ['roomId', 'name', 'hostToken', 'accessCode']) && isValidRoomId(d.roomId) && normalizeName(d.name) !== null && optionalString(d.hostToken) && optionalString(d.accessCode),
  [C2S.LEAVE]: empty, [C2S.END]: empty, [C2S.PING]: empty,
  [C2S.MUTE_STATE]: (d) => exact(d, ['micMuted']) && typeof d.micMuted === 'boolean',
  [C2S.CLAIM_SHARE]: (d) => exact(d, ['force']) && typeof d.force === 'boolean',
  [C2S.RELEASE_SHARE]: (d) => exact(d, ['epoch']) && Number.isInteger(d.epoch) && d.epoch >= 0,
  [C2S.OFFER]: (d) => relayDescription(d, C2S.OFFER),
  [C2S.ANSWER]: (d) => relayDescription(d, C2S.ANSWER),
  [C2S.ICE_CANDIDATE]: (d) => exact(d, ['to', 'candidate']) && isValidPeerId(d.to) && isValidCandidatePayload(d.candidate),
};
function optionalString(v) { return v === undefined || typeof v === 'string'; }
function relayDescription(d, type) { return exact(d, ['to', 'description']) && isValidPeerId(d.to) && d.description && typeof d.description === 'object' && !Array.isArray(d.description) && d.description.type === type && typeof d.description.sdp === 'string' && Buffer.byteLength(d.description.sdp) <= LIMITS.MAX_SDP_BYTES; }

export function validateMessage(raw, state) {
  const parsed = parseEnvelope(raw); if (!parsed.ok) return parsed;
  const { message } = parsed;
  if (!C2S_TYPES.includes(message.type)) return { ok: false, code: ERRORS.UNKNOWN_TYPE, detail: 'unknown client message type', id: message.id };
  if (!LEGAL_IN_STATE[message.type].includes(state)) return { ok: false, code: ERRORS.WRONG_STATE, detail: 'message is not legal in the current state', id: message.id };
  if (!validators[message.type](message.data)) { const nameType = message.type === C2S.CREATE_ROOM || message.type === C2S.JOIN; return { ok: false, code: nameType && normalizeName(message.data.name) === null ? ERRORS.NAME_INVALID : ERRORS.INVALID_PAYLOAD, detail: 'invalid message payload', id: message.id }; }
  if (message.type === C2S.CREATE_ROOM || message.type === C2S.JOIN) message.data.name = normalizeName(message.data.name);
  return parsed;
}

export { validators as payloadValidators };
