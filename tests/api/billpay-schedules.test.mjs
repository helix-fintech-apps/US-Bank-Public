import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('hex');      // test-only key, made fresh for each run
const { testEnv, signIn } = await import('../helpers.mjs');
const { clock, cutoffAt, previousBusinessDay } = await import('../../lib/money-movement/calendar.mjs');
const { occurrence } = await import('../../lib/routes/billpay-schedules.mjs');

let env;
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const at = iso => { clock.now = () => new Date(iso); };

const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'];
let n = 0; const key = () => `bp-${Date.now()}-${++n}`;
const acct = async last4 => (await env.q("SELECT id, balance_cents FROM accounts WHERE number_last4 = $1 AND kind <> 'system'", [last4])).rows[0];
const id = async last4 => (await acct(last4)).id;
const bal = async last4 => (await acct(last4)).balance_cents;
const sysBal = async code => (await env.q('SELECT balance_cents FROM accounts WHERE system_code = $1', [code])).rows[0].balance_cents;
async function stepped(user) {
  const c = await signIn(env.base, ...user);
  const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
  return c;
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

// Nizam's seeded payees have only an address (paid by check); "Metro Water" gets an account number (paid electronically).
let NZ, CHK, SAV, CHECK_PAYEE, E_PAYEE;
before(async () => {
  env = await testEnv();
  NZ = await stepped(NIZAM);
  CHK = await id('4471'); SAV = await id('9302');
  const pay = ok(await NZ.get('/api/pay'));
  CHECK_PAYEE = pay.payees.find(p => p.name === 'City Power & Light').id;
  E_PAYEE = ok(await NZ.post('/api/pay/payees', { name: 'Metro Water', accountNumber: '000987654321' })).payee.id;
});
after(async () => { await env.close(); });

const create = (c, over = {}) => c.post('/api/billpay/schedules', { idempotencyKey: key(), payeeId: E_PAYEE, fromAccountId: CHK, amountCents: 1000,
  frequency: 'once', startDate: '2027-03-12', ...over });
const cancelAll = async () => {
  for (const s of ok(await NZ.get('/api/billpay/schedules?status=active')).schedules) await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {});
};

test('calendar: the 2:00 pm CT cut-off instant follows daylight saving; occurrences keep the start day', () => {
  assert.equal(cutoffAt('billpay', '2027-03-12').toISOString(), '2027-03-12T20:00:00.000Z');   // CST
  assert.equal(cutoffAt('billpay', '2027-03-15').toISOString(), '2027-03-15T19:00:00.000Z');   // CDT
  assert.equal(previousBusinessDay('2026-12-28'), '2026-12-24');                               // Monday after the Christmas Friday
  const m = { frequency: 'monthly', start_date: '2027-01-31', end_date: null, count: null };
  assert.deepEqual([0, 1, 2, 3, 13].map(k => occurrence(m, k)), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2028-02-29']);
  assert.equal(occurrence({ frequency: 'biweekly', start_date: '2027-03-12', end_date: '2027-03-26', count: null }, 1), '2027-03-26');
  assert.equal(occurrence({ frequency: 'biweekly', start_date: '2027-03-12', end_date: '2027-03-25', count: null }, 1), null);
  assert.equal(occurrence({ frequency: 'weekly', start_date: '2027-03-12', end_date: null, count: 2 }, 2), null);
  assert.equal(occurrence({ frequency: 'once', start_date: '2027-03-12', end_date: null, count: null }, 1), null);
});

test('R1: every endpoint needs a signed-in customer', async () => {
  const { client } = await import('../helpers.mjs');
  const c = client(env.base), x = '00000000-0000-4000-8000-0000000000aa';
  for (const [m, p] of [['POST', '/api/billpay/schedules'], ['GET', '/api/billpay/schedules'], ['GET', `/api/billpay/schedules/${x}`],
    ['POST', `/api/billpay/schedules/${x}/edit`], ['POST', `/api/billpay/schedules/${x}/cancel`], ['POST', '/api/billpay/run-due'],
    ['GET', `/api/billpay/availability/${x}`], ['GET', `/api/billpay/quote?payeeId=${x}&startDate=2027-03-12`]]) {
    const r = await c.call(m, p, {});
    assert.equal(r.status, 401, p); assert.equal(r.body.error, 'signed_out', p);
  }
});

test('R3, R13, R16-R18: create a schedule; its dates match the quote; nothing moves', async () => {
  at('2027-03-10T15:00:00Z');                                              // Wednesday 9:00 am CST
  const before = await bal('4471'), entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const qe = ok(await NZ.get(`/api/billpay/quote?payeeId=${E_PAYEE}&startDate=2027-03-13`));
  assert.deepEqual(qe, { method: 'electronic', sendOn: '2027-03-15', holdOn: '2027-03-12', deliverBy: '2027-03-16', editableUntil: '2027-03-15T19:00:00.000Z' });
  const r = ok(await create(NZ, { startDate: '2027-03-13', memo: '  Water bill  ' }));
  assert.equal(r.replayed, false);
  const s = r.schedule;
  assert.equal(s.payeeName, 'Metro Water'); assert.equal(s.method, 'electronic'); assert.equal(s.fromAccountId, CHK);
  assert.equal(s.amountCents, 1000); assert.equal(s.frequency, 'once'); assert.equal(s.startDate, '2027-03-13');
  assert.equal(s.endDate, null); assert.equal(s.count, null); assert.equal(s.memo, 'Water bill'); assert.equal(s.status, 'active');
  assert.equal(s.paymentsSent, 0); assert.equal(s.paymentsFailed, 0);
  const p = s.nextPayment;
  assert.deepEqual({ ...p, id: undefined, scheduleId: undefined }, { id: undefined, scheduleId: undefined, sequence: 1, scheduledFor: '2027-03-13', sendOn: '2027-03-15',
    holdOn: '2027-03-12', deliverBy: '2027-03-16', editableUntil: '2027-03-15T19:00:00.000Z', amountCents: 1000, status: 'scheduled', holdCents: 0, attempts: 0,
    sentOn: null, entryId: null, feeCents: 0, failureCode: null });
  // a payee paid by check: 5 business days; a Friday send date (before the clocks change) cuts off at 20:00 UTC
  const qc = ok(await NZ.get(`/api/billpay/quote?payeeId=${CHECK_PAYEE}&startDate=2027-03-12`));
  assert.deepEqual(qc, { method: 'check', sendOn: '2027-03-12', holdOn: '2027-03-11', deliverBy: '2027-03-19', editableUntil: '2027-03-12T20:00:00.000Z' });
  const c2 = ok(await create(NZ, { payeeId: CHECK_PAYEE, frequency: 'monthly', startDate: '2027-03-12', count: 3 })).schedule;
  assert.equal(c2.method, 'check'); assert.equal(c2.nextPayment.deliverBy, '2027-03-19'); assert.equal(c2.count, 3);
  const list = ok(await NZ.get('/api/billpay/schedules')).schedules;
  assert.deepEqual(list.slice(0, 2).map(x => x.id), [c2.id, s.id]);                                    // newest first
  assert.ok(ok(await NZ.get('/api/billpay/schedules?status=active')).schedules.some(x => x.id === s.id));
  assert.equal(ok(await NZ.get('/api/billpay/schedules?status=canceled')).schedules.length, 0);
  assert.equal((await NZ.get('/api/billpay/schedules?status=done')).body.error, 'bad_status');
  const d = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.equal(d.schedule.id, s.id); assert.deepEqual(d.payments.map(x => x.id), [p.id]);
  assert.equal(await bal('4471'), before);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  const a = (await env.q("SELECT detail FROM audit_events WHERE action = 'billpay.schedule_create' AND detail->>'schedule' = $1", [s.id])).rows;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].detail.payee, a[0].detail.amountCents, a[0].detail.frequency, a[0].detail.startDate], [E_PAYEE, 1000, 'once', '2027-03-13']);
  await cancelAll();
});

