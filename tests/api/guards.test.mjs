// Guards on everything that checks a secret. Two kinds of test:
//  1. an inventory: every place in lib/ that compares a code or a password is listed here, so a new one fails until it is
//     limited and given a row in the table below;
//  2. a table of behaviors, the same for each limited secret: the cap holds when twenty wrong guesses arrive in parallel, the
//     right guess is refused once the cap is reached, the refusal keeps its audit rows, and nothing more is evaluated afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testEnv, client, signIn } from '../helpers.mjs';
import { RULES, LOCK_MINUTES, guard } from '../../lib/throttle.mjs';
import { audit } from '../../lib/audit.mjs';
import { tx } from '../../lib/db.mjs';
import { LOCK_AFTER } from '../../lib/auth.mjs';

let env;
before(async () => { env = await testEnv(); await env.q('UPDATE users SET mfa_required = true'); });
after(async () => { await env.close(); });
const wrongOf = code => (code === '000000' ? '111111' : '000000');
const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const countOf = async (username, actions) => (await env.q(`SELECT count(*)::int n FROM audit_events a JOIN users u ON u.id = a.user_id WHERE u.username = $1 AND a.action = ANY($2)`, [username, actions])).rows[0].n;

// ---------- 1. inventory ----------
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mjs') ? [path.join(d, e.name)] : []));
// Files that compare a secret, and how each is limited. A new file here needs a limit and a row in ROWS (or its own test).
const SECRET_CHECKS = {
  'lib/auth.mjs': 'passwordStep (users.failed_logins, row lock) and checkChallenge (RULES.codes): rows "sign-in password" and "codes"',
  'lib/routes/money-movement.mjs': 'p2p enrollment code (tries per code, 24-hour wrong-code caps): tests/api/money-movement.test.mjs',
  'lib/routes/servicing.mjs': 'change password (RULES.password): row "change password"',
  'lib/routes/session.mjs': 'sign-in and step-up code routes, through checkChallenge: row "codes"'
};
test('inventory: every place that compares a code or a password is known and limited', () => {
  const found = walk('lib').filter(f => !f.startsWith('lib/seed') && /\b(checkChallenge|checkPassword|timingSafeEqual)\(/.test(fs.readFileSync(f, 'utf8').replace(/^import .*$/gm, '')));
  assert.deepEqual(found.sort(), Object.keys(SECRET_CHECKS).sort(), 'a file that checks a secret is new or gone: limit it with lib/throttle.mjs, add a row below, list it in SECRET_CHECKS');
});

// ---------- 2. behaviors ----------
// Each row: bring the customer to one wrong guess below the cap, then fire twenty wrong guesses in parallel.
// `later()` are calls with the right credential that must now be refused.
const ROWS = [
  {
    name: 'codes (sign-in and step-up together)', user: 'ava@usabanc.example', cap: RULES.codes.max, fails: RULES.codes.fails,
    throttled: ['stepup.code_throttled', 'login.code_throttled'], status: 429, code: 'too_many_tries', text: /paused for 15 minutes/,
    async setup() {
      const pw = 'ava-demo-pass', S = await signIn(env.base, this.user, pw);
      let st = await S.post('/api/stepup');
      for (let i = 0; i < 5; i++) await S.post('/api/stepup/verify', { code: wrongOf(st.body.demoCode) });              // 5 wrong
      const L = client(env.base), lr = await L.post('/api/session', { username: this.user, password: pw });
      for (let i = 0; i < 4; i++) await L.post('/api/session/code', { code: wrongOf(lr.body.demoCode) });              // 9 wrong
      st = await S.post('/api/stepup');
      return { S, L, pw, st, lr };
    },
    burst: x => parallel(20, i => (i === 0 ? x.L.post('/api/session/code', { code: wrongOf(x.lr.body.demoCode) }) : x.S.post('/api/stepup/verify', { code: wrongOf(x.st.body.demoCode) }))),
    async later(x) {
      const st = await x.S.post('/api/stepup');
      return [['step-up code', await x.S.post('/api/stepup/verify', { code: st.body.demoCode })],
        ['sign-in code', await x.L.post('/api/session/code', { code: x.lr.body.demoCode })],
        ['resend', await x.L.post('/api/session/resend', {})],
        ['sign-in with the right password', await client(env.base).post('/api/session', { username: this.user, password: x.pw })]];
    }
  },
  {
    name: 'change password', user: 'nizam@helixbots.ai', cap: RULES.password.max, fails: RULES.password.fails,
    throttled: ['password.change_throttled'], status: 429, code: 'locked', text: /paused for 15 minutes/,
    async setup() {
      const S = await signIn(env.base, this.user, 'nizam'), st = await S.post('/api/stepup');
      await S.post('/api/stepup/verify', { code: st.body.demoCode });
      const wrong = i => S.post('/api/security/password', { current: 'not-it-' + i, next: 'A-much-longer-pass-9' });
      for (let i = 0; i < this.cap - 1; i++) await wrong(i);
      return { S, wrong };
    },
    burst: x => parallel(20, x.wrong),
    later: async x => [['right current password', await x.S.post('/api/security/password', { current: 'nizam', next: 'A-much-longer-pass-9' })]]
  },
  {
    name: 'sign-in password', user: 'zak@helixbots.ai', cap: LOCK_AFTER, fails: ['login.bad_password', 'login.lock'],
    throttled: ['login.locked'], status: 429, code: 'locked', text: /sign-in is paused for 15 minutes/,
    async setup() {
      const wrong = i => client(env.base).post('/api/session', { username: this.user, password: 'not-it-' + i });
      for (let i = 0; i < this.cap - 1; i++) await wrong(i);
      return { wrong };
    },
    burst: x => parallel(20, x.wrong),
    later: async () => [['right password', await client(env.base).post('/api/session', { username: 'zak@helixbots.ai', password: 'zak' })]]
  }
];

for (const row of ROWS) {
  test(`guard: ${row.name}: parallel wrong guesses never exceed ${row.cap}, then even the right guess is refused`, async () => {
    const x = await row.setup();
    const before = await countOf(row.user, row.fails);
    assert.equal(before, row.cap - 1, 'set-up should stop one below the cap');
    await row.burst(x);
    assert.equal(await countOf(row.user, row.fails), row.cap, `exactly ${row.cap} guesses are evaluated, however many arrive together`);
    for (const [what, r] of await row.later(x)) {
      assert.equal(r.status, row.status, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, row.code, what); assert.match(r.body.message, row.text, what);
      assert.equal(r.body.demoCode, undefined, `${what}: no code is handed out`);
    }
    assert.ok(await countOf(row.user, row.throttled) >= 1, 'the refusal is audited and the row is kept');
    await row.burst(x);
    assert.equal(await countOf(row.user, row.fails), row.cap, 'once paused, no more guesses are evaluated');
  });
}

test('the windows and caps are the documented ones', () => {
  assert.equal(LOCK_MINUTES, 15);
  assert.deepEqual([RULES.codes.max, RULES.password.max, RULES.lookup.max, LOCK_AFTER], [10, 5, 5, 5]);
  assert.equal(RULES.lookup.mins, 24 * 60);
});

test('guard: two evaluators for one customer cannot both pass the count (the lock is what makes the cap exact)', async () => {
  const uid = (await env.q("SELECT id FROM users WHERE username = 'asim@helixbots.ai'")).rows[0].id;
  for (let i = 0; i < RULES.password.max - 1; i++) await tx(env.pool, c => audit(c, null, uid, 'password.change_bad_current'));      // one below the cap
  const evaluator = () => tx(env.pool, async c => {
    await guard(c, null, uid, RULES.password);
    await new Promise(r => setTimeout(r, 200));                                       // the compare and the write take a moment
    await audit(c, null, uid, 'password.change_bad_current');
  });
  const out = await Promise.allSettled([evaluator(), evaluator(), evaluator()]);
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 1, 'only one of three parallel evaluators gets to compare a guess');
  assert.ok(out.filter(o => o.status === 'rejected').every(o => o.reason.status === 429 && o.reason.code === 'locked'));
  assert.equal(await countOf('asim@helixbots.ai', RULES.password.fails), RULES.password.max);
});
