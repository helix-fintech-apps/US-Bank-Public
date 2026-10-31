// Personal loan servicing (/api/loan-servicing): taking out a loan, the 30/360 schedule with its remainder, scheduled,
// early, late and extra payments, late fees, payoff quotes and payoff, request ids, access, ledger and audit records.
// The bank clock is moved with clock.now (lib/bank-date.mjs); each test uses fresh customers so figures are exact.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { clock, addDays } from '../../lib/bank-date.mjs';
import { monthlyPayment } from '../../lib/loans-credit/amortize.mjs';
import { days360, dueDate, lateFee, accrue, DENOM } from '../../lib/loan-servicing/math.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const on = date => { clock.now = () => new Date(`${date}T18:00:00Z`); };      // noon Central: that bank date

const API = '/api/loan-servicing/loans';
let n = 0;
const key = () => `ls-key-${++n}-${Date.now()}`;
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const count = async (sql, args) => (await env.q(`SELECT count(*)::int n FROM ${sql}`, args)).rows[0].n;
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}
/** A fresh customer (mfa off) with a funded checking account, signed in and stepped up. */
async function customer(name, { funds = 100_000_00n, stepped = true } = {}) {
  const username = `${name.toLowerCase()}-${n++}@loan-servicing.test`, uid = newId(), chk = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,'55')`,
      [uid, username, name, await hashPassword('pw-' + name)]);
    await c.query(`INSERT INTO accounts (id, kind, name) VALUES ($1,'checking','Smart Checking')`, [chk]);
    await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [chk, uid]);
    if (funds) await fund(c, chk, funds);
  });
  const c = await signIn(env.base, username, 'pw-' + name);
  if (stepped) await stepUp(c);
  return { c, uid, chk, username, password: 'pw-' + name };
}
async function fund(c, accountId, cents) {
  await post(c, { key: `test:fund:${newId()}`, kind: 'seed', lines: [{ accountId, amountCents: cents, description: 'Opening deposit' },
    { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Opening deposit' }] });
}
async function account(owner, { kind = 'checking', role = 'owner', status = 'open', funds = 0n, also = [] } = {}) {
  const id = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO accounts (id, kind, name, status, allow_negative) VALUES ($1,$2,'Test account',$3,$4)`, [id, kind, status, kind === 'loan' || kind === 'credit_card']);
    await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, owner.uid, role]);
    for (const [who, r] of also) await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, who.uid, r]);
    if (funds) await fund(c, id, funds);
  });
  return id;
}
const TERMS = { principalCents: 1_000_000, aprBps: 774, termMonths: 36, paymentDay: 15 };
const open = (who, body = {}) => who.c.post(API, { idempotencyKey: key(), ...TERMS, disbursementAccountId: who.chk, ...body });
async function loanOf(who, body) { const r = await open(who, body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.loan; }
const pay = (who, loan, body) => who.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: key(), kind: 'scheduled', fromAccountId: who.chk, ...body });
async function paid(who, loan, body) { const r = await pay(who, loan, body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
const detail = async (who, loan) => (await who.c.get(`${API}/${loan.id}`)).body.loan;
const sched = async (who, loan) => (await who.c.get(`${API}/${loan.id}/schedule`)).body;
const quote = (who, loan, goodThrough) => who.c.post(`${API}/${loan.id}/payoff-quotes`, { goodThrough });
const payoff = (who, loan, quoteId, body = {}) => who.c.post(`${API}/${loan.id}/payoff`, { idempotencyKey: key(), quoteId, fromAccountId: who.chk, ...body });
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, code); assert.equal(typeof r.body.message, 'string'); };
const loansOf = who => count('personal_loans WHERE user_id = $1', [who.uid]);
const audits = (loanId, action) => env.q("SELECT * FROM audit_events WHERE detail->>'loan' = $1 AND action = $2 ORDER BY id", [loanId, action]).then(r => r.rows);

// ---------- arithmetic (section 5) ----------
test('5.5 days360, 5.4 due dates, 5.7 late fee, 5.3 payment: the worked examples', () => {
  for (const [a, b, d] of [['2027-03-10', '2027-04-15', 35], ['2027-04-15', '2027-05-15', 30], ['2027-01-31', '2027-02-01', 1], ['2027-02-28', '2027-03-01', 3],
    ['2027-03-15', '2027-03-31', 16], ['2027-03-30', '2027-03-31', 0], ['2027-12-31', '2028-01-31', 30], ['2027-03-31', '2027-04-30', 30]]) assert.equal(days360(a, b), d, `${a} to ${b}`);
  const t = { originatedOn: '2027-03-10', paymentDay: 15 };
  assert.equal(dueDate(t, 1), '2027-04-15'); assert.equal(dueDate(t, 2), '2027-05-15'); assert.equal(dueDate(t, 12), '2028-03-15');
  assert.equal(dueDate({ originatedOn: '2027-03-31', paymentDay: 1 }, 1), '2027-04-01');
  assert.equal(dueDate({ originatedOn: '2027-11-20', paymentDay: 28 }, 3), '2028-02-28');
  assert.equal(lateFee(9670n), 484n); assert.equal(lateFee(50000n), 2500n); assert.equal(lateFee(49990n), 2500n); assert.equal(lateFee(31217n), 1561n);   // 1560.85 → 1561
  assert.equal(monthlyPayment(1000000n, 774, 36), 31217n); assert.equal(monthlyPayment(2500000n, 2499, 84), 63263n); assert.equal(monthlyPayment(100000n, 774, 12), 8687n);
});

test('R13: accruing in pieces carries the fraction of a cent, so the total is the whole period rounded down', () => {
  const t = { aprBps: 1999 }, s = { P: 1234567n, I: 0n, R: 0n, AT: '2027-01-01' };
  const days = ['2027-01-02', '2027-01-03', '2027-01-17', '2027-01-31', '2027-02-01', '2027-02-28', '2027-03-01', '2027-03-31', '2027-06-30', '2027-12-31', '2028-01-01'];
  let total = 0, from = s.AT;
  for (const d of days) { total += days360(from, d); from = d; accrue(t, s, d); }
  assert.equal(total, 362);                                                           // 30/360 periods: 2027-01-31 → 02-01 counts 1, 02-28 → 03-01 counts 3
  const whole = 1234567n * 1999n * BigInt(total);
  assert.equal(s.I, whole / DENOM); assert.equal(s.R, whole % DENOM);
  const back = { ...s }; accrue(t, back, '2027-06-01');
  assert.deepEqual(back, s, 'a date not later than AT changes nothing');
});

