import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { onRequest } from '../../apps/web/functions/api/proxy/[[catchall]].ts';

const defaultRoot = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
const browserHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
};
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function proxy(req, res, url, origin) {
  if (!['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed' });
  if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: 'Origin not allowed' });
  const init = { method: req.method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  const response = await onRequest({
    request: new Request(url, init),
    params: { catchall: url.pathname.slice('/api/proxy/'.length).split('/').filter(Boolean) },
  });
  // Fetch decodes upstream compression; don't forward stale encoding/length or hop headers.
  for (const [key, value] of response.headers) {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'].includes(key)) res.setHeader(key, value);
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(response.status);
  if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}
export function createServer({ root = defaultRoot } = {}) {
  root = resolve(root);
  return http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(browserHeaders)) res.setHeader(key, value);
    try {
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const origin = `${proto}://${req.headers.host}`;
      const url = new URL(req.url, origin);
      if (url.pathname === '/healthz') return reply(res, 200, { status: 'ok', app: 'LicketySplit', revision: process.env.RAILWAY_GIT_COMMIT_SHA || 'local' });
      if (url.pathname === '/api/proxy' || url.pathname.startsWith('/api/proxy/')) return await proxy(req, res, url, origin);
      if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return reply(res, 400, { error: 'Invalid path' }); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.') || part === '..')) return reply(res, 404, { error: 'Not found' });
      let file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep) && file !== root) return reply(res, 404, { error: 'Not found' });
      let info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (extname(pathname) || pathname.startsWith('/assets/') || pathname.startsWith('/fonts/')) return reply(res, 404, { error: 'Not found' });
        file = resolve(root, 'index.html');
        info = await stat(file);
      }
      const tag = `W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;
      res.setHeader('ETag', tag);
      res.setHeader('Last-Modified', info.mtime.toUTCString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mime[extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (req.headers['if-none-match'] === tag) { res.writeHead(304); return res.end(); }
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === info.mtime.toUTCString())) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        }
        if (!match || (!match[1] && !match[2]) || start > end || start >= info.size) {
          res.setHeader('Content-Range', `bytes */${info.size}`);
          res.writeHead(416); return res.end();
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      res.writeHead(status);
      if (req.method === 'HEAD' || info.size === 0) return res.end();
      await pipeline(createReadStream(file, { start, end }), res);
    } catch (error) {
      if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || req.destroyed || res.destroyed) return;
      console.error('Request failed:', error.code || error.name);
      if (!res.headersSent) reply(res, 500, { error: 'Request failed' });
      else res.destroy();
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('LicketySplit production server ready'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
