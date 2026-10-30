// The API as one Node request handler: routing, request checks, database setup on first use, and error replies.
import { AppError, router, send, readJson, checkWrite, noNul } from './http.mjs';
import { migrate, tx } from './db.mjs';
import { seed } from './seed.mjs';
import { modules } from './routes/index.mjs';
import { warnDemoKeys } from './demo-keys.mjs';
import { describe, checkSame, remember } from './idempotency.mjs';

export function createApp({ pool, setup = true } = {}) {
  warnDemoKeys();                                                   // one line at startup when optional keys use demo values
  const r = router();
  for (const m of modules) m.register(r);
  let ready = null;
  const getPool = () => (typeof pool === 'function' ? pool() : pool);

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      let p = url.pathname;
      if (p === '/api/index' || p === '/api/index.mjs') p = '/api/' + (url.searchParams.get('path') ?? '');   // Vercel rewrite
      const hit = r.match(req.method, p);
      if (!hit) throw new AppError(404, 'not_found', 'Not found.');
      checkWrite(req);
      const P = getPool();
      if (setup) await (ready ??= (async () => { await migrate(P); if (process.env.DEMO_SEED !== '0') await tx(P, seed); })().catch(e => { ready = null; throw e; }));
      const body = req.method === 'GET' ? {} : await readJson(req);
      const query = Object.fromEntries(url.searchParams); delete query.path;
      noNul(query); noNul(hit.params);                                                        // NUL can't reach Postgres (a 400, not a 500)
      const keyed = req.method === 'GET' ? null : describe(req, hit.route, hit.params, body);       // a request id reused for a different request is refused (lib/idempotency.mjs)
      if (keyed) await checkSame(P, keyed);
      const out = await hit.route.handler({ req, res, pool: P, params: hit.params, body, query });
      if (keyed) await remember(P, keyed).catch(e => console.error('idempotency note failed:', e?.code ?? ''));
      if (!res.writableEnded) send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error('api error:', e?.code ?? '', String(e?.message ?? e).slice(0, 300));          // never request bodies: they can hold passwords
      send(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Please try again.' });
    }
  };
}