// ---------- access ----------
test('R1: all eight endpoints need a signed-in session', async () => {
  const anon = client(env.base), id = newId();
  for (const [m, p] of [['POST', API], ['GET', API], ['GET', `${API}/${id}`], ['GET', `${API}/${id}/schedule`], ['POST', `${API}/${id}/payments`],
    ['GET', `${API}/${id}/payments`], ['POST', `${API}/${id}/payoff-quotes`], ['POST', `${API}/${id}/payoff`]]) {
    const r = await anon.call(m, p, m === 'GET' ? undefined : { idempotencyKey: key() });
    err(r, 401, 'signed_out');
  }
});

test('R2: only the borrower reaches a loan, even a joint owner of the account it was paid into', async () => {
  const a = await customer('Ana'), b = await customer('Ben');
  const joint = await account(a, { funds: 10n, also: [[b, 'joint_owner']] });
  on('2027-03-10');
  const loan = await loanOf(a, { disbursementAccountId: joint });
  const before = await detail(a, loan);
  const qa = (await quote(a, loan, '2027-03-20')).body.quote;
  for (const id of [loan.id, newId(), 'not-a-uuid', loan.id.toUpperCase().replace(/-/g, '')]) {
    for (const [m, p, body] of [['GET', `${API}/${id}`], ['GET', `${API}/${id}/schedule`], ['GET', `${API}/${id}/payments`],
      ['POST', `${API}/${id}/payments`, { idempotencyKey: key(), kind: 'extra', amountCents: 100, fromAccountId: joint }],
      ['POST', `${API}/${id}/payoff-quotes`, { goodThrough: '2027-03-20' }],
      ['POST', `${API}/${id}/payoff`, { idempotencyKey: key(), quoteId: qa.id, fromAccountId: joint }]]) err(await b.c.call(m, p, body), 404, 'not_found');
  }
  assert.deepEqual((await b.c.get(API)).body.loans, []);
  assert.deepEqual(await detail(a, loan), before);
  assert.equal(await count('personal_loan_payments WHERE loan_id = $1', [loan.id]), 0);
  // the borrower may pay from the joint account (R24)
  const r = await pay(a, loan, { kind: 'extra', amountCents: 5, fromAccountId: joint });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

// ---------- taking out a loan ----------
test('R3, R10, R11, R14, R32, R34: taking out a loan opens the account, pays it in, and shows the worked schedule', async () => {
  const a = await customer('Cy');
  on('2027-03-10');
  const before = await bal(a.chk), k = key();
  const r = await a.c.post(API, { idempotencyKey: k, ...TERMS, disbursementAccountId: a.chk });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  const L = r.body.loan;
  assert.match(L.id, /^[0-9a-f-]{36}$/); assert.match(L.last4, /^\d{4}$/); assert.ok(!isNaN(Date.parse(L.createdAt)));
  const { id, last4, createdAt, ...rest } = L;
  assert.deepEqual(rest, { status: 'active', principalCents: 1000000, aprBps: 774, termMonths: 36, paymentDay: 15, paymentCents: 31217, lateFeeCents: 1561,
    originatedOn: '2027-03-10', firstDueDate: '2027-04-15', disbursementAccountId: a.chk, principalBalanceCents: 1000000, accruedInterestCents: 0, feesDueCents: 0,
    accruedThrough: '2027-03-10', installmentsPaid: 0, nextInstallment: { number: 1, dueDate: '2027-04-15' }, pastDue: false, paidOffOn: null });
  assert.equal(await bal(a.chk), before + 1000000n);
  const acct = (await env.q('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  assert.equal(acct.kind, 'loan'); assert.equal(acct.name, 'Personal Loan'); assert.equal(acct.status, 'open'); assert.equal(acct.allow_negative, true);
  assert.equal(acct.number_last4, last4); assert.equal(acct.balance_cents, -1000000n);
  assert.deepEqual((await env.q('SELECT user_id, role FROM account_owners WHERE account_id = $1', [id])).rows, [{ user_id: a.uid, role: 'owner' }]);
  assert.equal(await count('accounts WHERE number_last4 = $1', [last4]), 1);
  // ledger
  const e = (await env.q('SELECT * FROM journal_entries WHERE idempotency_key = $1', [`${a.uid}:loan-servicing:${k}`])).rows[0];
  assert.equal(e.kind, 'personal_loan_disbursement');
  const lines = (await env.q('SELECT account_id, amount_cents, description, category, posted_on FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents', [e.id])).rows;
  assert.deepEqual(lines, [
    { account_id: id, amount_cents: -1000000n, description: 'Personal loan opened', category: 'Loans', posted_on: '2027-03-10' },
    { account_id: a.chk, amount_cents: 1000000n, description: `Personal loan ··${last4} disbursement`, category: 'Loans', posted_on: '2027-03-10' }]);
  // audit
  const [ev] = await audits(id, 'loanservicing.open');
  assert.equal(ev.user_id, a.uid);
  assert.deepEqual(ev.detail, { loan: id, principalCents: 1000000, aprBps: 774, termMonths: 36, paymentDay: 15, paymentCents: 31217, entry: e.id });
  // list and detail
  assert.deepEqual((await a.c.get(API)).body, { loans: [L] });
  assert.deepEqual((await a.c.get(`${API}/${id}`)).body, { loan: L });
  // the schedule of 5.9
  const s = await sched(a, L);
  assert.equal(s.loanId, id); assert.equal(s.asOf, '2027-03-10'); assert.equal(s.rows.length, 36);
  assert.deepEqual(s.rows[0], { number: 1, dueDate: '2027-04-15', paymentCents: 31217, feeCents: 0, interestCents: 7525, principalCents: 23692, balanceAfterCents: 976308 });
  assert.equal(s.rows[1].interestCents, 6297); assert.equal(s.rows[1].dueDate, '2027-05-15');
  assert.deepEqual(s.rows[35], { number: 36, dueDate: '2030-03-15', paymentCents: 32545, feeCents: 0, interestCents: 209, principalCents: 32336, balanceAfterCents: 0 });
  assert.deepEqual(s.totals, { paymentsCents: 1125140, feesCents: 0, interestCents: 125140, principalCents: 1000000 });
  s.rows.forEach((row, i) => {
    assert.equal(row.number, i + 1); assert.equal(row.dueDate, dueDate({ originatedOn: '2027-03-10', paymentDay: 15 }, i + 1));
    if (i < 35) assert.equal(row.principalCents, 31217 - row.interestCents);
  });
});

test('R10: the regular payment at the edges of the limits', async () => {
  const a = await customer('Dee');
  on('2027-03-10');
  assert.equal((await loanOf(a, { principalCents: 2500000, aprBps: 2499, termMonths: 84 })).paymentCents, 63263);
  const small = await loanOf(a, { principalCents: 100000, aprBps: 774, termMonths: 12, paymentDay: 1 });
  assert.equal(small.paymentCents, 8687); assert.equal(small.lateFeeCents, 434); assert.equal(small.firstDueDate, '2027-04-01');
  assert.equal((await sched(a, small)).rows.length, 12);
});

test('R4, R5, R9: amount, rate, term, payment day and account are checked in order, and nothing is created', async () => {
  const a = await customer('Eve'), other = await customer('Fay');
  const viewer = await account(other, { also: [[a, 'viewer']] }), custodial = await account(other, { also: [[a, 'custodian']] });
  const card = await account(a, { kind: 'credit_card' }), cd = await account(a, { kind: 'cd' }), frozen = await account(a, { status: 'frozen' }), shut = await account(a, { status: 'closed' });
  const savings = await account(a, { kind: 'savings' }), mm = await account(a, { kind: 'money_market' });
  on('2027-03-10');
  const bad = [undefined, null, '1000000', 1000000.5, true, [1000000], { v: 1 }];
  const cases = [
    ...bad.map(v => [{ principalCents: v }, 400, 'bad_principal']), [{ principalCents: 99999 }, 400, 'bad_principal'], [{ principalCents: 2500001 }, 400, 'bad_principal'],
    ...bad.map(v => [{ aprBps: v }, 400, 'bad_apr']), [{ aprBps: 773 }, 400, 'bad_apr'], [{ aprBps: 2500 }, 400, 'bad_apr'],
    ...bad.map(v => [{ termMonths: v }, 400, 'bad_term']), [{ termMonths: 11 }, 400, 'bad_term'], [{ termMonths: 85 }, 400, 'bad_term'],
    ...bad.map(v => [{ paymentDay: v }, 400, 'bad_payment_day']), [{ paymentDay: 0 }, 400, 'bad_payment_day'], [{ paymentDay: 29 }, 400, 'bad_payment_day'],
    [{ disbursementAccountId: undefined }, 400, 'bad_account'], [{ disbursementAccountId: 7 }, 400, 'bad_account'], [{ disbursementAccountId: [a.chk] }, 400, 'bad_account'],
    [{ disbursementAccountId: newId() }, 404, 'not_found'], [{ disbursementAccountId: 'nope' }, 404, 'not_found'], [{ disbursementAccountId: other.chk }, 404, 'not_found'],
    [{ disbursementAccountId: viewer }, 404, 'not_found'], [{ disbursementAccountId: custodial }, 404, 'not_found'],
    [{ disbursementAccountId: card }, 400, 'bad_account'], [{ disbursementAccountId: cd }, 400, 'bad_account'],
    [{ disbursementAccountId: frozen }, 409, 'account_not_open'], [{ disbursementAccountId: shut }, 409, 'account_not_open'],
    // order: principal before rate before term before day before account
    [{ principalCents: 1, aprBps: 1, termMonths: 1, paymentDay: 99, disbursementAccountId: 3 }, 400, 'bad_principal'],
    [{ aprBps: 1, termMonths: 1, paymentDay: 99, disbursementAccountId: 3 }, 400, 'bad_apr'],
    [{ termMonths: 1, paymentDay: 99, disbursementAccountId: 3 }, 400, 'bad_term'],
    [{ paymentDay: 99, disbursementAccountId: 3 }, 400, 'bad_payment_day']];
  for (const [body, status, code] of cases) {
    const r = await a.c.post(API, { idempotencyKey: key(), ...TERMS, disbursementAccountId: a.chk, ...body });
    err(r, status, code);
  }
  err(await a.c.post(API, { ...TERMS, disbursementAccountId: a.chk }), 400, 'idempotency_key_required');
  err(await a.c.post(API, { idempotencyKey: 'short', ...TERMS, principalCents: 1 }), 400, 'idempotency_key_required');
  assert.equal(await loansOf(a), 0);
  assert.equal(await count('accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.kind = $2', [a.uid, 'loan']), 0);
  for (const id of [savings, mm]) assert.equal((await loanOf(a, { disbursementAccountId: id })).disbursementAccountId, id);
});

test('R6, R9: taking out a loan needs a recent step-up, checked after the account', async () => {
  const a = await customer('Gil', { stepped: false });
  on('2027-03-10');
  err(await open(a), 403, 'stepup_required');
  err(await open(a, { disbursementAccountId: newId() }), 404, 'not_found');
  err(await open(a, { aprBps: 5 }), 400, 'bad_apr');
  assert.equal(await loansOf(a), 0);
  await stepUp(a.c);
  assert.equal((await open(a)).status, 200);
});

test('R7: a request id makes one loan: replays from any session, conflicts, per-customer keys, simultaneous requests', async () => {
  const a = await customer('Hal'), b = await customer('Ida');
  on('2027-03-10');
  const k = key(), body = { idempotencyKey: k, ...TERMS, disbursementAccountId: a.chk };
  const first = await a.c.post(API, body);
  assert.equal(first.status, 200);
  const entries = await count('journal_entries'), events = await count('audit_events WHERE action LIKE $1', ['loanservicing.%']), accounts = await count('accounts');
  const again = await a.c.post(API, body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.loan, first.body.loan);
  const other = await signIn(env.base, a.username, a.password);                         // another session: no step-up needed for a replay
  const x = await other.post(API, body);
  assert.equal(x.status, 200); assert.equal(x.body.replayed, true); assert.equal(x.body.loan.id, first.body.loan.id);
  err(await other.post(API, { ...body, termMonths: 48 }), 422, 'idempotency_conflict');
  err(await a.c.post(API, { ...body, termMonths: 48 }), 422, 'idempotency_conflict');
  err(await other.post(API, { ...body, principalCents: 5 }), 422, 'idempotency_conflict');            // replay or conflict comes before the checks
  assert.equal(await loansOf(a), 1);
  assert.equal(await count('journal_entries'), entries); assert.equal(await count('accounts'), accounts);
  assert.equal(await count('audit_events WHERE action LIKE $1', ['loanservicing.%']), events);
  // the same key string is another customer's own key
  const theirs = await b.c.post(API, { ...body, disbursementAccountId: b.chk });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.loan.id, first.body.loan.id);
  // simultaneous identical requests: one loan, every answer 200, exactly one not a replay
  const k2 = key(), b2 = { idempotencyKey: k2, ...TERMS, principalCents: 200000, disbursementAccountId: b.chk };
  const rs = await Promise.all(Array.from({ length: 5 }, () => b.c.post(API, b2)));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.body)));
  assert.equal(new Set(rs.map(r => r.body.loan.id)).size, 1);
  assert.equal(rs.filter(r => !r.body.replayed).length, 1);
  assert.equal(await loansOf(b), 2);
  // one id for one request across the feature: a payment's id can't open a loan, an open's id can't pay
  const loan = first.body.loan, pk = key();
  assert.equal((await a.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: pk, kind: 'extra', amountCents: 100, fromAccountId: a.chk })).status, 200);
  err(await a.c.post(API, { ...body, idempotencyKey: pk }), 422, 'idempotency_conflict');
  err(await a.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: k, kind: 'extra', amountCents: 100, fromAccountId: a.chk }), 422, 'idempotency_conflict');
  err(await other.post(`${API}/${loan.id}/payments`, { idempotencyKey: k, kind: 'extra', amountCents: 100, fromAccountId: a.chk }), 422, 'idempotency_conflict');
  assert.equal(await loansOf(a), 1);
});