test('R4-R10, R12: request checks, in order', async () => {
  at('2027-03-10T15:00:00Z');
  const err = async (over, status, code, c = NZ) => { const r = await create(c, over); assert.equal(r.status, status, JSON.stringify([over, r.body])); assert.equal(r.body.error, code, JSON.stringify(over)); return r.body; };
  await err({ idempotencyKey: 'short' }, 400, 'idempotency_key_required');
  for (const v of [undefined, null, '1000', 10.5, 0, -1, 10_000_000_001, true, [1], { a: 1 }]) await err({ amountCents: v }, 400, 'bad_amount');
  await err({ frequency: 'daily' }, 400, 'bad_frequency');
  await err({ frequency: 'Weekly' }, 400, 'bad_frequency');
  for (const d of ['2027-03-09', '2028-03-10', '2027-02-30', 20270312, undefined]) await err({ startDate: d }, 400, 'bad_date');
  assert.equal(ok(await create(NZ, { startDate: '2028-03-09' })).schedule.startDate, '2028-03-09');   // today + 365 is allowed
  await err({ count: 2 }, 400, 'bad_end');
  await err({ endDate: '2027-04-01' }, 400, 'bad_end');
  await err({ frequency: 'weekly', count: 2, endDate: '2027-04-01' }, 400, 'bad_end');
  await err({ frequency: 'weekly', endDate: '2027-03-11' }, 400, 'bad_end');
  for (const v of [0, 521, 2.5, '3']) await err({ frequency: 'weekly', count: v }, 400, 'bad_end');
  await err({ memo: 'x'.repeat(141) }, 400, 'bad_memo');
  await err({ memo: 5 }, 400, 'bad_memo');
  await err({ payeeId: undefined }, 400, 'bad_payee');
  await err({ payeeId: 7 }, 400, 'bad_payee');
  await err({ fromAccountId: undefined }, 400, 'bad_account');
  await err({ payeeId: 'nope' }, 404, 'not_found');
  await err({ payeeId: '00000000-0000-4000-8000-0000000000aa' }, 404, 'not_found');
  await err({ fromAccountId: 'nope' }, 404, 'not_found');
  await err({ fromAccountId: await id('5120') }, 404, 'not_found');                // custodian of a minor's account
  await err({ fromAccountId: await id('3388') }, 404, 'not_found');                // Jordan's account
  await err({ fromAccountId: await id('0088') }, 400, 'bad_account');              // a credit card
  // order: amount before frequency before date ... ; payee before account; step-up before the per-payment maximum
  await err({ amountCents: 0, frequency: 'x', startDate: 'x' }, 400, 'bad_amount');
  await err({ frequency: 'x', startDate: 'x' }, 400, 'bad_frequency');
  await err({ payeeId: undefined, fromAccountId: undefined }, 400, 'bad_payee');
  await err({ payeeId: 'nope', fromAccountId: 'nope' }, 404, 'not_found');
  const plain = await signIn(env.base, ...NIZAM);                                 // no recent step-up
  await err({ amountCents: 500_001 }, 403, 'stepup_required', plain);
  await err({}, 403, 'stepup_required', plain);
  const over = await err({ amountCents: 500_001 }, 422, 'over_limit');
  assert.equal(over.limit, 'per_payment');
  ok(await create(NZ, { amountCents: 500_000 }));                                   // exactly the maximum is allowed
  // a closed account
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [SAV]);
  await err({ fromAccountId: SAV }, 409, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [SAV]);
  // a removed payee
  const gone = ok(await NZ.post('/api/pay/payees', { name: 'Old Gym', address: '9 Elm St' })).payee.id;
  ok(await NZ.del(`/api/pay/payees/${gone}`, {}));
  await err({ payeeId: gone }, 404, 'not_found');
  assert.equal((await env.q("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'billpay.schedule_create'")).rows[0].n,
    (await env.q('SELECT count(*)::int n FROM billpay_schedules')).rows[0].n);
  await cancelAll();
});

