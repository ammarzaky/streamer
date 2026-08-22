import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** First byte of a TLS record for a handshake. Anything else on this port is not TLS. */
const TLS_HANDSHAKE = 0x16;

export async function createHttpsServer(config, handler, cwd = process.cwd()) {
  const dir = path.resolve(cwd, config.tls.certDir);
  const [key, cert] = await Promise.all([
    readFile(path.join(dir, config.tls.keyFile)),
    readFile(path.join(dir, config.tls.certFile)),
  ]);
  return https.createServer({ key, cert }, handler);
}

/**
 * A front door that answers plain HTTP on the HTTPS port instead of dropping it.
 *
 * Typing `192.168.1.34:8443` into a browser sends plain HTTP, because a bare host:port
 * defaults to http://. A TLS socket handed a plaintext request cannot parse a handshake and
 * the connection dies, which the browser renders as "This site can't be reached" -- with no
 * hint that the address was right and only the scheme was wrong. It is the single most likely
 * way someone fails to join, and it is silent at both ends.
 *
 * Answering it needs the first byte BEFORE the TLS layer sees it. Node's `tlsClientError`
 * looks like the natural hook and is not: it reports the right error code, but by the time it
 * fires the socket is already destroyed and cannot be written to. So this peeks instead --
 * a TLS handshake starts with 0x16, an HTTP request starts with an ASCII method letter -- and
 * either hands the connection to the real HTTPS server untouched, or replies with a redirect.
 */
export function createFrontDoor(httpsServer) {
  const frontDoor = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      // Put the bytes back so whichever handler takes over sees the whole stream.
      socket.pause();
      socket.unshift(chunk);

      if (chunk[0] === TLS_HANDSHAKE) {
        httpsServer.emit('connection', socket);
      } else {
        redirectToHttps(socket, chunk);
      }

      // Resume on the next tick, once the new owner has attached its listeners.
      process.nextTick(() => socket.resume());
    });

    // A client that connects and sends nothing must not hold a socket open forever.
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
  });

  return frontDoor;
}

function redirectToHttps(socket, chunk) {
  if (!socket.writable) return;

  // Prefer the host the client actually typed, so a name like streamer.local survives the
  // redirect instead of being replaced by a bare IP.
  const text = chunk.toString('latin1', 0, Math.min(chunk.length, 2048));
  const hostHeader = text.match(/\r\nhost:\s*([^\r\n]+)/i)?.[1]?.trim();

  const fallbackHost = socket.localAddress?.replace(/^::ffff:/, '') ?? 'localhost';
  const port = socket.localPort;
  const host = hostHeader || (fallbackHost.includes(':') ? `[${fallbackHost}]` : `${fallbackHost}:${port}`);

  const requestPath = text.match(/^[A-Z]+\s+(\S+)/)?.[1] ?? '/';
  const target = `https://${host}${requestPath.startsWith('/') ? requestPath : '/'}`;
  const body = `This server speaks HTTPS. Open ${target}\n`;

  socket.end(
    'HTTP/1.1 308 Permanent Redirect\r\n' +
      `Location: ${target}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}
