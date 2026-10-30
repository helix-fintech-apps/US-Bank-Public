import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testEnv, client, signIn } from '../helpers.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'];

test('unknown username and wrong password get the same answer', async () => {
  const c = client(env.base);
  const a = await c.post('/api/session', { username: 'nobody@nowhere.example', password: 'x' });
  const b = await c.post('/api/session', { username: NIZAM[0], password: 'wrong' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('the demo user signs straight in and sees their accounts from the database', async () => {
  const c = client(env.base);
  const r = await c.post('/api/session', { username: 'NIZAM@helixbots.ai ', password: NIZAM[1] });
  assert.equal(r.body.next, 'done');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.displayName, 'Nizam');
  const by = Object.fromEntries(me.body.accounts.map(a => [a.last4, a]));
  assert.equal(by['4471'].balance, '2906.12');
  assert.equal(by['9302'].balance, '1312.43');
  assert.equal(by['0088'].owed, '418.20'); assert.equal(by['0088'].available, '2081.80');
  assert.equal(by['5120'].role, 'custodian'); assert.equal(by['5120'].balance, '64.00');
  assert.equal(by['7781'].role, 'owner'); assert.equal(by['7781'].balance, '8500.00');
  assert.equal(me.body.totalDeposits, '12718.55');      // checking + savings + joint savings (the teen account is Ava's)
});

test('a user who needs a code gets one; a wrong code counts down; the right one signs in', async () => {
  const c = client(env.base);
  const r = await c.post('/api/session', { username: JORDAN[0], password: JORDAN[1] });
  assert.equal(r.body.next, 'code'); assert.equal(r.body.phoneLast2, '17'); assert.match(r.body.demoCode, /^\d{6}$/);
  assert.equal((await c.get('/api/me')).status, 401);                        // no session before the code
  const wrong = await c.post('/api/session/code', { code: r.body.demoCode === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 401); assert.match(wrong.body.message, /4 tries left/);
  assert.equal((await c.post('/api/session/code', { code: r.body.demoCode })).status, 200);
  const me = await c.get('/api/me');
  assert.deepEqual(me.body.accounts.map(a => a.last4).sort(), ['3388', '7781']);
  assert.equal(me.body.accounts.find(a => a.last4 === '7781').role, 'joint_owner');
});

test('five wrong codes use up the challenge (resend too); an expired code is refused; resend gives a new one', async () => {
  const c = client(env.base);
  const r = await c.post('/api/session', { username: JORDAN[0], password: JORDAN[1] });
  const bad = r.body.demoCode === '123456' ? '654321' : '123456';
  for (let i = 0; i < 4; i++) await c.post('/api/session/code', { code: bad });
  const fifth = await c.post('/api/session/code', { code: bad });
  assert.equal(fifth.status, 429); assert.equal(fifth.body.error, 'too_many_tries');
  assert.equal((await c.post('/api/session/code', { code: r.body.demoCode })).body.error, 'too_many_tries');
  assert.equal((await c.post('/api/session/resend')).body.error, 'too_many_tries');     // a resend doesn't buy more guesses
  await c.post('/api/session', { username: JORDAN[0], password: JORDAN[1] });           // start over
  const again = await c.post('/api/session/resend');
  assert.equal(again.status, 200);
  await env.q("UPDATE challenges SET expires_at = now() - interval '1 second'");
  const late = await c.post('/api/session/code', { code: again.body.demoCode });
  assert.equal(late.body.error, 'code_expired');
});

test('five wrong passwords pause sign-in, even with the right password, and it is audited', async () => {
  await env.q("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = $1", [JORDAN[0]]);
  const c = client(env.base);
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/session', { username: JORDAN[0], password: 'nope' + i })).status, 401);
  const fifth = await c.post('/api/session', { username: JORDAN[0], password: 'nope5' });
  assert.equal(fifth.status, 429); assert.equal(fifth.body.error, 'locked');
  assert.equal((await c.post('/api/session', { username: JORDAN[0], password: JORDAN[1] })).body.error, 'locked');
  const a = await env.q("SELECT action FROM audit_events WHERE action = 'login.lock'");
  assert.ok(a.rowCount >= 1);
  await env.q("UPDATE users SET locked_until = NULL WHERE username = $1", [JORDAN[0]]);
});

test('sessions end after 15 idle minutes; log out ends one session, everywhere ends all', async () => {
  const a = await signIn(env.base, ...NIZAM), b = await signIn(env.base, ...NIZAM);
  assert.equal((await a.get('/api/me')).status, 200);
  const hashOf = cl => createHash('sha256').update(cl.jar.get('usab_sid')).digest('hex');
  await env.q("UPDATE sessions SET last_seen_at = now() - interval '16 minutes' WHERE token_hash = $1", [hashOf(a)]);
  const s1 = await a.get('/api/me'), s2 = await b.get('/api/me');
  assert.equal(s1.status, 401); assert.equal(s2.status, 200);
  const c = await signIn(env.base, ...NIZAM);
  assert.equal((await c.del('/api/session', {})).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await b.del('/api/session', { everywhere: true })).status, 200);
  const left = await env.q("SELECT count(*)::int n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = $1", [NIZAM[0]]);
  assert.equal(left.rows[0].n, 0);
});

test("you can't see someone else's account; a minor sees their own account as minor", async () => {
  const j = await signIn(env.base, ...JORDAN);
  const nizamChecking = (await env.q("SELECT id FROM accounts WHERE number_last4 = '4471'")).rows[0].id;
  assert.equal((await j.get(`/api/accounts/${nizamChecking}/transactions`)).status, 404);
  assert.equal((await j.get('/api/accounts/not-a-uuid/transactions')).status, 404);
  const ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  const me = await ava.get('/api/me');
  assert.equal(me.body.user.isMinor, true);
  assert.deepEqual(me.body.accounts.map(a => [a.last4, a.role]), [['5120', 'minor']]);
});

test('writes must be JSON from this site', async () => {
  const r1 = await fetch(env.base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
  assert.equal(r1.status, 415);
  const r2 = await fetch(env.base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r2.status, 403);
});

test('step-up: a fresh code marks the session for risky actions', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const s = await c.post('/api/stepup');
  assert.equal(s.status, 200); assert.equal(s.body.phoneLast2, '42');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
  const row = await env.q("SELECT stepup_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = $1 AND stepup_at IS NOT NULL", [NIZAM[0]]);
  assert.ok(row.rowCount >= 1);
});

test('activity comes from the ledger and is newest first', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const id = (await env.q("SELECT id FROM accounts WHERE number_last4 = '4471'")).rows[0].id;
  const r = await c.get(`/api/accounts/${id}/transactions?limit=5`);
  assert.equal(r.status, 200); assert.equal(r.body.transactions.length, 5);
  const dates = r.body.transactions.map(t => t.postedOn);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('no password or code is ever written to the audit trail', async () => {
  const rows = (await env.q('SELECT coalesce(detail::text, \'\') d FROM audit_events')).rows.map(r => r.d).join('\n');
  for (const secret of ['nizam"', 'jordan-demo-pass', 'ava-demo-pass']) assert.ok(!rows.includes(secret), secret);
});
