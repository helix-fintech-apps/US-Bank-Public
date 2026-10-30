import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { bankToday, addDays, clock } from '../../lib/bank-date.mjs';
import { schedule } from '../../lib/routes/pay-in-4.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
/** Moves the bank's clock n days ahead of the real one (the app runs in this process). */
const travel = days => { clock.now = () => new Date(Date.now() + days * 86_400_000); };

let n = 0;
const key = () => `p4-test-${++n}-${Date.now()}`;
const uniq = () => `${Date.now().toString(36)}${++n}`;

/** A fresh customer with a funded checking account, an empty savings account and a card, signed in. */
async function customer({ checking = 100_000n } = {}) {
  const id = newId(), username = `p4-${uniq()}@usabanc.example`;
  const ids = { checking: newId(), savings: newId(), card: newId() };
  await tx(env.pool, async c => {
    await c.query('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
      [id, username, 'Pat', await hashPassword('pw-pay-in-4'), '11']);
    for (const [k, kind, neg] of [['checking', 'checking', false], ['savings', 'savings', false], ['card', 'credit_card', true]]) {
      await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ids[k], kind, kind, String(1000 + n).slice(-4), neg, neg ? 500000n : null]);
      await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [ids[k], id]);
    }
    if (checking > 0n) await fund(c, ids.checking, checking);
  });
  const web = await signIn(env.base, username, 'pw-pay-in-4');
  return { id, web, ...ids };
}
const fund = async (c, accountId, cents) => post(c, { key: `p4-fund:${newId()}`, kind: 'seed', lines: [
  { accountId, amountCents: cents, description: 'Deposit' }, { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Deposit' }] });
const deposit = (accountId, cents) => tx(env.pool, c => fund(c, accountId, cents));
const drain = async accountId => { const b = await balance(accountId); if (b > 0n) await tx(env.pool, async c => post(c, { key: `p4-drain:${newId()}`, kind: 'seed', lines: [
  { accountId, amountCents: -b, description: 'Withdrawal' }, { accountId: await systemAccount(c, 'equity'), amountCents: b, description: 'Withdrawal' }] })); };
/** A card purchase on an account, posted daysAgo; returns its ledger line id as a string. */
async function purchase(accountId, cents, { daysAgo = 0, kind = 'card_purchase', merchant = 'Bright Cycles' } = {}) {
  return tx(env.pool, async c => {
    const { entryId } = await post(c, { key: `p4-buy:${newId()}`, kind, lines: [
      { accountId, amountCents: -cents, description: merchant, category: 'Shopping', postedOn: addDays(bankToday(), -daysAgo) },
      { accountId: await systemAccount(c, 'card_network_settlement'), amountCents: cents, description: merchant }] });
    return String((await c.query('SELECT id FROM ledger_lines WHERE entry_id = $1 AND account_id = $2', [entryId, accountId])).rows[0].id);
  });
}
const balance = async id => BigInt((await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents);
const stepUp = async web => { const s = await web.post('/api/stepup'); assert.equal((await web.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); };
const stated = (cu, cents = 10003, extra = {}) => ({ merchant: 'Bright Cycles', purchaseAmountCents: cents, autopayAccountId: cu.checking, ...extra });
const accept = (cu, purchaseBody, extra = {}) => cu.web.post('/api/pay-in-4/plans', {
  idempotencyKey: key(), acceptedDisclosure: true, acknowledgedTotalCents: purchaseBody.purchaseAmountCents ?? extra.total, ...purchaseBody, ...extra });
/** A signed-in, stepped-up customer with one accepted stated plan. */
async function withPlan(cents = 10000, opts) {
  const cu = await customer(opts); await stepUp(cu.web);
  const r = await accept(cu, stated(cu, cents));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cu, plan: r.body.plan };
}
const audits = async (userId, action) => (await env.q('SELECT detail FROM audit_events WHERE user_id = $1 AND action = $2 ORDER BY id', [userId, action])).rows.map(r => r.detail);
const entry = async (k) => {
  const e = (await env.q('SELECT * FROM journal_entries WHERE idempotency_key = $1', [k])).rows[0];
  if (!e) return null;
  e.lines = (await env.q(`SELECT l.*, a.kind account_kind, a.system_code FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = $1 ORDER BY l.id`, [e.id])).rows;
  return e;
};
const planRow = async id => (await env.q('SELECT * FROM pay_in_4_plans WHERE id = $1', [id])).rows[0];
const detail = async (cu, id) => (await cu.web.get(`/api/pay-in-4/plans/${id}`)).body.plan;

// ---------- access ----------
test('R1: every endpoint needs a signed-in customer', async () => {
  const anon = client(env.base), id = newId();
  for (const [m, p] of [['POST', '/api/pay-in-4/quote'], ['POST', '/api/pay-in-4/plans'], ['GET', '/api/pay-in-4/plans'], ['GET', `/api/pay-in-4/plans/${id}`],
    ['POST', `/api/pay-in-4/plans/${id}/autopay`], ['POST', `/api/pay-in-4/plans/${id}/payoff`], ['POST', `/api/pay-in-4/plans/${id}/refund`], ['POST', '/api/pay-in-4/collect']]) {
    const r = await anon.call(m, p, { idempotencyKey: key() });
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out');
  }
});

test('R2: another customer’s plan is a 404 everywhere and is left unchanged; list and collect see only your own', async () => {
  const { cu: a, plan } = await withPlan(10000);
  const b = await customer();
  const before = JSON.stringify(await detail(a, plan.id));
  for (const [p, body] of [['', null], ['/autopay', { accountId: b.checking }], ['/payoff', {}], ['/refund', { idempotencyKey: key(), amountCents: 100 }]]) {
    const r = body ? await b.web.post(`/api/pay-in-4/plans/${plan.id}${p}`, body) : await b.web.get(`/api/pay-in-4/plans/${plan.id}`);
    assert.equal(r.status, 404, p); assert.equal(r.body.error, 'not_found');
  }
  for (const id of [newId(), 'not-a-uuid']) assert.equal((await a.web.get(`/api/pay-in-4/plans/${id}`)).status, 404);
  assert.deepEqual((await b.web.get('/api/pay-in-4/plans')).body.plans, []);
  travel(14);
  assert.deepEqual((await b.web.post('/api/pay-in-4/collect', {})).body, { results: [], paid: 0, failed: 0 });
  clock.now = realNow;
  assert.equal(JSON.stringify(await detail(a, plan.id)), before);
});

// ---------- quote and schedule ----------
test('R3/R4: a quote shows the disclosure and the 4.2 schedule, moves no money and writes pay4.quote', async () => {
  const cu = await customer(), bal = await balance(cu.checking);
  const entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const r = await cu.web.post('/api/pay-in-4/quote', stated(cu, 10003, { merchant: '  Bright Cycles  ' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.disclosure, today = bankToday();
  assert.equal(d.merchant, 'Bright Cycles');
  for (const [k, v] of Object.entries({ totalCents: 10003, amountFinancedCents: 10003, financeChargeCents: 0, totalOfPaymentsCents: 10003, aprBps: 0, upfrontFeeCents: 0,
    installmentCount: 4, intervalDays: 14, autopayAccountId: cu.checking, lateFeeCents: 500, lateFeeGraceDays: 5, lateFeeCapCents: 1000, earlyPayoffPenaltyCents: 0 })) assert.equal(d[k], v, k);
  assert.deepEqual(d.installments, [
    { number: 1, dueDate: today, amountCents: 2501 }, { number: 2, dueDate: addDays(today, 14), amountCents: 2501 },
    { number: 3, dueDate: addDays(today, 28), amountCents: 2501 }, { number: 4, dueDate: addDays(today, 42), amountCents: 2500 }]);
  assert.ok(d.notice.length > 20);
  assert.equal(await balance(cu.checking), bal);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  assert.equal((await env.q('SELECT count(*)::int n FROM pay_in_4_plans WHERE user_id = $1', [cu.id])).rows[0].n, 0);
  assert.deepEqual(await audits(cu.id, 'pay4.quote'), [{ totalCents: 10003, merchant: 'Bright Cycles' }]);

  await stepUp(cu.web);
  const p = (await accept(cu, stated(cu, 10003))).body.plan;
  assert.deepEqual(p.installments.map(i => [i.dueDate, i.originalAmountCents]), d.installments.map(i => [i.dueDate, i.amountCents]));
});

test('R4: schedule amounts always add up and the extra cents go first', () => {
  for (const t of [5000n, 5001n, 5002n, 5003n, 10003n, 99999n, 100000n]) {
    const s = schedule(t, '2027-03-01');
    assert.equal(s.reduce((x, i) => x + i.amountCents, 0n), t);
    assert.ok(s.every((i, k) => i.amountCents === t / 4n + (BigInt(k) < t % 4n ? 1n : 0n)));
    assert.deepEqual(s.map(i => i.dueDate), ['2027-03-01', '2027-03-15', '2027-03-29', '2027-04-12']);
  }
});

// ---------- accepting ----------
test('R13: accepting a stated purchase posts system-only lines, collects installment 1, and audits it', async () => {
  const cu = await customer(), bal = await balance(cu.checking);
  const r0 = await accept(cu, stated(cu, 10003));
  assert.equal(r0.status, 403); assert.equal(r0.body.error, 'stepup_required');
  await stepUp(cu.web);
  const r = await accept(cu, stated(cu, 10003));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  const p = r.body.plan, today = bankToday();
  assert.equal(p.status, 'active'); assert.equal(p.source, 'stated'); assert.equal(p.lineId, null); assert.equal(p.purchaseAccountId, null);
  assert.equal(p.merchant, 'Bright Cycles'); assert.equal(p.totalCents, 10003); assert.equal(p.installmentCount, 4); assert.equal(p.autopayAccountId, cu.checking);
  assert.equal(p.refundedCents, 0); assert.equal(p.lateFeesCents, 0); assert.equal(p.remainingCents, 7502); assert.equal(p.nextDueDate, addDays(today, 14));
  assert.deepEqual(p.installments[0], { number: 1, dueDate: today, originalAmountCents: 2501, amountCents: 2501, lateFeeCents: 0, status: 'paid', paidOn: today, entryId: p.installments[0].entryId });
  assert.ok(p.installments.slice(1).every(i => i.status === 'scheduled' && i.paidOn === null && i.entryId === null));
  assert.equal(await balance(cu.checking), bal - 2501n);

  const buy = await entry(`${cu.id}:pay-in-4:${p.id}:purchase`);
  assert.equal(buy.kind, 'pay_in_4_purchase'); assert.equal(buy.memo, 'Pay it in 4: Bright Cycles');
  assert.ok(buy.lines.every(l => l.account_kind === 'system' && l.posted_on === today));
  assert.equal(buy.lines.reduce((s, l) => s + BigInt(l.amount_cents), 0n), 0n);
  const one = await entry(`${cu.id}:pay-in-4:${p.id}:1`);
  assert.equal(one.id, p.installments[0].entryId); assert.equal(one.kind, 'pay_in_4_installment'); assert.equal(one.memo, 'Pay it in 4: Bright Cycles');
  assert.equal(one.lines.length, 2);
  assert.deepEqual(one.lines.map(l => [l.account_id, BigInt(l.amount_cents)]), [[cu.checking, -2501n], [one.lines[1].account_id, 2501n]]);
  assert.equal(one.lines[0].category, 'Payments'); assert.equal(one.lines[0].description, 'Pay it in 4: payment 1 of 4, Bright Cycles');
  assert.equal(one.lines[1].account_kind, 'system');

  const d = await detail(cu, p.id);
  assert.deepEqual(d.attempts, [{ installment: 1, attemptedOn: today, status: 'posted', failureCode: null, entryId: one.id }]);
  assert.deepEqual(await audits(cu.id, 'pay4.accept'), [{ plan: p.id, totalCents: 10003, source: 'stated' }]);
  assert.deepEqual(await audits(cu.id, 'pay4.installment_paid'), [{ plan: p.id, installment: 1, amountCents: 2501, lateFeeCents: 0 }]);
  assert.deepEqual(await audits(cu.id, 'pay4.status'), []);
});

test('R13/R14: a card purchase on checking is converted (credit, then installment 1), even when it spent the whole balance', async () => {
  const cu = await customer({ checking: 8000n }); await stepUp(cu.web);
  const lineId = await purchase(cu.checking, 8000n);
  assert.equal(await balance(cu.checking), 0n);
  const q = await cu.web.post('/api/pay-in-4/quote', { lineId, autopayAccountId: cu.checking });
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.disclosure.totalCents, 8000); assert.equal(q.body.disclosure.merchant, 'Bright Cycles');
  const r = await accept(cu, { lineId, autopayAccountId: cu.checking }, { acknowledgedTotalCents: 8000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.plan;
  assert.equal(p.source, 'ledger_line'); assert.equal(p.lineId, lineId); assert.equal(p.purchaseAccountId, cu.checking); assert.equal(p.merchant, 'Bright Cycles');
  assert.equal(await balance(cu.checking), 6000n);
  const conv = await entry(`${cu.id}:pay-in-4:${p.id}:convert`);
  assert.equal(conv.kind, 'pay_in_4_convert'); assert.equal(conv.memo, 'Pay it in 4: Bright Cycles');
  const mine = conv.lines.filter(l => l.account_kind !== 'system');
  assert.deepEqual(mine.map(l => [l.account_id, BigInt(l.amount_cents), l.category, l.description]), [[cu.checking, 8000n, 'Payments', 'Pay it in 4: Bright Cycles']]);
  assert.equal(conv.lines.filter(l => l.account_kind === 'system').reduce((s, l) => s + BigInt(l.amount_cents), 0n), -8000n);

  const again = await accept(cu, { lineId, autopayAccountId: cu.checking }, { acknowledgedTotalCents: 8000 });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_in_plan');
});

test('R14: not enough for installment 1 creates nothing at all', async () => {
  const cu = await customer({ checking: 2000n }); await stepUp(cu.web);
  const entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const r = await accept(cu, stated(cu, 10000));
  assert.equal(r.status, 409); assert.equal(r.body.error, 'insufficient_funds');
  assert.equal((await env.q('SELECT count(*)::int n FROM pay_in_4_plans WHERE user_id = $1', [cu.id])).rows[0].n, 0);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  assert.equal(await balance(cu.checking), 2000n);
  assert.deepEqual(await audits(cu.id, 'pay4.accept'), []);
});

test('R5/R6/R8: purchase, account and amount checks', async () => {
  const cu = await customer(), other = await customer();
  const q = b => cu.web.post('/api/pay-in-4/quote', b);
  const expect = async (b, status, code) => { const r = await q(b); assert.equal(r.status, status, `${JSON.stringify(b)} -> ${JSON.stringify(r.body)}`); assert.equal(r.body.error, code); };
  const acct = { autopayAccountId: cu.checking };
  await expect({ ...acct }, 400, 'bad_purchase');
  await expect({ lineId: '12', merchant: 'Shop', ...acct }, 400, 'bad_purchase');
  await expect({ lineId: '12', purchaseAmountCents: 6000, ...acct }, 400, 'bad_purchase');
  for (const lineId of [12, '', 'abc', '1'.repeat(19), '-5']) await expect({ lineId, ...acct }, 400, 'bad_purchase');
  for (const merchant of [undefined, 5, 'x', ' y ', 'z'.repeat(61)]) await expect({ merchant, purchaseAmountCents: 6000, ...acct }, 400, 'bad_purchase');
  for (const a of [undefined, '6000', 60.5, 0, -1, 10_000_000_001]) await expect({ merchant: 'Shop', purchaseAmountCents: a, ...acct }, 400, 'bad_amount');
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000 }, 400, 'bad_account');
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: 7 }, 400, 'bad_account');
  for (const id of [newId(), 'nope', other.checking]) await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: id }, 404, 'not_found');
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: cu.card }, 400, 'bad_account');
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.savings]);
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: cu.savings }, 409, 'account_not_open');
  await expect({ merchant: 'Shop', purchaseAmountCents: 4999, ...acct }, 422, 'amount_below_minimum');
  await expect({ merchant: 'Shop', purchaseAmountCents: 100001, ...acct }, 422, 'amount_above_maximum');
  for (const t of [5000, 100000]) assert.equal((await q({ merchant: 'Shop', purchaseAmountCents: t, ...acct })).status, 200);

  // roles: viewer and custodian are not found, minor is refused
  const minorAcct = newId(), viewAcct = newId(), custAcct = newId();
  for (const [id, kind, role] of [[minorAcct, 'checking', 'minor'], [viewAcct, 'checking', 'viewer'], [custAcct, 'checking', 'custodian']]) {
    await env.q(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,$2,'x','0001')`, [id, kind]);
    await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, cu.id, role]);
  }
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: viewAcct }, 404, 'not_found');
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: custAcct }, 404, 'not_found');
  await expect({ merchant: 'Shop', purchaseAmountCents: 6000, autopayAccountId: minorAcct }, 403, 'minor_not_allowed');
  // order: the purchase fields come before the account
  await expect({ merchant: 'x', purchaseAmountCents: 6000, autopayAccountId: newId() }, 400, 'bad_purchase');
  await expect({ merchant: 'Shop', purchaseAmountCents: 1, autopayAccountId: newId() }, 404, 'not_found');
});

test('R7: which purchases on an account can be split', async () => {
  const cu = await customer(), other = await customer();
  const q = lineId => cu.web.post('/api/pay-in-4/quote', { lineId, autopayAccountId: cu.checking });
  const expect = async (lineId, status, code) => { const r = await q(lineId); assert.equal(r.status, status, `${lineId}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, code); };
  assert.equal((await q(await purchase(cu.checking, 6000n, { daysAgo: 30 }))).status, 200);
  assert.equal((await q(await purchase(cu.card, 6000n))).status, 200);
  await expect(await purchase(cu.checking, 6000n, { daysAgo: 31 }), 422, 'purchase_not_eligible');
  await expect(await purchase(cu.checking, 6000n, { kind: 'transfer' }), 422, 'purchase_not_eligible');
  const sysLine = String((await env.q("SELECT l.id FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE a.kind = 'system' LIMIT 1")).rows[0].id);
  await expect(sysLine, 404, 'not_found');
  await expect(await purchase(other.checking, 6000n), 404, 'not_found');
  await expect('999999999999', 404, 'not_found');
  // a positive card_purchase line (the settlement side) on the customer's own account is not a purchase
  const credit = await tx(env.pool, async c => {
    const { entryId } = await post(c, { key: `p4-credit:${newId()}`, kind: 'card_purchase', lines: [
      { accountId: cu.checking, amountCents: 6000n, description: 'Refund' }, { accountId: await systemAccount(c, 'card_network_settlement'), amountCents: -6000n, description: 'x' }] });
    return String((await c.query('SELECT id FROM ledger_lines WHERE entry_id = $1 AND account_id = $2', [entryId, cu.checking])).rows[0].id);
  });
  await expect(credit, 422, 'purchase_not_eligible');
  // savings is not a purchase account
  await deposit(cu.savings, 10000n);
  await expect(await purchase(cu.savings, 6000n), 422, 'purchase_not_eligible');
  // disputed
  const disputed = await purchase(cu.card, 6000n);
  await tx(env.pool, async c => {
    const { entryId } = await post(c, { key: `p4-dispute:${newId()}`, kind: 'card_dispute', lines: [
      { accountId: cu.card, amountCents: 6000n, description: 'Provisional credit' }, { accountId: await systemAccount(c, 'card_disputes'), amountCents: -6000n, description: 'x' }] });
    await c.query(`INSERT INTO card_disputes (id, account_id, line_id, amount_cents, reason, idempotency_key, provisional_entry_id) VALUES ($1,$2,$3,6000,'unrecognized',$4,$5)`,
      [newId(), cu.card, disputed, `p4-d:${newId()}`, entryId]);
  });
  await expect(disputed, 422, 'purchase_not_eligible');
  // amount range applies to the line's amount
  await expect(await purchase(cu.checking, 4999n), 422, 'amount_below_minimum');
  // closed account: 409, checked before the age of the line
  const old = await purchase(cu.card, 6000n, { daysAgo: 40 });
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [cu.card]);
  await expect(old, 409, 'account_not_open');
  // minor on the line's account
  const kid = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'teen_checking','x','0002')`, [kid]);
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [kid, cu.id]);
  await deposit(kid, 10000n);
  await expect(await purchase(kid, 6000n), 403, 'minor_not_allowed');
});

test('R9/R10: at most 4 open plans; a past-due plan blocks a new one; completed plans do not count', async () => {
  const cu = await customer({ checking: 1_000_000n }); await stepUp(cu.web);
  const ids = [];
  for (let i = 0; i < 4; i++) { const r = await accept(cu, stated(cu, 6000)); assert.equal(r.status, 200); ids.push(r.body.plan.id); }
  const fifth = await accept(cu, stated(cu, 6000));
  assert.equal(fifth.status, 422); assert.equal(fifth.body.error, 'plan_limit');
  assert.equal((await cu.web.post('/api/pay-in-4/quote', stated(cu, 6000))).body.error, 'plan_limit');
  assert.equal((await cu.web.post(`/api/pay-in-4/plans/${ids[0]}/payoff`, {})).status, 200);
  assert.equal((await accept(cu, stated(cu, 6000))).status, 200);
  // make one past due: drain the account and let installment 2 run late
  await drain(cu.checking); travel(20);
  const c = await cu.web.post('/api/pay-in-4/collect', {});
  assert.equal(c.status, 200); assert.ok(c.body.failed >= 1);
  clock.now = realNow;
  await deposit(cu.checking, 100000n);
  const statuses = (await cu.web.get('/api/pay-in-4/plans')).body.plans.map(p => p.status);
  assert.ok(statuses.includes('past_due'), statuses.join());
  await env.q("UPDATE pay_in_4_plans SET status = 'completed' WHERE user_id = $1 AND status = 'active'", [cu.id]);   // room under the plan limit
  const r = await accept(cu, stated(cu, 6000));
  assert.equal(r.status, 422); assert.equal(r.body.error, 'not_in_good_standing');
});

test('R11/R16: disclosure acceptance, and the order of checks on accept', async () => {
  const cu = await customer();
  const post_ = b => cu.web.post('/api/pay-in-4/plans', b);
  const base = { idempotencyKey: key(), ...stated(cu, 10000), acceptedDisclosure: true, acknowledgedTotalCents: 10000 };
  assert.equal((await post_({ ...base, idempotencyKey: undefined })).body.error, 'idempotency_key_required');
  assert.equal((await post_({ ...base, idempotencyKey: 'short' })).body.error, 'idempotency_key_required');
  for (const [a, t] of [[false, 10000], ['true', 10000], [true, '10000'], [true, 100.5], [undefined, 10000]]) {
    const r = await post_({ ...base, idempotencyKey: key(), acceptedDisclosure: a, acknowledgedTotalCents: t });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'disclosure_not_accepted');
  }
  const mm = await post_({ ...base, idempotencyKey: key(), acknowledgedTotalCents: 9999 });
  assert.equal(mm.status, 409); assert.equal(mm.body.error, 'disclosure_mismatch');
  // step-up comes after the disclosure, and the funds check after step-up
  assert.equal((await post_({ ...base, idempotencyKey: key() })).body.error, 'stepup_required');
  assert.equal((await post_({ ...base, idempotencyKey: key(), merchant: 'x', acceptedDisclosure: false })).body.error, 'bad_purchase');
  assert.equal((await post_({ ...base, idempotencyKey: key(), purchaseAmountCents: 4000, acknowledgedTotalCents: 1 })).body.error, 'amount_below_minimum');
  assert.equal((await env.q('SELECT count(*)::int n FROM pay_in_4_plans WHERE user_id = $1', [cu.id])).rows[0].n, 0);
});

test('R15: the accept request id: replay from another sign-in, conflict, per customer, parallel, refusals do not use it', async () => {
  const cu = await customer(); await stepUp(cu.web);
  const body = { idempotencyKey: key(), ...stated(cu, 10000), acceptedDisclosure: true, acknowledgedTotalCents: 10000 };
  const refused = await cu.web.post('/api/pay-in-4/plans', { ...body, purchaseAmountCents: 1, acknowledgedTotalCents: 1 });
  assert.equal(refused.status, 422); assert.equal(refused.body.error, 'amount_below_minimum');
  const first = await cu.web.post('/api/pay-in-4/plans', body);
  assert.equal(first.status, 200); assert.equal(first.body.replayed, false);
  await drain(cu.checking);
  const entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const auditsBefore = (await env.q('SELECT count(*)::int n FROM audit_events WHERE user_id = $1 AND action LIKE $2', [cu.id, 'pay4.%'])).rows[0].n;
  // another sign-in of the same customer (no step-up), now not eligible (account drained): still the original plan
  const web2 = await signIn(env.base, (await env.q('SELECT username FROM users WHERE id = $1', [cu.id])).rows[0].username, 'pw-pay-in-4');
  const again = await web2.post('/api/pay-in-4/plans', body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.equal(again.body.plan.id, first.body.plan.id);
  const diff = await web2.post('/api/pay-in-4/plans', { ...body, merchant: 'Other Shop' });
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  assert.equal((await env.q('SELECT count(*)::int n FROM audit_events WHERE user_id = $1 AND action LIKE $2', [cu.id, 'pay4.%'])).rows[0].n, auditsBefore);
  // the same key string for another customer is their own plan
  const other = await customer(); await stepUp(other.web);
  const theirs = await other.web.post('/api/pay-in-4/plans', { ...body, autopayAccountId: other.checking });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.plan.id, first.body.plan.id);
  // two identical requests at once: one plan, one replayed: false
  const both = { ...body, idempotencyKey: key(), autopayAccountId: other.checking };
  const rs = await Promise.all([other.web.post('/api/pay-in-4/plans', both), other.web.post('/api/pay-in-4/plans', both)]);
  assert.deepEqual(rs.map(r => r.status), [200, 200]);
  assert.deepEqual(rs.map(r => r.body.replayed).sort(), [false, true]);
  assert.equal(rs[0].body.plan.id, rs[1].body.plan.id);
});

// ---------- reading ----------
test('R17/R18: list newest first with a status filter; detail agrees with its installments', async () => {
  const cu = await customer({ checking: 500_000n }); await stepUp(cu.web);
  const a = (await accept(cu, stated(cu, 6000))).body.plan, b = (await accept(cu, stated(cu, 7000))).body.plan;
  await cu.web.post(`/api/pay-in-4/plans/${a.id}/payoff`, {});
  const all = (await cu.web.get('/api/pay-in-4/plans')).body.plans;
  assert.deepEqual(all.map(p => p.id), [b.id, a.id]);
  assert.deepEqual((await cu.web.get('/api/pay-in-4/plans?status=completed')).body.plans.map(p => p.id), [a.id]);
  assert.deepEqual((await cu.web.get('/api/pay-in-4/plans?status=active')).body.plans.map(p => p.id), [b.id]);
  assert.deepEqual((await cu.web.get('/api/pay-in-4/plans?status=canceled')).body.plans, []);
  for (const s of ['', 'Active', 'open']) {
    const r = await cu.web.get(`/api/pay-in-4/plans?status=${s}`);
    assert.equal(r.status, 400, s); assert.equal(r.body.error, 'bad_status');
  }
  const d = await detail(cu, b.id);
  assert.equal(d.remainingCents, d.installments.filter(i => ['scheduled', 'missed'].includes(i.status)).reduce((s, i) => s + i.amountCents + i.lateFeeCents, 0));
  assert.equal(d.nextDueDate, d.installments[1].dueDate);
  assert.equal(d.attempts.length, 1);
});

test('R19: change the payment account', async () => {
  const { cu, plan } = await withPlan(10000);
  const other = await customer();
  const r = p => cu.web.post(`/api/pay-in-4/plans/${plan.id}/autopay`, p);
  assert.equal((await r({})).body.error, 'bad_account');
  assert.equal((await r({ accountId: other.checking })).status, 404);
  assert.equal((await r({ accountId: cu.card })).body.error, 'bad_account');
  assert.equal((await other.web.post(`/api/pay-in-4/plans/${plan.id}/autopay`, { accountId: 5 })).status, 404);   // 404 before the account check
  const ok = await r({ accountId: cu.savings });
  assert.equal(ok.status, 200); assert.equal(ok.body.plan.autopayAccountId, cu.savings);
  assert.equal((await audits(cu.id, 'pay4.autopay_change')).length, 1);
  await deposit(cu.savings, 2500n);
  travel(14);
  const c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.equal(c.paid, 1);
  assert.equal(await balance(cu.savings), 0n);
  clock.now = realNow;
  await deposit(cu.savings, 5000n);
  assert.equal((await cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {})).status, 200);
  const done = await r({ accountId: cu.checking });
  assert.equal(done.status, 409); assert.equal(done.body.error, 'invalid_state');
});

// ---------- collecting ----------
test('R20/R21/R25: installments are collected on their due date, once, and the plan completes', async () => {
  const { cu, plan } = await withPlan(10003);
  assert.deepEqual((await cu.web.post('/api/pay-in-4/collect', {})).body, { results: [], paid: 0, failed: 0 });
  travel(13);
  assert.deepEqual((await cu.web.post('/api/pay-in-4/collect', {})).body, { results: [], paid: 0, failed: 0 });
  travel(14);
  const bal = await balance(cu.checking);
  // parallel calls from two sign-ins: one pays
  const web2 = await signIn(env.base, (await env.q('SELECT username FROM users WHERE id = $1', [cu.id])).rows[0].username, 'pw-pay-in-4');
  const rs = await Promise.all([cu.web.post('/api/pay-in-4/collect', {}), web2.post('/api/pay-in-4/collect', {}), cu.web.post('/api/pay-in-4/collect', {})]);
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(rs.reduce((s, r) => s + r.body.paid, 0), 1);
  const item = rs.find(r => r.body.paid).body.results[0];
  const due = addDays(plan.installments[0].dueDate, 14);
  assert.deepEqual(item, { planId: plan.id, installment: 2, dueDate: due, status: 'paid', amountCents: 2501, lateFeeCents: 0, entryId: item.entryId, failureCode: null });
  assert.equal(await balance(cu.checking), bal - 2501n);
  const e = await entry(`${cu.id}:pay-in-4:${plan.id}:2`);
  assert.equal(e.id, item.entryId); assert.equal(e.lines.length, 2); assert.equal(e.kind, 'pay_in_4_installment');
  assert.ok(e.lines.every(l => l.posted_on === bankToday()));
  assert.equal((await cu.web.post('/api/pay-in-4/collect', {})).body.results.length, 0);
  // skip ahead past both remaining due dates: two items, oldest first
  travel(45);
  const last = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.deepEqual(last.results.map(r => [r.installment, r.status]), [[3, 'paid'], [4, 'paid']]);
  const d = await detail(cu, plan.id);
  assert.equal(d.status, 'completed'); assert.equal(d.nextDueDate, null); assert.equal(d.remainingCents, 0);
  assert.deepEqual(await audits(cu.id, 'pay4.status'), [{ plan: plan.id, from: 'active', to: 'completed' }]);
  travel(100);
  assert.deepEqual((await cu.web.post('/api/pay-in-4/collect', {})).body, { results: [], paid: 0, failed: 0 });
});

test('R22/R23/R24: grace period, missed installments, late fees, past due and back to active', async () => {
  const { cu, plan } = await withPlan(10000);
  await drain(cu.checking);
  travel(19);                                                       // due + 5: still in the grace period
  let c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.deepEqual(c.results.map(r => [r.installment, r.status, r.failureCode, r.lateFeeCents, r.entryId]), [[2, 'failed', 'insufficient_funds', 0, null]]);
  assert.deepEqual([c.paid, c.failed], [0, 1]);
  let d = await detail(cu, plan.id);
  assert.equal(d.status, 'active'); assert.equal(d.installments[1].status, 'scheduled'); assert.equal(d.installments[1].lateFeeCents, 0);
  travel(20);                                                       // due + 6: missed, fee 500
  c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.equal(c.results[0].lateFeeCents, 0);                       // the failed attempt is for the amount without the new fee
  d = await detail(cu, plan.id);
  assert.equal(d.status, 'past_due'); assert.equal(d.installments[1].status, 'missed'); assert.equal(d.installments[1].lateFeeCents, 500);
  assert.equal(d.lateFeesCents, 500); assert.equal(d.remainingCents, 7500 + 500);
  assert.deepEqual(d.attempts.map(a => [a.installment, a.status, a.failureCode]), [[1, 'posted', null], [2, 'failed', 'insufficient_funds'], [2, 'failed', 'insufficient_funds']]);
  assert.deepEqual(await audits(cu.id, 'pay4.installment_missed'), [{ plan: plan.id, installment: 2, lateFeeCents: 500 }]);
  c = (await cu.web.post('/api/pay-in-4/collect', {})).body;        // marked and charged only once
  assert.equal((await detail(cu, plan.id)).lateFeesCents, 500);
  assert.equal((await audits(cu.id, 'pay4.installment_missed')).length, 1);
  // the money arrives: paid with its fee in three lines, plan back to active
  await deposit(cu.checking, 3000n);
  c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.deepEqual(c.results.map(r => [r.installment, r.status, r.amountCents, r.lateFeeCents]), [[2, 'paid', 2500, 500]]);
  assert.equal(await balance(cu.checking), 0n);
  const e = await entry(`${cu.id}:pay-in-4:${plan.id}:2`);
  assert.equal(e.lines.length, 3);
  assert.deepEqual(e.lines.map(l => BigInt(l.amount_cents)), [-3000n, 2500n, 500n]);
  d = await detail(cu, plan.id);
  assert.equal(d.status, 'active'); assert.equal(d.installments[1].lateFeeCents, 500); assert.equal(d.lateFeesCents, 500);
  assert.deepEqual((await audits(cu.id, 'pay4.status')).map(x => [x.from, x.to]), [['active', 'past_due'], ['past_due', 'active']]);
});

test('R22: a closed payment account fails with account_not_open; a payment that succeeds late has no fee', async () => {
  const { cu, plan } = await withPlan(10000);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.checking]);
  travel(14);
  const c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.equal(c.results[0].failureCode, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.checking]);
  travel(40);                                                       // far past due, never marked missed (no failed attempt late): no fee
  const r = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.ok(r.results.every(x => x.status === 'paid' && x.lateFeeCents === 0));
  assert.equal((await detail(cu, plan.id)).lateFeesCents, 0);
});

test('R23/R24/R26: two missed installments default the plan; collect leaves it, payoff settles it, fees capped at 1000', async () => {
  const { cu, plan } = await withPlan(10000);
  await drain(cu.checking);
  travel(40);                                                       // installments 2 (due +14) and 3 (due +28) are both late
  const c = (await cu.web.post('/api/pay-in-4/collect', {})).body;
  assert.deepEqual(c.results.map(r => [r.installment, r.status]), [[2, 'failed'], [3, 'failed']]);
  let d = await detail(cu, plan.id);
  assert.equal(d.status, 'defaulted'); assert.equal(d.lateFeesCents, 1000);
  travel(60);                                                       // installment 4 is due and late, but a defaulted plan is not collected
  assert.deepEqual((await cu.web.post('/api/pay-in-4/collect', {})).body, { results: [], paid: 0, failed: 0 });
  d = await detail(cu, plan.id);
  assert.equal(d.installments[3].status, 'scheduled'); assert.equal(d.lateFeesCents, 1000);
  // payoff: 7500 + 1000 in fees
  const poor = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {});
  assert.equal(poor.status, 409); assert.equal(poor.body.error, 'insufficient_funds');
  await deposit(cu.checking, 8500n);
  const r = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payoff.amountCents, 8500);
  assert.equal(r.body.plan.status, 'completed'); assert.equal(r.body.plan.remainingCents, 0);
  assert.ok(r.body.plan.installments.slice(1).every(i => i.status === 'paid' && i.entryId === r.body.payoff.entryId && i.paidOn === bankToday()));
  const e = await entry(`${cu.id}:pay-in-4:${plan.id}:payoff`);
  assert.equal(e.kind, 'pay_in_4_payoff');
  assert.deepEqual(e.lines.map(l => BigInt(l.amount_cents)), [-8500n, 7500n, 1000n]);
  assert.equal(e.lines[0].description, 'Pay it in 4: payoff, Bright Cycles'); assert.equal(e.lines[0].category, 'Payments');
  assert.equal(await balance(cu.checking), 0n);
  assert.deepEqual(await audits(cu.id, 'pay4.payoff'), [{ plan: plan.id, amountCents: 8500 }]);
  const again = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {});
  assert.equal(again.status, 409); assert.equal(again.body.error, 'invalid_state');
});

test('R26: payoff without fees has two lines; parallel payoffs pay once; a frozen account is refused', async () => {
  const { cu, plan } = await withPlan(10000);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.checking]);
  const f = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {});
  assert.equal(f.status, 409); assert.equal(f.body.error, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.checking]);
  const bal = await balance(cu.checking);
  const rs = await Promise.all([1, 2, 3].map(() => cu.web.post(`/api/pay-in-4/plans/${plan.id}/payoff`, {})));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await balance(cu.checking), bal - 7500n);
  assert.equal((await entry(`${cu.id}:pay-in-4:${plan.id}:payoff`)).lines.length, 2);
});

// ---------- refunds ----------
test('R27/R28: refunds reduce the last installments first, then pay back; replay, conflict and errors', async () => {
  const { cu, plan } = await withPlan(10000);
  const ref = (body, id = plan.id) => cu.web.post(`/api/pay-in-4/plans/${id}/refund`, body);
  assert.equal((await ref({ amountCents: 100 })).body.error, 'idempotency_key_required');
  for (const a of [0, -1, 1.5, '100', undefined, 10_000_000_001]) {
    const r = await ref({ idempotencyKey: key(), amountCents: a });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_amount');
  }
  assert.equal((await ref({ idempotencyKey: key(), amountCents: 10001 })).body.error, 'refund_exceeds_purchase');
  const k1 = key();
  const r1 = await ref({ idempotencyKey: k1, amountCents: 2000 });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual({ ...r1.body.refund, entryId: null }, { amountCents: 2000, appliedToPlanCents: 2000, creditedCents: 0, entryId: null });
  assert.equal(r1.body.replayed, false);
  assert.deepEqual(r1.body.plan.installments.map(i => [i.amountCents, i.status]), [[2500, 'paid'], [2500, 'scheduled'], [2500, 'scheduled'], [500, 'scheduled']]);
  assert.equal(r1.body.plan.refundedCents, 2000); assert.equal(r1.body.plan.remainingCents, 5500);
  const e1 = await entry(`${cu.id}:pay-in-4:${plan.id}:refund:${k1}`);
  assert.equal(e1.kind, 'pay_in_4_refund');
  assert.deepEqual(e1.lines.map(l => [l.account_kind, BigInt(l.amount_cents)]), [['system', -2000n], ['system', 2000n]]);
  // replay: same figures, nothing applied again
  const again = await ref({ idempotencyKey: k1, amountCents: 2000 });
  assert.equal(again.body.replayed, true); assert.deepEqual(again.body.refund, r1.body.refund); assert.equal(again.body.plan.refundedCents, 2000);
  assert.equal((await ref({ idempotencyKey: k1, amountCents: 2001 })).body.error, 'idempotency_conflict');
  // the next refund cancels installments 4, 3, 2 and credits the rest
  const bal = await balance(cu.checking), k2 = key();
  const r2 = await ref({ idempotencyKey: k2, amountCents: 7000 });
  assert.deepEqual({ ...r2.body.refund, entryId: null }, { amountCents: 7000, appliedToPlanCents: 5500, creditedCents: 1500, entryId: null });
  assert.deepEqual(r2.body.plan.installments.map(i => [i.amountCents, i.originalAmountCents, i.status]),
    [[2500, 2500, 'paid'], [0, 2500, 'canceled'], [0, 2500, 'canceled'], [0, 2500, 'canceled']]);
  assert.equal(r2.body.plan.status, 'completed'); assert.equal(r2.body.plan.nextDueDate, null);
  assert.equal(await balance(cu.checking), bal + 1500n);
  const e2 = await entry(`${cu.id}:pay-in-4:${plan.id}:refund:${k2}`);
  const credit = e2.lines.find(l => l.account_id === cu.checking);
  assert.equal(BigInt(credit.amount_cents), 1500n); assert.equal(credit.category, 'Payments'); assert.equal(credit.description, 'Pay it in 4: refund from Bright Cycles');
  // the rest of the purchase: canceled
  assert.equal((await ref({ idempotencyKey: key(), amountCents: 1001 })).body.error, 'refund_exceeds_purchase');
  const r3 = await ref({ idempotencyKey: key(), amountCents: 1000 });
  assert.equal(r3.body.plan.status, 'canceled'); assert.equal(r3.body.refund.creditedCents, 1000);
  assert.deepEqual((await audits(cu.id, 'pay4.status')).map(x => x.to), ['completed', 'canceled']);
  assert.deepEqual((await audits(cu.id, 'pay4.refund')).map(x => [x.amountCents, x.appliedToPlanCents, x.creditedCents]), [[2000, 2000, 0], [7000, 5500, 1500], [1000, 0, 1000]]);
  // the same key on another plan is a conflict; another customer's plan is a 404
  const p2 = (await accept(cu, stated(cu, 6000))).body.plan;
  assert.equal((await ref({ idempotencyKey: k1, amountCents: 2000 }, p2.id)).body.error, 'idempotency_conflict');
});

test('R27: a refund that cancels a missed installment waives its fee; credit to a closed account is refused', async () => {
  const { cu, plan } = await withPlan(10000);
  await drain(cu.checking);
  travel(20);
  await cu.web.post('/api/pay-in-4/collect', {});
  clock.now = realNow;
  assert.equal((await detail(cu, plan.id)).status, 'past_due');
  const r = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/refund`, { idempotencyKey: key(), amountCents: 7000 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.plan.installments.map(i => [i.amountCents, i.lateFeeCents, i.status]), [[2500, 0, 'paid'], [500, 500, 'missed'], [0, 0, 'canceled'], [0, 0, 'canceled']]);
  const r2 = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/refund`, { idempotencyKey: key(), amountCents: 500 });
  assert.deepEqual(r2.body.plan.installments[1], { ...r.body.plan.installments[1], amountCents: 0, lateFeeCents: 0, status: 'canceled' });
  assert.equal(r2.body.plan.status, 'completed'); assert.equal(r2.body.plan.lateFeesCents, 0);
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [cu.checking]);
  const before = await planRow(plan.id);
  const r3 = await cu.web.post(`/api/pay-in-4/plans/${plan.id}/refund`, { idempotencyKey: key(), amountCents: 100 });
  assert.equal(r3.status, 409); assert.equal(r3.body.error, 'account_not_open');
  assert.deepEqual(await planRow(plan.id), before);
});

// ---------- integrity ----------
test('R29: balances equal their ledger lines, every entry balances, and the money adds up over a plan’s life', async () => {
  const cu = await customer({ checking: 20000n }); await stepUp(cu.web);
  const lineId = await purchase(cu.card, 10003n);
  const card0 = await balance(cu.card), chk0 = await balance(cu.checking);
  const p = (await accept(cu, { lineId, autopayAccountId: cu.checking }, { acknowledgedTotalCents: 10003 })).body.plan;
  await drain(cu.checking);
  travel(20); await cu.web.post('/api/pay-in-4/collect', {});        // missed, fee 500
  clock.now = realNow;
  await deposit(cu.checking, 100000n);
  const chk1 = await balance(cu.checking);
  travel(50); await cu.web.post('/api/pay-in-4/collect', {});
  const d = await detail(cu, p.id);
  assert.equal(d.status, 'completed');
  assert.equal(await balance(cu.card), card0 + 10003n);
  // left checking: 2501 at accept; then 7502 + 500 fee after the deposit
  assert.equal(chk1 - await balance(cu.checking), 7502n + 500n);
  assert.equal(2501n + 7502n + 500n, BigInt(d.totalCents + d.lateFeesCents));
  assert.ok(chk0 >= 2501n);
  for (const id of [cu.checking, cu.card, cu.savings]) {
    const s = (await env.q('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1', [id])).rows[0].s;
    assert.equal(BigInt(s), await balance(id));
  }
  const bad = (await env.q(`SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.kind LIKE 'pay_in_4_%'
     GROUP BY e.id HAVING sum(l.amount_cents) <> 0`)).rows;
  assert.deepEqual(bad, []);
  const touched = (await env.q(`SELECT DISTINCT l.account_id, a.kind FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.idempotency_key LIKE $1`, [`${cu.id}:pay-in-4:%`])).rows;
  assert.ok(touched.every(t => t.kind === 'system' || [cu.checking, cu.card].includes(t.account_id)));
});

test('R30: audit details never hold an account number', async () => {
  const { cu } = await withPlan(10000);
  const rows = (await env.q(`SELECT detail::text d FROM audit_events WHERE user_id = $1 AND action LIKE 'pay4.%'`, [cu.id])).rows;
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => !/number|last4/i.test(r.d)));
});
