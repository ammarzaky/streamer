import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isValidRoomId } from '../../public/shared/protocol.js';
import { MIME } from './mime.js';
import { setSecurityHeaders } from './securityHeaders.js';

const allowed = new Set(Object.keys(MIME));
export function createStaticHandler(config, cwd = process.cwd()) {
  const configured = path.resolve(cwd, config.server.staticDir); const rootPromise = realpath(configured);
  return async (request, response) => {
    setSecurityHeaders(response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return finish(response, 405);
    let pathname; try { pathname = decodeURIComponent(new URL(request.url, 'https://local').pathname); } catch { return finish(response, 400); }
    if (pathname === '/') pathname = '/index.html';
    else if (pathname === '/r/new' || (pathname.startsWith('/r/') && isValidRoomId(pathname.slice(3)))) pathname = '/room.html';
    const extension = path.extname(pathname).toLowerCase(); if (!allowed.has(extension)) return finish(response, 404);
    try {
      const root = await rootPromise; const candidate = path.resolve(root, `.${pathname}`); const actual = await realpath(candidate);
      if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) return finish(response, 403);
      const info = await stat(actual); if (!info.isFile()) return finish(response, 404);
      let body = await readFile(actual); if (config.e2e && path.basename(actual) === 'room.html') body = Buffer.from(body.toString().replace('</head>', '<script>window.__E2E__=true</script></head>'));
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
      response.setHeader('Content-Type', MIME[extension]); response.setHeader('ETag', etag); response.setHeader('Last-Modified', info.mtime.toUTCString()); response.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=3600');
      if (request.headers['if-none-match'] === etag) return finish(response, 304);
      response.writeHead(200, { 'Content-Length': body.length }); response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) { if (error.code === 'ENOENT') return finish(response, 404); finish(response, 500); }
  };
}
function finish(response, status) { response.writeHead(status); response.end(); }
