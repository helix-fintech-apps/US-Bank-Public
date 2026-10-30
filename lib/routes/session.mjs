// Sign-in: password, then (for users who need it) a one-time code; sign-out; step-up codes for risky actions.
import { AppError, cookies, setCookie } from '../http.mjs';
import { tx } from '../db.mjs';
import { passwordStep, newChallenge, resendChallenge, checkChallenge, startSession, requireUser, endSession, audit,
  CHALLENGE_COOKIE, CODE_MINUTES } from '../auth.mjs';
import { RULES, guard } from '../throttle.mjs';

// No real texts are sent in this demo. The code is returned so the screen can show it as a "simulated message".
const revealCodes = () => process.env.DEMO_REVEAL_CODES !== '0';
const codeBody = code => (revealCodes() ? { demoCode: code } : {});

export function register(r) {
  r.add('POST', '/api/session', async ({ req, res, pool, body }) => tx(pool, async c => {
    const u = await passwordStep(c, req, body.username, body.password);
    if (!u.mfa_required) { await startSession(c, req, res, u.id, { steppedUp: false }); return { next: 'done' }; }
    await guard(c, req, u.id, RULES.codes, { purpose: 'login', evaluates: false });      // only after the right password, so it tells no one else anything
    const ch = await newChallenge(c, u.id, 'login');
    setCookie(req, res, CHALLENGE_COOKIE, ch.id, { maxAge: CODE_MINUTES * 60 });
    return { next: 'code', phoneLast2: u.phone_last2, ...codeBody(ch.code) };
  }));

  r.add('POST', '/api/session/code', async ({ req, res, pool, body }) => tx(pool, async c => {
    const userId = await checkChallenge(c, req, cookies(req)[CHALLENGE_COOKIE], body.code, 'login');
    await startSession(c, req, res, userId, { steppedUp: true });
    return { next: 'done' };
  }));

  r.add('POST', '/api/session/resend', async ({ req, pool }) => tx(pool, async c => {
    const { userId, code } = await resendChallenge(c, cookies(req)[CHALLENGE_COOKIE]);
    await audit(c, req, userId, 'login.code_resent');
    return { ok: true, ...codeBody(code) };
  }));

  r.add('DELETE', '/api/session', async ({ req, res, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await endSession(c, req, res, u, body.everywhere === true);
    return { ok: true };
  }));

  // Step-up: a fresh code before a risky action. The page asks for it when an API call answers 403 stepup_required.
  r.add('POST', '/api/stepup', async ({ req, res, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ch = await newChallenge(c, u.id, 'stepup');
    setCookie(req, res, CHALLENGE_COOKIE, ch.id, { maxAge: CODE_MINUTES * 60 });
    return { phoneLast2: u.phoneLast2, ...codeBody(ch.code) };
  }));
  r.add('POST', '/api/stepup/verify', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const who = await checkChallenge(c, req, cookies(req)[CHALLENGE_COOKIE], body.code, 'stepup');
    if (who !== u.id) throw new AppError(401, 'no_challenge', 'Start again.');
    await c.query('UPDATE sessions SET stepup_at = now() WHERE token_hash = $1', [u.tokenHash]);
    return { ok: true };
  }));
}