test('R11: request ids replay across sessions, conflict on a different request, and race to one schedule', async () => {
  at('2027-03-10T15:00:00Z');
  const k = key(), body = { idempotencyKey: k, payeeId: E_PAYEE, fromAccountId: CHK, amountCents: 2000, frequency: 'weekly', startDate: '2027-03-12', count: 2 };
  const a = ok(await NZ.post('/api/billpay/schedules', body));
  const other = await signIn(env.base, ...NIZAM);                                  // another session, without step-up
  const b = ok(await other.post('/api/billpay/schedules', body));
  assert.equal(b.replayed, true); assert.equal(b.schedule.id, a.schedule.id);
  const x = await other.post('/api/billpay/schedules', { ...body, amountCents: 2001 });
  assert.equal(x.status, 422); assert.equal(x.body.error, 'idempotency_conflict');
  assert.equal((await env.q('SELECT count(*)::int n FROM billpay_schedules WHERE id = $1 AND amount_cents = 2000', [a.schedule.id])).rows[0].n, 1);
  // another customer may use the same key string
  const jordan = await stepped(JORDAN);
  const jp = ok(await jordan.post('/api/pay/payees', { name: 'Jordan Power', address: '1 Main St' })).payee.id;
  const j = ok(await jordan.post('/api/billpay/schedules', { ...body, payeeId: jp, fromAccountId: await id('3388') }));
  assert.equal(j.replayed, false); assert.notEqual(j.schedule.id, a.schedule.id);
  // simultaneous identical requests: one schedule
  const race = { ...body, idempotencyKey: key() };
  const rs = await Promise.all([1, 2, 3, 4].map(() => NZ.post('/api/billpay/schedules', race)));
  rs.forEach(r => assert.equal(r.status, 200));
  assert.equal(new Set(rs.map(r => r.body.schedule.id)).size, 1);
  assert.equal(rs.filter(r => !r.body.replayed).length, 1);
  await cancelAll();
  ok(await jordan.post(`/api/billpay/schedules/${j.schedule.id}/cancel`, {}));
});

test('R15, R16: the first-day cut-off is 14:00 bank time exactly; today is the bank date at 11:30 pm', async () => {
  const q = async d => ok(await NZ.get(`/api/billpay/quote?payeeId=${E_PAYEE}&startDate=${d}`));
  at('2027-03-12T19:59:59.999Z');                                           // Friday 1:59:59 pm CST
  assert.equal((await q('2027-03-12')).sendOn, '2027-03-12');
  const s1 = ok(await create(NZ, { startDate: '2027-03-12' })).schedule;
  assert.equal(s1.nextPayment.sendOn, '2027-03-12'); assert.equal(s1.nextPayment.holdCents, 1000);   // hold date (Thursday) has passed
  at('2027-03-12T20:00:00.000Z');                                           // 2:00 pm CST
  const s2 = ok(await create(NZ, { startDate: '2027-03-12' })).schedule;
  assert.deepEqual([s2.nextPayment.scheduledFor, s2.nextPayment.sendOn, s2.nextPayment.holdOn], ['2027-03-12', '2027-03-15', '2027-03-12']);
  assert.equal(s2.nextPayment.editableUntil, '2027-03-15T19:00:00.000Z');
  assert.equal((await q('2027-03-16')).sendOn, '2027-03-16');               // a later start date is not affected by the time of day
  at('2027-07-02T18:59:00Z');                                               // summer: 1:59 pm CDT on a Friday before a holiday Monday
  assert.equal((await q('2027-07-02')).sendOn, '2027-07-02');
  at('2027-07-02T19:00:00Z');                                               // 2:00 pm CDT
  assert.deepEqual(await q('2027-07-02'), { method: 'electronic', sendOn: '2027-07-06', holdOn: '2027-07-02', deliverBy: '2027-07-07', editableUntil: '2027-07-06T19:00:00.000Z' });
  at('2027-03-13T05:30:00Z');                                               // 11:30 pm CST on Friday 2027-03-12
  assert.equal((await q('2027-03-12')).sendOn, '2027-03-15');
  assert.equal((await NZ.get(`/api/billpay/quote?payeeId=${E_PAYEE}&startDate=2027-03-11`)).body.error, 'bad_date');
  // quote checks: the date first, then the payee
  assert.equal((await NZ.get(`/api/billpay/quote?startDate=2027-03-11`)).body.error, 'bad_date');
  assert.equal((await NZ.get(`/api/billpay/quote?startDate=2027-03-15`)).body.error, 'bad_payee');
  assert.equal((await NZ.get(`/api/billpay/quote?payeeId=nope&startDate=2027-03-15`)).status, 404);
  at('2026-12-21T15:00:00Z');                                               // R17: a Monday send date after a Friday holiday holds from Thursday
  assert.equal((await q('2026-12-26')).holdOn, '2026-12-24');
  at('2027-03-12T15:00:00Z');
  await cancelAll();
});

