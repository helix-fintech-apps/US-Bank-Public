// Request ids: a loan application sent twice is one application; the same request id
// with a different request is refused, not answered with the first result; an exact replay still returns the first result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn } from '../helpers.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const NIZAM = ['nizam@helixbots.ai', 'nizam'];
const stepUp = async c => { const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); };
const acct = async last4 => (await env.q('SELECT id, balance_cents FROM accounts WHERE number_last4 = $1', [last4])).rows[0];
let n = 0; const key = () => `idem-key-${++n}-${Date.now()}`;
const PERSONAL = { product: 'personal', amount: '10000', term: 36, annualIncome: '120000', housingPayment: '1650', employment: 'employed' };
const entries = async k => (await env.q('SELECT count(*)::int n FROM journal_entries WHERE idempotency_key LIKE $1', [`%${k}`])).rows[0].n;

test('R1: a loan application sent twice (even at once) is one application and one hard inquiry; a different one with the same id is refused', async () => {
  const c = await signIn(env.base, ...NIZAM); await stepUp(c);
  const uid = (await env.q("SELECT id FROM users WHERE username = $1", [NIZAM[0]])).rows[0].id;
  const apps = async () => (await env.q('SELECT count(*)::int n FROM loan_applications WHERE user_id = $1', [uid])).rows[0].n;
  const hard = async () => (await env.q("SELECT count(*)::int n FROM credit_pulls WHERE user_id = $1 AND kind = 'hard'", [uid])).rows[0].n;
  const [a0, h0, k] = [await apps(), await hard(), key()];
  const [x, y] = await Promise.all([c.post('/api/loans/applications', { ...PERSONAL, idempotencyKey: k }), c.post('/api/loans/applications', { ...PERSONAL, idempotencyKey: k })]);
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(y.status, 200, JSON.stringify(y.body));
  assert.equal(x.body.id, y.body.id, 'both answers are the same application');
  assert.equal(await apps(), a0 + 1); assert.equal(await hard(), h0 + 1);
  const again = await c.post('/api/loans/applications', { ...PERSONAL, idempotencyKey: k });
  assert.equal(again.body.id, x.body.id); assert.equal(await apps(), a0 + 1);
  const other = await c.post('/api/loans/applications', { ...PERSONAL, amount: '12000', idempotencyKey: k });
  assert.equal(other.status, 422); assert.equal(other.body.error, 'idempotency_conflict'); assert.equal(await apps(), a0 + 1);
});

test('R2: the same request id with a different amount is refused; an exact replay returns the first result', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const [chk, sav, k] = [await acct('4471'), await acct('9302'), key()];
  const send = amount => c.post('/api/pay/transfers', { idempotencyKey: k, fromAccountId: chk.id, toAccountId: sav.id, amount });
  const first = await send('5.00'); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.transfer.amount, '5.00');
  const replay = await send('5.00'); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.transfer.id, first.body.transfer.id);
  const diff = await send('6.00');
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict'); assert.match(diff.body.message, /different request/);
  assert.equal(await entries(k), 1, 'money moved once');
});

test('R2: a card payment and a refused request are covered too; a refusal does not use up the id', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const [chk, sav] = [await acct('4471'), await acct('9302')];
  const k = key();
  const tooMuch = await c.post('/api/pay/transfers', { idempotencyKey: k, fromAccountId: sav.id, toAccountId: chk.id, amount: '999999.00' });
  assert.ok(tooMuch.status >= 400 && tooMuch.status < 500);
  const fixed = await c.post('/api/pay/transfers', { idempotencyKey: k, fromAccountId: sav.id, toAccountId: chk.id, amount: '1.00' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const cc = await acct('0088'), pk = key();
  const pay = type => c.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: pk, fromAccountId: chk.id, type, amount: '2.00' });
  assert.equal((await pay('custom')).status, 200);
  const diff = await c.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: pk, fromAccountId: chk.id, type: 'custom', amount: '3.00' });
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
});

test('R2: a numeric request id is the same id as its string form, so it cannot dodge the check', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const [chk, sav] = [await acct('4471'), await acct('9302')];
  const k = String(10000000 + (++n));
  const send = (idempotencyKey, amount) => c.post('/api/pay/transfers', { idempotencyKey, fromAccountId: chk.id, toAccountId: sav.id, amount });
  assert.equal((await send(Number(k), '5.00')).status, 200);
  const diff = await send(k, '6.00');
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
});

