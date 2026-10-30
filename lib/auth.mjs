// Passwords, sessions, one-time codes, lockout and step-up. Tokens and codes are random; only their hashes are stored.
import { randomBytes, randomInt, randomUUID, scrypt as _scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, refuse, cookies, setCookie, clearCookie } from './http.mjs';
import { audit } from './audit.mjs';
import { RULES, IP_RULES, guard, guardIp, LOCK_MINUTES, CODE_FAILS_MAX, PASSWORD_FAILS_MAX } from './throttle.mjs';
export { audit, LOCK_MINUTES, CODE_FAILS_MAX, PASSWORD_FAILS_MAX };

const scrypt = promisify(_scrypt);
export const SESSION_COOKIE = 'usab_sid', CHALLENGE_COOKIE = 'usab_chal';
export const IDLE_MINUTES = 15, ABSOLUTE_HOURS = 12, LOCK_AFTER = 5, CODE_MINUTES = 10, STEPUP_MINUTES = 5, MAX_SENDS = 5;
const sha = s => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 32)).toString('base64')}`;
}
export async function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 32), want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}
let dummy;                                                     // checked for unknown usernames, so timing doesn't reveal who exists
const dummyHash = async () => (dummy ??= await hashPassword(randomBytes(12).toString('hex')));

// ---------- sign-in ----------
const BAD_LOGIN = "That username and password don't match.";
export const LOCKED = `Too many tries. For your security, sign-in is paused for ${LOCK_MINUTES} minutes.`;

/** Checks a password. Returns the user, or throws the same message whether the username exists or not. */
export async function passwordStep(c, req, username, password) {
  const name = String(username ?? '').trim().toLowerCase();
  await guardIp(c, req, IP_RULES.login);                         // one address can't try without end, whoever it tries
  const u = name ? (await c.query('SELECT * FROM users WHERE username = $1 FOR UPDATE', [name])).rows[0] : null;
  if (!u) {                                                      // an unknown name behaves exactly like a real one: 401, then paused after LOCK_AFTER misses in LOCK_MINUTES
    const who = createHmac('sha256', process.env.SSN_PEPPER ?? 'usabanc-demo-ssn-pepper').update('login-name:' + name).digest('hex').slice(0, 16);   // a keyed fingerprint of the typed name (never the name; not guessable offline)
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['unknown:' + who]);
    const prior = (await c.query(`SELECT count(*)::int n FROM audit_events WHERE user_id IS NULL AND action = 'login.unknown_user' AND detail->>'who' = $1 AND at > now() - make_interval(mins => $2)`, [who, LOCK_MINUTES])).rows[0].n;
    await checkPassword(String(password ?? ''), await dummyHash());
    await audit(c, req, null, 'login.unknown_user', { who });
    throw refuse(prior + 1 >= LOCK_AFTER ? 429 : 401, prior + 1 >= LOCK_AFTER ? 'locked' : 'bad_login', prior + 1 >= LOCK_AFTER ? LOCKED : BAD_LOGIN);
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { await checkPassword(String(password ?? ''), await dummyHash()); await audit(c, req, u.id, 'login.locked'); throw refuse(429, 'locked', LOCKED); }
  if (!(await checkPassword(String(password ?? ''), u.password_hash))) {
    const n = u.failed_logins + 1, lock = n >= LOCK_AFTER;
    await c.query(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [u.id, lock ? 0 : n, lock, LOCK_MINUTES]);
    await audit(c, req, u.id, lock ? 'login.lock' : 'login.bad_password', { attempt: n });
    if (lock) throw refuse(429, 'locked', LOCKED);
    throw refuse(401, 'bad_login', BAD_LOGIN);
  }
  await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  await audit(c, req, u.id, 'login.password_ok');
  return u;
}

// ---------- one-time codes ----------
/** Starts a challenge and returns { id, code }. The browser keeps the id (cookie); the code goes to the user's phone (simulated). */
export async function newChallenge(c, userId, purpose) {
  const id = randomBytes(24).toString('base64url'), code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await c.query('DELETE FROM challenges WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  await c.query(`INSERT INTO challenges (id_hash, user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
    [sha(id), userId, purpose, sha(id + code), CODE_MINUTES]);
  return { id, code };
}
// Tries belong to the challenge, not to one code, so a resend can't buy more guesses. Out of tries: start over.
const TOO_MANY_TRIES = 'Too many wrong codes. Start over to get a new code.';
/** Sends a fresh code for a live challenge. Keeps the tries left (a resend is not a way around the limit) and the expiry rules of checkChallenge. */
export async function resendChallenge(c, id) {
  const ch = id ? (await c.query('SELECT * FROM challenges WHERE id_hash = $1 FOR UPDATE', [sha(id)])).rows[0] : null;
  if (!ch) throw new AppError(401, 'no_challenge', 'Start again: your sign-in timed out.');
  if (new Date(ch.expires_at) <= new Date()) throw new AppError(401, 'code_expired', `That code expired. Codes work for ${CODE_MINUTES} minutes.`);
  await guard(c, null, ch.user_id, RULES.codes, { evaluates: false, record: false });                 // no new code while codes are paused
  if (ch.tries_left <= 0) throw new AppError(429, 'too_many_tries', TOO_MANY_TRIES);
  if (ch.sends >= MAX_SENDS) throw new AppError(429, 'too_many_sends', 'You asked for too many codes. Start again in a few minutes.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await c.query(`UPDATE challenges SET code_hash = $2, sends = sends + 1, expires_at = now() + make_interval(mins => $3) WHERE id_hash = $1`,
    [sha(id), sha(id + code), CODE_MINUTES]);
  return { userId: ch.user_id, code };
}
/** Checks a code. Returns the user id; throws with plain-words errors (wrong, expired, too many tries). */
export async function checkChallenge(c, req, id, code, purpose) {
  await guardIp(c, req, IP_RULES.codes);
  const ch = id ? (await c.query('SELECT * FROM challenges WHERE id_hash = $1 AND purpose = $2 FOR UPDATE', [sha(id), purpose])).rows[0] : null;
  if (!ch) throw new AppError(401, 'no_challenge', 'Start again: your sign-in timed out.');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`codes:${ch.user_id}`]);               // guesses by one customer are counted one at a time, so parallel tries can't slip past the limit
  await guard(c, req, ch.user_id, RULES.codes, { purpose });                                            // across challenges: a new code never buys new guesses
  if (new Date(ch.expires_at) <= new Date()) throw new AppError(401, 'code_expired', `That code expired. Codes work for ${CODE_MINUTES} minutes.`);
  if (ch.tries_left <= 0) throw new AppError(429, 'too_many_tries', TOO_MANY_TRIES);
  const ok = /^\d{6}$/.test(String(code ?? '')) && timingSafeEqual(Buffer.from(sha(id + code)), Buffer.from(ch.code_hash));
  if (!ok) {
    const left = ch.tries_left - 1;
    await c.query('UPDATE challenges SET tries_left = $2 WHERE id_hash = $1', [sha(id), left]);
    await audit(c, req, ch.user_id, `${purpose}.code_bad`, { tries_left: left });
    if (!left) throw refuse(429, 'too_many_tries', TOO_MANY_TRIES);
    throw refuse(401, 'bad_code', `That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }
  await c.query('DELETE FROM challenges WHERE id_hash = $1', [sha(id)]);
  await audit(c, req, ch.user_id, `${purpose}.code_ok`);
  return ch.user_id;
}

// ---------- sessions ----------
export async function startSession(c, req, res, userId, { steppedUp }) {
  // Sweep expired and abandoned rows as people sign in, so these tables don't grow forever.
  await c.query('DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - make_interval(mins => $1)', [IDLE_MINUTES]);
  await c.query('DELETE FROM challenges WHERE expires_at < now()');
  const token = randomBytes(32).toString('base64url');
  await c.query(`INSERT INTO sessions (token_hash, user_id, expires_at, stepup_at, user_agent) VALUES ($1,$2, now() + make_interval(hours => $3), $4, $5)`,
    [sha(token), userId, ABSOLUTE_HOURS, steppedUp ? new Date() : null, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  setCookie(req, res, SESSION_COOKIE, token, { maxAge: ABSOLUTE_HOURS * 3600 });
  clearCookie(req, res, CHALLENGE_COOKIE);
  await audit(c, req, userId, 'login.ok', { stepped_up: !!steppedUp });
}

/** The signed-in user, or a 401. Idle sessions end after IDLE_MINUTES; every session ends after ABSOLUTE_HOURS. */
export async function requireUser(c, req) {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) throw new AppError(401, 'signed_out', 'Please log in.');
  const s = (await c.query(`SELECT s.*, u.username, u.display_name, u.phone_last2, u.date_of_birth FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => $2)`, [sha(token), IDLE_MINUTES])).rows[0];
  if (!s) throw new AppError(401, 'signed_out', 'For your security you were logged out. Please log in again.');
  await c.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [sha(token)]);
  return { id: s.user_id, username: s.username, displayName: s.display_name, phoneLast2: s.phone_last2, dateOfBirth: s.date_of_birth,
    tokenHash: sha(token), stepupAt: s.stepup_at };
}

/** Risky actions (moving money out, adding a payee, changing contact details) need a code entered in the last few minutes. */
export function requireStepUp(user) {
  if (!user.stepupAt || Date.now() - new Date(user.stepupAt).getTime() > STEPUP_MINUTES * 60_000)
    throw new AppError(403, 'stepup_required', 'For your security, enter a one-time code to continue.');
}

export async function endSession(c, req, res, user, everywhere = false) {
  if (everywhere) await c.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  else await c.query('DELETE FROM sessions WHERE token_hash = $1', [user.tokenHash]);
  clearCookie(req, res, SESSION_COOKIE);
  await audit(c, req, user.id, everywhere ? 'logout.everywhere' : 'logout');
}

export const newId = () => randomUUID();
