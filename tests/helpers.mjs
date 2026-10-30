// Test kit: a private database schema per test file (migrated and seeded), the app on a random port, and a
// cookie-keeping HTTP client. Many test runs (and many agents) can share one Postgres server safely.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool, migrate, tx } from '../lib/db.mjs';
import { seed } from '../lib/seed.mjs';
import { createApp } from '../lib/app.mjs';
import { start } from './serve.mjs';

process.env.AUDIT_STRICT = '1';                       // audit() refuses an action that is not in lib/audit-actions.mjs

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://payroll@localhost:5433/usabanc_test';

export async function testEnv() {
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const pool = createPool({ url: TEST_DB, schema, max: 5 });
  await migrate(pool);
  await tx(pool, seed);
  const srv = await start(0, createApp({ pool, setup: false }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    pool, base, schema,
    q: (sql, args) => pool.query(sql, args),
    async close() {
      await new Promise(ok => srv.close(ok)); await pool.end();
      const a = new pg.Client({ connectionString: TEST_DB }); await a.connect(); await a.query(`DROP SCHEMA ${schema} CASCADE`); await a.end();
    }
  };
}

/** A browser-like client: keeps cookies, sends JSON, and returns { status, body }. */
export function client(base) {
  const jar = new Map();
  return {
    jar,
    async call(method, path, body, headers = {}) {
      const r = await fetch(base + path, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
      });
      for (const sc of r.headers.getSetCookie()) {
        const [kv, ...attrs] = sc.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i).trim(), v = decodeURIComponent(kv.slice(i + 1).trim());
        if (attrs.some(a => /max-age=0/i.test(a.trim())) || v === '') jar.delete(k); else jar.set(k, v);
      }
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    get(p) { return this.call('GET', p); }, post(p, b) { return this.call('POST', p, b); }, del(p, b) { return this.call('DELETE', p, b); }
  };
}

/** Signs in a demo user, entering the one-time code if they need one. */
export async function signIn(base, username, password) {
  const c = client(base);
  const r = await c.post('/api/session', { username, password });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.next === 'code') { const v = await c.post('/api/session/code', { code: r.body.demoCode }); if (v.status !== 200) throw new Error('code failed'); }
  return c;
}
