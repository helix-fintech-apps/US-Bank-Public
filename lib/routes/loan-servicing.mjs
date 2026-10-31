// Personal loan servicing: take out a fixed-rate personal loan (approved at once, no credit decision), its schedule as of
// today, scheduled and extra payments, late fees, payoff quotes and payoff. Money is BigInt cents inside and JSON integers
// in and out (this feature's contract); the math is in lib/loan-servicing/math.mjs, the tables in 065_loan_servicing.sql.
// Separate from the loans module: these loans have no row in `loans`, so /api/loans never lists or pays them.
import { AppError, isUuid } from '../http.mjs';
import { fingerprintOf, conflict, requestKey } from '../idempotency.mjs';
import { tx } from '../db.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { bankToday, addDays } from '../bank-date.mjs';
import { isDate } from '../dates.mjs';
import { newLast4 } from '../onboarding.mjs';
import { monthlyPayment } from '../loans-credit/amortize.mjs';
import { LATE_DAYS, dueDate, lateFee, accrue, copy, step, feesDue, scheduleAsOf, payoffOn } from '../loan-servicing/math.mjs';

const F = 'loan-servicing';
const DEPOSIT = ['checking', 'savings', 'money_market'];
const OWN = ['owner', 'joint_owner'];
const MAX_ACTIVE = 3;                                          // active personal loans per customer
const QUOTE_DAYS = 30;                                         // a payoff quote can be good through today + 30 days
const MAX_EXTRA_CENTS = 10_000_000_000n;
const PRODUCT = 'personal';                                    // amount, rate and term limits are this loan_products row (040)

const n = v => (v == null ? v : Number(v));                    // ok-number: cents as JSON integers (this API's contract), exact far below 2^53
const ledgerKey = (u, k) => `${u.id}:${F}:${k}`;
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);
const inRange = (v, lo, hi) => isInt(v) && BigInt(v) >= BigInt(lo) && BigInt(v) <= BigInt(hi);

const terms = l => ({ aprBps: l.apr_bps, termMonths: l.term_months, paymentDay: l.payment_day, paymentCents: BigInt(l.payment_cents),
  lateFeeCents: BigInt(l.late_fee_cents), originatedOn: l.originated_on });
const stateOf = l => ({ P: BigInt(l.principal_balance_cents), I: BigInt(l.interest_due_cents), R: BigInt(l.interest_remainder), AT: l.accrued_through,
  k: l.installments_paid + 1, latePaid: l.late_installments_paid, feesPaid: BigInt(l.fees_paid_cents), paidOff: l.status === 'paid_off' });

/** The loan object (5.1); accrued interest, fees due and past due are as of today. */
function loanView(l) {
  const t = terms(l), s = stateOf(l), today = bankToday();
  const next = s.paidOff ? null : { number: s.k, dueDate: dueDate(t, s.k) };
  return { id: l.id, status: l.status, principalCents: n(l.principal_cents), aprBps: l.apr_bps, termMonths: l.term_months, paymentDay: l.payment_day,
    paymentCents: n(l.payment_cents), lateFeeCents: n(l.late_fee_cents), originatedOn: l.originated_on, firstDueDate: l.first_due_date,
    disbursementAccountId: l.disbursement_account_id, last4: l.number_last4, principalBalanceCents: n(s.P),
    accruedInterestCents: n(accrue(t, copy(s), today).I), feesDueCents: n(feesDue(t, s, today)), accruedThrough: s.AT,
    installmentsPaid: l.installments_paid, nextInstallment: next, pastDue: !!next && next.dueDate < today, paidOffOn: l.paid_off_on, createdAt: l.created_at };
}
const paymentView = p => ({ id: p.id, loanId: p.loan_id, kind: p.kind, installmentNumber: p.installment_number, postedOn: p.posted_on, fromAccountId: p.from_account_id,
  amountCents: n(p.amount_cents), feeCents: n(p.fee_cents), interestCents: n(p.interest_cents), principalCents: n(p.principal_cents),
  principalBalanceAfterCents: n(p.principal_balance_after_cents), entryId: p.entry_id, createdAt: p.created_at });
