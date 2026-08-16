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
  const config = supplied ?? await loadConfig({ cwd, env }); configureIds(config); ensureCertificates({ quiet: true });
  const log = createLogger(config.logging.level); const server = await createHttpsServer(config, createStaticHandler(config, cwd), cwd); const signaling = attachSignaling(server, config, log); const address = await listen(server, config.server.port, config.server.host);
  let redirect = null; if (config.server.httpRedirect.enabled) { redirect = createHttpRedirect(config); await listen(redirect, config.server.httpRedirect.port, config.server.host); }
  const port = address.port; const hosts = ['localhost', ...lanIps()]; console.log(`Streamer ready: ${hosts.map((h) => `https://${h}:${port}`).join('  ')}`); console.log(`Certificate SHA-256: ${fingerprint()}`); console.log('Outside-network access requires router port forwarding.');
  let closing = false;
  async function close() { if (closing) return; closing = true; await signaling.close(); await Promise.all([new Promise((resolve) => { server.close(resolve); }), redirect ? new Promise((resolve) => { redirect.close(resolve); }) : Promise.resolve()]); }
  return { server, signaling, registry: signaling.registry, config, port, close };
}

const isMain = process.argv[1] && new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname.toLowerCase() === new URL(import.meta.url).pathname.toLowerCase();
if (isMain) {
  const app = await startServer();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