test('R8: at most three active loans, also when requests arrive at once; paid-off loans do not count', async () => {
  const a = await customer('Jo');
  on('2027-03-10');
  const rs = await Promise.all(Array.from({ length: 5 }, () => open(a, { principalCents: 100000, termMonths: 12 })));
  assert.equal(rs.filter(r => r.status === 200).length, 3, JSON.stringify(rs.map(r => r.body)));
  for (const r of rs.filter(x => x.status !== 200)) err(r, 409, 'too_many_loans');
  assert.equal(await loansOf(a), 3);
  err(await open(a), 409, 'too_many_loans');
  err(await open(a, { disbursementAccountId: newId() }), 404, 'not_found');               // the account comes first
  const loan = rs.find(r => r.status === 200).body.loan;
  const q = (await quote(a, loan, '2027-03-10')).body.quote;
  assert.equal((await payoff(a, loan, q.id)).status, 200);
  assert.equal((await open(a)).status, 200);
  err(await open(a), 409, 'too_many_loans');
});

// ---------- payments ----------
test('R18, R19, R11: early scheduled payments pay installments in order with interest to each due date; due dates stay', async () => {
  const a = await customer('Kit');
  on('2027-03-10');
  const loan = await loanOf(a);
  on('2027-04-01');
  const s = await sched(a, loan), k = key(), before = await bal(a.chk);
  assert.equal(s.rows[0].interestCents, 7525, 'reading early does not cut the interest');
  const r = await a.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: k, kind: 'scheduled', fromAccountId: a.chk });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.replayed, false);
  const p = r.body.payment;
  assert.deepEqual({ ...p, id: 0, entryId: 0, createdAt: 0 }, { id: 0, loanId: loan.id, kind: 'scheduled', installmentNumber: 1, postedOn: '2027-04-01', fromAccountId: a.chk,
    amountCents: 31217, feeCents: 0, interestCents: 7525, principalCents: 23692, principalBalanceAfterCents: 976308, entryId: 0, createdAt: 0 });
  assert.equal(r.body.loan.installmentsPaid, 1); assert.equal(r.body.loan.principalBalanceCents, 976308); assert.equal(r.body.loan.accruedThrough, '2027-04-15');
  assert.deepEqual(r.body.loan.nextInstallment, { number: 2, dueDate: '2027-05-15' }); assert.equal(r.body.loan.accruedInterestCents, 0);
  assert.equal(await bal(a.chk), before - 31217n);
  // ledger lines and audit
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [p.entryId])).rows[0];
  assert.equal(e.kind, 'personal_loan_payment'); assert.equal(e.idempotency_key, `${a.uid}:loan-servicing:${k}`);
  const lines = (await env.q('SELECT account_id, amount_cents, description, category, posted_on FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents', [p.entryId])).rows;
  assert.deepEqual(lines, [
    { account_id: a.chk, amount_cents: -31217n, description: `Personal loan ··${loan.last4} payment`, category: 'Loans', posted_on: '2027-04-01' },
    { account_id: await systemAccount(env.pool, 'loan_interest_income'), amount_cents: 7525n, description: `Interest, personal loan ··${loan.last4}`, category: null, posted_on: '2027-04-01' },
    { account_id: loan.id, amount_cents: 23692n, description: 'Principal', category: 'Loans', posted_on: '2027-04-01' }]);
  const [ev] = await audits(loan.id, 'loanservicing.payment');
  assert.deepEqual(ev.detail, { loan: loan.id, payment: p.id, kind: 'scheduled', amountCents: 31217, feeCents: 0, interestCents: 7525, principalCents: 23692, entry: p.entryId });
  // the next one, the same day, is installment 2 with its own month of interest
  const p2 = (await paid(a, loan)).payment;
  assert.equal(p2.installmentNumber, 2); assert.equal(p2.interestCents, 6297); assert.equal(p2.principalCents, 31217 - 6297);
  const d = await detail(a, loan);
  assert.deepEqual(d.nextInstallment, { number: 3, dueDate: '2027-06-15' }); assert.equal(d.pastDue, false); assert.equal(d.accruedThrough, '2027-05-15');
  // the schedule continues from installment 3, and matches a loan nobody paid early (R15, R19)
  const rows = (await sched(a, loan)).rows;
  assert.equal(rows[0].number, 3); assert.equal(rows[0].dueDate, '2027-06-15'); assert.equal(rows.length, 34);
  assert.equal(rows.reduce((t, x) => t + x.principalCents, 0), d.principalBalanceCents);
});

