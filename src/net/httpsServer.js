import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export async function createHttpsServer(config, handler, cwd = process.cwd()) { const dir = path.resolve(cwd, config.tls.certDir); const [key, cert] = await Promise.all([readFile(path.join(dir, config.tls.keyFile)), readFile(path.join(dir, config.tls.certFile))]); return https.createServer({ key, cert }, handler); }
export function listen(server, port, host) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }); }
