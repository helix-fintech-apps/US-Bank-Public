// Recurring transfers between a customer's own accounts (lib/routes/recurring-transfers.mjs). Each test makes its own
// customer with fresh accounts, so balances, limits and the 25-schedule cap don't leak between tests. The bank clock is
// moved with clock.now; every test puts it back.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, client, signIn } from '../helpers.mjs';
import { clock } from '../../lib/bank-date.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { tx } from '../../lib/db.mjs';
import { occurrence, firstOnOrAfter } from '../../lib/recurring-transfers/occurrences.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
/** Moves the bank clock to noon Central Time on a date. */
const on = date => { clock.now = () => new Date(`${date}T18:00:00Z`); };

const NIZAM = ['nizam@helixbots.ai', 'nizam'];
let n = 0;
const key = () => `rt-${Date.now()}-${++n}`;
const BASE = '/api/recurring-transfers';

/** A new customer (no code needed at sign-in), signed in, with the accounts asked for, each funded from equity. */
async function customer(accounts = [{ kind: 'checking', cents: 100000n }, { kind: 'savings', cents: 0n }]) {
  const userId = newId(), username = `rt-${userId.slice(0, 8)}@usabanc.example`;
  await env.q('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
    [userId, username, 'Test Customer', await hashPassword('rt-test-pass'), '11']);
  const ids = [];
  for (const a of accounts) ids.push(await account(userId, a));
  const c = await signIn(env.base, username, 'rt-test-pass');
  return { c, userId, ids, username };
}
let last4 = 1000;
async function account(userId, { kind = 'savings', cents = 0n, status = 'open', role = 'owner', name = `Test ${kind}` } = {}) {
  const id = newId(), l4 = String(++last4);
  await env.q('INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,$2,$3,$4)', [id, kind, name, l4]);
  await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, userId, role]);
  if (cents > 0n) await fund(id, cents);
  if (status !== 'open') await env.q('UPDATE accounts SET status = $2 WHERE id = $1', [id, status]);
  return id;
}
const fund = (id, cents) => tx(env.pool, async c => post(c, { key: `rt-fund:${newId()}`, kind: 'seed', lines: [
  { accountId: id, amountCents: cents, description: 'Test deposit', category: 'Income' },
  { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Test deposit' }] }));
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const entries = async scheduleId => (await env.q('SELECT * FROM journal_entries WHERE idempotency_key LIKE $1 ORDER BY idempotency_key', [`%:recurring-transfers:${scheduleId}:%`])).rows;
const audits = async (userId, action) => (await env.q('SELECT detail FROM audit_events WHERE user_id = $1 AND action = $2 ORDER BY id', [userId, action])).rows.map(r => r.detail);
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}
/** Creates a schedule and returns it (asserting 200). */
async function make(cu, fields = {}) {
  const r = await cu.c.post(BASE, { idempotencyKey: key(), fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 2500, cadence: 'weekly',
    startDate: today(), ...fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.schedule;
}
const today = () => { const d = clock.now(); return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d); };
const run = async cu => { const r = await cu.c.post(`${BASE}/run`, {}); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const detail = async (cu, id) => (await cu.c.get(`${BASE}/${id}`)).body;

// ---------- occurrence dates (section 4.2, R15) ----------
test('R15: occurrence dates: weekly every 7 days; monthly keeps the start day, clamped to short months', () => {
  assert.deepEqual([0, 1, 2, 3].map(i => occurrence('2027-02-25', 'weekly', i)), ['2027-02-25', '2027-03-04', '2027-03-11', '2027-03-18']);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => occurrence('2027-01-31', 'monthly', i)), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  assert.deepEqual([0, 1, 2].map(i => occurrence('2027-12-31', 'monthly', i)), ['2027-12-31', '2028-01-31', '2028-02-29']);   // leap year
  assert.equal(occurrence('2027-01-15', 'monthly', 12), '2028-01-15');
  assert.equal(firstOnOrAfter('2027-01-31', 'monthly', 0, '2027-03-01'), 2);
  assert.equal(firstOnOrAfter('2027-01-31', 'monthly', 3, '2027-03-01'), 3);
  assert.equal(firstOnOrAfter('2027-01-01', 'weekly', 0, '2027-01-15'), 2);
  assert.equal(firstOnOrAfter('2027-01-01', 'weekly', 0, '2027-01-16'), 3);
});

// ---------- access ----------
test('R1: every endpoint needs a signed-in customer (401 signed_out)', async () => {
  const anon = client(env.base), id = newId();
  for (const [m, p] of [['POST', BASE], ['GET', BASE], ['GET', `${BASE}/${id}`], ['POST', `${BASE}/${id}/pause`], ['POST', `${BASE}/${id}/resume`],
    ['POST', `${BASE}/${id}/cancel`], ['POST', `${BASE}/run`]]) {
    const r = await anon.call(m, p, m === 'GET' ? undefined : { idempotencyKey: key() });
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out', `${m} ${p}`);
  }
  const stale = client(env.base); stale.jar.set('usab_sid', 'not-a-real-session');
  assert.equal((await stale.get(BASE)).body.error, 'signed_out');
});

test('R26: another customer\'s schedule, an unknown id and a malformed id are 404 and left unchanged; list and run see only your own', async () => {
  on('2027-03-01');
  const a = await customer(), b = await customer();
  const s = await make(a, { amountCents: 1000 });
  for (const path of [`${BASE}/${s.id}`, `${BASE}/${newId()}`, `${BASE}/not-a-uuid`]) {
    assert.deepEqual([(await b.c.get(path)).status, (await b.c.get(path)).body.error], [404, 'not_found'], path);
    for (const act of ['pause', 'resume', 'cancel']) {
      const r = await b.c.post(`${path}/${act}`, {});
      assert.equal(r.status, 404, `${act} ${path}`); assert.equal(r.body.error, 'not_found');
    }
  }
  assert.equal((await detail(a, s.id)).schedule.status, 'active');
  assert.deepEqual((await b.c.get(BASE)).body.schedules, []);
  assert.deepEqual(await run(b), { runs: [], posted: 0, failed: 0 });   // a's occurrence is due today, but b's run doesn't touch it
  assert.equal((await detail(a, s.id)).runs.length, 0);
  assert.equal(await bal(a.ids[0]), 100000n);
  assert.equal((await run(a)).posted, 1);
});

// ---------- create ----------
test('R2, R12, R13: create echoes the request, moves no money, and shows in the list and the detail', async () => {
  on('2027-03-01');
  const cu = await customer();
  const journal0 = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const body = { idempotencyKey: key(), fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 2500, cadence: 'monthly', startDate: '2027-03-15', endDate: '2027-12-31', memo: '  Rainy day fund ' };
  const r = await cu.c.post(BASE, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  const s = r.body.schedule;
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...s, id: undefined, createdAt: undefined }, { id: undefined, createdAt: undefined, fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 2500,
    cadence: 'monthly', startDate: '2027-03-15', endDate: '2027-12-31', maxRuns: null, memo: 'Rainy day fund', status: 'active', nextRunDate: '2027-03-15',
    runsPosted: 0, runsFailed: 0 });
  assert.equal(typeof s.amountCents, 'number');
  assert.ok(!isNaN(Date.parse(s.createdAt)));
  const s2 = await make(cu, { maxRuns: 3, cadence: 'weekly', startDate: '2027-03-01' });
  assert.equal(s2.maxRuns, 3); assert.equal(s2.endDate, null); assert.equal(s2.memo, null);
  const blank = await make(cu, { memo: '   ' });
  assert.equal(blank.memo, null);
  const list = (await cu.c.get(BASE)).body.schedules;
  assert.deepEqual(list.map(x => x.id), [blank.id, s2.id, s.id]);                 // newest first
  assert.deepEqual(list[2], s);
  const d = await detail(cu, s.id);
  assert.deepEqual(d, { schedule: s, runs: [] });
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, journal0);
  assert.equal(await bal(cu.ids[0]), 100000n); assert.equal(await bal(cu.ids[1]), 0n);
});

test('R12: the list filters by status; an unknown status is 400 bad_status', async () => {
  on('2027-03-01');
  const cu = await customer();
  const a = await make(cu), b = await make(cu), c = await make(cu, { maxRuns: 1 });
  await cu.c.post(`${BASE}/${a.id}/pause`, {});
  await cu.c.post(`${BASE}/${b.id}/cancel`, {});
  await run(cu);                                                                  // c runs once and completes
  const by = async st => (await cu.c.get(`${BASE}?status=${st}`)).body.schedules.map(x => x.id);
  assert.deepEqual(await by('paused'), [a.id]);
  assert.deepEqual(await by('canceled'), [b.id]);
  assert.deepEqual(await by('completed'), [c.id]);
  assert.deepEqual(await by('active'), []);
  for (const st of ['done', 'ACTIVE', '']) {
    const r = await cu.c.get(`${BASE}?status=${st}`);
    assert.equal(r.status, 400, st); assert.equal(r.body.error, 'bad_status');
  }
});

test('R3-R7: field validation, each with its own code; nothing is created', async () => {
  on('2027-03-01');
  const cu = await customer();
  const ok = { fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 2500, cadence: 'weekly', startDate: '2027-03-01' };
  const cases = [
    ['bad_amount', { amountCents: undefined }], ['bad_amount', { amountCents: '2500' }], ['bad_amount', { amountCents: 25.5 }], ['bad_amount', { amountCents: 0 }],
    ['bad_amount', { amountCents: -5 }], ['bad_amount', { amountCents: 10_000_000_001 }], ['bad_amount', { amountCents: null }], ['bad_amount', { amountCents: true }],
    ['bad_cadence', { cadence: 'daily' }], ['bad_cadence', { cadence: 'Weekly' }], ['bad_cadence', { cadence: undefined }],
    ['bad_date', { startDate: undefined }], ['bad_date', { startDate: '2027-02-30' }], ['bad_date', { startDate: '03/05/2027' }], ['bad_date', { startDate: '2027-02-28' }],
    ['bad_date', { startDate: '2028-03-01' }], ['bad_date', { startDate: 20270301 }],
    ['bad_end', { endDate: '2027-12-31', maxRuns: 5 }], ['bad_end', { endDate: '2027-02-28' }], ['bad_end', { endDate: '2027-13-01' }], ['bad_end', { maxRuns: 0 }],
    ['bad_end', { maxRuns: 521 }], ['bad_end', { maxRuns: 2.5 }], ['bad_end', { maxRuns: '5' }],
    ['bad_memo', { memo: 'x'.repeat(141) }], ['bad_memo', { memo: 42 }], ['bad_memo', { memo: ['a'] }],
    ['bad_account', { fromAccountId: undefined }], ['bad_account', { toAccountId: 7 }], ['bad_account', { toAccountId: '' }]
  ];
  for (const [code, change] of cases) {
    const r = await cu.c.post(BASE, { ...ok, ...change, idempotencyKey: key() });
    assert.equal(r.status, 400, `${JSON.stringify(change)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code, JSON.stringify(change)); assert.ok(r.body.message);
  }
  // the edges that are allowed
  for (const change of [{ amountCents: 1 }, { amountCents: 10_000_000_000, fromAccountId: cu.ids[0] }, { startDate: '2027-03-01' }, { startDate: '2028-02-29' },
    { endDate: '2027-03-01' }, { maxRuns: 520 }, { maxRuns: 1, endDate: null }, { memo: 'y'.repeat(140) }, { memo: null }]) {
    if (change.amountCents === 10_000_000_000) await stepUp(cu.c);
    const r = await cu.c.post(BASE, { ...ok, ...change, idempotencyKey: key() });
    assert.equal(r.status, 200, `${JSON.stringify(change)} -> ${JSON.stringify(r.body)}`);
  }
  assert.equal((await cu.c.get(BASE)).body.schedules.length, 9);
});

test('create: the first applicable check wins (key, then fields in order, then accounts, step-up, count)', async () => {
  on('2027-03-01');
  const cu = await customer(), other = await customer();
  const allBad = { amountCents: 0, cadence: 'daily', startDate: 'x', endDate: 'y', maxRuns: 0, memo: 1, fromAccountId: other.ids[0], toAccountId: other.ids[0] };
  const err = async b => (await cu.c.post(BASE, b)).body.error;
  assert.equal(await err({ ...allBad }), 'idempotency_key_required');
  assert.equal(await err({ ...allBad, idempotencyKey: 'short' }), 'idempotency_key_required');
  assert.equal(await err({ ...allBad, idempotencyKey: key() }), 'bad_amount');
  assert.equal(await err({ ...allBad, idempotencyKey: key(), amountCents: 600000 }), 'bad_cadence');
  assert.equal(await err({ ...allBad, idempotencyKey: key(), amountCents: 600000, cadence: 'weekly' }), 'bad_date');
  assert.equal(await err({ ...allBad, idempotencyKey: key(), amountCents: 600000, cadence: 'weekly', startDate: '2027-03-02' }), 'bad_end');
  const fields = { amountCents: 600000, cadence: 'weekly', startDate: '2027-03-02', endDate: null, maxRuns: null };
  assert.equal(await err({ ...allBad, ...fields, idempotencyKey: key() }), 'bad_memo');
  assert.equal(await err({ ...allBad, ...fields, memo: null, fromAccountId: null, idempotencyKey: key() }), 'bad_account');
  assert.equal(await err({ ...allBad, ...fields, memo: null, idempotencyKey: key() }), 'not_found');                     // before step-up
  assert.equal(await err({ ...allBad, ...fields, memo: null, fromAccountId: cu.ids[0], toAccountId: cu.ids[0], idempotencyKey: key() }), 'same_account');
  assert.equal(await err({ ...allBad, ...fields, memo: null, fromAccountId: cu.ids[0], toAccountId: cu.ids[1], idempotencyKey: key() }), 'stepup_required');
});

test('R8: accounts must be your own deposit accounts, different, and open; nothing is created on a refusal', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 50000n }, { kind: 'money_market', cents: 0n }]);
  const other = await customer();
  const card = await account(cu.userId, { kind: 'credit_card' });
  const cd = await account(cu.userId, { kind: 'cd' });
  const closed = await account(cu.userId, { kind: 'savings', status: 'closed' });
  const frozen = await account(cu.userId, { kind: 'savings', status: 'frozen' });
  const joint = await account(other.userId, { kind: 'savings' });
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')", [joint, cu.userId]);
  const roles = {};
  for (const role of ['custodian', 'minor', 'viewer']) {
    roles[role] = await account(other.userId, { kind: 'savings' });
    await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [roles[role], cu.userId, role]);
  }
  const body = (from, to) => ({ idempotencyKey: key(), fromAccountId: from, toAccountId: to, amountCents: 1000, cadence: 'monthly', startDate: '2027-03-05' });
  const expect = async (from, to, status, code) => {
    const r = await cu.c.post(BASE, body(from, to));
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, code);
  };
  await expect(other.ids[0], cu.ids[1], 404, 'not_found');
  await expect(cu.ids[0], other.ids[1], 404, 'not_found');
  await expect(cu.ids[0], newId(), 404, 'not_found');
  await expect(cu.ids[0], 'nope', 404, 'not_found');
  for (const role of ['custodian', 'minor', 'viewer']) { await expect(roles[role], cu.ids[0], 404, 'not_found'); await expect(cu.ids[0], roles[role], 404, 'not_found'); }
  await expect(cu.ids[0], card, 400, 'bad_account');
  await expect(cd, cu.ids[0], 400, 'bad_account');
  await expect(cu.ids[0], cu.ids[0], 400, 'same_account');
  await expect(cu.ids[0], closed, 409, 'account_not_open');
  await expect(frozen, cu.ids[0], 409, 'account_not_open');
  assert.equal((await env.q('SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1', [cu.userId])).rows[0].n, 0);
  // a joint account and a money market account are fine
  const r = await cu.c.post(BASE, body(joint, cu.ids[1]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('R9: $5,000.00 or more needs a recent step-up; less does not; pause and cancel never do; resume does', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 2000000n }, { kind: 'savings' }]);
  const b = { fromAccountId: cu.ids[0], toAccountId: cu.ids[1], cadence: 'weekly', startDate: '2027-03-08' };
  assert.equal((await cu.c.post(BASE, { ...b, amountCents: 499999, idempotencyKey: key() })).status, 200);
  const refused = await cu.c.post(BASE, { ...b, amountCents: 500000, idempotencyKey: key() });
  assert.equal(refused.status, 403); assert.equal(refused.body.error, 'stepup_required');
  assert.equal((await cu.c.get(BASE)).body.schedules.length, 1);
  const fresh = await signIn(env.base, cu.username, 'rt-test-pass'); await stepUp(fresh);
  const big = await fresh.post(BASE, { ...b, amountCents: 500000, idempotencyKey: key() });
  assert.equal(big.status, 200, JSON.stringify(big.body));
  const id = big.body.schedule.id;
  assert.equal((await cu.c.post(`${BASE}/${id}/pause`, {})).status, 200);                 // the session without a step-up
  const resume = await cu.c.post(`${BASE}/${id}/resume`, {});
  assert.equal(resume.status, 403); assert.equal(resume.body.error, 'stepup_required');
  assert.equal((await detail(cu, id)).schedule.status, 'paused');
  assert.equal((await fresh.post(`${BASE}/${id}/resume`, {})).body.schedule.status, 'active');
  assert.equal((await cu.c.post(`${BASE}/${id}/cancel`, {})).body.schedule.status, 'canceled');
});

test('R10: the same request id replays the first schedule; a different request with it is 422; ids belong to the customer', async () => {
  on('2027-03-01');
  const cu = await customer(), other = await customer();
  const k = key();
  const body = { idempotencyKey: k, fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 2500, cadence: 'weekly', startDate: '2027-03-02' };
  const first = await cu.c.post(BASE, body), again = await cu.c.post(BASE, body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.deepEqual(again.body.schedule, first.body.schedule);
  const second = await signIn(env.base, cu.username, 'rt-test-pass');                     // another session of the same customer
  assert.equal((await second.post(BASE, body)).body.replayed, true);
  for (const s of [cu.c, second]) {
    const diff = await s.post(BASE, { ...body, amountCents: 2600 });
    assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
  }
  assert.equal((await cu.c.get(BASE)).body.schedules.length, 1);
  assert.equal((await cu.c.get(BASE)).body.schedules[0].amountCents, 2500);
  const theirs = await other.c.post(BASE, { ...body, fromAccountId: other.ids[0], toAccountId: other.ids[1] });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false);
  assert.notEqual(theirs.body.schedule.id, first.body.schedule.id);
  // two identical creates at once make one schedule
  const k2 = key(), rs = await Promise.all([1, 2].map(() => cu.c.post(BASE, { ...body, idempotencyKey: k2 })));
  assert.deepEqual(rs.map(r => r.status), [200, 200]);
  assert.equal(rs[0].body.schedule.id, rs[1].body.schedule.id);
  assert.equal((await cu.c.get(BASE)).body.schedules.length, 2);
});

test('R11: at most 25 active or paused schedules; canceling or completing one frees a place', async () => {
  on('2027-03-01');
  const cu = await customer();
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push((await make(cu, { startDate: '2027-03-10' })).id);
  const done = await make(cu, { maxRuns: 1 });
  await cu.c.post(`${BASE}/${ids[0]}/pause`, {});
  const full = await cu.c.post(BASE, { idempotencyKey: key(), fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 100, cadence: 'weekly', startDate: '2027-03-10' });
  assert.equal(full.status, 422); assert.equal(full.body.error, 'schedule_limit');
  await cu.c.post(`${BASE}/${ids[1]}/cancel`, {});
  await make(cu);                                                                          // 25 again
  assert.equal((await cu.c.post(BASE, { idempotencyKey: key(), fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amountCents: 100, cadence: 'weekly', startDate: '2027-03-10' })).body.error, 'schedule_limit');
  await run(cu);                                                                           // `done` (maxRuns 1, due today) completes
  assert.equal((await detail(cu, done.id)).schedule.status, 'completed');
  await make(cu, { startDate: '2027-03-10' });
});

// ---------- running ----------
test('R14: a due occurrence moves the money in one two-line ledger entry; nothing runs before its date', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 100000n, name: 'Everyday Checking' }, { kind: 'savings', name: 'Rainy Savings' }]);
  const [from, to] = cu.ids;
  const l4 = Object.fromEntries((await env.q('SELECT id, number_last4 FROM accounts WHERE id = ANY($1)', [cu.ids])).rows.map(r => [r.id, r.number_last4]));
  const s = await make(cu, { amountCents: 2500, startDate: '2027-03-03', memo: 'Rainy day fund' });
  const others = (await env.q('SELECT id, balance_cents FROM accounts WHERE id <> ALL($1)', [cu.ids])).rows;
  on('2027-03-02');
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });                   // the day before: nothing
  on('2027-03-03');
  const out = await run(cu);
  assert.equal(out.posted, 1); assert.equal(out.failed, 0); assert.equal(out.runs.length, 1);
  const r = out.runs[0];
  assert.deepEqual({ ...r, id: undefined, entryId: undefined, executedAt: undefined }, { id: undefined, entryId: undefined, executedAt: undefined,
    scheduleId: s.id, scheduledFor: '2027-03-03', status: 'posted', amountCents: 2500, failureCode: null, failureMessage: null });
  assert.ok(!isNaN(Date.parse(r.executedAt)));
  assert.equal(await bal(from), 97500n); assert.equal(await bal(to), 2500n);
  for (const o of others) assert.equal(await bal(o.id), o.balance_cents);                // no other account changed
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [r.entryId])).rows[0];
  assert.equal(e.idempotency_key, `${cu.userId}:recurring-transfers:${s.id}:2027-03-03`);
  assert.equal(e.kind, 'recurring_transfer'); assert.equal(e.memo, 'Rainy day fund');
  const lines = (await env.q('SELECT account_id, amount_cents, description, category, posted_on FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents', [r.entryId])).rows;
  assert.deepEqual(lines, [
    { account_id: from, amount_cents: -2500n, description: `Recurring transfer to Rainy Savings ··${l4[to]}`, category: 'Transfers', posted_on: '2027-03-03' },
    { account_id: to, amount_cents: 2500n, description: `Recurring transfer from Everyday Checking ··${l4[from]}`, category: 'Transfers', posted_on: '2027-03-03' }]);
  const d = await detail(cu, s.id);
  assert.equal(d.schedule.runsPosted, 1); assert.equal(d.schedule.runsFailed, 0); assert.equal(d.schedule.nextRunDate, '2027-03-10');
  assert.deepEqual(d.runs, [r]);
});

test('R14: lines are dated the day the run happens; an occurrence starting today runs on the first call', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { startDate: '2027-03-01', cadence: 'monthly' });
  on('2027-03-04');                                                                        // run late: posted today, for the 1st
  const r = (await run(cu)).runs[0];
  assert.equal(r.scheduledFor, '2027-03-01');
  assert.deepEqual((await env.q('SELECT DISTINCT posted_on FROM ledger_lines WHERE entry_id = $1', [r.entryId])).rows, [{ posted_on: '2027-03-04' }]);
  assert.equal((await detail(cu, s.id)).schedule.nextRunDate, '2027-04-01');
});

test('R15: a monthly schedule from the 31st runs Feb 28, Mar 31, Apr 30, then back on the 31st', async () => {
  on('2027-01-31');
  const cu = await customer();
  const s = await make(cu, { cadence: 'monthly', startDate: '2027-01-31', amountCents: 100 });
  const seen = [];
  for (const d of ['2027-01-31', '2027-02-27', '2027-02-28', '2027-03-30', '2027-03-31', '2027-04-30', '2027-05-31']) {
    on(d);
    seen.push(...(await run(cu)).runs.map(r => r.scheduledFor));
  }
  assert.deepEqual(seen, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.equal((await detail(cu, s.id)).schedule.nextRunDate, '2027-06-30');
  on('2027-12-01');
  const leap = await make(cu, { cadence: 'monthly', startDate: '2027-12-31', amountCents: 100 });
  on('2028-03-01');
  assert.deepEqual((await run(cu)).runs.filter(r => r.scheduleId === leap.id).map(r => r.scheduledFor), ['2027-12-31', '2028-01-31', '2028-02-29']);
});

test('R16: running twice, or twice at once, posts each occurrence once', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { amountCents: 1000 });
  const t = await make(cu, { amountCents: 700, cadence: 'monthly' });
  const first = await run(cu);
  assert.equal(first.posted, 2);
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });
  assert.equal((await entries(s.id)).length, 1);
  on('2027-03-15');                                                                        // two weekly occurrences due (8th and 15th)
  const second = await signIn(env.base, cu.username, 'rt-test-pass');
  const both = await Promise.all([cu.c.post(`${BASE}/run`, {}), second.post(`${BASE}/run`, {}), cu.c.post(`${BASE}/run`, {})]);
  assert.deepEqual(both.map(r => r.status), [200, 200, 200]);
  assert.equal(both.reduce((n, r) => n + r.body.posted, 0), 2);
  assert.deepEqual((await entries(s.id)).map(e => e.idempotency_key.slice(-10)), ['2027-03-01', '2027-03-08', '2027-03-15']);
  assert.equal((await entries(t.id)).length, 1);
  assert.equal(await bal(cu.ids[0]), 100000n - 3000n - 700n);
  const d = await detail(cu, s.id);
  assert.equal(d.runs.length, 3); assert.equal(d.schedule.runsPosted, 3);
});

test('R17: catching up processes due occurrences oldest first, each with its own entry, at most 12 per call', async () => {
  on('2027-01-04');
  const cu = await customer([{ kind: 'checking', cents: 1000000n }, { kind: 'savings' }]);
  const s = await make(cu, { amountCents: 1000, startDate: '2027-01-04' });
  const t = await make(cu, { amountCents: 500, cadence: 'monthly', startDate: '2027-01-10' });
  on('2027-05-03');                                                                        // weekly: 18 occurrences due (Jan 4 .. May 3)
  const a = await run(cu);
  const mine = a.runs.filter(r => r.scheduleId === s.id);
  assert.equal(mine.length, 12);
  assert.equal(mine[0].scheduledFor, '2027-01-04'); assert.equal(mine[11].scheduledFor, '2027-03-22');
  assert.deepEqual(a.runs.map(r => r.scheduledFor), [...a.runs.map(r => r.scheduledFor)].sort());       // ordered by date
  assert.equal(a.runs.filter(r => r.scheduleId === t.id).length, 4);                     // Jan 10, Feb 10, Mar 10, Apr 10
  assert.equal(new Set(a.runs.map(r => r.entryId)).size, 16);
  assert.equal((await detail(cu, s.id)).schedule.nextRunDate, '2027-03-29');
  const b = await run(cu);
  assert.deepEqual(b.runs.map(r => r.scheduledFor), ['2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19', '2027-04-26', '2027-05-03']);
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });
  assert.equal(await bal(cu.ids[1]), 18n * 1000n + 4n * 500n);
});

test('R18: a schedule completes after its end date or its number of transfers; an occurrence on the end date runs', async () => {
  on('2027-03-01');
  const cu = await customer();
  const byDate = await make(cu, { amountCents: 100, startDate: '2027-03-01', endDate: '2027-03-15' });
  const byCount = await make(cu, { amountCents: 100, startDate: '2027-03-01', maxRuns: 2 });
  const oneDay = await make(cu, { amountCents: 100, startDate: '2027-03-01', endDate: '2027-03-01' });
  const shortEnd = await make(cu, { amountCents: 100, startDate: '2027-03-01', endDate: '2027-03-14' });
  on('2027-04-30');
  await run(cu);
  const d = async s => (await detail(cu, s.id));
  assert.deepEqual((await d(byDate)).runs.map(r => r.scheduledFor), ['2027-03-01', '2027-03-08', '2027-03-15']);
  assert.deepEqual((await d(byCount)).runs.map(r => r.scheduledFor), ['2027-03-01', '2027-03-08']);
  assert.deepEqual((await d(oneDay)).runs.map(r => r.scheduledFor), ['2027-03-01']);
  assert.deepEqual((await d(shortEnd)).runs.map(r => r.scheduledFor), ['2027-03-01', '2027-03-08']);
  for (const s of [byDate, byCount, oneDay, shortEnd]) {
    const x = (await d(s)).schedule;
    assert.equal(x.status, 'completed'); assert.equal(x.nextRunDate, null);
  }
  on('2027-12-31');
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });                   // never processed again
  for (const act of ['pause', 'resume', 'cancel']) {
    const r = await cu.c.post(`${BASE}/${byDate.id}/${act}`, {});
    assert.equal(r.status, 409, act); assert.equal(r.body.error, 'invalid_state');
  }
});

test('R19: not enough money: recorded as failed, nothing posted, not retried; the next occurrence runs normally', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 3000n }, { kind: 'savings' }]);
  const s = await make(cu, { amountCents: 2000, maxRuns: 3 });
  assert.equal((await run(cu)).posted, 1);                                                 // 3000 -> 1000
  on('2027-03-08');
  const journal0 = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const out = await run(cu);
  assert.equal(out.posted, 0); assert.equal(out.failed, 1);
  const f = out.runs[0];
  assert.equal(f.status, 'failed'); assert.equal(f.failureCode, 'insufficient_funds'); assert.ok(f.failureMessage.length > 0);
  assert.equal(f.entryId, null); assert.equal(f.scheduledFor, '2027-03-08');
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, journal0);
  assert.equal(await bal(cu.ids[0]), 1000n); assert.equal(await bal(cu.ids[1]), 2000n);
  let d = await detail(cu, s.id);
  assert.equal(d.schedule.status, 'active'); assert.equal(d.schedule.nextRunDate, '2027-03-15'); assert.equal(d.schedule.runsFailed, 1);
  await fund(cu.ids[0], 5000n);
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });                   // the failed one is not retried
  on('2027-03-15');
  const next = await run(cu);
  assert.equal(next.posted, 1); assert.equal(next.runs[0].scheduledFor, '2027-03-15');
  d = await detail(cu, s.id);
  assert.deepEqual(d.runs.map(r => [r.scheduledFor, r.status]), [['2027-03-01', 'posted'], ['2027-03-08', 'failed'], ['2027-03-15', 'posted']]);
  assert.equal(d.schedule.runsPosted, 2); assert.equal(d.schedule.runsFailed, 1);
  assert.equal(d.schedule.status, 'completed');                                             // failures count towards maxRuns
});

test('R20, R21: occurrences are held to the internal limits, use them up when posted, and not when they fail', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 5000000n }, { kind: 'savings' }]);
  const internal = async () => (await cu.c.get('/api/pay/limits')).body.limits.find(l => l.rail === 'internal');
  const before = await internal();
  assert.equal(before.usedToday, '0.00');
  await make(cu, { amountCents: 30000 });
  await run(cu);
  let l = await internal();
  assert.equal(l.usedToday, '300.00'); assert.equal(l.usedMonth, '300.00');
  // the customer lowers their own limit: $500 a day, $600 per 30 days
  const lower = await cu.c.call('PUT', '/api/pay/limits/internal', { daily: '500.00', monthly: '600.00' });
  assert.equal(lower.status, 200, JSON.stringify(lower.body));
  const big = await make(cu, { amountCents: 30000, cadence: 'monthly' });                 // 300 more today would be 600 > 500
  const out = await run(cu);
  assert.equal(out.failed, 1); assert.equal(out.runs[0].failureCode, 'over_limit'); assert.ok(out.runs[0].failureMessage);
  assert.equal(out.runs[0].entryId, null);
  l = await internal();
  assert.equal(l.usedToday, '300.00'); assert.equal(l.usedMonth, '300.00');               // a failure uses nothing
  assert.equal((await detail(cu, big.id)).schedule.nextRunDate, '2027-04-01');
  on('2027-03-08');                                                                         // a new day: 300 fits the daily, 600 the 30-day
  assert.equal((await run(cu)).posted, 1);
  l = await internal();
  assert.equal(l.usedToday, '300.00'); assert.equal(l.usedMonth, '600.00');
  on('2027-03-15');                                                                         // 30-day room is used up
  const third = await run(cu);
  assert.equal(third.runs[0].failureCode, 'over_limit');
  // a one-off transfer sees the recurring use too
  const oneOff = await cu.c.post('/api/pay/transfers', { idempotencyKey: key(), fromAccountId: cu.ids[0], toAccountId: cu.ids[1], amount: '1.00' });
  assert.equal(oneOff.status, 422); assert.equal(oneOff.body.error, 'over_limit');
});

test('R20: precedence: account not open, then over the limit, then not enough money', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 100n }, { kind: 'savings' }]);
  await cu.c.call('PUT', '/api/pay/limits/internal', { daily: '10.00', monthly: '10.00' });
  const s = await make(cu, { amountCents: 5000 });                                        // over the limit and more than the balance
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.ids[1]]);
  assert.equal((await run(cu)).runs[0].failureCode, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.ids[1]]);
  on('2027-03-08');
  assert.equal((await run(cu)).runs[0].failureCode, 'over_limit');
  const fresh = await signIn(env.base, cu.username, 'rt-test-pass'); await stepUp(fresh);    // raising a limit back needs a step-up
  assert.equal((await fresh.call('PUT', '/api/pay/limits/internal', { daily: '25000.00', monthly: '100000.00' })).status, 200);
  on('2027-03-15');
  assert.equal((await run(cu)).runs[0].failureCode, 'insufficient_funds');
  assert.equal((await detail(cu, s.id)).schedule.runsFailed, 3);
});

test('R22: a source or destination account that is not open fails the occurrence; the schedule carries on', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { amountCents: 1000 });
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [cu.ids[1]]);
  const out = await run(cu);
  assert.deepEqual([out.posted, out.failed, out.runs[0].failureCode, out.runs[0].entryId], [0, 1, 'account_not_open', null]);
  assert.ok(out.runs[0].failureMessage);
  assert.equal(await bal(cu.ids[0]), 100000n);
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.ids[1]]);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.ids[0]]);
  on('2027-03-08');
  assert.equal((await run(cu)).runs[0].failureCode, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.ids[0]]);
  on('2027-03-15');
  assert.equal((await run(cu)).posted, 1);
  const d = (await detail(cu, s.id)).schedule;
  assert.deepEqual([d.status, d.runsPosted, d.runsFailed, d.nextRunDate], ['active', 1, 2, '2027-03-22']);
});

// ---------- state changes ----------
test('R23-R25: pause, resume and cancel move between states; anything else is 409 invalid_state', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { startDate: '2027-03-05' });
  const act = (a, id = s.id) => cu.c.post(`${BASE}/${id}/${a}`, {});
  const resumeActive = await act('resume');
  assert.equal(resumeActive.status, 409); assert.equal(resumeActive.body.error, 'invalid_state');
  const p = await act('pause');
  assert.equal(p.status, 200); assert.equal(p.body.schedule.status, 'paused'); assert.equal(p.body.schedule.nextRunDate, null);
  assert.equal((await act('pause')).body.error, 'invalid_state');
  on('2027-03-05');
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });                   // paused: not processed though due
  const r = await act('resume');
  assert.equal(r.body.schedule.status, 'active'); assert.equal(r.body.schedule.nextRunDate, '2027-03-05');   // today's occurrence still counts
  const c = await act('cancel');
  assert.equal(c.body.schedule.status, 'canceled'); assert.equal(c.body.schedule.nextRunDate, null);
  for (const a of ['pause', 'resume', 'cancel']) { const x = await act(a); assert.equal(x.status, 409, a); assert.equal(x.body.error, 'invalid_state'); }
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });
  const paused = await make(cu, { startDate: '2027-03-06' });
  await act('pause', paused.id);
  assert.equal((await act('cancel', paused.id)).body.schedule.status, 'canceled');      // a paused schedule can be canceled
});

test('R24: occurrences that fell while paused are skipped and not counted; resuming past the end completes', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { amountCents: 100, maxRuns: 3 });
  await run(cu);                                                                            // Mar 1 posted
  await cu.c.post(`${BASE}/${s.id}/pause`, {});
  on('2027-03-24');                                                                         // Mar 8, 15, 22 fell while paused
  const r = await cu.c.post(`${BASE}/${s.id}/resume`, {});
  assert.equal(r.body.schedule.nextRunDate, '2027-03-29');
  on('2027-04-30');
  const out = await run(cu);
  assert.deepEqual(out.runs.map(x => x.scheduledFor), ['2027-03-29', '2027-04-05']);     // two more make three: the skipped ones don't count
  const d = await detail(cu, s.id);
  assert.deepEqual(d.runs.map(x => x.scheduledFor), ['2027-03-01', '2027-03-29', '2027-04-05']);
  assert.equal(d.schedule.status, 'completed');
  // ending by date: nothing left after resuming
  on('2027-05-03');
  const e = await make(cu, { amountCents: 100, endDate: '2027-05-20' });
  await cu.c.post(`${BASE}/${e.id}/pause`, {});
  on('2027-05-21');
  const done = await cu.c.post(`${BASE}/${e.id}/resume`, {});
  assert.equal(done.status, 200); assert.equal(done.body.schedule.status, 'completed'); assert.equal(done.body.schedule.nextRunDate, null);
  assert.equal((await detail(cu, e.id)).runs.length, 0);
  // an occurrence on the end date is still ahead
  on('2027-06-01');
  const f = await make(cu, { amountCents: 100, cadence: 'monthly', startDate: '2027-06-01', endDate: '2027-08-01' });
  await cu.c.post(`${BASE}/${f.id}/pause`, {});
  on('2027-07-15');
  assert.equal((await cu.c.post(`${BASE}/${f.id}/resume`, {})).body.schedule.nextRunDate, '2027-08-01');
});

test('R25: canceling keeps the money already moved and the run records; the schedule stays in the list', async () => {
  on('2027-03-01');
  const cu = await customer();
  const s = await make(cu, { amountCents: 1500 });
  await run(cu);
  await cu.c.post(`${BASE}/${s.id}/cancel`, {});
  on('2027-03-29');
  assert.deepEqual(await run(cu), { runs: [], posted: 0, failed: 0 });
  const d = await detail(cu, s.id);
  assert.equal(d.schedule.status, 'canceled'); assert.equal(d.runs.length, 1); assert.equal(d.schedule.runsPosted, 1);
  assert.equal(await bal(cu.ids[1]), 1500n);
  assert.deepEqual((await cu.c.get(BASE)).body.schedules.map(x => x.id), [s.id]);
});

// ---------- integrity and records ----------
test('R27: balances equal their ledger lines, every entry sums to zero, and what left equals what arrived', async () => {
  on('2027-01-04');
  const cu = await customer([{ kind: 'checking', cents: 50000n }, { kind: 'savings', cents: 1234n }, { kind: 'money_market' }]);
  await make(cu, { amountCents: 1999, startDate: '2027-01-04' });
  await make(cu, { amountCents: 3333, cadence: 'monthly', fromAccountId: cu.ids[1], toAccountId: cu.ids[2], startDate: '2027-01-05' });
  await make(cu, { amountCents: 777, fromAccountId: cu.ids[0], toAccountId: cu.ids[2], startDate: '2027-01-06' });
  for (const d of ['2027-01-20', '2027-02-10', '2027-03-31', '2027-05-01']) { on(d); await run(cu); }
  for (const id of cu.ids) {
    const sum = (await env.q('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1', [id])).rows[0].s;
    assert.equal(await bal(id), sum);
  }
  const bad = (await env.q(`SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.kind = 'recurring_transfer'
    GROUP BY e.id HAVING sum(l.amount_cents) <> 0 OR count(*) <> 2`)).rows;
  assert.deepEqual(bad, []);
  const runs = (await env.q(`SELECT r.* FROM recurring_transfer_runs r JOIN recurring_transfers s ON s.id = r.schedule_id WHERE s.user_id = $1 AND r.status = 'posted'`, [cu.userId])).rows;
  const moved = runs.reduce((a, r) => a + r.amount_cents, 0n);
  const out = (await env.q(`SELECT coalesce(sum(-amount_cents), 0)::bigint s FROM ledger_lines WHERE entry_id = ANY($1) AND amount_cents < 0`, [runs.map(r => r.entry_id)])).rows[0].s;
  const inn = (await env.q(`SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE entry_id = ANY($1) AND amount_cents > 0`, [runs.map(r => r.entry_id)])).rows[0].s;
  assert.equal(out, moved); assert.equal(inn, moved);
  assert.equal(await bal(cu.ids[0]) + await bal(cu.ids[1]) + await bal(cu.ids[2]), 51234n);   // only moved between the customer's accounts
  await assert.rejects(env.q('UPDATE recurring_transfer_runs SET status = $1', ['failed']), /append-only/);
});

test('R28: create, pause, resume, cancel and each run write an audit event with the schedule id and no account number', async () => {
  on('2027-03-01');
  const cu = await customer([{ kind: 'checking', cents: 1500n }, { kind: 'savings' }]);
  const s = await make(cu, { amountCents: 1000 });
  await run(cu);                                                                            // posted
  on('2027-03-08');
  await run(cu);                                                                            // failed: 500 left
  await cu.c.post(`${BASE}/${s.id}/pause`, {});
  await cu.c.post(`${BASE}/${s.id}/resume`, {});
  await cu.c.post(`${BASE}/${s.id}/cancel`, {});
  for (const action of ['recurring.create', 'recurring.pause', 'recurring.resume', 'recurring.cancel', 'recurring.run_posted', 'recurring.run_failed']) {
    const rows = await audits(cu.userId, action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].schedule, s.id, action);
  }
  assert.equal((await audits(cu.userId, 'recurring.run_posted'))[0].scheduledFor, '2027-03-01');
  assert.equal((await audits(cu.userId, 'recurring.run_failed'))[0].scheduledFor, '2027-03-08');
  assert.equal((await audits(cu.userId, 'recurring.run_failed'))[0].reason, 'insufficient_funds');
  const all = JSON.stringify((await env.q("SELECT detail FROM audit_events WHERE user_id = $1 AND action LIKE 'recurring.%'", [cu.userId])).rows);
  assert.doesNotMatch(all.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ''), /\d{5,}/);                                                       // no account number (only last 4 digits)
});

test('a seeded customer can set up and run a transfer between their own accounts', async () => {
  on('2027-03-01');
  const c = await signIn(env.base, ...NIZAM);
  const ids = Object.fromEntries((await env.q("SELECT number_last4, id FROM accounts WHERE number_last4 IN ('4471', '9302', '5120', '7781')")).rows.map(r => [r.number_last4, r.id]));
  const custodial = await c.post(BASE, { idempotencyKey: key(), fromAccountId: ids['5120'], toAccountId: ids['9302'], amountCents: 100, cadence: 'weekly', startDate: '2027-03-01' });
  assert.equal(custodial.status, 404);                                                     // a custodian is not an owner
  const r = await c.post(BASE, { idempotencyKey: key(), fromAccountId: ids['4471'], toAccountId: ids['7781'], amountCents: 100, cadence: 'weekly', startDate: '2027-03-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b0 = await bal(ids['7781']);
  const out = (await c.post(`${BASE}/run`, {})).body;
  assert.equal(out.posted, 1);
  assert.equal(await bal(ids['7781']), b0 + 100n);
});