test('R16, R17, R19, R20: past due, late fees from the 11th day, once per late installment, paid first; late pays no extra interest', async () => {
  const a = await customer('Lou');
  on('2027-03-10');
  const loan = await loanOf(a), fee = loan.lateFeeCents;
  on('2027-04-15');
  let d = await detail(a, loan);
  assert.equal(d.pastDue, false); assert.equal(d.accruedInterestCents, 7525);
  on('2027-04-16');
  d = await detail(a, loan);
  assert.equal(d.pastDue, true); assert.equal(d.feesDueCents, 0); assert.equal(d.accruedThrough, '2027-03-10');
  on('2027-04-25');                                                                       // due + 10: still on time
  assert.equal((await detail(a, loan)).feesDueCents, 0);
  on('2027-04-26');                                                                       // due + 11: one fee
  d = await detail(a, loan);
  assert.equal(d.feesDueCents, fee); assert.equal(d.accruedInterestCents, 1000000 * 774 * 46 / 3600000);   // days360(2027-03-10, 2027-04-26) = 46, exactly 9,890
  let s = await sched(a, loan);
  assert.equal(s.rows[0].feeCents, fee); assert.equal(s.rows[0].paymentCents, 31217 + fee); assert.equal(s.totals.feesCents, fee);
  assert.ok(s.rows.slice(1).every(r => r.feeCents === 0));
  assert.equal(s.totals.paymentsCents, s.totals.feesCents + s.totals.interestCents + s.totals.principalCents);
  on('2027-05-26');                                                                       // installment 2 is late too: two fees, not three
  assert.equal((await detail(a, loan)).feesDueCents, 2 * fee);
  on('2027-06-10');
  assert.equal((await detail(a, loan)).feesDueCents, 2 * fee, 'a late installment is charged once, however long');
  const p1 = (await paid(a, loan)).payment;
  assert.deepEqual([p1.installmentNumber, p1.feeCents, p1.interestCents, p1.principalCents], [1, 2 * fee, 7525, 23692], 'interest is to the due date, not to the payment date');
  const inc = await systemAccount(env.pool, 'fee_income');
  const feeLine = (await env.q('SELECT amount_cents, description FROM ledger_lines WHERE entry_id = $1 AND account_id = $2', [p1.entryId, inc])).rows[0];
  assert.deepEqual(feeLine, { amount_cents: BigInt(2 * fee), description: `Late fee, personal loan ··${loan.last4}` });
  d = await detail(a, loan);
  assert.equal(d.feesDueCents, 0); assert.equal(d.pastDue, true);
  const p2 = (await paid(a, loan)).payment;
  assert.deepEqual([p2.installmentNumber, p2.feeCents, p2.interestCents], [2, 0, 6297]);
  d = await detail(a, loan);
  assert.equal(d.pastDue, false); assert.equal(d.feesDueCents, 0); assert.deepEqual(d.nextInstallment, { number: 3, dueDate: '2027-06-15' });
  // a scheduled payment on the 10th day after the due date is on time: no fee, then or later
  on('2027-06-25');
  assert.equal((await paid(a, loan)).payment.feeCents, 0);
  on('2027-07-20');
  assert.equal((await detail(a, loan)).feesDueCents, 0);
});