test('R22, R23: holds show on availability and keep /api/pay transfers and wires from spending held money', async () => {
  at('2027-03-11T15:00:00Z');                                               // Thursday: a Friday payment is held from today
  const av0 = ok(await NZ.get(`/api/billpay/availability/${CHK}`));
  assert.equal(av0.availableCents, av0.balanceCents - av0.heldCents);
  const amount = 50_000;
  const s = ok(await create(NZ, { amountCents: amount, startDate: '2027-03-12' })).schedule;
  const later = ok(await create(NZ, { amountCents: 700, startDate: '2027-03-17' })).schedule;     // held only from 03-16
  assert.equal(s.nextPayment.holdCents, amount); assert.equal(later.nextPayment.holdCents, 0);
  const av = ok(await NZ.get(`/api/billpay/availability/${CHK}`));
  assert.equal(av.heldCents, av0.heldCents + amount); assert.equal(av.balanceCents, av0.balanceCents);
  assert.equal(av.availableCents, av.balanceCents - av.heldCents);
  const dollars = c => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  const tr = cents => NZ.post('/api/pay/transfers', { fromAccountId: CHK, toAccountId: SAV, amount: dollars(cents), idempotencyKey: key() });
  const refused = await tr(av.availableCents + 1);
  assert.equal(refused.status, 409); assert.equal(refused.body.error, 'insufficient_funds');
  assert.match(refused.body.message, /held for scheduled bill payments/);
  const wire = await NZ.post('/api/pay/wires', { fromAccountId: CHK, amount: dollars(av.availableCents - 2499), recipientName: 'A', bankName: 'B', routing: '123456780',
    accountNumber: '12345678', confirmIrrevocable: true, idempotencyKey: key() });           // + the $25 fee is one cent too much
  assert.equal(wire.status, 409); assert.equal(wire.body.error, 'insufficient_funds');
  assert.equal(await bal('4471'), BigInt(av.balanceCents));
  ok(await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {}));                             // the hold is gone
  const moved = ok(await tr(av.availableCents + 1));
  assert.equal(moved.transfer.status, 'completed');
  ok(await NZ.post('/api/pay/transfers', { fromAccountId: SAV, toAccountId: CHK, amount: dollars(av.availableCents + 1), idempotencyKey: key() }));
  // a joint owner sees the holds on a shared account, whoever scheduled them
  const joint = await id('7781');
  const js = ok(await create(NZ, { fromAccountId: joint, amountCents: 1234, startDate: '2027-03-12' })).schedule;
  const jordan = await signIn(env.base, ...JORDAN);
  assert.equal(ok(await jordan.get(`/api/billpay/availability/${joint}`)).heldCents, 1234);
  assert.equal((await jordan.get(`/api/billpay/schedules/${js.id}`)).status, 404);
  await cancelAll();
  assert.equal(ok(await NZ.get(`/api/billpay/availability/${CHK}`)).heldCents, 0);
});

test('R2: only your own schedules and accounts', async () => {
  at('2027-03-10T15:00:00Z');
  const s = ok(await create(NZ)).schedule;
  const jordan = await stepped(JORDAN);
  for (const [m, p, b] of [['GET', `/api/billpay/schedules/${s.id}`], ['POST', `/api/billpay/schedules/${s.id}/edit`, { amountCents: 5 }], ['POST', `/api/billpay/schedules/${s.id}/cancel`, {}],
    ['GET', '/api/billpay/schedules/not-a-uuid'], ['GET', '/api/billpay/schedules/00000000-0000-4000-8000-0000000000aa']]) {
    const r = await jordan.call(m, p, b);
    assert.equal(r.status, 404, p); assert.equal(r.body.error, 'not_found', p);
  }
  assert.ok(!ok(await jordan.get('/api/billpay/schedules')).schedules.some(x => x.id === s.id));
  for (const a of [await id('3388'), await id('5120'), 'nope', '00000000-0000-4000-8000-0000000000aa'])   // Jordan's, custodian of a minor's, malformed, unknown
    assert.equal((await NZ.get(`/api/billpay/availability/${a}`)).body.error, 'not_found', a);
  assert.equal(ok(await NZ.get(`/api/billpay/availability/${CHK}`)).accountId, CHK);
  at('2027-03-12T20:00:00Z');
  assert.equal(ok(await jordan.post('/api/billpay/run-due', {})).payments.length, 0);      // never another customer's payments
  const d = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.equal(d.schedule.status, 'active'); assert.equal(d.schedule.amountCents, 1000);
  at('2027-03-10T15:00:00Z');
  await cancelAll();
});

