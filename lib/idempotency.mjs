// One rule for every route that takes a request id (body.idempotencyKey): the same id with the same request returns the
// first result (each route does that itself); the same id with a DIFFERENT request is refused with 422
// idempotency_conflict, instead of silently returning the first result. A request is recorded only after it succeeded
// (a refusal such as "not enough money" records nothing, so the customer can fix the amount and send again with the same id).
import { createHash } from 'node:crypto';
import { AppError, cookies } from './http.mjs';
import { tx } from './db.mjs';
import { SESSION_COOKIE } from './auth.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const KEEP_DAYS = 30;

/** The request id of a write, as the one string every route and the conflict check agree on: null when absent or malformed. */
const KEY_RE = /^[\w:-]{8,100}$/;
export function readKey(body) {
  const raw = body?.idempotencyKey, k = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';   // 12345678 and "12345678" are the same id; arrays and objects are not ids
  return KEY_RE.test(k) ? k : null;
}
/** The same, for a route that requires one: a missing or malformed id is a 400 with one code and message everywhere. */
export function requestKey(body) {
  const k = readKey(body);
  if (!k) throw new AppError(400, 'idempotency_key_required', 'This request is missing its request id (8-100 letters, digits, - or _). Refresh the page and try again.');
  return k;
}

/** What makes two requests "the same": the body without its request id, plus the path ids. */
export function fingerprintOf(params, body) {
  const { idempotencyKey, ...rest } = body ?? {};
  return sha(stable({ params, body: rest }));
}
export const conflict = () => new AppError(422, 'idempotency_conflict', 'This request id was already used for a different request. Nothing was changed. Refresh the page and try again.');

/** { scope, fingerprint, route } for a keyed write, or null when the request has no usable id or no session. */
export function describe(req, route, params, body) {
  const key = readKey(body), session = cookies(req)[SESSION_COOKIE];
  if (!key || !session) return null;
  const r = `${req.method} ${route.pattern}`;
  return { route: r, scope: sha(`${sha(session)}\0${r}\0${key}`), fingerprint: fingerprintOf(params, body) };
}

/** Throws 422 when this id was already used, successfully, for a different request. */
export async function checkSame(pool, d) {
  const row = (await pool.query('SELECT fingerprint FROM idempotency_requests WHERE scope_hash = $1', [d.scope])).rows[0];
  if (row && row.fingerprint !== d.fingerprint)
    throw conflict();
}

/** Remembers a request that succeeded (and forgets old ones). */
export async function remember(pool, d) {
  await pool.query('INSERT INTO idempotency_requests (scope_hash, fingerprint, route) VALUES ($1,$2,$3) ON CONFLICT (scope_hash) DO NOTHING', [d.scope, d.fingerprint, d.route]);
  if (Math.random() < 0.01) await pool.query(`DELETE FROM idempotency_requests WHERE created_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
}