test('R20, R21: an extra payment pays fees, then interest to today, then principal; it pays no installment', async () => {
  const a = await customer('Mo');
  on('2027-03-10');
  const loan = await loanOf(a), fee = loan.lateFeeCents;
  on('2027-04-26');
  const accrued = (await detail(a, loan)).accruedInterestCents;                           // 46 days360 of interest
  assert.equal(accrued, Math.floor(1000000 * 774 * 46 / 3600000));
  // smaller than the fee: all to the fee
  let p = (await paid(a, loan, { kind: 'extra', amountCents: 1000 })).payment;
  assert.deepEqual([p.kind, p.installmentNumber, p.feeCents, p.interestCents, p.principalCents, p.amountCents], ['extra', null, 1000, 0, 0, 1000]);
  let d = await detail(a, loan);
  assert.equal(d.feesDueCents, fee - 1000); assert.equal(d.installmentsPaid, 0); assert.equal(d.pastDue, true); assert.equal(d.accruedThrough, '2027-04-26');
  // the rest of the fee, part of the interest
  p = (await paid(a, loan, { kind: 'extra', amountCents: fee - 1000 + 500 })).payment;
  assert.deepEqual([p.feeCents, p.interestCents, p.principalCents], [fee - 1000, 500, 0]);
  d = await detail(a, loan);
  assert.equal(d.feesDueCents, 0); assert.equal(d.accruedInterestCents, accrued - 500);
  // the rest of the interest and 10,000 of principal
  p = (await paid(a, loan, { kind: 'extra', amountCents: accrued - 500 + 10000 })).payment;
  assert.deepEqual([p.feeCents, p.interestCents, p.principalCents, p.principalBalanceAfterCents], [0, accrued - 500, 10000, 990000]);
  d = await detail(a, loan);
  assert.equal(d.accruedInterestCents, 0); assert.equal(d.installmentsPaid, 0); assert.deepEqual(d.nextInstallment, { number: 1, dueDate: '2027-04-15' });
  // installment 1 stays late (its fee is already paid), and its interest is now 0: interest was paid to 2027-04-26
  const s = (await paid(a, loan)).payment;
  assert.deepEqual([s.installmentNumber, s.feeCents, s.interestCents, s.principalCents], [1, 0, 0, 31217]);
  assert.equal((await detail(a, loan)).accruedThrough, '2027-04-26');
});

test('R22: extra payments shorten the loan; the payment and due dates stay', async () => {
  const a = await customer('Ned');
  on('2027-03-10');
  const loan = await loanOf(a);
  on('2027-03-20');
  await paid(a, loan, { kind: 'extra', amountCents: 300000 });
  const d = await detail(a, loan), s = await sched(a, loan);
  assert.equal(d.paymentCents, 31217); assert.equal(d.termMonths, 36);
  assert.ok(s.rows.length < 36, `${s.rows.length} rows`);
  assert.equal(s.rows[0].dueDate, '2027-04-15');
  s.rows.forEach((r, i) => { assert.equal(r.dueDate, dueDate({ originatedOn: '2027-03-10', paymentDay: 15 }, i + 1)); if (i < s.rows.length - 1) assert.equal(r.paymentCents, 31217); });
  assert.ok(s.rows.at(-1).paymentCents <= 31217);
  assert.equal(s.totals.principalCents, d.principalBalanceCents);
});

