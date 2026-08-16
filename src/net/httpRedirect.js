import http from 'node:http';
export function createHttpRedirect(config) { return http.createServer((request, response) => { const host = (request.headers.host ?? 'localhost').replace(/:\d+$/, `:${config.server.port}`); response.writeHead(308, { Location: `https://${host}${request.url}` }); response.end(); }); }
