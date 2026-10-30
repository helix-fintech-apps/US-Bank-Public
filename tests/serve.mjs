// Local server: public/ with Vercel-style clean URLs (/login -> login.html, /app -> app/index.html) plus the API at /api/*.
// `npm run serve` uses DATABASE_URL (default: the local dev database postgres://payroll@localhost:5433/usabanc, not the test one).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

export function resolve(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const candidates = safe.endsWith('/') ? [path.join(ROOT, safe, 'index.html')] : [path.join(ROOT, safe), path.join(ROOT, safe + '.html'), path.join(ROOT, safe, 'index.html')];
  return candidates.find(f => f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

/** api: an app from createApp(), or null to serve static files only. */
export function start(port = 0, api = null) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/') && api) return api(req, res);
    const f = resolve(req.url);
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok(srv)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createApp } = await import('../lib/app.mjs');
  const { createPool } = await import('../lib/db.mjs');
  const pool = createPool({ url: process.env.DATABASE_URL ?? 'postgres://payroll@localhost:5433/usabanc' });
  const s = await start(Number(process.env.PORT ?? 3000), createApp({ pool }));
  console.log(`USA Banc on http://127.0.0.1:${s.address().port}  (demo login: nizam@helixbots.ai / nizam)`);
}
