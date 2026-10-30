// Pay it in 4: one purchase split into four 0% installments, 14 days apart. Quote (disclosure), accept (step-up), list,
// detail, change the payment account, collect what is due, pay off early, and record a merchant refund.
// Terms are data (TERMS below, from the Pay it in 4 requirements). Storage: db/migrations/065_pay_in_4.sql.
// In this API amounts are JSON integers in cents (fields ending in `Cents`): BigInt inside, Number only at the edge.
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { bankToday, addDays } from '../bank-date.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';

const F = 'pay-in-4';
export const TERMS = {
  installments: 4, intervalDays: 14, minCents: 5000n, maxCents: 100000n, maxOpenPlans: 4,
  lateFeeCents: 500n, lateFeeCapCents: 1000n, graceDays: 5, purchaseMaxAgeDays: 30
};
export const STATUSES = ['active', 'past_due', 'defaulted', 'completed', 'canceled'];
const OPEN = ['active', 'past_due', 'defaulted'];
const COLLECTABLE = ['active', 'past_due'];
const UNPAID = ['scheduled', 'missed'];
const OWN = ['owner', 'joint_owner'];
const PAY_FROM = ['checking', 'savings', 'money_market'];
const PURCHASE_ON = ['checking', 'credit_card'];
const MAX_INPUT_CENTS = 10_000_000_000;
const SYS = { receivable: 'pay4_receivable', merchant: 'pay4_merchant', fees: 'pay4_late_fees' };

const cents = x => Number(x);                                   // ok-number: API amounts are JSON integers, at most 10^10 (exact in a double)
const big = x => BigInt(x);
const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0n);
const memo = m => `Pay it in 4: ${m}`;
const has = v => v !== undefined && v !== null;
const isCentsInput = v => Number.isSafeInteger(v) && v >= 1 && v <= MAX_INPUT_CENTS;
const notFound = () => new AppError(404, 'not_found', 'Plan not found.');
const lock = (c, k) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [k]);

/** The schedule for a purchase of `total` cents accepted on bank date `on`: the remainder goes to the first installments. */
export function schedule(total, on) {
  const n = BigInt(TERMS.installments), base = total / n, extra = total % n;
  return Array.from({ length: TERMS.installments }, (_, i) => ({
    number: i + 1, dueDate: addDays(on, TERMS.intervalDays * i), amountCents: base + (BigInt(i + 1) <= extra ? 1n : 0n)
  }));
}

/** R24: the status that follows from the installments and refunds. */
export function statusOf(plan, insts) {
  if (big(plan.refunded_cents) === big(plan.total_cents)) return 'canceled';
  if (!insts.some(i => UNPAID.includes(i.status))) return 'completed';
  const missed = insts.filter(i => i.status === 'missed').length;
  return missed >= 2 ? 'defaulted' : missed === 1 ? 'past_due' : 'active';
}

// ---------- views ----------
const instView = i => ({
  number: i.number, dueDate: i.due_date, originalAmountCents: cents(i.original_amount_cents), amountCents: cents(i.amount_cents),
  lateFeeCents: cents(i.late_fee_cents), status: i.status, paidOn: i.paid_on, entryId: i.entry_id
});
function planView(p, insts, attempts) {
  const unpaid = insts.filter(i => UNPAID.includes(i.status));
  return {
    id: p.id, status: p.status, merchant: p.merchant, source: p.source, lineId: p.line_id == null ? null : String(p.line_id),
    purchaseAccountId: p.purchase_account_id, totalCents: cents(p.total_cents), installmentCount: TERMS.installments,
    autopayAccountId: p.autopay_account_id, refundedCents: cents(p.refunded_cents),
    lateFeesCents: cents(sum(insts, i => big(i.late_fee_cents))),
    remainingCents: cents(sum(unpaid, i => big(i.amount_cents) + big(i.late_fee_cents))),
    nextDueDate: unpaid[0]?.due_date ?? null, createdAt: p.created_at, installments: insts.map(instView),
    ...(attempts ? { attempts: attempts.map(a => ({ installment: a.installment, attemptedOn: a.attempted_on, status: a.status, failureCode: a.failure_code, entryId: a.entry_id })) } : {})
  };
}
const installmentsOf = async (c, planId) => (await c.query('SELECT * FROM pay_in_4_installments WHERE plan_id = $1 ORDER BY number', [planId])).rows;
async function viewOf(c, planId, { attempts = false } = {}) {
  const p = (await c.query('SELECT * FROM pay_in_4_plans WHERE id = $1', [planId])).rows[0];
  const a = attempts ? (await c.query('SELECT * FROM pay_in_4_attempts WHERE plan_id = $1 ORDER BY id', [planId])).rows : null;
  return planView(p, await installmentsOf(c, planId), a);
}

