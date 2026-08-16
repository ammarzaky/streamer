#!/usr/bin/env node
/**
 * Print the addresses to hand out, and be honest about which of them are actually reachable.
 *
 * The reachability distinction is the whole point. It is easy to print a public address and
 * let someone assume it works; the failure that follows costs hours, because "the page will
 * not open from abroad" looks like a WebRTC problem and is not one. So this prints the LAN
 * address as a fact, and anything beyond it as a checklist.
 */

import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';

import { loadConfig } from '../src/config.js';
import { lanIPv4s, certProblem, fingerprint } from './make-certs.mjs';

const config = await loadConfig({ cwd: process.cwd(), env: process.env });
const port = config.server.port;

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
const rule = () => console.log('─'.repeat(64));

console.log();
rule();
console.log('  Streamer — addresses');
rule();

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

console.log('\nOn this machine:');
line('', `https://localhost:${port}`);

const addresses = lanIPv4s();
if (addresses.length === 0) {
  console.log('\nOn your network:');
  line('', 'no network interface found — are you offline?');
} else {
  console.log('\nOn your network (send this to people on the same Wi-Fi):');
  for (const address of addresses) line('', `https://${address}:${port}`);
}

// ---------------------------------------------------------------------------
// Certificate
// ---------------------------------------------------------------------------

console.log('\nCertificate:');
if (!existsSync('certs/server.crt')) {
  line('status', 'not generated yet — run `npm start` or `npm run certs`');
} else {
  const problem = certProblem();
  line('status', problem ? `NEEDS REGENERATION — ${problem}` : 'valid for the addresses above');
  line('SHA-256', fingerprint());
  console.log(
    '\n  Ask people to check that fingerprint against what their browser shows before\n' +
      '  accepting the warning. Or install certs/ca.crt on their device to remove it.',
  );
}

// ---------------------------------------------------------------------------
// Public reachability
// ---------------------------------------------------------------------------

/**
 * Ask a STUN server what our public address looks like.
 *
 * A single UDP binding request, no third-party HTTP call, and no dependency. It tells us the
 * address, and NOT whether anything can reach it -- those are different questions and the
 * output below is careful to say so.
 */
function publicAddressViaStun(host = 'stun.l.google.com', stunPort = 19302, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const transactionId = Buffer.alloc(12);
    for (let i = 0; i < 12; i++) transactionId[i] = Math.floor(i * 7 + 13) % 256;

    // Binding request: type 0x0001, length 0, magic cookie, transaction id.
    const request = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]),
      transactionId,
    ]);

    const done = (value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(value);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    socket.on('error', () => done(null));

    socket.on('message', (message) => {
      // Walk the attributes looking for XOR-MAPPED-ADDRESS (0x0020).
      let offset = 20;
      while (offset + 4 <= message.length) {
        const type = message.readUInt16BE(offset);
        const length = message.readUInt16BE(offset + 2);
        const value = message.subarray(offset + 4, offset + 4 + length);

        if (type === 0x0020 && value.length >= 8) {
          const xorPort = value.readUInt16BE(2) ^ 0x2112;
          const raw = value.readUInt32BE(4) ^ 0x2112a442;
          const ip = [(raw >>> 24) & 0xff, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff];
          return done({ ip: ip.join('.'), port: xorPort });
        }
        offset += 4 + length + ((4 - (length % 4)) % 4);
      }
      done(null);
    });

    socket.send(request, stunPort, host, (err) => {
      if (err) done(null);
    });
  });
}

console.log('\nFrom outside your network:');

const usesStun = (config.webrtc.iceServers ?? []).some((server) =>
  (server.urls ?? []).some((url) => String(url).startsWith('stun')),
);

if (!usesStun) {
  line('', 'STUN is disabled in config, so the public address was not looked up.');
} else {
  const stun = await publicAddressViaStun();
  if (stun) {
    line('your public address', `${stun.ip}`);
    line('would be', `https://${stun.ip}:${port}`);
  } else {
    line('', 'could not determine a public address (STUN did not answer)');
  }
}

console.log(`
  This address is NOT reachable until you arrange it yourself. You need one of:
    - port forwarding of TCP ${port} on your router to this machine, or
    - a tunnel (Cloudflare Tunnel, Tailscale, ngrok), or
    - a VPN that puts everyone on one network.

  And it cannot be made to work on every network: CGNAT, symmetric NAT, and most
  mobile carriers block a direct connection regardless of configuration.

  The only way to know is for someone outside to open the URL. If the page itself
  does not load, that is the problem -- not screen sharing. See docs/NETWORK.md.
`);

rule();
console.log();
