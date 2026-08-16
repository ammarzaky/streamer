import { ensureCertificates, fingerprint } from '../scripts/make-certs.mjs';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createHttpRedirect } from './net/httpRedirect.js';
import { createHttpsServer, listen } from './net/httpsServer.js';
import { createStaticHandler } from './net/staticFiles.js';
import { configureIds } from './signaling/ids.js';
import { attachSignaling } from './signaling/server.js';
import { lanIps } from './util/lanIp.js';

export async function startServer({ cwd = process.cwd(), env = process.env, config: supplied } = {}) {
  const config = supplied ?? (await loadConfig({ cwd, env }));
  configureIds(config);
  ensureCertificates({ quiet: true });

  const log = createLogger(config.logging.level);
  const server = await createHttpsServer(config, createStaticHandler(config, cwd), cwd);
  const signaling = attachSignaling(server, config, log);
  const address = await listen(server, config.server.port, config.server.host);

  let redirect = null;
  if (config.server.httpRedirect.enabled) {
    redirect = createHttpRedirect(config);
    await listen(redirect, config.server.httpRedirect.port, config.server.host);
  }

  const port = address.port;
  let closing = false;

  /**
   * Shut down within a bounded time.
   *
   * `server.close()` alone only stops accepting NEW connections and then waits for existing
   * ones to end. Browsers hold HTTP keep-alive sockets open for a minute or more, so on its
   * own this hangs long enough to look like the process has locked up -- and the first thing
   * anyone does with a self-hosted server is Ctrl+C it. So: tell peers the room is ending,
   * close listeners, actively destroy remaining sockets, and give up after the configured
   * grace period regardless.
   */
  async function close() {
    if (closing) return;
    closing = true;

    await signaling.close();

    const closeHttp = (target) =>
      new Promise((resolve) => {
        if (!target) {
          resolve();
          return;
        }
        target.close(resolve);
        // Node 18.2+: without this, idle keep-alive sockets keep the server open.
        target.closeAllConnections?.();
      });

    const graceMs = config.server.shutdownGraceMs ?? 3000;
    await Promise.race([
      Promise.all([closeHttp(server), closeHttp(redirect)]),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      }),
    ]);
  }

  return { server, signaling, registry: signaling.registry, config, port, close, log };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname.toLowerCase() ===
    new URL(import.meta.url).pathname.toLowerCase();

if (isMain) {
  const app = await startServer();

  const hosts = ['localhost', ...lanIps()];
  console.log(`Streamer ready: ${hosts.map((h) => `https://${h}:${app.port}`).join('  ')}`);
  console.log(`Certificate SHA-256: ${fingerprint()}`);
  console.log('Outside-network access requires router port forwarding. See docs/NETWORK.md.');
  console.log('Run `npm run links` for the addresses to share. Ctrl+C to stop.');

  let stopping = false;
  const shutdown = async (signal) => {
    // A second Ctrl+C from an impatient user should exit immediately rather than queue
    // another graceful shutdown behind the first.
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${signal} — shutting down…`);
    await app.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(signal));

  // On Windows a console Ctrl+C does not always surface as SIGINT when stdin is a pipe.
  if (process.platform === 'win32' && process.stdin.isTTY) {
    process.stdin.on('data', (chunk) => {
      if (chunk.includes(0x03)) void shutdown('Ctrl+C');
    });
  }
}
