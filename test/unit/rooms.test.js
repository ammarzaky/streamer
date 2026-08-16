import test from 'node:test'; import assert from 'node:assert/strict'; import { Room } from '../../src/signaling/rooms.js';
test('join order is never reused', () => { const room = new Room(); const socket = { readyState: 1 }; const a = room.addPeer('a',socket); room.peers.delete(a.id); const b = room.addPeer('b',socket); assert.equal(b.joinOrder, 2); });