test('R23, R24, R25: payment checks, in order, and nothing changes on a refusal', async () => {
  const a = await customer('Ola', { funds: 0n }), b = await customer('Pia');
  const rich = await account(a, { funds: 5_000_000n }), shut = await account(a, { status: 'closed' }), card = await account(a, { kind: 'credit_card' });
  const viewer = await account(b, { funds: 100000n, also: [[a, 'viewer']] });
  on('2027-03-10');
  const loan = await loanOf(a, { disbursementAccountId: rich });
  on('2027-03-20');
  const P = (body, k = key()) => a.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: k, fromAccountId: rich, ...body });
  const before = await detail(a, loan), entries = await count('journal_entries');
  err(await a.c.post(`${API}/${loan.id}/payments`, { kind: 'extra', amountCents: 5, fromAccountId: rich }), 400, 'idempotency_key_required');
  for (const kind of [undefined, null, 'payoff', 'Scheduled', 1, ['extra']]) err(await P({ kind }), 400, 'bad_kind');
  for (const amountCents of [undefined, null, 0, -1, 1.5, '100', true, 10_000_000_001]) err(await P({ kind: 'extra', amountCents }), 400, 'bad_amount');
  for (const amountCents of [null, 31217, 'x']) err(await P({ kind: 'scheduled', amountCents }), 400, 'bad_amount');
  for (const fromAccountId of [undefined, null, 5, [rich]]) err(await P({ kind: 'scheduled', fromAccountId }), 400, 'bad_account');
  for (const fromAccountId of [newId(), 'zzz', b.chk, viewer]) err(await P({ kind: 'scheduled', fromAccountId }), 404, 'not_found');
  for (const fromAccountId of [loan.id, card]) err(await P({ kind: 'scheduled', fromAccountId }), 400, 'bad_account');
  err(await P({ kind: 'scheduled', fromAccountId: shut }), 409, 'account_not_open');
  err(await P({ kind: 'scheduled', fromAccountId: a.chk }), 409, 'insufficient_funds');
  // use_payoff: the payoff amount as of today or more
  const payoffNow = before.principalBalanceCents + (await detail(a, loan)).accruedInterestCents;
  err(await P({ kind: 'extra', amountCents: payoffNow }), 422, 'use_payoff');
  err(await P({ kind: 'extra', amountCents: payoffNow + 1, fromAccountId: a.chk }), 422, 'use_payoff');            // before insufficient_funds
  err(await P({ kind: 'extra', amountCents: payoffNow - 1, fromAccountId: a.chk }), 409, 'insufficient_funds');
  // order: kind before amount before account
  err(await P({ kind: 'nope', amountCents: -5, fromAccountId: 3 }), 400, 'bad_kind');
  err(await P({ kind: 'extra', amountCents: -5, fromAccountId: 3 }), 400, 'bad_amount');
  // a refused request does not use up its key
  const k = key();
  err(await P({ kind: 'scheduled', fromAccountId: a.chk }, k), 409, 'insufficient_funds');
  assert.deepEqual(await detail(a, loan), before);
  assert.equal(await count('journal_entries'), entries);
  assert.equal(await count('personal_loan_payments WHERE loan_id = $1', [loan.id]), 0);
  await tx(env.pool, c => fund(c, a.chk, 31217n));
  const exact = await P({ kind: 'scheduled', fromAccountId: a.chk }, k);                  // exactly enough is allowed
  assert.equal(exact.status, 200, JSON.stringify(exact.body)); assert.equal(await bal(a.chk), 0n);
  assert.equal((await a.c.get(`${API}/${loan.id}/payments`)).body.payments.length, 1);
});

test('R26, R33: payment request ids replay from any session, conflict on another body or loan, and history lists each payment once', async () => {
  const a = await customer('Quin');
  on('2027-03-10');
  const L1 = await loanOf(a), L2 = await loanOf(a);
  on('2027-03-25');
  const k = key(), body = { idempotencyKey: k, kind: 'extra', amountCents: 12345, fromAccountId: a.chk };
  const first = await a.c.post(`${API}/${L1.id}/payments`, body);
  assert.equal(first.status, 200);
  const events = await count('audit_events WHERE action LIKE $1', ['loanservicing.%']), before = await bal(a.chk);
  const other = await signIn(env.base, a.username, a.password);
  for (const c of [a.c, other]) {
    const r = await c.post(`${API}/${L1.id}/payments`, body);
    assert.equal(r.status, 200); assert.equal(r.body.replayed, true); assert.deepEqual(r.body.payment, first.body.payment);
    assert.deepEqual(r.body.loan, first.body.loan);
  }
  err(await other.post(`${API}/${L1.id}/payments`, { ...body, amountCents: 1 }), 422, 'idempotency_conflict');
  err(await other.post(`${API}/${L2.id}/payments`, body), 422, 'idempotency_conflict');
  err(await a.c.post(`${API}/${L2.id}/payments`, body), 422, 'idempotency_conflict');
  const qk = (await quote(a, L1, '2027-03-25')).body.quote;
  err(await a.c.post(`${API}/${L1.id}/payoff`, { idempotencyKey: k, quoteId: qk.id, fromAccountId: a.chk }), 422, 'idempotency_conflict');
  assert.equal(await bal(a.chk), before);
  assert.equal(await count('audit_events WHERE action LIKE $1', ['loanservicing.%']), events + 1);   // + the quote only
  const second = await paid(a, L1);
  const h = (await a.c.get(`${API}/${L1.id}/payments`)).body.payments;
  assert.deepEqual(h, [first.body.payment, second.payment]);
  assert.deepEqual((await a.c.get(`${API}/${L2.id}/payments`)).body.payments, []);
});

test('R27: simultaneous payments apply one at a time', async () => {
  const a = await customer('Rae');
  on('2027-03-10');
  const loan = await loanOf(a);
  on('2027-04-01');
  const [x, y] = await Promise.all([pay(a, loan), pay(a, loan)]);
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  assert.deepEqual([x.body.payment.installmentNumber, y.body.payment.installmentNumber].sort(), [1, 2]);
  const second = [x, y].find(r => r.body.payment.installmentNumber === 2).body.payment;
  assert.equal(second.interestCents, 6297); assert.equal(second.principalBalanceAfterCents, 976308 - (31217 - 6297));
  const k = key();
  const same = await Promise.all(Array.from({ length: 4 }, () => a.c.post(`${API}/${loan.id}/payments`, { idempotencyKey: k, kind: 'extra', amountCents: 777, fromAccountId: a.chk })));
  assert.ok(same.every(r => r.status === 200)); assert.equal(same.filter(r => !r.body.replayed).length, 1);
  assert.equal(new Set(same.map(r => r.body.payment.id)).size, 1);
  // an extra payment and a payoff at once: whichever is second sees the first's state
  const q = (await quote(a, loan, '2027-04-01')).body.quote;
  const [e, o] = await Promise.all([pay(a, loan, { kind: 'extra', amountCents: 1000 }), payoff(a, loan, q.id)]);
  const ok = [e, o].filter(r => r.status === 200);
  assert.ok(ok.length >= 1);
  if (e.status !== 200) err(e, 409, 'loan_closed');
  if (o.status !== 200) err(o, 409, 'quote_stale');
  const d = await detail(a, loan), pays = (await a.c.get(`${API}/${loan.id}/payments`)).body.payments;
  assert.equal(d.principalBalanceCents, pays.at(-1).principalBalanceAfterCents);
  assert.equal(await bal(loan.id), BigInt(-d.principalBalanceCents));
});