const quoteView = q => ({ id: q.id, loanId: q.loan_id, createdOn: q.created_on, goodThrough: q.good_through, principalCents: n(q.principal_cents),
  interestCents: n(q.interest_cents), feeCents: n(q.fee_cents), amountCents: n(q.amount_cents) });

const LOAN = 'SELECT l.*, a.number_last4 FROM personal_loans l JOIN accounts a ON a.id = l.id';
/** The caller's own loan (they borrowed it), or a 404: another customer's, unknown and malformed ids look the same. */
async function loanFor(c, u, id, { lock = false } = {}) {
  const l = isUuid(id) && (await c.query(`${LOAN} WHERE l.id = $1 AND l.user_id = $2${lock ? ' FOR UPDATE OF l' : ''}`, [id, u.id])).rows[0];
  if (!l) throw new AppError(404, 'not_found', 'Loan not found.');
  return l;
}
const loanById = async (c, id) => (await c.query(`${LOAN} WHERE l.id = $1`, [id])).rows[0];
const paymentById = async (c, id) => (await c.query('SELECT * FROM personal_loan_payments WHERE id = $1', [id])).rows[0];

/** One customer's writes in this feature run one at a time: request ids, the 3-loan cap and each loan's state stay exact. */
const lockCustomer = (c, u) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${F}:${u.id}`]);

/** The earlier successful request with this id (any endpoint of this feature), or null. A different request is a 422. */
async function prior(c, u, k, fingerprint) {
  const r = (await c.query('SELECT * FROM personal_loan_requests WHERE user_id = $1 AND idempotency_key = $2', [u.id, k])).rows[0];
  if (r && r.fingerprint !== fingerprint) throw conflict();
  return r ?? null;
}
const remember = (c, u, k, fingerprint, loanId, paymentId = null) =>
  c.query('INSERT INTO personal_loan_requests (user_id, idempotency_key, fingerprint, loan_id, payment_id) VALUES ($1,$2,$3,$4,$5)', [u.id, k, fingerprint, loanId, paymentId]);

/** One of the caller's own open deposit accounts (owner or joint owner), with plain-words refusals. */
async function ownDeposit(c, u, id, what) {
  if (typeof id !== 'string') throw new AppError(400, 'bad_account', `Choose the checking or savings account ${what}.`);
  const a = await accountFor(c, u.id, id, OWN);
  if (!DEPOSIT.includes(a.kind)) throw new AppError(400, 'bad_account', `Choose a checking, savings or money market account ${what}.`);
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', 'That account is not open. Choose an open account.');
  return a;
}
const enoughIn = (a, cents) => {
  if (BigInt(a.balance_cents) < cents) throw new AppError(409, 'insufficient_funds', "There isn't enough money in that account.");
};
const closed = () => new AppError(409, 'loan_closed', 'This loan is paid off.');

/**
 * Posts one payment (scheduled, extra or payoff) and saves the loan's new state: one ledger entry, one payment row, the
 * request id, and the audit trail, all in this transaction. parts: { feeCents, interestCents, principalCents } (BigInt).
 */
async function book(c, req, u, l, { k, fingerprint, from, kind, installmentNumber = null, parts, next }) {
  const { feeCents, interestCents, principalCents } = parts, amount = feeCents + interestCents + principalCents, last4 = l.number_last4;
  const lines = [{ accountId: from.id, amountCents: -amount, description: `Personal loan ··${last4} payment`, category: 'Loans' }];
  if (principalCents) lines.push({ accountId: l.id, amountCents: principalCents, description: 'Principal', category: 'Loans' });
  if (interestCents) lines.push({ accountId: await systemAccount(c, 'loan_interest_income'), amountCents: interestCents, description: `Interest, personal loan ··${last4}` });
  if (feeCents) lines.push({ accountId: await systemAccount(c, 'fee_income'), amountCents: feeCents, description: `Late fee, personal loan ··${last4}` });
  const { entryId, replayed } = await post(c, { key: ledgerKey(u, k), kind: 'personal_loan_payment', memo: `${kind} payment, personal loan ${l.id}`, createdBy: u.id, lines });
  if (replayed) throw conflict();                              // the ledger already has this id: never pay twice
  const id = newId(), on = bankToday(), done = next.P === 0n;
  await c.query(`INSERT INTO personal_loan_payments (id, loan_id, kind, installment_number, posted_on, from_account_id, amount_cents, fee_cents, interest_cents,
      principal_cents, principal_balance_after_cents, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, l.id, kind, installmentNumber, on, from.id, amount, feeCents, interestCents, principalCents, next.P, entryId]);
  if (done) Object.assign(next, { I: 0n, R: 0n });             // the remainder is never paid: dropped at payoff
  await c.query(`UPDATE personal_loans SET principal_balance_cents = $2, interest_due_cents = $3, interest_remainder = $4, accrued_through = $5,
      installments_paid = $6, late_installments_paid = $7, fees_paid_cents = $8, payments_made = payments_made + 1, status = $9, paid_off_on = $10 WHERE id = $1`,
    [l.id, next.P, next.I, next.R, next.AT, next.k - 1, next.latePaid, next.feesPaid, done ? 'paid_off' : 'active', done ? on : null]);
  await c.query(`UPDATE accounts SET payment_due = $2, status = CASE WHEN $3 THEN 'closed' ELSE status END WHERE id = $1`,
    [l.id, done ? null : dueDate(terms(l), next.k), done]);
  await remember(c, u, k, fingerprint, l.id, id);
  await audit(c, req, u.id, 'loanservicing.payment', { loan: l.id, payment: id, kind, amountCents: n(amount), feeCents: n(feeCents),
    interestCents: n(interestCents), principalCents: n(principalCents), entry: entryId });
  if (done) await audit(c, req, u.id, 'loanservicing.paid_off', { loan: l.id, on });
  return { payment: paymentView(await paymentById(c, id)), loan: loanView(await loanById(c, l.id)), replayed: false };
}

