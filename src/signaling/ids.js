import crypto from 'node:crypto';
import { isValidPeerId, isValidRoomId } from '../../public/shared/protocol.js';

let roomIdBytes = 16;
let hostTokenBytes = 16;
export function configureIds(config) { roomIdBytes = config.rooms.roomIdBytes; hostTokenBytes = config.rooms.hostTokenBytes; }
function token(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }
export function newRoomId(bytes = roomIdBytes) { return token(bytes); }
export function newPeerId() { return token(16); }
export function newHostToken(bytes = hostTokenBytes) { return token(bytes); }
export { isValidPeerId, isValidRoomId };