/** The caller's plan (locked when it will change), or a 404 for someone else's, an unknown or a malformed id. */
async function ownPlan(c, u, id, { forUpdate = false } = {}) {
  if (!isUuid(id)) throw notFound();
  const p = (await c.query(`SELECT * FROM pay_in_4_plans WHERE id = $1 AND user_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [id, u.id])).rows[0];
  if (!p) throw notFound();
  return p;
}

// ---------- eligibility (R5 to R10, in the order of R16) ----------
/** R5: a purchase on an account ({ lineId }) or a stated one ({ merchant, totalCents }). */
function readPurchase(b) {
  const bad = () => new AppError(400, 'bad_purchase', 'Choose a purchase from your activity, or enter the merchant name (2 to 60 characters) and the amount.');
  if (has(b.lineId)) {
    if (has(b.merchant) || has(b.purchaseAmountCents)) throw bad();
    if (typeof b.lineId !== 'string' || !/^\d{1,18}$/.test(b.lineId)) throw bad();
    return { lineId: b.lineId };
  }
  if (typeof b.merchant !== 'string') throw bad();
  const merchant = b.merchant.trim();
  if (merchant.length < 2 || merchant.length > 60) throw bad();
  if (!isCentsInput(b.purchaseAmountCents)) throw new AppError(400, 'bad_amount', 'Enter the purchase amount in whole cents.');
  return { merchant, totalCents: big(b.purchaseAmountCents) };
}

/** R6: an open checking, savings or money market account the customer owns (missing, lookup, minor, kind, status). */
async function payFromAccount(c, u, id) {
  if (typeof id !== 'string') throw new AppError(400, 'bad_account', 'Choose the account your installments are paid from.');
  const a = await accountFor(c, u.id, id, [...OWN, 'minor']);
  if (a.role === 'minor') throw new AppError(403, 'minor_not_allowed', "Pay it in 4 isn't available on a minor's account.");
  if (!PAY_FROM.includes(a.kind)) throw new AppError(400, 'bad_account', 'Installments are paid from a checking, savings or money market account.');
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', 'That account is not open. Choose another account.');
  return a;
}

/** R7: a recent card purchase on the customer's own open checking or card account, not disputed and not in a plan. */
async function purchaseLine(c, u, lineId) {
  const l = (await c.query(`SELECT l.id, l.account_id, l.amount_cents, l.description, l.posted_on, a.kind, a.status, e.kind entry_kind, o.role,
      EXISTS (SELECT 1 FROM card_disputes d WHERE d.line_id = l.id) disputed
     FROM ledger_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
     LEFT JOIN account_owners o ON o.account_id = a.id AND o.user_id = $2 WHERE l.id = $1`, [lineId, u.id])).rows[0];
  if (!l || l.kind === 'system' || ![...OWN, 'minor'].includes(l.role)) throw new AppError(404, 'not_found', 'Purchase not found.');
  if (l.role === 'minor') throw new AppError(403, 'minor_not_allowed', "Pay it in 4 isn't available on a minor's account.");
  const notEligible = () => new AppError(422, 'purchase_not_eligible', 'Only a card purchase from the last 30 days that is not disputed can be split.');
  if (!PURCHASE_ON.includes(l.kind)) throw notEligible();
  if (l.status !== 'open') throw new AppError(409, 'account_not_open', 'The account this purchase is on is not open.');
  if (l.entry_kind !== 'card_purchase' || big(l.amount_cents) >= 0n || l.posted_on < addDays(bankToday(), -TERMS.purchaseMaxAgeDays) || l.disputed) throw notEligible();
  await lock(c, `${F}:line:${l.id}`);                             // two plans for one purchase at once: the second waits, then sees the first
  if ((await c.query("SELECT 1 FROM pay_in_4_plans WHERE line_id = $1 AND status <> 'canceled'", [l.id])).rowCount)
    throw new AppError(409, 'already_in_plan', 'This purchase is already in a Pay it in 4 plan.');
  return { lineId: l.id, purchaseAccountId: l.account_id, merchant: l.description, totalCents: -big(l.amount_cents) };
}

/** Every eligibility check shared by quote and accept: the purchase, the payment account, amount, standing and plan count. */
async function eligible(c, u, b) {
  const given = readPurchase(b);
  const pay = await payFromAccount(c, u, b.autopayAccountId);
  const p = given.lineId ? await purchaseLine(c, u, given.lineId) : { lineId: null, purchaseAccountId: null, ...given };
  if (p.totalCents < TERMS.minCents) throw new AppError(422, 'amount_below_minimum', 'Pay it in 4 is for purchases of $50.00 or more.');
  if (p.totalCents > TERMS.maxCents) throw new AppError(422, 'amount_above_maximum', 'Pay it in 4 is for purchases of up to $1,000.00.');
  const mine = (await c.query('SELECT status, count(*)::int n FROM pay_in_4_plans WHERE user_id = $1 GROUP BY status', [u.id])).rows;
  const count = s => mine.filter(r => s.includes(r.status)).reduce((t, r) => t + r.n, 0);
  if (count(['past_due', 'defaulted'])) throw new AppError(422, 'not_in_good_standing', 'Pay the late installment on your other plan before starting a new one.');
  if (count(OPEN) >= TERMS.maxOpenPlans) throw new AppError(422, 'plan_limit', `You can have up to ${TERMS.maxOpenPlans} Pay it in 4 plans at a time.`);
  return { ...p, source: p.lineId ? 'ledger_line' : 'stated', payFrom: pay };
}

function disclosure(p, autopayAccountId) {
  const t = cents(p.totalCents), s = schedule(p.totalCents, bankToday());
  return {
    merchant: p.merchant, totalCents: t, amountFinancedCents: t, financeChargeCents: 0, totalOfPaymentsCents: t, aprBps: 0, upfrontFeeCents: 0,
    installmentCount: TERMS.installments, intervalDays: TERMS.intervalDays,
    installments: s.map(i => ({ number: i.number, dueDate: i.dueDate, amountCents: cents(i.amountCents) })),
    autopayAccountId, lateFeeCents: cents(TERMS.lateFeeCents), lateFeeGraceDays: TERMS.graceDays, lateFeeCapCents: cents(TERMS.lateFeeCapCents),
    earlyPayoffPenaltyCents: 0,
    notice: `You pay ${usd(p.totalCents)} to ${p.merchant} in ${TERMS.installments} payments: the first today, then one every ${TERMS.intervalDays} days, ` +
      `taken automatically from the account you chose. APR 0%, finance charge $0.00, no up-front fee. A late fee of ${usd(TERMS.lateFeeCents)} applies only to a payment ` +
      `still unpaid ${TERMS.graceDays} days after its due date, at most ${usd(TERMS.lateFeeCapCents)} per plan. You can pay the rest early at any time at no cost. ` +
      'Simulated: this is a fictional demo bank.'
  };
}
const usd = c => `$${(c / 100n).toLocaleString('en-US')}.${String(c % 100n).padStart(2, '0')}`;

// ---------- collecting ----------
/**
 * Tries one installment from the plan's payment account (R20, R22, R23). On success one entry pays it; on failure an
 * attempt is recorded and, past the grace period, the installment is marked missed and charged its late fee once.
 */
async function collectOne(c, req, plan, inst, today) {
  const amount = big(inst.amount_cents), fee = big(inst.late_fee_cents), due = amount + fee;
  const base = { planId: plan.id, installment: inst.number, dueDate: inst.due_date, amountCents: cents(amount), lateFeeCents: cents(fee) };
  const a = (await c.query('SELECT status, balance_cents FROM accounts WHERE id = $1 FOR UPDATE', [plan.autopay_account_id])).rows[0];
  const failure = a.status !== 'open' ? 'account_not_open' : big(a.balance_cents) < due ? 'insufficient_funds' : null;
  if (failure) {
    await c.query(`INSERT INTO pay_in_4_attempts (plan_id, installment, attempted_on, amount_cents, status, failure_code) VALUES ($1,$2,$3,$4,'failed',$5)`,
      [plan.id, inst.number, today, due, failure]);
    await audit(c, req, plan.user_id, 'pay4.installment_failed', { plan: plan.id, installment: inst.number, failureCode: failure });
    if (inst.status === 'scheduled' && today > addDays(inst.due_date, TERMS.graceDays)) {
      const charged = (await c.query('SELECT coalesce(sum(late_fee_cents), 0)::bigint s FROM pay_in_4_installments WHERE plan_id = $1', [plan.id])).rows[0].s;
      const room = TERMS.lateFeeCapCents - big(charged), newFee = room < TERMS.lateFeeCents ? (room > 0n ? room : 0n) : TERMS.lateFeeCents;
      await c.query(`UPDATE pay_in_4_installments SET status = 'missed', late_fee_cents = $3 WHERE plan_id = $1 AND number = $2`, [plan.id, inst.number, newFee]);
      await audit(c, req, plan.user_id, 'pay4.installment_missed', { plan: plan.id, installment: inst.number, lateFeeCents: cents(newFee) });
    }
    return { ...base, status: 'failed', entryId: null, failureCode: failure };
  }
  const lines = [
    { accountId: plan.autopay_account_id, amountCents: -due, description: `Pay it in 4: payment ${inst.number} of ${TERMS.installments}, ${plan.merchant}`, category: 'Payments' },
    { accountId: await systemAccount(c, SYS.receivable), amountCents: amount, description: `Pay it in 4 payment ${inst.number}: ${plan.merchant}` }];
  if (fee > 0n) lines.push({ accountId: await systemAccount(c, SYS.fees), amountCents: fee, description: `Pay it in 4 late fee: ${plan.merchant}` });
  const { entryId } = await post(c, { key: `${plan.user_id}:${F}:${plan.id}:${inst.number}`, kind: 'pay_in_4_installment', memo: memo(plan.merchant), createdBy: plan.user_id, lines });
  await c.query(`UPDATE pay_in_4_installments SET status = 'paid', paid_on = $3, entry_id = $4 WHERE plan_id = $1 AND number = $2`, [plan.id, inst.number, today, entryId]);
  await c.query(`INSERT INTO pay_in_4_attempts (plan_id, installment, attempted_on, amount_cents, status, entry_id) VALUES ($1,$2,$3,$4,'posted',$5)`,
    [plan.id, inst.number, today, due, entryId]);
  await audit(c, req, plan.user_id, 'pay4.installment_paid', { plan: plan.id, installment: inst.number, amountCents: cents(amount), lateFeeCents: cents(fee) });
  return { ...base, status: 'paid', entryId, failureCode: null };
}

/** Recomputes a plan's status from its installments (R24) and audits a change. */
async function settleStatus(c, req, planId) {
  const p = (await c.query('SELECT * FROM pay_in_4_plans WHERE id = $1', [planId])).rows[0];
  const to = statusOf(p, await installmentsOf(c, planId));
  if (to === p.status) return;
  await c.query('UPDATE pay_in_4_plans SET status = $2 WHERE id = $1', [planId, to]);
  await audit(c, req, p.user_id, 'pay4.status', { plan: planId, from: p.status, to });
}

const paymentAccountOpen = async (c, plan, needed) => {
  const a = (await c.query('SELECT status, balance_cents FROM accounts WHERE id = $1 FOR UPDATE', [plan.autopay_account_id])).rows[0];
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', 'The account your installments are paid from is not open. Choose another account first.');
  if (needed !== undefined && big(a.balance_cents) < needed) throw new AppError(409, 'insufficient_funds', "There isn't enough money in that account.");
};

export function register(r) {
  // Quote: the disclosure for the plan this purchase would get today. Checks everything accepting does, up to the plan count.
  r.add('POST', '/api/pay-in-4/quote', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const p = await eligible(c, u, body);
    await audit(c, req, u.id, 'pay4.quote', { totalCents: cents(p.totalCents), merchant: p.merchant });
    return { disclosure: disclosure(p, body.autopayAccountId) };
  }));

  // Accept: create the plan, post the purchase, and collect installment 1 now, in one transaction.
  r.add('POST', '/api/pay-in-4/plans', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = requestKey(body), fingerprint = fingerprintOf({}, body);
    await lock(c, `${u.id}:${F}`);                                 // one accept per customer at a time: replays, plan count and standing stay exact
    const prev = (await c.query('SELECT id, fingerprint FROM pay_in_4_plans WHERE user_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
    if (prev) {
      if (prev.fingerprint !== fingerprint) throw conflict();
      return { plan: await viewOf(c, prev.id), replayed: true };
    }
    const p = await eligible(c, u, body);
    if (body.acceptedDisclosure !== true || !Number.isInteger(body.acknowledgedTotalCents))
      throw new AppError(400, 'disclosure_not_accepted', 'Read the Pay it in 4 terms and confirm you agree to them.');
    if (big(body.acknowledgedTotalCents) !== p.totalCents)
      throw new AppError(409, 'disclosure_mismatch', 'The total you agreed to is not this purchase total. Get a new quote and try again.');
    requireStepUp(u);

    const id = newId(), today = bankToday();
    const plan = (await c.query(`INSERT INTO pay_in_4_plans (id, user_id, merchant, source, line_id, purchase_account_id, total_cents, autopay_account_id, idempotency_key, fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, u.id, p.merchant, p.source, p.lineId, p.purchaseAccountId, p.totalCents, p.payFrom.id, key, fingerprint])).rows[0];
    for (const i of schedule(p.totalCents, today))
      await c.query('INSERT INTO pay_in_4_installments (plan_id, number, due_date, original_amount_cents, amount_cents) VALUES ($1,$2,$3,$4,$4)', [id, i.number, i.dueDate, i.amountCents]);
    const receivable = await systemAccount(c, SYS.receivable);
    if (p.lineId) {                                                  // the purchase on the account is paid back now; the plan owes it instead
      await post(c, { key: `${u.id}:${F}:${id}:convert`, kind: 'pay_in_4_convert', memo: memo(p.merchant), createdBy: u.id, lines: [
        { accountId: p.purchaseAccountId, amountCents: p.totalCents, description: memo(p.merchant), category: 'Payments' },
        { accountId: receivable, amountCents: -p.totalCents, description: `Pay it in 4 plan: ${p.merchant}` }] });
    } else {                                                         // the bank pays the merchant (simulated); the customer's accounts don't change
      await post(c, { key: `${u.id}:${F}:${id}:purchase`, kind: 'pay_in_4_purchase', memo: memo(p.merchant), createdBy: u.id, lines: [
        { accountId: receivable, amountCents: -p.totalCents, description: `Pay it in 4 plan: ${p.merchant}` },
        { accountId: await systemAccount(c, SYS.merchant), amountCents: p.totalCents, description: `Paid to ${p.merchant} (simulated)` }] });
    }
    await audit(c, req, u.id, 'pay4.accept', { plan: id, totalCents: cents(p.totalCents), source: p.source });
    const first = await collectOne(c, req, plan, (await installmentsOf(c, id))[0], today);
    if (first.status !== 'paid') throw new AppError(409, first.failureCode, first.failureCode === 'insufficient_funds'
      ? "There isn't enough money in that account for the first payment." : 'That account is not open. Choose another account.');
    return { plan: await viewOf(c, id), replayed: false };
  }));

  r.add('GET', '/api/pay-in-4/plans', async ({ req, pool, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if ('status' in query && !STATUSES.includes(query.status)) throw new AppError(400, 'bad_status', `Status must be one of: ${STATUSES.join(', ')}.`);
    const plans = (await c.query(`SELECT * FROM pay_in_4_plans WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, id DESC`,
      [u.id, query.status ?? null])).rows;
    const insts = (await c.query('SELECT * FROM pay_in_4_installments WHERE plan_id = ANY($1::uuid[]) ORDER BY number', [plans.map(p => p.id)])).rows;
    return { plans: plans.map(p => planView(p, insts.filter(i => i.plan_id === p.id))) };
  }));

  r.add('GET', '/api/pay-in-4/plans/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const p = await ownPlan(c, u, params.id);
    return { plan: await viewOf(c, p.id, { attempts: true }) };
  }));

  r.add('POST', '/api/pay-in-4/plans/:id/autopay', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const p = await ownPlan(c, u, params.id, { forUpdate: true });
    if (!OPEN.includes(p.status)) throw new AppError(409, 'invalid_state', `This plan is ${p.status}, so there is nothing left to pay from another account.`);
    const a = await payFromAccount(c, u, body.accountId);
    if (a.id !== p.autopay_account_id) {
      await c.query('UPDATE pay_in_4_plans SET autopay_account_id = $2 WHERE id = $1', [p.id, a.id]);
      await audit(c, req, u.id, 'pay4.autopay_change', { plan: p.id });
    }
    return { plan: await viewOf(c, p.id) };
  }));

  // Collect: every installment of the caller's active and past-due plans that is due today or earlier, oldest first.
  r.add('POST', '/api/pay-in-4/collect', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const today = bankToday();
    // Locked in one order, so parallel collects (any sign-in) wait for each other and never take an installment twice.
    const plans = (await c.query(`SELECT * FROM pay_in_4_plans WHERE user_id = $1 AND status = ANY($2::text[]) ORDER BY id FOR UPDATE`, [u.id, COLLECTABLE])).rows;
    const byId = new Map(plans.map(p => [p.id, p]));
    const due = (await c.query(`SELECT i.* FROM pay_in_4_installments i JOIN pay_in_4_plans p ON p.id = i.plan_id
       WHERE i.plan_id = ANY($1::uuid[]) AND i.status = ANY($2::text[]) AND i.due_date <= $3::date ORDER BY i.due_date, p.created_at, i.number`,
      [[...byId.keys()], UNPAID, today])).rows;
    const results = [];
    for (const i of due) results.push(await collectOne(c, req, byId.get(i.plan_id), i, today));
    for (const id of new Set(due.map(i => i.plan_id))) await settleStatus(c, req, id);
    return { results, paid: results.filter(x => x.status === 'paid').length, failed: results.filter(x => x.status === 'failed').length };
  }));

  // Pay off: every unpaid installment (and late fee already charged) at once, no penalty.
  r.add('POST', '/api/pay-in-4/plans/:id/payoff', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const p = await ownPlan(c, u, params.id, { forUpdate: true });
    if (!OPEN.includes(p.status)) throw new AppError(409, 'invalid_state', `This plan is ${p.status}: there is nothing left to pay.`);
    const unpaid = (await installmentsOf(c, p.id)).filter(i => UNPAID.includes(i.status));
    const amounts = sum(unpaid, i => big(i.amount_cents)), fees = sum(unpaid, i => big(i.late_fee_cents)), total = amounts + fees;
    await paymentAccountOpen(c, p, total);
    const today = bankToday();
    const lines = [
      { accountId: p.autopay_account_id, amountCents: -total, description: `Pay it in 4: payoff, ${p.merchant}`, category: 'Payments' },
      { accountId: await systemAccount(c, SYS.receivable), amountCents: amounts, description: `Pay it in 4 payoff: ${p.merchant}` }];
    if (fees > 0n) lines.push({ accountId: await systemAccount(c, SYS.fees), amountCents: fees, description: `Pay it in 4 late fees: ${p.merchant}` });
    const { entryId } = await post(c, { key: `${u.id}:${F}:${p.id}:payoff`, kind: 'pay_in_4_payoff', memo: memo(p.merchant), createdBy: u.id, lines });
    await c.query(`UPDATE pay_in_4_installments SET status = 'paid', paid_on = $2, entry_id = $3 WHERE plan_id = $1 AND status = ANY($4::text[])`, [p.id, today, entryId, UNPAID]);
    await audit(c, req, u.id, 'pay4.payoff', { plan: p.id, amountCents: cents(total) });
    await settleStatus(c, req, p.id);
    return { plan: await viewOf(c, p.id), payoff: { amountCents: cents(total), entryId } };
  }));

  // Refund (simulated merchant refund): reduces what is unpaid from the last installment back, and pays the rest back.
  r.add('POST', '/api/pay-in-4/plans/:id/refund', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = requestKey(body);
    const p = await ownPlan(c, u, params.id, { forUpdate: true });
    await lock(c, `${u.id}:${F}:refund:${key}`);
    const prev = (await c.query('SELECT * FROM pay_in_4_refunds WHERE user_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
    if (prev) {
      if (prev.plan_id !== p.id || !Number.isSafeInteger(body.amountCents) || big(body.amountCents) !== big(prev.amount_cents)) throw conflict();
      return { plan: await viewOf(c, p.id), refund: refundView(prev), replayed: true };
    }
    if (!isCentsInput(body.amountCents)) throw new AppError(400, 'bad_amount', 'Enter the refund amount in whole cents.');
    const amount = big(body.amountCents);
    if (amount > big(p.total_cents) - big(p.refunded_cents)) throw new AppError(422, 'refund_exceeds_purchase', 'The refund is more than what is left of the purchase.');
    let left = amount;
    const changes = [];
    for (const i of (await installmentsOf(c, p.id)).filter(i => UNPAID.includes(i.status)).reverse()) {
      if (!left) break;
      const owed = big(i.amount_cents), cut = owed < left ? owed : left;
      left -= cut;
      changes.push({ number: i.number, amount: owed - cut });
    }
    const applied = amount - left, credited = left;
    if (credited > 0n) await paymentAccountOpen(c, p);
    const lines = [{ accountId: await systemAccount(c, SYS.merchant), amountCents: -amount, description: `Refund from ${p.merchant} (simulated)` }];
    if (applied > 0n) lines.push({ accountId: await systemAccount(c, SYS.receivable), amountCents: applied, description: `Pay it in 4 refund: ${p.merchant}` });
    if (credited > 0n) lines.push({ accountId: p.autopay_account_id, amountCents: credited, description: `Pay it in 4: refund from ${p.merchant}`, category: 'Payments' });
    const { entryId } = await post(c, { key: `${u.id}:${F}:${p.id}:refund:${key}`, kind: 'pay_in_4_refund', memo: memo(p.merchant), createdBy: u.id, lines });
    for (const ch of changes)                                        // reduced to 0: canceled, and its late fee waived
      await c.query(`UPDATE pay_in_4_installments SET amount_cents = $3, status = CASE WHEN $3::bigint = 0 THEN 'canceled' ELSE status END,
        late_fee_cents = CASE WHEN $3::bigint = 0 THEN 0 ELSE late_fee_cents END WHERE plan_id = $1 AND number = $2`, [p.id, ch.number, ch.amount]);
    await c.query('UPDATE pay_in_4_plans SET refunded_cents = refunded_cents + $2 WHERE id = $1', [p.id, amount]);
    const row = (await c.query(`INSERT INTO pay_in_4_refunds (id, plan_id, user_id, idempotency_key, amount_cents, applied_cents, credited_cents, entry_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [newId(), p.id, u.id, key, amount, applied, credited, entryId])).rows[0];
    await audit(c, req, u.id, 'pay4.refund', { plan: p.id, amountCents: cents(amount), appliedToPlanCents: cents(applied), creditedCents: cents(credited) });
    await settleStatus(c, req, p.id);
    return { plan: await viewOf(c, p.id), refund: refundView(row), replayed: false };
  }));
}
const refundView = r => ({ amountCents: cents(r.amount_cents), appliedToPlanCents: cents(r.applied_cents), creditedCents: cents(r.credited_cents), entryId: r.entry_id });