export function register(r) {
  // Take out a loan: approved at once. Opens the loan account and pays the principal into the customer's deposit account.
  r.add('POST', '/api/loan-servicing/loans', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const k = requestKey(body), fingerprint = fingerprintOf({ endpoint: 'open' }, body);
    await lockCustomer(c, u);
    const was = await prior(c, u, k, fingerprint);
    if (was) return { loan: loanView(await loanById(c, was.loan_id)), replayed: true };
    const p = (await c.query('SELECT * FROM loan_products WHERE code = $1', [PRODUCT])).rows[0];
    const { principalCents, aprBps, termMonths, paymentDay } = body;
    if (!inRange(principalCents, p.min_amount_cents, p.max_amount_cents)) throw new AppError(400, 'bad_principal', `Choose an amount from ${p.min_amount_cents} to ${p.max_amount_cents} cents.`);
    if (!inRange(aprBps, p.apr_min_bps, p.apr_max_bps)) throw new AppError(400, 'bad_apr', `Choose a rate from ${p.apr_min_bps} to ${p.apr_max_bps} basis points.`);
    if (!inRange(termMonths, p.min_term, p.max_term)) throw new AppError(400, 'bad_term', `Choose a term from ${p.min_term} to ${p.max_term} months.`);
    if (!inRange(paymentDay, 1, 28)) throw new AppError(400, 'bad_payment_day', 'Choose a payment day from 1 to 28.');
    const to = await ownDeposit(c, u, body.disbursementAccountId, 'to pay the loan into');
    requireStepUp(u);
    const active = (await c.query("SELECT count(*)::int n FROM personal_loans WHERE user_id = $1 AND status = 'active'", [u.id])).rows[0].n;
    if (active >= MAX_ACTIVE) throw new AppError(409, 'too_many_loans', `You can have up to ${MAX_ACTIVE} personal loans open at once. Pay one off to take out another.`);

    const P = BigInt(principalCents), payment = monthlyPayment(P, aprBps, termMonths), on = bankToday(), id = newId(), last4 = await newLast4(c);
    const t = { originatedOn: on, paymentDay }, first = dueDate(t, 1);
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4, status, allow_negative, payment_due) VALUES ($1, 'loan', 'Personal Loan', $2, 'open', true, $3)`, [id, last4, first]);
    await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [id, u.id]);
    const { entryId, replayed } = await post(c, { key: ledgerKey(u, k), kind: 'personal_loan_disbursement', memo: `personal loan ${id}`, createdBy: u.id, lines: [
      { accountId: id, amountCents: -P, description: 'Personal loan opened', category: 'Loans' },
      { accountId: to.id, amountCents: P, description: `Personal loan ··${last4} disbursement`, category: 'Loans' }] });
    if (replayed) throw conflict();
    await c.query(`INSERT INTO personal_loans (id, user_id, principal_cents, apr_bps, term_months, payment_day, payment_cents, late_fee_cents, originated_on, first_due_date,
        disbursement_account_id, principal_balance_cents, accrued_through, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$3,$9,$12)`,
      [id, u.id, P, aprBps, termMonths, paymentDay, payment, lateFee(payment), on, first, to.id, entryId]);
    await remember(c, u, k, fingerprint, id);
    await audit(c, req, u.id, 'loanservicing.open', { loan: id, principalCents: n(P), aprBps, termMonths, paymentDay, paymentCents: n(payment), entry: entryId });
    return { loan: loanView(await loanById(c, id)), replayed: false };
  }));

  r.add('GET', '/api/loan-servicing/loans', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`${LOAN} WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.seq DESC`, [u.id])).rows;
    return { loans: rows.map(loanView) };
  }));

  r.add('GET', '/api/loan-servicing/loans/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    return { loan: loanView(await loanFor(c, u, params.id)) };
  }));

  r.add('GET', '/api/loan-servicing/loans/:id/schedule', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const l = await loanFor(c, u, params.id), today = bankToday();
    const { rows, totals } = scheduleAsOf(terms(l), stateOf(l), today);
    const obj = o => Object.fromEntries(Object.entries(o).map(([key, v]) => [key, typeof v === 'bigint' ? n(v) : v]));
    return { loanId: l.id, asOf: today, rows: rows.map(obj), totals: obj(totals) };
  }));

  // A scheduled payment pays installment k exactly as the first schedule row as of today; an extra payment pays fees, then
  // interest accrued to today, then principal, and pays no installment.
  r.add('POST', '/api/loan-servicing/loans/:id/payments', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await loanFor(c, u, params.id);
    const k = requestKey(body), fingerprint = fingerprintOf({ endpoint: 'payment', id: params.id.toLowerCase() }, body);
    await lockCustomer(c, u);
    const was = await prior(c, u, k, fingerprint);
    const l = await loanFor(c, u, params.id, { lock: true });
    if (was) return { payment: paymentView(await paymentById(c, was.payment_id)), loan: loanView(l), replayed: true };
    const kind = body.kind;
    if (kind !== 'scheduled' && kind !== 'extra') throw new AppError(400, 'bad_kind', 'Choose a scheduled or an extra payment. To pay the loan off, get a payoff quote.');
    if (kind === 'scheduled' && Object.hasOwn(body, 'amountCents')) throw new AppError(400, 'bad_amount', "A scheduled payment's amount is set by the schedule: leave the amount out.");
    if (kind === 'extra' && !inRange(body.amountCents, 1n, MAX_EXTRA_CENTS)) throw new AppError(400, 'bad_amount', `Enter the extra payment in whole cents, from 1 to ${MAX_EXTRA_CENTS}.`);
    const from = await ownDeposit(c, u, body.fromAccountId, 'to pay from');
    if (l.status !== 'active') throw closed();
    const t = terms(l), s = stateOf(l), today = bankToday();
    let parts, next;
    if (kind === 'scheduled') {
      const fee = feesDue(t, s, today);
      next = copy(s);
      const row = step(t, next);                               // interest to the due date, whatever the payment date
      parts = { feeCents: fee, interestCents: row.interestCents, principalCents: row.principalCents };
      next.feesPaid += fee;
      if (addDays(row.dueDate, LATE_DAYS) < today) next.latePaid += 1;
    } else {
      const X = BigInt(body.amountCents), fee = feesDue(t, s, today);
      next = accrue(t, copy(s), today);
      if (X >= fee + next.I + next.P) throw new AppError(422, 'use_payoff', 'That pays off the loan. Get a payoff quote and pay it off instead.', { payoffCents: n(fee + next.I + next.P) });
      const feeCents = X < fee ? X : fee, rest = X - feeCents, interestCents = rest < next.I ? rest : next.I;
      parts = { feeCents, interestCents, principalCents: rest - interestCents };
      next.feesPaid += feeCents; next.I -= interestCents; next.P -= parts.principalCents;
    }
    enoughIn(from, parts.feeCents + parts.interestCents + parts.principalCents);
    return book(c, req, u, l, { k, fingerprint, from, kind, installmentNumber: kind === 'scheduled' ? s.k : null, parts, next });
  }));

  r.add('GET', '/api/loan-servicing/loans/:id/payments', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const l = await loanFor(c, u, params.id);
    return { payments: (await c.query('SELECT * FROM personal_loan_payments WHERE loan_id = $1 ORDER BY seq', [l.id])).rows.map(paymentView) };
  }));

  // A quote is figured on a copy of the loan for paying off on goodThrough: interest to that date and the late fees due by then.
  r.add('POST', '/api/loan-servicing/loans/:id/payoff-quotes', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const l = await loanFor(c, u, params.id);
    if (l.status !== 'active') throw closed();
    const today = bankToday(), last = addDays(today, QUOTE_DAYS), g = body.goodThrough;
    if (typeof g !== 'string' || !isDate(g) || g < today || g > last) throw new AppError(400, 'bad_date', `Choose a good-through date from ${today} to ${last}.`);
    const q = payoffOn(terms(l), stateOf(l), g), id = newId();
    const row = (await c.query(`INSERT INTO personal_loan_quotes (id, loan_id, created_on, good_through, principal_cents, interest_cents, fee_cents, amount_cents, payments_made)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, l.id, today, g, q.principalCents, q.interestCents, q.feeCents, q.amountCents, l.payments_made])).rows[0];
    await audit(c, req, u.id, 'loanservicing.quote', { loan: l.id, quote: id, goodThrough: g, amountCents: n(q.amountCents) });
    return { quote: quoteView(row) };
  }));

  // Pay off with a quote: the payoff amount as of today (never more than the quote), then the loan and its account close.
  r.add('POST', '/api/loan-servicing/loans/:id/payoff', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await loanFor(c, u, params.id);
    const k = requestKey(body), fingerprint = fingerprintOf({ endpoint: 'payoff', id: params.id.toLowerCase() }, body);
    await lockCustomer(c, u);
    const was = await prior(c, u, k, fingerprint);
    const l = await loanFor(c, u, params.id, { lock: true });
    if (was) return { payment: paymentView(await paymentById(c, was.payment_id)), loan: loanView(l), replayed: true };
    if (l.status !== 'active') throw closed();
    const q = typeof body.quoteId === 'string' && isUuid(body.quoteId)
      && (await c.query('SELECT * FROM personal_loan_quotes WHERE id = $1 AND loan_id = $2', [body.quoteId, l.id])).rows[0];
    if (!q) throw new AppError(404, 'quote_not_found', 'Payoff quote not found. Get a new payoff quote.');
    const today = bankToday();
    if (today > q.good_through) throw new AppError(409, 'quote_expired', `This quote was good through ${q.good_through}. Get a new payoff quote.`);
    if (q.payments_made !== l.payments_made) throw new AppError(409, 'quote_stale', 'A payment was made after this quote. Get a new payoff quote.');
    const from = await ownDeposit(c, u, body.fromAccountId, 'to pay from');
    const t = terms(l), s = stateOf(l), parts = payoffOn(t, s, today);
    enoughIn(from, parts.amountCents);
    const next = { ...accrue(t, copy(s), today), P: 0n, feesPaid: s.feesPaid + parts.feeCents };
    return book(c, req, u, l, { k, fingerprint, from, kind: 'payoff', parts, next });
  }));
}
