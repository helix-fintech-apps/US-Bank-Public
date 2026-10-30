// Postgres access. One small pool per process (a Vercel function instance), migrations run once under an advisory lock.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './http.mjs';

pg.types.setTypeParser(20, v => BigInt(v));        // int8 -> BigInt, so cents never pass through a float
pg.types.setTypeParser(1700, v => v);              // numeric stays a string
pg.types.setTypeParser(1082, v => v);              // date stays 'YYYY-MM-DD'

export const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');

/**
 * Pool settings from a connection string. Neon's strings end in ?sslmode=require&channel_binding=require:
 * TLS is turned on through `ssl` (certificate checked) and both query options are removed properly, so they
 * can't leak into the database name.
 */
export function poolConfig(url, { schema, max = 3 } = {}) {
  const u = new URL(url);
  const wantsTls = u.searchParams.get('sslmode') === 'require' || /\.neon\.tech$/.test(u.hostname);
  u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
  return {
    connectionString: u.toString(), max,
    ssl: wantsTls ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 8000,                                       // fail fast with a clear error, well inside the 60 s function limit (vercel.json maxDuration)
    options: schema ? `-c search_path=${schema}` : undefined
  };
}

/** A pool. `schema` puts every query in that schema first (tests use one schema per run). */
export function createPool({ url = process.env.DATABASE_URL, schema, max = 3 } = {}) {
  if (!url) throw new AppError(503, 'no_database', 'The bank is not connected to its database yet.');
  return new pg.Pool(poolConfig(url, { schema, max }));
}

let shared;
export const sharedPool = () => (shared ??= createPool());

export async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    // e.commit: refuse the request but keep what was written (a failed-login count, a used-up code, the audit row)
    await c.query(e?.commit ? 'COMMIT' : 'ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/**
 * Runs db/migrations/*.sql in name order, each once. Safe to call from many processes at once.
 * Everything happens in one transaction with a transaction-scoped lock, so it also works through a connection
 * pooler (Neon's -pooler endpoint), where a session-level lock could be taken and released on different connections.
 */
export async function migrate(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      try { await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')); }
      catch (e) { throw new Error(`migration ${f} failed: ${e.message}`); }
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