test('R24-R27, R31, R33, R38-R40: run-due sends from the cut-off, once, and /api/pay/run-due pays it out', async () => {
  at('2027-03-10T15:00:00Z');
  const s = ok(await create(NZ, { amountCents: 12_550, startDate: '2027-03-12', memo: 'Electric' })).schedule;
  const chk0 = await bal('4471'), bp0 = await sysBal('mm_billpay'), net0 = await sysBal('mm_network');
  const lim0 = ok(await NZ.get('/api/pay/limits')).limits.find(l => l.rail === 'billpay');
  at('2027-03-12T19:59:00Z');                                               // 1:59 pm: not yet
  assert.deepEqual(ok(await NZ.post('/api/billpay/run-due', {})), { payments: [], sent: 0, retrying: 0, failed: 0 });
  assert.equal(ok(await NZ.get('/api/pay/limits')).limits.find(l => l.rail === 'billpay').usedToday, '0.00');
  at('2027-03-12T20:00:00Z');                                               // 2:00 pm: due; edits are closed even before run-due
  assert.equal((await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {})).body.error, 'cutoff_passed');
  assert.equal((await NZ.post(`/api/billpay/schedules/${s.id}/edit`, { memo: 'x' })).body.error, 'cutoff_passed');
  const runs = await Promise.all([1, 2, 3].map(() => NZ.post('/api/billpay/run-due', {})));          // R26: at the same moment
  const all = runs.flatMap(r => ok(r).payments);
  assert.equal(all.length, 1);
  const p = all[0];
  assert.deepEqual([p.status, p.attempts, p.sentOn, p.deliverBy, p.holdCents, p.editableUntil, p.failureCode], ['sent', 1, '2027-03-12', '2027-03-15', 0, null, null]);
  assert.equal(runs.reduce((x, r) => x + r.body.sent, 0), 1);
  const lines = (await env.q('SELECT l.account_id, l.amount_cents, l.description, l.category, l.posted_on, e.kind, e.memo, e.idempotency_key FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.id = $1 ORDER BY l.amount_cents', [p.entryId])).rows;
  const userId = (await env.q("SELECT id FROM users WHERE username = 'nizam@helixbots.ai'")).rows[0].id;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].idempotency_key, `${userId}:billpay-schedules:${p.id}:send`);
  assert.deepEqual([lines[0].kind, lines[0].memo, lines[0].account_id, lines[0].amount_cents, lines[0].category, lines[0].description, lines[0].posted_on],
    ['bill_pay', 'Electric', CHK, -12550n, 'Bills & Utilities', 'Bill pay: Metro Water', '2027-03-12']);
  assert.deepEqual([lines[1].amount_cents, lines[1].description], [12550n, 'Bill pay: Metro Water']);
  assert.equal(await bal('4471'), chk0 - 12550n); assert.equal(await sysBal('mm_billpay'), bp0 + 12550n);
  const t = (await env.q('SELECT * FROM transfers WHERE entry_id = $1', [p.entryId])).rows;
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].rail, t[0].status, t[0].payee_id, t[0].amount_cents, t[0].process_on, t[0].settles_on, t[0].booked_on, t[0].idempotency_key],
    ['billpay', 'sent', E_PAYEE, 12550n, '2027-03-12', '2027-03-15', '2027-03-12', lines[0].idempotency_key]);
  assert.equal((await env.q('SELECT count(*)::int n FROM limit_usage WHERE transfer_id = $1', [t[0].id])).rows[0].n, 1);
  const lim = ok(await NZ.get('/api/pay/limits')).limits.find(l => l.rail === 'billpay');
  assert.equal(lim.usedToday, '125.50');
  assert.equal(Number(lim.usedMonth) * 100, Number(lim0.usedMonth) * 100 + 12550);
  const sched = ok(await NZ.get(`/api/billpay/schedules/${s.id}`)).schedule;
  assert.deepEqual([sched.status, sched.paymentsSent, sched.nextPayment], ['completed', 1, null]);
  const ev = (await env.q("SELECT user_id, detail FROM audit_events WHERE action = 'billpay.payment_sent' AND detail->>'payment' = $1", [p.id])).rows;
  assert.equal(ev.length, 1); assert.equal(ev[0].user_id, userId);
  assert.deepEqual([ev[0].detail.schedule, ev[0].detail.entry, ev[0].detail.amountCents, ev[0].detail.sentOn], [s.id, p.entryId, 12550, '2027-03-12']);
  const notes = ok(await NZ.get('/api/alerts')).items.filter(x => x.kind.startsWith('billpay_'));
  assert.equal(notes.filter(x => x.title === 'Bill payment sent: Metro Water').length, 1);
  assert.match(notes.find(x => x.kind === 'billpay_sent').body, /\$125\.50/);
  assert.equal(ok(await NZ.post('/api/billpay/run-due', {})).payments.length, 0);
  // R31: the existing run-due pays it out on its deliver-by day
  at('2027-03-15T15:00:00Z');
  ok(await NZ.post('/api/pay/run-due', {}));
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [t[0].id])).rows[0].status, 'paid');
  assert.equal(await sysBal('mm_billpay'), bp0); assert.equal(await sysBal('mm_network'), net0 + 12550n);
  // R38: every balance equals its lines
  const off = (await env.q(`SELECT a.id FROM accounts a WHERE a.balance_cents <> (SELECT coalesce(sum(amount_cents), 0) FROM ledger_lines WHERE account_id = a.id)`)).rows;
  assert.deepEqual(off, []);
});

