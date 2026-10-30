import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, client, signIn } from '../helpers.mjs';
import { clock } from '../../lib/bank-date.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { occurrence } from '../../lib/routes/recurring-transfers.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const on = day => { clock.now = () => new Date(`${day}T18:00:00Z`); };        // noon (or 1 pm) Central Time on that bank date

const BASE = '/api/recurring-transfers';
let n = 0; const key = () => `rt-test-${Date.now()}-${++n}`;
let last4 = 1000; const nextLast4 = () => String(++last4);

/**
 * A fresh customer with their own accounts, so each test starts from known balances and unused limits.
 * accounts: { name: [kind, cents, role?] }; returns { c (signed in), userId, acct: { name: id }, last4: { name: '1234' } }.
 */
async function customer(accounts = { chk: ['checking', 100000n], sav: ['savings', 0n] }) {
  const userId = newId(), username = `rt${Date.now()}${++n}@test.example`, password = 'recurring-pass-1';
  const acct = {}, l4 = {};
  await tx(env.pool, async c => {
    await c.query('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
      [userId, username, 'Tester', await hashPassword(password), '11']);
    for (const [name, [kind, cents, role = 'owner']] of Object.entries(accounts)) {
      const id = newId(); acct[name] = id; l4[name] = nextLast4();
      await c.query('INSERT INTO accounts (id, kind, name, number_last4, allow_negative) VALUES ($1,$2,$3,$4,$5)', [id, kind, `Test ${name}`, l4[name], kind === 'credit_card']);
      await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, userId, role]);
      if (cents > 0n) await post(c, { key: `test:fund:${id}`, kind: 'seed', lines: [
        { accountId: id, amountCents: cents, description: 'Opening deposit' },
        { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Opening deposit' }] });
    }
  });
  return { c: await signIn(env.base, username, password), userId, username, password, acct, last4: l4 };
}
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const entries = async userId => (await env.q("SELECT * FROM journal_entries WHERE kind = 'recurring_transfer' AND created_by = $1 ORDER BY created_at, idempotency_key", [userId])).rows;
const dateNow = () => clock.now().toISOString().slice(0, 10);                   // the pinned clock is midday CT, so UTC and CT agree
const create = (u, fields = {}) => u.c.post(BASE, { idempotencyKey: key(), fromAccountId: u.acct.chk, toAccountId: u.acct.sav, amountCents: 2500,
  cadence: 'weekly', startDate: dateNow(), ...fields });
const run = u => u.c.post(`${BASE}/run`, {});
const detail = async (u, id) => (await u.c.get(`${BASE}/${id}`)).body;

test('R1: every endpoint needs a signed-in customer', async () => {
  const anon = client(env.base), id = newId();
  const calls = [['POST', BASE], ['GET', BASE], ['GET', `${BASE}/${id}`], ['POST', `${BASE}/${id}/pause`], ['POST', `${BASE}/${id}/resume`],
    ['POST', `${BASE}/${id}/cancel`], ['POST', `${BASE}/run`]];
  for (const [m, p] of calls) {
    const r = await anon.call(m, p, {});
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out'); assert.ok(r.body.message);
  }
  const stale = client(env.base); stale.jar.set('usab_sid', 'not-a-real-session');
  assert.equal((await stale.get(BASE)).body.error, 'signed_out');
});

test('R2: create returns the schedule, lists it and shows it with no runs, and moves no money', async () => {
  on('2027-03-01');
  const u = await customer(), before = [await bal(u.acct.chk), await bal(u.acct.sav)];
  const body = { idempotencyKey: key(), fromAccountId: u.acct.chk, toAccountId: u.acct.sav, amountCents: 2500, cadence: 'weekly', startDate: '2027-03-08' };
  const r = await u.c.post(BASE, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  const s = r.body.schedule;
  assert.deepEqual({ ...s, id: undefined, createdAt: undefined }, { id: undefined, createdAt: undefined, fromAccountId: u.acct.chk, toAccountId: u.acct.sav,
    amountCents: 2500, cadence: 'weekly', startDate: '2027-03-08', endDate: null, maxRuns: null, memo: null, status: 'active', nextRunDate: '2027-03-08',
    runsPosted: 0, runsFailed: 0 });
  assert.ok(!Number.isNaN(Date.parse(s.createdAt)));
  const list = await u.c.get(BASE);
  assert.deepEqual(list.body.schedules, [s]);
  assert.deepEqual(await detail(u, s.id), { schedule: s, runs: [] });
  assert.deepEqual([await bal(u.acct.chk), await bal(u.acct.sav)], before);
  assert.equal((await entries(u.userId)).length, 0);
  const withEnd = await create(u, { endDate: '2027-12-31', memo: '  Rainy day fund  ' });
  assert.equal(withEnd.body.schedule.endDate, '2027-12-31'); assert.equal(withEnd.body.schedule.memo, 'Rainy day fund');
  const withMax = await create(u, { maxRuns: 10, endDate: null });
  assert.equal(withMax.status, 200); assert.equal(withMax.body.schedule.maxRuns, 10); assert.equal(withMax.body.schedule.endDate, null);
});

test('R3-R7: field validation', async () => {
  on('2027-03-01');
  const u = await customer();
  const expect = async (fields, code) => {
    const r = await create(u, fields);
    assert.equal(r.status, 400, `${JSON.stringify(fields)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code, JSON.stringify(fields)); assert.ok(r.body.message);
  };
  for (const amountCents of [undefined, null, '2500', 25.5, 0, -1, 10_000_000_001, true, [2500]]) await expect({ amountCents }, 'bad_amount');
  for (const cadence of [undefined, 'daily', 'Weekly', ' weekly', 7]) await expect({ cadence }, 'bad_cadence');
  for (const startDate of [undefined, '2027-02-30', '2027-3-5', 'tomorrow', 20270305, '2027-02-28', '2028-03-01']) await expect({ startDate }, 'bad_date');
  for (const f of [{ endDate: '2027-12-31', maxRuns: 3 }, { endDate: '2027-02-28' }, { endDate: '2027-02-30' }, { endDate: 5 },
    { maxRuns: 0 }, { maxRuns: 521 }, { maxRuns: 2.5 }, { maxRuns: '3' }]) await expect(f, 'bad_end');
  for (const memo of ['x'.repeat(141), 5, { a: 1 }, ['a']]) await expect({ memo }, 'bad_memo');
  for (const f of [{ fromAccountId: undefined }, { toAccountId: null }, { fromAccountId: 7 }, { toAccountId: '' }]) await expect(f, 'bad_account');
  // the edges that are allowed
  assert.equal((await create(u, { amountCents: 1 })).status, 200);
  assert.equal((await create(u, { amountCents: 10_000_000_000, fromAccountId: u.acct.sav, toAccountId: u.acct.chk })).body.error, 'stepup_required');
  assert.equal((await create(u, { startDate: '2027-03-01' })).status, 200);                  // today
  assert.equal((await create(u, { startDate: '2028-02-29' })).status, 200);                  // today + 365
  assert.equal((await create(u, { cadence: 'monthly', endDate: '2027-03-01' })).status, 200); // end on the start date
  assert.equal((await create(u, { maxRuns: 520 })).status, 200);
  const m = await create(u, { memo: ' '.repeat(3) });
  assert.equal(m.body.schedule.memo, null);
  assert.equal((await create(u, { memo: `  ${'é'.repeat(140)}  ` })).body.schedule.memo, 'é'.repeat(140));
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries WHERE created_by = $1', [u.userId])).rows[0].n, 0);
});

test('R8: both accounts must be the customer\'s own open checking, savings or money market accounts', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 50000n], sav: ['savings', 0n], mm: ['money_market', 0n], joint: ['savings', 0n, 'joint_owner'],
    card: ['credit_card', 0n], cd: ['cd', 0n], kid: ['custodial_savings', 0n, 'custodian'], seen: ['savings', 0n, 'viewer'], frozen: ['savings', 0n] });
  const other = await customer();
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [u.acct.frozen]);
  const count = async () => (await env.q('SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1', [u.userId])).rows[0].n;
  const cases = [
    [{ toAccountId: other.acct.sav }, 404, 'not_found'], [{ fromAccountId: newId() }, 404, 'not_found'], [{ toAccountId: 'nope' }, 404, 'not_found'],
    [{ toAccountId: u.acct.kid }, 404, 'not_found'], [{ fromAccountId: u.acct.seen }, 404, 'not_found'],
    [{ toAccountId: u.acct.card }, 400, 'bad_account'], [{ toAccountId: u.acct.cd }, 400, 'bad_account'],
    [{ toAccountId: u.acct.chk }, 400, 'same_account'], [{ toAccountId: u.acct.frozen }, 409, 'account_not_open'],
    [{ fromAccountId: u.acct.frozen, toAccountId: u.acct.card }, 400, 'bad_account']];                 // kind is checked before status
  for (const [f, status, code] of cases) {
    const r = await create(u, f);
    assert.equal(r.status, status, `${JSON.stringify(f)} ${JSON.stringify(r.body)}`); assert.equal(r.body.error, code);
  }
  assert.equal(await count(), 0);
  assert.equal((await create(u, { toAccountId: u.acct.mm })).status, 200);
  assert.equal((await create(u, { fromAccountId: u.acct.joint, toAccountId: u.acct.mm })).status, 200);
});

test('check order: request id, replay, then fields in order, then accounts, step-up and the schedule count', async () => {
  on('2027-03-01');
  const u = await customer();
  assert.equal((await create(u, { idempotencyKey: undefined, amountCents: 0 })).body.error, 'idempotency_key_required');
  assert.equal((await create(u, { idempotencyKey: 'short', amountCents: 0 })).body.error, 'idempotency_key_required');
  assert.equal((await create(u, { amountCents: 0, cadence: 'daily', startDate: 'x' })).body.error, 'bad_amount');
  assert.equal((await create(u, { cadence: 'daily', startDate: 'x' })).body.error, 'bad_cadence');
  assert.equal((await create(u, { startDate: 'x', endDate: 'y', maxRuns: 1 })).body.error, 'bad_date');
  assert.equal((await create(u, { maxRuns: 0, memo: 5 })).body.error, 'bad_end');
  assert.equal((await create(u, { memo: 5, fromAccountId: null })).body.error, 'bad_memo');
  assert.equal((await create(u, { fromAccountId: null, amountCents: 600000 })).body.error, 'bad_account');
  assert.equal((await create(u, { toAccountId: newId(), amountCents: 600000 })).body.error, 'not_found');
  const k = key(), ok = await create(u, { idempotencyKey: k });
  const again = await create(u, { idempotencyKey: k, amountCents: 0 });                                  // the request id is checked before the fields
  assert.equal(again.status, 422); assert.equal(again.body.error, 'idempotency_conflict');
  assert.equal(ok.status, 200);
});

test('R9: $5,000 or more needs a recent step-up to create or resume; pause and cancel never do', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 1000000n], sav: ['savings', 0n] });
  assert.equal((await create(u, { amountCents: 499_999 })).status, 200);
  const big = await create(u, { amountCents: 500_000 });
  assert.equal(big.status, 403); assert.equal(big.body.error, 'stepup_required');
  assert.equal((await env.q('SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1', [u.userId])).rows[0].n, 1);
  await stepUp(u.c);
  const s = (await create(u, { amountCents: 500_000 })).body.schedule;
  assert.equal(s.status, 'active');
  const fresh = await signIn(env.base, u.username, u.password);                                          // a new session without step-up
  assert.equal((await fresh.post(`${BASE}/${s.id}/pause`, {})).body.schedule.status, 'paused');
  const r = await fresh.post(`${BASE}/${s.id}/resume`, {});
  assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
  assert.equal((await fresh.get(`${BASE}/${s.id}`)).body.schedule.status, 'paused');
  assert.equal((await fresh.post(`${BASE}/${s.id}/cancel`, {})).body.schedule.status, 'canceled');
  const small = (await create(u, { amountCents: 499_999 })).body.schedule;
  await fresh.post(`${BASE}/${small.id}/pause`, {});
  assert.equal((await fresh.post(`${BASE}/${small.id}/resume`, {})).body.schedule.status, 'active');
});

test('R10: a request id creates one schedule; reused for something else it is refused; ids belong to the customer', async () => {
  on('2027-03-01');
  const u = await customer(), v = await customer();
  const k = key(), body = { idempotencyKey: k, fromAccountId: u.acct.chk, toAccountId: u.acct.sav, amountCents: 2500, cadence: 'monthly', startDate: '2027-03-15', memo: 'Rent' };
  const a = await u.c.post(BASE, body), b = await u.c.post(BASE, body);
  assert.equal(a.body.replayed, false); assert.equal(b.status, 200); assert.equal(b.body.replayed, true);
  assert.deepEqual(b.body.schedule, a.body.schedule);
  const other = await signIn(env.base, u.username, u.password);                                          // another session of the same customer
  const c = await other.post(BASE, body);
  assert.equal(c.body.replayed, true); assert.equal(c.body.schedule.id, a.body.schedule.id);
  for (const change of [{ amountCents: 2600 }, { memo: 'Other' }, { cadence: 'weekly' }]) {
    const r = await other.post(BASE, { ...body, ...change });
    assert.equal(r.status, 422); assert.equal(r.body.error, 'idempotency_conflict');
  }
  assert.equal((await env.q('SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1', [u.userId])).rows[0].n, 1);
  const theirs = await v.c.post(BASE, { ...body, fromAccountId: v.acct.chk, toAccountId: v.acct.sav });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.schedule.id, a.body.schedule.id);
  const parallel = await Promise.all([1, 2, 3].map(() => u.c.post(BASE, { ...body, idempotencyKey: `${k}-p` })));
  assert.deepEqual(parallel.map(r => r.status), [200, 200, 200]);
  assert.equal(new Set(parallel.map(r => r.body.schedule.id)).size, 1);
});

test('R11: at most 25 active or paused schedules; canceling or completing frees a place', async () => {
  on('2027-03-01');
  const u = await customer();
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await create(u, { maxRuns: 1 })).body.schedule.id);
  await u.c.post(`${BASE}/${ids[0]}/pause`, {});
  const r = await create(u);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'schedule_limit');
  await u.c.post(`${BASE}/${ids[0]}/cancel`, {});
  const tomorrow = (await create(u, { startDate: '2027-03-02' })).body.schedule;
  assert.equal(tomorrow.status, 'active');
  assert.equal((await create(u)).body.error, 'schedule_limit');
  await u.c.post(`${BASE}/${tomorrow.id}/cancel`, {});
  const ran = await run(u);                                                                               // 24 one-time schedules complete today
  assert.equal(ran.body.posted, 24);
  assert.equal((await u.c.get(`${BASE}?status=completed`)).body.schedules.length, 24);
  assert.equal((await create(u)).status, 200);
});

test('R12: list is newest first and filters by status', async () => {
  on('2027-03-01');
  const u = await customer(), v = await customer();
  const a = (await create(u)).body.schedule, b = (await create(u)).body.schedule, c = (await create(u)).body.schedule;
  await create(v);
  await u.c.post(`${BASE}/${b.id}/pause`, {}); await u.c.post(`${BASE}/${c.id}/cancel`, {});
  assert.deepEqual((await u.c.get(BASE)).body.schedules.map(s => s.id), [c.id, b.id, a.id]);
  assert.deepEqual((await u.c.get(`${BASE}?status=active`)).body.schedules.map(s => s.id), [a.id]);
  assert.deepEqual((await u.c.get(`${BASE}?status=paused`)).body.schedules.map(s => [s.id, s.nextRunDate]), [[b.id, null]]);
  assert.deepEqual((await u.c.get(`${BASE}?status=canceled`)).body.schedules.map(s => s.id), [c.id]);
  assert.deepEqual((await u.c.get(`${BASE}?status=completed`)).body.schedules, []);
  for (const bad of ['done', 'ACTIVE', '']) {
    const r = await u.c.get(`${BASE}?status=${bad}`);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_status');
  }
});

test('R14: a due occurrence posts one two-line entry between the two accounts and nothing runs early', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 100000n], sav: ['savings', 5000n], other: ['savings', 7000n] });
  const s = (await create(u, { startDate: '2027-03-03', memo: 'Rainy day fund' })).body.schedule;
  on('2027-03-02');
  assert.deepEqual((await run(u)).body, { runs: [], posted: 0, failed: 0 });
  on('2027-03-03');
  const r = await run(u);
  assert.equal(r.status, 200); assert.equal(r.body.posted, 1); assert.equal(r.body.failed, 0);
  const [x] = r.body.runs;
  assert.deepEqual({ ...x, id: undefined, entryId: undefined, executedAt: undefined }, { id: undefined, entryId: undefined, executedAt: undefined,
    scheduleId: s.id, scheduledFor: '2027-03-03', status: 'posted', amountCents: 2500, failureCode: null, failureMessage: null });
  assert.equal(await bal(u.acct.chk), 97500n); assert.equal(await bal(u.acct.sav), 7500n); assert.equal(await bal(u.acct.other), 7000n);
  const [e] = await entries(u.userId);
  assert.equal(e.id, x.entryId); assert.equal(e.kind, 'recurring_transfer'); assert.equal(e.memo, 'Rainy day fund');
  assert.equal(e.idempotency_key, `${u.userId}:recurring-transfers:${s.id}:2027-03-03`);
  const lines = (await env.q('SELECT * FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents', [e.id])).rows;
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.posted_on]), [
    [u.acct.chk, -2500n, `Recurring transfer to Test sav ··${u.last4.sav}`, 'Transfers', '2027-03-03'],
    [u.acct.sav, 2500n, `Recurring transfer from Test chk ··${u.last4.chk}`, 'Transfers', '2027-03-03']]);
  const d = await detail(u, s.id);
  assert.equal(d.schedule.runsPosted, 1); assert.equal(d.schedule.nextRunDate, '2027-03-10'); assert.equal(d.schedule.status, 'active');
  assert.deepEqual(d.runs, r.body.runs);
});

test('R15: monthly occurrences keep the start day, clamped to short months', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 12, 13].map(k => occurrence('monthly', '2027-01-31', k)),
    ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2028-01-31', '2028-02-29']);
  assert.deepEqual([0, 1, 2].map(k => occurrence('monthly', '2027-11-30', k)), ['2027-11-30', '2027-12-30', '2028-01-30']);
  assert.deepEqual([0, 1, 52].map(k => occurrence('weekly', '2027-12-29', k)), ['2027-12-29', '2028-01-05', '2028-12-27']);
  on('2027-01-15');
  const u = await customer();
  const s = (await create(u, { cadence: 'monthly', startDate: '2027-01-31', amountCents: 100 })).body.schedule;
  on('2027-02-27');
  await run(u);
  assert.equal((await detail(u, s.id)).schedule.nextRunDate, '2027-02-28');
  on('2027-05-31');
  const r = await run(u);
  assert.deepEqual(r.body.runs.map(x => x.scheduledFor), ['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.deepEqual((await detail(u, s.id)).runs.map(x => x.scheduledFor), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.equal((await detail(u, s.id)).schedule.nextRunDate, '2027-06-30');
});

test('R16: running again, or twice at once, posts each occurrence once', async () => {
  on('2027-03-01');
  const u = await customer();
  const s = (await create(u)).body.schedule;
  assert.equal((await run(u)).body.posted, 1);
  assert.deepEqual((await run(u)).body, { runs: [], posted: 0, failed: 0 });
  on('2027-03-22');                                                                     // 03-08, 03-15, 03-22 due
  const rs = await Promise.all([run(u), run(u), run(u)]);
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
  assert.equal(rs.reduce((a, r) => a + r.body.posted, 0), 3);
  assert.equal((await entries(u.userId)).length, 4);
  assert.deepEqual((await detail(u, s.id)).runs.map(x => x.scheduledFor), ['2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22']);
  assert.equal(await bal(u.acct.chk), 100000n - 4n * 2500n);
});

test('R17: catching up posts each missed occurrence oldest first, at most 12 per schedule per run', async () => {
  on('2027-03-01');
  const u = await customer();
  const s = (await create(u, { amountCents: 100 })).body.schedule;
  const t = (await create(u, { amountCents: 200, startDate: '2027-03-03' })).body.schedule;
  on('2027-06-14');                                                                      // weeks 0..15 of s are due (16), and 15 of t
  const a = await run(u);
  assert.equal(a.body.posted, 24);
  const mine = id => a.body.runs.filter(x => x.scheduleId === id).map(x => x.scheduledFor);
  assert.deepEqual(mine(s.id), Array.from({ length: 12 }, (_, k) => occurrence('weekly', '2027-03-01', k)));
  assert.deepEqual(mine(t.id), Array.from({ length: 12 }, (_, k) => occurrence('weekly', '2027-03-03', k)));
  const dates = a.body.runs.map(x => x.scheduledFor);
  assert.deepEqual(dates, [...dates].sort());
  const b = await run(u);
  assert.deepEqual(b.body.runs.filter(x => x.scheduleId === s.id).map(x => x.scheduledFor), ['2027-05-24', '2027-05-31', '2027-06-07', '2027-06-14']);
  assert.equal(b.body.runs.filter(x => x.scheduleId === t.id).length, 3);
  assert.equal((await detail(u, s.id)).schedule.nextRunDate, '2027-06-21');
  assert.equal((await entries(u.userId)).length, 31);
});

test('R18: a schedule completes after its last occurrence (end date inclusive, maxRuns counts failures)', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 3000n], sav: ['savings', 0n] });
  const byEnd = (await create(u, { amountCents: 100, endDate: '2027-03-15' })).body.schedule;
  const byCount = (await create(u, { amountCents: 2500, maxRuns: 2 })).body.schedule;
  on('2027-03-08');
  await run(u);                                                                         // byCount: 03-01 posts, 03-08 fails (not enough left)
  let c = (await detail(u, byCount.id)).schedule;
  assert.deepEqual([c.status, c.nextRunDate, c.runsPosted, c.runsFailed], ['completed', null, 1, 1]);
  on('2027-03-29');
  const r = await run(u);
  assert.deepEqual(r.body.runs.map(x => [x.scheduleId, x.scheduledFor]), [[byEnd.id, '2027-03-15']]);
  const e = (await detail(u, byEnd.id)).schedule;
  assert.deepEqual([e.status, e.nextRunDate, e.runsPosted], ['completed', null, 3]);
  on('2027-05-01');
  assert.deepEqual((await run(u)).body.runs, []);
  c = (await detail(u, byCount.id)).schedule;
  assert.equal(c.runsPosted + c.runsFailed, 2);
  for (const id of [byEnd.id, byCount.id]) {
    for (const op of ['pause', 'resume', 'cancel']) assert.equal((await u.c.post(`${BASE}/${id}/${op}`, {})).body.error, 'invalid_state');
  }
});

test('R19: not enough money: nothing posts, a failed run is recorded once and the schedule carries on', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 1000n], sav: ['savings', 0n] });
  const s = (await create(u, { amountCents: 2500 })).body.schedule;
  const r = await run(u);
  assert.equal(r.body.failed, 1); assert.equal(r.body.posted, 0);
  const [x] = r.body.runs;
  assert.equal(x.status, 'failed'); assert.equal(x.failureCode, 'insufficient_funds'); assert.ok(x.failureMessage.length > 0); assert.equal(x.entryId, null);
  assert.equal(await bal(u.acct.chk), 1000n); assert.equal(await bal(u.acct.sav), 0n);
  assert.equal((await entries(u.userId)).length, 0);
  let d = (await detail(u, s.id)).schedule;
  assert.deepEqual([d.status, d.nextRunDate, d.runsFailed, d.runsPosted], ['active', '2027-03-08', 1, 0]);
  await tx(env.pool, async c => post(c, { key: `test:topup:${u.acct.chk}`, kind: 'seed', lines: [
    { accountId: u.acct.chk, amountCents: 5000n, description: 'Deposit' }, { accountId: await systemAccount(c, 'equity'), amountCents: -5000n, description: 'Deposit' }] }));
  assert.deepEqual((await run(u)).body.runs, []);                                                         // the failed one is not retried
  on('2027-03-08');
  const next = await run(u);
  assert.deepEqual(next.body.runs.map(y => [y.scheduledFor, y.status]), [['2027-03-08', 'posted']]);
  d = (await detail(u, s.id));
  assert.deepEqual([d.schedule.runsFailed, d.schedule.runsPosted, d.runs.length], [1, 1, 2]);
  assert.equal(await bal(u.acct.chk), 3500n);
});

test('R20-R22: over a limit or an account not open: failed in that order of precedence; limits count posted runs only', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 1000000n], sav: ['savings', 0n] });
  const internal = async () => (await u.c.get('/api/pay/limits')).body.limits.find(l => l.rail === 'internal');
  const before = await internal();
  const s = (await create(u, { amountCents: 12345 })).body.schedule;
  assert.equal((await run(u)).body.posted, 1);
  const after = await internal();
  const cents = v => BigInt(v.replace('.', ''));
  assert.equal(cents(after.usedToday) - cents(before.usedToday), 12345n);
  assert.equal(cents(after.usedMonth) - cents(before.usedMonth), 12345n);
  // the customer's own lower limit: next week's $123.45 fits $150.00 a day but not what is left of $200.00 per 30 days
  assert.equal((await u.c.call('PUT', '/api/pay/limits/internal', { daily: '150.00', monthly: '200.00' })).status, 200);
  on('2027-03-08');
  let r = await run(u);
  assert.equal(r.body.runs[0].failureCode, 'over_limit'); assert.ok(r.body.runs[0].failureMessage);
  assert.equal(cents((await internal()).usedMonth), 12345n);
  // over a limit and not enough money: over_limit wins
  const poor = await customer({ chk: ['checking', 100n], sav: ['savings', 0n] });
  await poor.c.call('PUT', '/api/pay/limits/internal', { daily: '10.00', monthly: '10.00' });
  await create(poor, { amountCents: 5000 });
  assert.equal((await run(poor)).body.runs[0].failureCode, 'over_limit');
  // not open beats both
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [poor.acct.sav]);
  on('2027-03-15');
  assert.equal((await run(poor)).body.runs[0].failureCode, 'account_not_open');
  const before2 = await bal(poor.acct.chk);
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [poor.acct.sav]);
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [u.acct.chk]);
  on('2027-03-15');
  r = await run(u);
  assert.deepEqual(r.body.runs.map(x => [x.scheduledFor, x.status, x.failureCode]), [['2027-03-15', 'failed', 'account_not_open']]);
  assert.equal(await bal(poor.acct.chk), before2);
  const d = (await detail(u, s.id)).schedule;
  assert.deepEqual([d.status, d.runsPosted, d.runsFailed, d.nextRunDate], ['active', 1, 2, '2027-03-22']);
  assert.equal((await entries(u.userId)).length, 1);
  assert.equal(cents((await internal()).usedMonth), 12345n);
});

test('R23-R25: pause, resume (skipping what fell due while paused) and cancel', async () => {
  on('2027-03-01');
  const u = await customer();
  const s = (await create(u, { maxRuns: 3 })).body.schedule;
  await run(u);                                                                           // 03-01 posted
  const p = await u.c.post(`${BASE}/${s.id}/pause`, {});
  assert.deepEqual([p.body.schedule.status, p.body.schedule.nextRunDate], ['paused', null]);
  assert.equal((await u.c.post(`${BASE}/${s.id}/pause`, {})).status, 409);
  on('2027-03-20');
  assert.deepEqual((await run(u)).body.runs, []);                                          // 03-08 and 03-15 fell due while paused
  assert.equal((await u.c.post(`${BASE}/${s.id}/resume`, {})).body.schedule.nextRunDate, '2027-03-22');
  const again = await u.c.post(`${BASE}/${s.id}/resume`, {});
  assert.equal(again.status, 409); assert.equal(again.body.error, 'invalid_state');
  on('2027-03-29');
  await run(u);
  const d = await detail(u, s.id);
  assert.deepEqual(d.runs.map(x => x.scheduledFor), ['2027-03-01', '2027-03-22', '2027-03-29']);     // skipped dates don't count towards maxRuns
  assert.equal(d.schedule.status, 'completed');
  // resuming on an occurrence date: that date is next
  const w = (await create(u)).body.schedule;
  await u.c.post(`${BASE}/${w.id}/pause`, {});
  on('2027-04-12');
  assert.equal((await u.c.post(`${BASE}/${w.id}/resume`, {})).body.schedule.nextRunDate, '2027-04-12');
  // nothing left before the end date: resume completes it
  const e = (await create(u, { startDate: '2027-04-13', endDate: '2027-04-20' })).body.schedule;
  await u.c.post(`${BASE}/${e.id}/pause`, {});
  on('2027-04-21');
  const done = await u.c.post(`${BASE}/${e.id}/resume`, {});
  assert.deepEqual([done.body.schedule.status, done.body.schedule.nextRunDate], ['completed', null]);
  assert.deepEqual((await detail(u, e.id)).runs, []);
  // cancel from active or paused; runs and money stay; never processed again
  const before = await bal(u.acct.chk);
  const cw = await u.c.post(`${BASE}/${w.id}/cancel`, {});
  assert.deepEqual([cw.body.schedule.status, cw.body.schedule.nextRunDate], ['canceled', null]);
  assert.equal((await u.c.post(`${BASE}/${w.id}/cancel`, {})).body.error, 'invalid_state');
  assert.equal((await u.c.post(`${BASE}/${w.id}/resume`, {})).body.error, 'invalid_state');
  const x = (await create(u, { startDate: '2027-04-22' })).body.schedule;
  await u.c.post(`${BASE}/${x.id}/pause`, {});
  assert.equal((await u.c.post(`${BASE}/${x.id}/cancel`, {})).body.schedule.status, 'canceled');
  on('2027-06-01');
  assert.deepEqual((await run(u)).body.runs, []);
  assert.equal(await bal(u.acct.chk), before);
  assert.equal((await detail(u, s.id)).runs.length, 3);
  assert.ok((await u.c.get(BASE)).body.schedules.some(y => y.id === w.id && y.status === 'canceled'));
});

test('R26: another customer\'s schedules are a 404 and are never touched or run', async () => {
  on('2027-03-01');
  const u = await customer(), v = await customer();
  const theirs = (await create(v)).body.schedule;
  for (const id of [theirs.id, newId(), 'not-a-uuid', '12345']) {
    const g = await u.c.get(`${BASE}/${encodeURIComponent(id)}`);
    assert.equal(g.status, 404, id); assert.equal(g.body.error, 'not_found');
    for (const op of ['pause', 'resume', 'cancel']) {
      const r = await u.c.post(`${BASE}/${encodeURIComponent(id)}/${op}`, {});
      assert.equal(r.status, 404, `${op} ${id}`); assert.equal(r.body.error, 'not_found');
    }
  }
  assert.deepEqual((await u.c.get(BASE)).body.schedules, []);
  assert.deepEqual((await run(u)).body, { runs: [], posted: 0, failed: 0 });
  assert.deepEqual((await detail(v, theirs.id)).schedule, theirs);
  assert.equal(await bal(v.acct.chk), 100000n);
});

test('R27: exact integer amounts; every entry balances and every balance equals its ledger lines', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 10_000_000_100n], sav: ['savings', 0n], mm: ['money_market', 0n] });
  await stepUp(u.c);
  const big = await create(u, { amountCents: 9_999_999_999, maxRuns: 1 });
  assert.equal(big.body.schedule.amountCents, 9_999_999_999);
  await env.q("UPDATE limit_profiles SET daily_cents = 100000000000, rolling_30d_cents = 100000000000 WHERE rail = 'internal' AND user_id IS NULL");
  try {
    await create(u, { amountCents: 1, toAccountId: u.acct.mm });
    await create(u, { amountCents: 333, fromAccountId: u.acct.sav, toAccountId: u.acct.mm, startDate: '2027-03-02' });
    on('2027-03-16');
    const r = await run(u);
    assert.ok(r.body.runs.every(x => Number.isInteger(x.amountCents)));
    assert.equal(r.body.runs[0].amountCents, 9_999_999_999);
  } finally {
    await env.q("UPDATE limit_profiles SET daily_cents = 2500000, rolling_30d_cents = 10000000 WHERE rail = 'internal' AND user_id IS NULL");
  }
  for (const id of Object.values(u.acct)) {
    const sum = (await env.q('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1', [id])).rows[0].s;
    assert.equal(sum, await bal(id));
  }
  const es = await entries(u.userId);
  assert.equal(es.length, 1 + 3 + 3);
  for (const e of es) {
    const lines = (await env.q('SELECT amount_cents FROM ledger_lines WHERE entry_id = $1', [e.id])).rows;
    assert.equal(lines.length, 2); assert.equal(lines.reduce((a, l) => a + l.amount_cents, 0n), 0n);
  }
  assert.equal(await bal(u.acct.chk) + await bal(u.acct.sav) + await bal(u.acct.mm), 10_000_000_100n);
});

test('R28: create, pause, resume, cancel and every run are audited for the customer, with no account numbers', async () => {
  on('2027-03-01');
  const u = await customer({ chk: ['checking', 3000n], sav: ['savings', 0n] });
  const s = (await create(u)).body.schedule;
  await run(u);                                                                           // posted
  on('2027-03-08');
  await run(u);                                                                           // failed: $5.00 left
  await u.c.post(`${BASE}/${s.id}/pause`, {}); await u.c.post(`${BASE}/${s.id}/resume`, {}); await u.c.post(`${BASE}/${s.id}/cancel`, {});
  const rows = (await env.q("SELECT action, detail FROM audit_events WHERE user_id = $1 AND action LIKE 'recurring.%' ORDER BY id", [u.userId])).rows;
  assert.deepEqual(rows.map(r => r.action), ['recurring.create', 'recurring.run_posted', 'recurring.run_failed', 'recurring.pause', 'recurring.resume', 'recurring.cancel']);
  for (const r of rows) assert.equal(r.detail.schedule, s.id, r.action);
  assert.deepEqual(rows.filter(r => r.action.startsWith('recurring.run')).map(r => r.detail.scheduledFor), ['2027-03-01', '2027-03-08']);
  assert.equal(rows[2].detail.failureCode, 'insufficient_funds');
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r.detail), /\d{8,}/);
});