test('R28: the final scheduled installment pays the loan off and closes its account', async () => {
  const a = await customer('Sam');
  on('2027-03-31');
  const loan = await loanOf(a, { principalCents: 100000, termMonths: 12, paymentDay: 28 });
  const plan = (await sched(a, loan)).rows;
  on('2027-04-28');
  for (let i = 0; i < 12; i++) {
    const p = (await paid(a, loan)).payment;
    assert.deepEqual([p.installmentNumber, p.interestCents, p.principalCents, p.amountCents], [i + 1, plan[i].interestCents, plan[i].principalCents, plan[i].paymentCents]);
  }
  const d = await detail(a, loan);
  assert.equal(d.status, 'paid_off'); assert.equal(d.paidOffOn, '2027-04-28'); assert.equal(d.nextInstallment, null); assert.equal(d.principalBalanceCents, 0);
  assert.equal(d.installmentsPaid, 12); assert.equal(d.pastDue, false); assert.equal(d.feesDueCents, 0); assert.equal(d.accruedInterestCents, 0);
  const acct = (await env.q('SELECT status, balance_cents FROM accounts WHERE id = $1', [loan.id])).rows[0];
  assert.deepEqual(acct, { status: 'closed', balance_cents: 0n });
  assert.equal((await audits(loan.id, 'loanservicing.paid_off')).length, 1);
  assert.deepEqual((await audits(loan.id, 'loanservicing.paid_off'))[0].detail, { loan: loan.id, on: '2027-04-28' });
  err(await pay(a, loan), 409, 'loan_closed');
  err(await pay(a, loan, { kind: 'extra', amountCents: 1 }), 409, 'loan_closed');
  err(await quote(a, loan, '2027-04-28'), 409, 'loan_closed');
  err(await quote(a, loan, 'garbage'), 409, 'loan_closed');
  err(await payoff(a, loan, newId()), 409, 'loan_closed');
  assert.deepEqual(await sched(a, loan), { loanId: loan.id, asOf: '2027-04-28', rows: [], totals: { paymentsCents: 0, feesCents: 0, interestCents: 0, principalCents: 0 } });
});

// ---------- payoff ----------
test('R29: payoff quotes: dates, figures with interest and fees to goodThrough, no change to the loan', async () => {
  const a = await customer('Tia');
  on('2027-03-10');
  const loan = await loanOf(a);
  on('2027-04-20');
  for (const g of [undefined, null, 20270420, '2027-04-19', '2027-05-21', '2027-02-30', '2027-4-20', ['2027-04-20'], ' 2027-04-20']) err(await quote(a, loan, g), 400, 'bad_date');
  const before = await detail(a, loan);
  const q1 = await quote(a, loan, '2027-04-20');
  assert.equal(q1.status, 200, JSON.stringify(q1.body));
  assert.deepEqual({ ...q1.body.quote, id: 0 }, { id: 0, loanId: loan.id, createdOn: '2027-04-20', goodThrough: '2027-04-20', principalCents: 1000000,
    interestCents: Math.floor(1000000 * 774 * 40 / 3600000), feeCents: 0, amountCents: 1000000 + Math.floor(1000000 * 774 * 40 / 3600000) });
  const q2 = (await quote(a, loan, '2027-05-20')).body.quote;                             // installment 1 is late by then
  assert.equal(q2.feeCents, loan.lateFeeCents); assert.equal(q2.interestCents, Math.floor(1000000 * 774 * 70 / 3600000));
  assert.equal(q2.amountCents, q2.principalCents + q2.interestCents + q2.feeCents);
  assert.deepEqual(await detail(a, loan), before);
  const [ev] = await audits(loan.id, 'loanservicing.quote');
  assert.deepEqual(ev.detail, { loan: loan.id, quote: q1.body.quote.id, goodThrough: '2027-04-20', amountCents: q1.body.quote.amountCents });
  // R30: paid on a day before goodThrough, it costs the payoff as of that day, never more than the quote
  const k = key(), before$ = await bal(a.chk);
  const r = await a.c.post(`${API}/${loan.id}/payoff`, { idempotencyKey: k, quoteId: q2.id, fromAccountId: a.chk });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.payment;
  assert.deepEqual([p.kind, p.installmentNumber, p.feeCents, p.principalCents, p.amountCents, p.principalBalanceAfterCents],
    ['payoff', null, 0, 1000000, q1.body.quote.amountCents, 0]);
  assert.ok(p.amountCents <= q2.amountCents);
  assert.equal(await bal(a.chk), before$ - BigInt(p.amountCents));
  assert.equal(r.body.loan.status, 'paid_off'); assert.equal(r.body.loan.paidOffOn, '2027-04-20');
  assert.equal((await env.q('SELECT status FROM accounts WHERE id = $1', [loan.id])).rows[0].status, 'closed');
  assert.equal((await audits(loan.id, 'loanservicing.payment')).length, 1); assert.equal((await audits(loan.id, 'loanservicing.paid_off')).length, 1);
  // a replay still answers after the payoff, with the loan as it is now
  on('2027-04-22');
  const again = await a.c.post(`${API}/${loan.id}/payoff`, { idempotencyKey: k, quoteId: q2.id, fromAccountId: a.chk });
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.payment, p);
  assert.equal((await audits(loan.id, 'loanservicing.payment')).length, 1);
});