test('R2: two loan applications at once with one id but different amounts: one wins, the other is refused', async () => {
  const c = await signIn(env.base, ...NIZAM); await stepUp(c);
  const uid = (await env.q("SELECT id FROM users WHERE username = $1", [NIZAM[0]])).rows[0].id;
  const apps = async () => (await env.q('SELECT count(*)::int n FROM loan_applications WHERE user_id = $1', [uid])).rows[0].n;
  const [a0, k] = [await apps(), key()];
  const rs = await Promise.all([c.post('/api/loans/applications', { ...PERSONAL, idempotencyKey: k }), c.post('/api/loans/applications', { ...PERSONAL, amount: '12000', idempotencyKey: k })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 422], JSON.stringify(rs.map(r => r.body)));
  assert.equal(rs.find(r => r.status === 422).body.error, 'idempotency_conflict');
  assert.equal(await apps(), a0 + 1);
});

// ---- one rule for every keyed route ----
import { readFileSync, readdirSync } from 'node:fs';
test('no route parses the request id itself: lib/idempotency.mjs (readKey / requestKey) is the only parser', () => {
  for (const f of readdirSync('lib/routes').filter(f => f.endsWith('.mjs'))) {
    const src = readFileSync(`lib/routes/${f}`, 'utf8');
    assert.doesNotMatch(src, /\{8,\d+\}/, `${f} has its own request id pattern`);
    assert.doesNotMatch(src, /String\(\s*body\.idempotencyKey/, `${f} reads body.idempotencyKey directly`);
  }
});

test('every keyed route: same 400 for a bad id, exact replay, changed body refused, refusal keeps the id, number = string', async () => {
  const c = await signIn(env.base, ...NIZAM); await stepUp(c);
  const [chk, sav, cc] = [await acct('4471'), await acct('9302'), await acct('0088')];
  const ov = (await c.get('/api/pay')).body, ext = ov.externalAccounts[0].id, payee = ov.payees[0].id;
  const routes = [
    ['transfer', '/api/pay/transfers', amount => ({ fromAccountId: chk.id, toAccountId: sav.id, amount })],
    ['p2p send', '/api/pay/p2p/send', amount => ({ fromAccountId: chk.id, to: 'jordan@usabanc.example', amount })],
    ['ach', '/api/pay/ach', amount => ({ accountId: chk.id, externalAccountId: ext, direction: 'out', amount })],
    ['bill', '/api/pay/bills', amount => ({ fromAccountId: chk.id, payeeId: payee, amount })],
    ['wire', '/api/pay/wires', amount => ({ fromAccountId: chk.id, amount, recipientName: 'A', bankName: 'B', routing: '123456780', accountNumber: '12345678', confirmIrrevocable: true })],
    ['card payment', `/api/cards/credit/${cc.id}/payments`, amount => ({ fromAccountId: chk.id, type: 'custom', amount })],
    ['loan application', '/api/loans/applications', amount => ({ ...PERSONAL, amount: String(10000 + Number(amount)) })],
  ];
  for (const [name, path, body] of routes) {
    const post = (k, amount) => c.post(path, { ...body(amount), idempotencyKey: k });
    for (const bad of ['short', 'has space!!', 'x'.repeat(101), {}, ['abcdefgh']]) {
      const r = await post(bad, '1.00');
      assert.equal(r.status, 400, `${name}: ${JSON.stringify(bad)} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'idempotency_key_required', `${name}: one error code for a bad id`);
    }
    const refused = await post(key(), '999999999.00');                                      // a refusal ...
    assert.ok(refused.status >= 400 && refused.status < 500, `${name}: refused (${refused.status})`);
    const k = key();
    assert.equal((await post(k, '999999999.00')).status, refused.status);
    const first = await post(k, '1.00');                                                    // ... does not use up the id
    assert.equal(first.status, 200, `${name}: ${JSON.stringify(first.body)}`);
    assert.equal((await post(k, '1.00')).status, 200, `${name}: exact replay`);
    const diff = await post(k, '2.00');
    assert.equal(diff.status, 422, `${name}: changed body`); assert.equal(diff.body.error, 'idempotency_conflict');
    const nk = String(20000000 + (++n));                                                    // digits only: 12345678 is "12345678"
    assert.equal((await post(Number(nk), '1.00')).status, 200, name);
    assert.equal((await post(nk, '2.00')).status, 422, `${name}: number vs string`);
  }
});
