// Tiny HTTP layer shared by every route: errors, JSON in/out, cookies, a router, and request checks.
export class AppError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
/** A refusal whose side effects must be kept: tx() commits before throwing it (see db.mjs). */
export const refuse = (status, code, message, extra) => Object.assign(new AppError(status, code, message, extra), { commit: true });

const json = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(json(body));
}

export async function readJson(req) {
  // Vercel parses the body lazily: reading req.body throws its own error for bad JSON, so map any throw to a 400.
  let pre;
  try { pre = req.body; } catch { throw new AppError(400, 'bad_json', 'Request body must be a JSON object.'); }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object' && !Buffer.isBuffer(pre)) {
      if (Array.isArray(pre)) throw new AppError(400, 'bad_json', 'Request body must be a JSON object.');
      return noNul(pre);
    }
    return parse(String(pre));
  }
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > 100_000) throw new AppError(413, 'too_large', 'Request is too large.'); chunks.push(ch); }
  return parse(Buffer.concat(chunks).toString('utf8'));
}
function parse(s) {
  if (!s) return {};
  let v;
  try { v = JSON.parse(s); } catch {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError(400, 'bad_json', 'Request body must be a JSON object.');
  return noNul(v);
}

/** True when a NUL character is anywhere in a value (strings, keys, nested objects and arrays). */
export function hasNul(v, depth = 0) {
  if (typeof v === 'string') return v.includes('\u0000');
  if (!v || typeof v !== 'object' || depth > 20) return false;
  return Object.entries(v).some(([k, x]) => k.includes('\u0000') || hasNul(x, depth + 1));
}
/** Refuses text with a NUL character (Postgres can't store it, so it would otherwise be a 500). Returns the value. */
export function noNul(v) {
  if (hasNul(v)) throw new AppError(400, 'bad_text', 'Remove the hidden characters from what you typed and try again.');
  return v;
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed %: ignore that cookie */ }
  }
  return out;
}

/** Cookies are HttpOnly and SameSite=Lax; Secure everywhere except plain-http localhost (tests, local dev). */
export function setCookie(req, res, name, value, { maxAge, path = '/' } = {}) {
  const host = String(req.headers.host ?? '');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !String(req.headers['x-forwarded-proto'] ?? '').includes('https');
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (!local) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}
export const clearCookie = (req, res, name) => setCookie(req, res, name, '', { maxAge: 0 });

/** A browser request from another site can't change anything: writes must be JSON and same-origin. */
export function checkWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('application/json')) throw new AppError(415, 'json_only', 'Send JSON.');
  const origin = req.headers.origin;
  if (origin) {
    let host; try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.headers.host && host !== req.headers['x-forwarded-host']) throw new AppError(403, 'bad_origin', 'This request came from another site.');
  }
}

export function router() {
  const routes = [];
  return {
    add(method, pattern, opts, handler) {
      if (typeof opts === 'function') { handler = opts; opts = {}; }
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
      routes.push({ method, re, keys, opts, handler, pattern });
    },
    match(method, p) {
      let wrongMethod = false;
      for (const r of routes) {
        const m = r.re.exec(p); if (!m) continue;
        if (r.method !== method) { wrongMethod = true; continue; }
        let params;
        try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); }
        catch { throw new AppError(400, 'bad_path', 'That address is not valid.'); }
        return { route: r, params };
      }
      if (wrongMethod) throw new AppError(405, 'method_not_allowed', 'Method not allowed.');
      return null;
    },
    routes
  };
}

/** Valid UUIDs only (8-4-4-4-12 hex), so a malformed id is a 404/400, never a database error. */
export const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

/**
 * The caller's address. The first X-Forwarded-For entry is whatever the client sent, so it is never trusted:
 * Vercel's own header first, then X-Real-IP, then the last X-Forwarded-For hop (added by our proxy), then the socket.
 */
export function clientIp(req) {
  const h = n => { const v = req.headers[n]; return String(Array.isArray(v) ? v.join(',') : v ?? '').trim(); };
  const vercel = h('x-vercel-forwarded-for').split(',')[0].trim();
  if (vercel) return vercel;
  const real = h('x-real-ip');
  if (real) return real;
  const xff = h('x-forwarded-for').split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff.at(-1);
  return String(req.socket?.remoteAddress ?? '');
}