test('R30: payoff on goodThrough pays the quote exactly, late fees included; expired, stale and unknown quotes are refused', async () => {
  const a = await customer('Uma'), b = await customer('Val');
  on('2027-03-10');
  const loan = await loanOf(a), other = await loanOf(a, { principalCents: 200000 }), bl = await loanOf(b);
  on('2027-04-20');
  const q = (await quote(a, loan, '2027-05-01')).body.quote, qo = (await quote(a, other, '2027-05-01')).body.quote, qb = (await quote(b, bl, '2027-05-01')).body.quote;
  for (const quoteId of [undefined, null, 'x', newId(), qo.id, qb.id, [q.id]]) err(await payoff(a, loan, quoteId), 404, 'quote_not_found');
  err(await a.c.post(`${API}/${loan.id}/payoff`, { quoteId: q.id, fromAccountId: a.chk }), 400, 'idempotency_key_required');
  err(await payoff(a, loan, q.id, { fromAccountId: 4 }), 400, 'bad_account');
  err(await payoff(a, loan, q.id, { fromAccountId: b.chk }), 404, 'not_found');
  err(await payoff(a, loan, newId(), { fromAccountId: 4 }), 404, 'quote_not_found');             // quote before account
  on('2027-05-02');
  err(await payoff(a, loan, q.id), 409, 'quote_expired');
  on('2027-04-28');
  const fresh = (await quote(a, loan, '2027-05-01')).body.quote;
  await paid(a, loan, { kind: 'extra', amountCents: 100 });
  err(await payoff(a, loan, fresh.id), 409, 'quote_stale');
  err(await payoff(a, loan, q.id), 409, 'quote_stale');
  const late = (await quote(a, loan, '2027-05-01')).body.quote;                          // installment 1 is late on 2027-04-26
  assert.equal(late.feeCents, loan.lateFeeCents - 100 > 0 ? loan.lateFeeCents - 100 : 0);
  on('2027-05-01');
  const before = await bal(a.chk);
  const p = (await payoff(a, loan, late.id)).body.payment;
  assert.deepEqual([p.feeCents, p.interestCents, p.principalCents, p.amountCents], [late.feeCents, late.interestCents, late.principalCents, late.amountCents]);
  assert.equal(await bal(a.chk), before - BigInt(late.amountCents));
  err(await payoff(a, loan, late.id), 409, 'loan_closed');
});

// ---------- reads, records, separation ----------
test('R15, R16, R35: reading changes nothing; two identical loans agree on every date however often they are read', async () => {
  const a = await customer('Wyn');
  on('2027-03-10');
  const x = await loanOf(a), y = await loanOf(a);
  const same = (p, q) => { const strip = l => ({ ...l, id: 0, last4: 0, createdAt: 0 }); assert.deepEqual(strip(p), strip(q)); };
  for (const day of ['2027-03-11', '2027-03-31', '2027-04-15', '2027-04-26', '2027-05-31']) { on(day); await detail(a, x); await sched(a, x); await quote(a, x, day); }
  on('2027-04-02');
  const px = (await paid(a, x, { kind: 'extra', amountCents: 50000 })).payment, py = (await paid(a, y, { kind: 'extra', amountCents: 50000 })).payment;
  assert.deepEqual([px.feeCents, px.interestCents, px.principalCents], [py.feeCents, py.interestCents, py.principalCents]);
  for (const day of ['2027-04-02', '2027-05-20', '2027-06-30']) {
    on(day);
    same(await detail(a, x), await detail(a, y));
    assert.deepEqual({ ...(await sched(a, x)), loanId: 0 }, { ...(await sched(a, y)), loanId: 0 });
  }
  // R35: the same extra payment a day later carries more interest
  on('2027-04-10'); const later = (await paid(a, x, { kind: 'extra', amountCents: 50000 })).payment;
  on('2027-04-03'); const sooner = (await paid(a, y, { kind: 'extra', amountCents: 50000 })).payment;
  assert.ok(later.interestCents > sooner.interestCents);
});

test('R31: balances equal their ledger lines, entries balance, loan accounts are -P, money splits to principal, interest and fees', async () => {
  const a = await customer('Xan');
  on('2027-03-10');
  const loan = await loanOf(a);
  on('2027-05-03'); await paid(a, loan); await paid(a, loan, { kind: 'extra', amountCents: 40000 });
  on('2027-07-01'); await paid(a, loan); await paid(a, loan, { kind: 'extra', amountCents: 999 });
  const q = (await quote(a, loan, '2027-07-05')).body.quote;
  on('2027-07-03'); await payoff(a, loan, q.id);
  const pays = (await a.c.get(`${API}/${loan.id}/payments`)).body.payments;
  const sum = k => pays.reduce((t, p) => t + p[k], 0);
  assert.equal(sum('principalCents'), 1000000);
  assert.ok(sum('feeCents') > 0);
  assert.equal(sum('amountCents'), sum('feeCents') + sum('interestCents') + sum('principalCents'));
  const entries = pays.map(p => p.entryId);
  const by = async acct => BigInt((await env.q('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE entry_id = ANY($1) AND account_id = $2', [entries, acct])).rows[0].s);
  assert.equal(await by(a.chk), BigInt(-sum('amountCents')));
  assert.equal(await by(loan.id), BigInt(sum('principalCents')));
  assert.equal(await by(await systemAccount(env.pool, 'loan_interest_income')), BigInt(sum('interestCents')));
  assert.equal(await by(await systemAccount(env.pool, 'fee_income')), BigInt(sum('feeCents')));
  assert.equal(await count('ledger_lines WHERE entry_id = ANY($1) AND account_id <> ALL($2)', [entries,
    [a.chk, loan.id, await systemAccount(env.pool, 'loan_interest_income'), await systemAccount(env.pool, 'fee_income')]]), 0);
  assert.equal(await count(`(SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.kind LIKE 'personal_loan_%' GROUP BY e.id HAVING sum(l.amount_cents) <> 0) x`), 0);
  assert.equal(await count('accounts a WHERE a.balance_cents <> (SELECT coalesce(sum(amount_cents), 0) FROM ledger_lines WHERE account_id = a.id)'), 0);
  assert.equal(await count('personal_loans l JOIN accounts a ON a.id = l.id WHERE a.balance_cents <> -l.principal_balance_cents'), 0);
  const keys = new Set((await env.q("SELECT DISTINCT jsonb_object_keys(detail) k FROM audit_events WHERE action LIKE 'loanservicing.%'")).rows.map(r => r.k));
  assert.deepEqual([...keys].filter(k => /account|number/i.test(k)), [], 'no account numbers in audit details');
});

test('R36: loans of this feature are not seen or paid by /api/loans', async () => {
  const a = await customer('Yul');
  on('2027-03-10');
  const loan = await loanOf(a);
  const list = await a.c.get('/api/loans');
  assert.equal(list.status, 200); assert.ok(!list.body.loans.some(l => l.id === loan.id));
  err(await a.c.get(`/api/loans/${loan.id}`), 404, 'not_found');
  err(await a.c.get(`/api/loans/${loan.id}/payoff`), 404, 'not_found');
  err(await a.c.post(`/api/loans/${loan.id}/payments`, { idempotencyKey: key(), kind: 'scheduled', fromAccountId: a.chk }), 404, 'not_found');
  assert.equal(await count('loans WHERE account_id = $1', [loan.id]), 0);
  assert.equal((await detail(a, loan)).principalBalanceCents, 1000000);
});