test('R19, R21, R27: a weekly schedule catches up in one call, oldest first; a rolled date does not shift later ones', async () => {
  at('2027-11-20T15:00:00Z');
  const s = ok(await create(NZ, { frequency: 'weekly', startDate: '2027-11-25', count: 3, amountCents: 300 })).schedule;   // Thanksgiving
  assert.deepEqual([s.nextPayment.scheduledFor, s.nextPayment.sendOn, s.nextPayment.holdOn], ['2027-11-25', '2027-11-26', '2027-11-24']);
  const chk0 = await bal('4471');
  at('2027-12-11T16:00:00Z');                                               // Saturday, two weeks later
  const r = ok(await NZ.post('/api/billpay/run-due', {}));
  assert.deepEqual(r.payments.map(p => [p.sequence, p.scheduledFor, p.status, p.sentOn, p.deliverBy]), [
    [1, '2027-11-25', 'sent', '2027-12-11', '2027-12-13'], [2, '2027-12-02', 'sent', '2027-12-11', '2027-12-13'], [3, '2027-12-09', 'sent', '2027-12-11', '2027-12-13']]);
  assert.equal(new Set(r.payments.map(p => p.entryId)).size, 3);
  assert.equal(await bal('4471'), chk0 - 900n);
  const d = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.deepEqual([d.schedule.status, d.schedule.paymentsSent, d.payments.length], ['completed', 3, 3]);
  // biweekly with an end date: the occurrence dated on the end date is included even though it is sent later
  at('2027-12-13T15:00:00Z');
  const b = ok(await create(NZ, { frequency: 'biweekly', startDate: '2027-12-14', endDate: '2027-12-25', amountCents: 100 })).schedule;
  at('2027-12-31T21:00:00Z');
  const rb = ok(await NZ.post('/api/billpay/run-due', {}));
  assert.deepEqual(rb.payments.filter(p => p.scheduleId === b.id).map(p => p.scheduledFor), ['2027-12-14']);
  const db = ok(await NZ.get(`/api/billpay/schedules/${b.id}`));
  assert.equal(db.schedule.status, 'completed'); assert.equal(db.payments.length, 1);
  at('2027-12-13T15:00:00Z');
  const e = ok(await create(NZ, { frequency: 'biweekly', startDate: '2027-12-13', endDate: '2027-12-25', amountCents: 100 })).schedule;   // 12-27 is after the end date
  at('2027-12-27T21:00:00Z');
  ok(await NZ.post('/api/billpay/run-due', {}));
  assert.equal(ok(await NZ.get(`/api/billpay/schedules/${e.id}`)).payments.length, 1);
  at('2027-12-10T15:00:00Z');
  const f = ok(await create(NZ, { frequency: 'weekly', startDate: '2027-12-18', endDate: '2027-12-25', amountCents: 100 })).schedule;      // Saturdays
  at('2027-12-27T21:00:00Z');
  const rf = ok(await NZ.post('/api/billpay/run-due', {}));
  assert.deepEqual(rf.payments.filter(p => p.scheduleId === f.id).map(p => [p.scheduledFor, p.sentOn]), [['2027-12-18', '2027-12-27'], ['2027-12-25', '2027-12-27']]);
});

test('R20: monthly payments keep the start day, the last day of short months', async () => {
  at('2027-01-20T15:00:00Z');
  const s = ok(await create(NZ, { payeeId: CHECK_PAYEE, frequency: 'monthly', startDate: '2027-01-31', count: 4, amountCents: 200 })).schedule;
  assert.equal(s.nextPayment.sendOn, '2027-02-01');                          // the 31st is a Sunday
  at('2027-05-10T20:00:00Z');
  const r = ok(await NZ.post('/api/billpay/run-due', {}));
  assert.deepEqual(r.payments.filter(p => p.scheduleId === s.id).map(p => p.scheduledFor), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.ok(r.payments.every(p => p.deliverBy === '2027-05-17'));             // by check: 5 business days after sending
  assert.equal(ok(await NZ.get(`/api/billpay/schedules/${s.id}`)).schedule.status, 'completed');
});

test('R28, R29: too little money is retried once on the next business day, then fails with a fee; the schedule goes on', async () => {
  at('2027-04-01T15:00:00Z');                                               // Thursday
  const sav0 = await bal('9302'), fee0 = await sysBal('billpay_fees');
  assert.ok(sav0 < 500_000n);
  const s = ok(await create(NZ, { fromAccountId: SAV, frequency: 'weekly', startDate: '2027-04-02', count: 2, amountCents: 500_000 })).schedule;
  at('2027-04-02T19:30:00Z');                                               // Friday 2:30 pm CDT
  const r1 = ok(await NZ.post('/api/billpay/run-due', {}));
  assert.equal(r1.retrying, 1);
  const p1 = r1.payments[0];
  assert.deepEqual([p1.status, p1.attempts, p1.failureCode, p1.sendOn, p1.holdOn, p1.deliverBy, p1.editableUntil, p1.holdCents, p1.feeCents],
    ['retrying', 1, 'insufficient_funds', '2027-04-05', '2027-04-02', '2027-04-06', '2027-04-05T19:00:00.000Z', 500_000, 0]);
  assert.equal(await bal('9302'), sav0);
  assert.equal(ok(await NZ.get(`/api/billpay/availability/${SAV}`)).heldCents, 500_000);
  assert.equal(ok(await NZ.post('/api/billpay/run-due', {})).payments.length, 0);             // not again before the retry date
  at('2027-04-05T19:00:00Z');                                               // the retry date's cut-off
  const r2 = ok(await NZ.post('/api/billpay/run-due', {}));
  const p2 = r2.payments[0];
  assert.deepEqual([p2.id, p2.status, p2.attempts, p2.failureCode, p2.feeCents, p2.holdCents, p2.entryId], [p1.id, 'failed', 2, 'insufficient_funds', 1500, 0, null]);
  assert.equal(await bal('9302'), sav0 - 1500n); assert.equal(await sysBal('billpay_fees'), fee0 + 1500n);
  const userId = (await env.q("SELECT id FROM users WHERE username = 'nizam@helixbots.ai'")).rows[0].id;
  const fee = (await env.q(`SELECT e.kind, l.amount_cents, l.category, l.description, l.posted_on FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.amount_cents`, [`${userId}:billpay-schedules:${p1.id}:fee`])).rows;
  assert.deepEqual(fee.map(x => [x.kind, x.amount_cents, x.category, x.posted_on]), [['bill_pay_fee', -1500n, 'Fees & Charges', '2027-04-05'], ['bill_pay_fee', 1500n, null, '2027-04-05']]);
  assert.equal(fee[0].description, 'Insufficient funds fee: bill payment to Metro Water');
  const d = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.deepEqual([d.schedule.status, d.schedule.paymentsFailed, d.schedule.nextPayment.sequence, d.schedule.nextPayment.scheduledFor], ['active', 1, 2, '2027-04-09']);
  const acts = (await env.q("SELECT action, detail FROM audit_events WHERE detail->>'payment' = $1 ORDER BY id", [p1.id])).rows;
  assert.deepEqual(acts.map(a => a.action), ['billpay.schedule_create', 'billpay.payment_retry', 'billpay.payment_failed']);
  assert.deepEqual([acts[1].detail.reason, acts[1].detail.retryOn, acts[2].detail.reason, acts[2].detail.feeCents], ['insufficient_funds', '2027-04-05', 'insufficient_funds', 1500]);
  const notes = ok(await NZ.get('/api/alerts')).items.filter(x => x.kind === 'billpay_retry' || x.kind === 'billpay_failed');
  assert.deepEqual(notes.map(x => x.title), ['Bill payment failed: Metro Water', 'Bill payment will be retried: Metro Water']);
  assert.ok(notes.every(x => x.body.includes('$5,000.00')));
  ok(await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {}));
  // a retry that finds the money is sent; a fee never takes more than the balance
  const jordan = await stepped(JORDAN), jchk = await id('3388');
  const jp = ok(await jordan.post('/api/pay/payees', { name: 'Jordan Phone', accountNumber: '55551234' })).payee.id;
  at('2027-04-06T15:00:00Z');
  const jbal = await bal('3388');
  const js = ok(await jordan.post('/api/billpay/schedules', { idempotencyKey: key(), payeeId: jp, fromAccountId: jchk, amountCents: Number(jbal) + 100, frequency: 'once', startDate: '2027-04-06' })).schedule;
  at('2027-04-06T19:00:00Z');
  assert.equal(ok(await jordan.post('/api/billpay/run-due', {})).retrying, 1);
  // money arrives before the retry: sent on the retry date
  const extra = (await env.q("SELECT id FROM accounts WHERE system_code = 'equity'")).rows[0].id;
  const { tx } = await import('../../lib/db.mjs'), { post } = await import('../../lib/ledger.mjs');
  await tx(env.pool, c => post(c, { key: `test:${key()}`, kind: 'seed', lines: [{ accountId: jchk, amountCents: 200n, description: 'Deposit' }, { accountId: extra, amountCents: -200n, description: 'Deposit' }] }));
  at('2027-04-07T19:00:00Z');
  const sent = ok(await jordan.post('/api/billpay/run-due', {})).payments[0];
  assert.deepEqual([sent.scheduleId, sent.status, sent.attempts, sent.sentOn, sent.feeCents], [js.id, 'sent', 2, '2027-04-07', 0]);
  // a small balance: the fee is the whole balance
  at('2027-04-08T15:00:00Z');
  const left = await bal('3388');
  const js2 = ok(await jordan.post('/api/billpay/schedules', { idempotencyKey: key(), payeeId: jp, fromAccountId: jchk, amountCents: 250_000, frequency: 'once', startDate: '2027-04-08' })).schedule;
  for (const t of ['2027-04-08T19:00:00Z', '2027-04-09T19:00:00Z']) { at(t); ok(await jordan.post('/api/billpay/run-due', {})); }
  const f = ok(await jordan.get(`/api/billpay/schedules/${js2.id}`));
  assert.deepEqual([f.schedule.status, f.payments[0].status, f.payments[0].feeCents], ['completed', 'failed', Number(left < 1500n ? left : 1500n)]);
});

