// One place for "too many wrong guesses". A rule says which audit actions count as wrong guesses, how many are allowed in a
// window and what the refusal says. guard() does the same four things every time, so no endpoint can forget one:
//   1. take a per-customer lock, so parallel guesses are counted one at a time and cannot all pass the count together;
//   2. count the customer's recent wrong guesses from the append-only audit trail (a new code or session never resets them);
//   3. at the limit, write a "throttled" audit row;
//   4. refuse with refuse(), which tx() commits, so that row (and the wrong-guess rows) are kept.
// Callers still write their own wrong-guess row (the audit action in `fails`) after a wrong guess.
import { refuse, clientIp } from './http.mjs';
import { audit } from './audit.mjs';

export const LOCK_MINUTES = 15, CODE_FAILS_MAX = 10, PASSWORD_FAILS_MAX = 5, MAX_LOOKUP_FAILS = 5;

export const RULES = {
  // One-time codes, sign-in and step-up together: 10 wrong in 15 minutes (1 in 100,000 per window at 6 digits).
  codes: {
    name: 'codes', fails: ['login.code_bad', 'stepup.code_bad'], max: CODE_FAILS_MAX, mins: LOCK_MINUTES,
    throttled: purpose => `${purpose}.code_throttled`, status: 429, code: 'too_many_tries',
    message: `Too many wrong codes. For your security, codes are paused for ${LOCK_MINUTES} minutes.`
  },
  // "Current password" on the change-password form.
  password: {
    name: 'password', fails: ['password.change_bad_current'], max: PASSWORD_FAILS_MAX, mins: LOCK_MINUTES,
    throttled: () => 'password.change_throttled', status: 429, code: 'locked',
    message: `Too many tries. For your security, password changes are paused for ${LOCK_MINUTES} minutes.`
  },
  // Applicant lookups of another customer by username (joint owner, minor): 5 misses a day.
  lookup: {
    name: 'lookup', fails: ['account.lookup_failed'], max: MAX_LOOKUP_FAILS, mins: 24 * 60,
    throttled: () => 'account.lookup_throttled', status: 429, code: 'too_many_lookups',
    message: 'Too many customer lookups that did not match. For your security, try again tomorrow or call us.'
  }
};

/** Wrong guesses by this customer inside the rule's window. */
export async function failsIn(c, userId, rule) {
  return (await c.query(`SELECT count(*)::int n FROM audit_events WHERE user_id = $1 AND action = ANY($2) AND at > now() - make_interval(mins => $3)`,
    [userId, rule.fails, rule.mins])).rows[0].n;
}

/** True when the customer is at the rule's limit. Read-only: use it for screens and for steps that evaluate no guess. */
export async function isPaused(c, userId, rule) { return (await failsIn(c, userId, rule)) >= rule.max; }

/**
 * Call before evaluating a guess. Throws the rule's committed refusal when the customer is at the limit.
 * `purpose` names the flow (login or stepup) for rules whose throttled row depends on it; `detail` goes in the throttled row.
 * `evaluates: false` is for a step that checks the limit but compares no guess (resend, the password step of sign-in): no lock.
 * `record: false` skips the throttled audit row (resend, so repeated clicks add no noise).
 */
export async function guard(c, req, userId, rule, { purpose, detail = null, evaluates = true, record = true } = {}) {
  if (evaluates) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guess:${rule.name}:${userId}`]);
  if (!(await isPaused(c, userId, rule))) return;
  if (record) await audit(c, req, userId, rule.throttled(purpose), detail);
  throw refuse(rule.status, rule.code, rule.message);
}

// Per address, across all usernames: a generous cap so one network can't try passwords or codes without end. It only refuses
// that address's own further tries and changes nobody's lock, so it can't be used to lock a named customer out. Behind a shared
// address (an office) the bound is high enough for ordinary use: 40 wrong passwords or 60 wrong codes per 15 minutes.
export const IP_RULES = {
  login: { name: 'ip-login', fails: ['login.bad_password', 'login.unknown_user', 'login.lock'], max: 40, throttled: 'login.ip_throttled',
    message: `Too many sign-in tries from this network. Try again in ${LOCK_MINUTES} minutes.` },
  codes: { name: 'ip-codes', fails: ['login.code_bad', 'stepup.code_bad'], max: 60, throttled: 'login.ip_throttled',
    message: `Too many wrong codes from this network. Try again in ${LOCK_MINUTES} minutes.` }
};
export async function guardIp(c, req, rule) {
  const ip = req ? clientIp(req) : '';
  if (!ip) return;
  const n = (await c.query(`SELECT count(*)::int n FROM audit_events WHERE ip = $1 AND action = ANY($2) AND at > now() - make_interval(mins => $3)`, [ip, rule.fails, LOCK_MINUTES])).rows[0].n;
  if (n < rule.max) return;
  await audit(c, req, null, rule.throttled, { rule: rule.name });
  throw refuse(429, 'locked', rule.message);
}