test('R30, R32, R33: removed payee, closed account and limits fail a payment at once, without a retry', async () => {
  at('2027-05-03T15:00:00Z');                                               // Monday
  const gone = ok(await NZ.post('/api/pay/payees', { name: 'Closing Co', address: '2 Oak St' })).payee.id;
  const a = ok(await create(NZ, { payeeId: gone, frequency: 'weekly', startDate: '2027-05-04', amountCents: 100 })).schedule;
  const b = ok(await create(NZ, { fromAccountId: SAV, frequency: 'weekly', startDate: '2027-05-04', count: 2, amountCents: 100 })).schedule;
  ok(await NZ.del(`/api/pay/payees/${gone}`, {}));
  // R32: the daily limit at creation counts the other open payments with the same send date
  ok(await NZ.call('PUT', '/api/pay/limits/billpay', { daily: '5.00', monthly: '5000.00' }));
  ok(await create(NZ, { startDate: '2027-05-04', amountCents: 300 }));                     // 100 + 100 + 300 = $5.00 exactly
  const over = await create(NZ, { startDate: '2027-05-04', amountCents: 1 });
  assert.equal(over.status, 422); assert.deepEqual([over.body.error, over.body.limit], ['over_limit', 'daily']);
  ok(await create(NZ, { startDate: '2027-05-05', amountCents: 500 }));
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [SAV]);
  at('2027-05-04T19:00:00Z');
  const r = ok(await NZ.post('/api/billpay/run-due', {}));
  const byId = Object.fromEntries(r.payments.map(p => [p.scheduleId, p]));
  assert.deepEqual([byId[a.id].status, byId[a.id].failureCode, byId[a.id].attempts, byId[a.id].feeCents], ['failed', 'payee_removed', 1, 0]);
  assert.deepEqual([byId[b.id].status, byId[b.id].failureCode], ['failed', 'account_not_open']);
  assert.equal(ok(await NZ.get(`/api/billpay/schedules/${a.id}`)).schedule.status, 'canceled');
  const bd = ok(await NZ.get(`/api/billpay/schedules/${b.id}`)).schedule;
  assert.deepEqual([bd.status, bd.paymentsFailed, bd.nextPayment.sequence], ['active', 1, 2]);
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [SAV]);
  // R33: at sending, what is left of the daily limit today (here: lowered after scheduling)
  at('2027-05-05T15:00:00Z');
  ok(await NZ.call('PUT', '/api/pay/limits/billpay', { daily: '4.99', monthly: '5000.00' }));
  at('2027-05-05T19:00:00Z');
  const r2 = ok(await NZ.post('/api/billpay/run-due', {}));
  const p = r2.payments.find(x => x.amountCents === 500);
  assert.deepEqual([p.status, p.failureCode, p.attempts], ['failed', 'over_limit', 1]);
  ok(await NZ.call('PUT', '/api/pay/limits/billpay', { daily: '10000.00', monthly: '25000.00' }));
  await cancelAll();
});

test('R34: run-due and /api/pay/bills at the same moment never pass the daily limit', async () => {
  at('2027-06-01T15:00:00Z');
  ok(await NZ.call('PUT', '/api/pay/limits/billpay', { daily: '10.00', monthly: '5000.00' }));
  ok(await create(NZ, { startDate: '2027-06-01', amountCents: 600 }));
  at('2027-06-01T19:00:00Z');
  const [run, bill] = await Promise.all([NZ.post('/api/billpay/run-due', {}),
    NZ.post('/api/pay/bills', { fromAccountId: CHK, payeeId: E_PAYEE, amount: '6.00', idempotencyKey: key() })]);
  assert.equal(run.status, 200);
  const sentOk = run.body.sent === 1, billOk = bill.status === 200;
  assert.ok(!(sentOk && billOk), 'both used the limit');
  assert.ok(sentOk || billOk);
  const lim = ok(await NZ.get('/api/pay/limits')).limits.find(l => l.rail === 'billpay');
  assert.equal(lim.usedToday, '6.00');
  ok(await NZ.call('PUT', '/api/pay/limits/billpay', { daily: '10000.00', monthly: '25000.00' }));
});

test('R35-R37: edit and cancel before the cut-off; step-up only to raise; order of checks', async () => {
  at('2027-06-07T15:00:00Z');                                               // Monday
  const s = ok(await create(NZ, { frequency: 'weekly', startDate: '2027-06-09', amountCents: 1000, memo: 'Water' })).schedule;
  const plain = await signIn(env.base, ...NIZAM);
  const edit = (c, b) => c.post(`/api/billpay/schedules/${s.id}/edit`, b);
  const audits = async () => (await env.q("SELECT count(*)::int n FROM audit_events WHERE action = 'billpay.schedule_edit' AND detail->>'schedule' = $1", [s.id])).rows[0].n;
  assert.equal((await edit(plain, {})).body.error, 'bad_edit');
  assert.equal((await edit(plain, { amountCents: 0 })).body.error, 'bad_amount');
  assert.equal((await edit(plain, { memo: 'x'.repeat(141) })).body.error, 'bad_memo');
  assert.equal((await edit(plain, { amountCents: 1001 })).body.error, 'stepup_required');
  ok(await edit(plain, { amountCents: 1000, memo: 'Water' }));                            // no change: no audit
  assert.equal(await audits(), 0);
  const low = ok(await edit(plain, { amountCents: 900 })).schedule;                       // lowering needs no code
  assert.deepEqual([low.amountCents, low.nextPayment.amountCents, low.memo], [900, 900, 'Water']);
  ok(await edit(plain, { memo: '  ' }));
  assert.equal(ok(await NZ.get(`/api/billpay/schedules/${s.id}`)).schedule.memo, null);
  const over = await edit(NZ, { amountCents: 500_001 });
  assert.deepEqual([over.status, over.body.error, over.body.limit], [422, 'over_limit', 'per_payment']);
  const up = ok(await edit(NZ, { amountCents: 1500 })).schedule;
  assert.equal(up.nextPayment.amountCents, 1500);
  assert.equal(await audits(), 3);
  const ev = (await env.q("SELECT detail FROM audit_events WHERE action = 'billpay.schedule_edit' AND detail->>'schedule' = $1 ORDER BY id DESC LIMIT 1", [s.id])).rows[0];
  assert.equal(ev.detail.amountCents, 1500);
  // the sent payment keeps its amount; the next one takes the new amount
  at('2027-06-09T19:00:00Z');
  ok(await NZ.post('/api/billpay/run-due', {}));
  at('2027-06-10T15:00:00Z');
  ok(await edit(NZ, { amountCents: 1200 }));
  const d = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.deepEqual(d.payments.map(p => [p.sequence, p.amountCents, p.status]), [[1, 1500, 'sent'], [2, 1200, 'scheduled']]);
  at('2027-06-16T18:59:59Z');                                               // 1:59:59 pm CDT: still possible
  const c = ok(await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {})).schedule;
  assert.deepEqual([c.status, c.nextPayment], ['canceled', null]);
  const after = ok(await NZ.get(`/api/billpay/schedules/${s.id}`));
  assert.deepEqual(after.payments.map(p => [p.status, p.holdCents]), [['sent', 0], ['canceled', 0]]);
  assert.equal((await NZ.post(`/api/billpay/schedules/${s.id}/cancel`, {})).body.error, 'invalid_state');
  assert.equal((await edit(NZ, { amountCents: 5 })).body.error, 'invalid_state');
  assert.equal((await edit(NZ, {})).body.error, 'bad_edit');                                // field checks come first
  const ca = (await env.q("SELECT detail FROM audit_events WHERE action = 'billpay.schedule_cancel' AND detail->>'schedule' = $1", [s.id])).rows;
  assert.deepEqual(ca.map(x => x.detail.payment), [d.payments[1].id]);
  at('2027-06-23T20:00:00Z');
  assert.ok(!ok(await NZ.post('/api/billpay/run-due', {})).payments.some(p => p.scheduleId === s.id));
});
