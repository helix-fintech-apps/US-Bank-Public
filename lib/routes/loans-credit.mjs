// Loans (M7) and credit tools (M8): products, prequalify (soft check), apply (hard check + decision), accept and
// disburse, repay, and the simulated credit file. Rules and rates are data (db/migrations/040_loans_credit.sql).
import { AppError } from '../http.mjs';
import { fingerprintOf, conflict, requestKey } from '../idempotency.mjs';
import { tx } from '../db.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor, MOVE_MONEY } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { parseAmount, toStr } from '../money.mjs';
import { ageOf } from './accounts.mjs';
import { monthlyPayment, dailyInterest, schedule, addMonths, daysBetween, divRound } from '../loans-credit/amortize.mjs';
import { decide, aprFor, pct } from '../loans-credit/decide.mjs';
import { ensureFile, liveScore, inputsFor, simulate, recordPull, creditAlert } from '../loans-credit/credit.mjs';
import { bankToday, bankDateOf, addDays } from '../bank-date.mjs';
import { newLast4 } from '../onboarding.mjs';

const F = 'loans-credit';
const OFFER_DAYS = 30;                                         // offers are non-binding and expire (RESEARCH.md §5 (d))
const SCORE_ALERT_POINTS = 10;                                 // a month-over-month move this big raises a monitoring alert (RESEARCH.md §5)
// Card offer on the credit page: the Cash+ Card's own terms from card_products (M6), so it agrees with card prequalify.
const CARD_OFFER = { product: 'cash_plus', upTo: '10000.00', href: '/app/cards' };
const EMPLOYMENT = { employed: 'Employed', self_employed: 'Self-employed', retired: 'Retired', unemployed: 'Not working', other: 'Other' };
const DEPOSIT = ['checking', 'savings', 'money_market'];
const OWN = ['owner', 'joint_owner'];
export const SIMULATED = 'Simulated: no real credit bureau. Scores, inquiries and decisions exist only in this demo.';

const today = bankToday;                                       // the bank date (Central Time), the same "today" as every feature
const apr = bps => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;     // ok-number: basis points to "7.74"
const band = s => (s >= 800 ? 'Excellent' : s >= 740 ? 'Very good' : s >= 670 ? 'Good' : s >= 580 ? 'Fair' : 'Poor');

function adultOnly(u) {
  if (u.dateOfBirth && ageOf(u.dateOfBirth) < 18) throw new AppError(403, 'not_eligible', 'You must be 18 or older to apply for credit or see a credit score.');
}
const key = (u, body) => `${u.id}:${F}:${requestKey(body)}`;

async function product(c, code) {
  const p = (await c.query('SELECT * FROM loan_products WHERE code = $1', [String(code ?? '')])).rows[0];
  if (!p) throw new AppError(400, 'bad_product', 'Choose a loan type.');
  p.rules = (await c.query('SELECT * FROM loan_rules WHERE product_code = $1 ORDER BY rank', [p.code])).rows;
  p.bands = (await c.query('SELECT * FROM loan_rate_bands WHERE product_code = $1 ORDER BY min_score DESC', [p.code])).rows;
  return p;
}
const productView = p => ({ code: p.code, family: p.family, name: p.name, blurb: p.blurb, collateral: p.collateral,
  minAmount: toStr(p.min_amount_cents), maxAmount: toStr(p.max_amount_cents), minTerm: p.min_term, maxTerm: p.max_term,
  aprMin: apr(p.apr_min_bps), aprMax: apr(p.apr_max_bps), source: p.source,
  rules: p.rules?.map(r => ({ rule: r.rule, limit: r.rule === 'min_score' ? String(r.limit_value) : pct(r.limit_value), reason: r.reason })),
  bands: p.bands?.map(b => ({ minScore: b.min_score, apr: apr(b.apr_bps) })) });

/** Reads and checks an application form. Amounts are strings in dollars; the product sets the limits. */
function readForm(p, b, { full }) {
  const amountCents = parseAmount(b.amount, { field: 'the amount', min: BigInt(p.min_amount_cents), max: BigInt(p.max_amount_cents) });
  const term = Number.parseInt(b.term, 10);
  if (!Number.isInteger(term) || term < p.min_term || term > p.max_term) throw new AppError(400, 'bad_term', `Choose a term from ${p.min_term} to ${p.max_term} months.`);
  const annualIncomeCents = parseAmount(b.annualIncome, { field: 'yearly income', min: 0n });
  const housingCents = b.housingPayment == null && !full ? 0n : parseAmount(b.housingPayment, { field: 'monthly housing payment', min: 0n });
  const employment = full ? String(b.employment ?? '') : 'employed';
  if (!EMPLOYMENT[employment]) throw new AppError(400, 'bad_employment', 'Tell us about your employment.');
  let collateral = null;
  if (p.collateral === 'vehicle') collateral = { valueCents: parseAmount(b.vehicleValue, { field: 'the vehicle value' }), lienCents: 0n };
  if (p.collateral === 'home') collateral = { valueCents: parseAmount(b.propertyValue, { field: 'the home value' }), lienCents: parseAmount(b.mortgageBalance ?? '0', { field: 'the mortgage balance', min: 0n }) };
  const legalName = String(b.legalName ?? '').trim().slice(0, 80);
  return { amountCents, term, annualIncomeCents, housingCents, employment, collateral, legalName };
}

/** Monthly debts already owed (without the new loan): housing + debts held elsewhere + our loans + card minimums (3%, at least $25). */
async function monthlyDebts(c, userId, housingCents, inputs) {
  const loans = (await c.query(`SELECT coalesce(sum(l.payment_cents), 0)::bigint s FROM loans l JOIN account_owners o ON o.account_id = l.account_id
     WHERE o.user_id = $1 AND o.role IN ('owner','joint_owner') AND l.status = 'active'`, [userId])).rows[0].s;
  const cards = (await c.query(`SELECT greatest(-a.balance_cents, 0) owed FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE o.user_id = $1 AND o.role IN ('owner','joint_owner') AND a.kind = 'credit_card' AND a.status <> 'closed'`, [userId])).rows;
  const min = owed => { const p = divRound(owed * 3n, 100n); return owed <= 2500n ? owed : p > 2500n ? p : 2500n; };
  const mins = cards.reduce((s, { owed }) => s + min(BigInt(owed)), 0n);
  return housingCents + BigInt(inputs.otherMonthlyDebtCents) + loans + mins;
}

const appView = (a, p) => ({
  id: a.id, product: { code: p.code, name: p.name }, status: a.status, decision: a.decision, createdAt: a.created_at,
  requested: { amount: toStr(a.amount_cents), term: a.term_months },
  score: a.score, dti: a.dti_bps == null ? null : pct(a.dti_bps), ltv: a.ltv_bps == null ? null : pct(a.ltv_bps),
  reasons: a.reasons, offer: a.offer_amount_cents == null ? null : { amount: toStr(a.offer_amount_cents), term: a.offer_term, apr: apr(a.offer_apr_bps),
    payment: toStr(a.offer_payment_cents), expiresAt: a.offer_expires_at, expired: new Date(a.offer_expires_at) <= new Date() },
  loanId: a.loan_id ?? null, simulated: SIMULATED });

/** Interest accrued since the last payment (or origination) to today, daily actual/365, half up to the cent (amortize.mjs). */
function accrued(l, owed) {
  const days = Math.max(0, daysBetween(l.last_paid_on ?? l.originated_on, today()));
  return { days, interest: dailyInterest(owed, l.apr_bps, days) };
}
async function payoffQuote(l, owed) {
  const { days, interest } = accrued(l, owed);
  return { principal: owed, interest, total: owed + interest, days };
}
const rowView = r => ({ n: r.n, payment: toStr(r.payment), interest: toStr(r.interest), principal: toStr(r.principal), balance: toStr(r.balance) });

async function loanView(c, a, l, { full = false } = {}) {
  const owed = -BigInt(a.balance_cents), q = await payoffQuote(l, owed);
  const v = { id: a.id, name: a.name, last4: a.number_last4, status: l.status, product: l.product_code, collateral: l.collateral_label,
    principal: toStr(l.principal_cents), owed: toStr(owed), apr: apr(l.apr_bps), term: l.term_months, payment: toStr(l.payment_cents),
    nextDue: l.next_due, originatedOn: l.originated_on, paidOffOn: l.paid_off_on, installmentsPaid: l.installments_paid,
    paidPercent: Number(divRound((BigInt(l.principal_cents) - owed) * 100n, BigInt(l.principal_cents))),       // ok-number: a whole percent for the progress bar
    payoff: l.status === 'active' ? { principal: toStr(q.principal), interest: toStr(q.interest), total: toStr(q.total), asOf: today(), days: q.days } : null };
  if (!full) return v;
  const orig = schedule(l.principal_cents, l.apr_bps, l.term_months);
  const left = l.status === 'active' ? schedule(owed, l.apr_bps, l.term_months - l.installments_paid, BigInt(l.payment_cents)) : [];
  const pays = (await c.query(`SELECT p.*, f.name from_name, f.number_last4 from_last4 FROM loan_payments p LEFT JOIN accounts f ON f.id = p.from_account_id
     WHERE p.loan_account_id = $1 ORDER BY p.posted_on DESC, p.id`, [a.id])).rows;
  let due = l.next_due;
  return { ...v,
    original: { rows: orig.map(rowView), totalPrincipal: toStr(orig.reduce((s, r) => s + r.principal, 0n)), totalInterest: toStr(orig.reduce((s, r) => s + r.interest, 0n)) },
    remaining: left.map((r, i) => ({ ...rowView(r), due: i === 0 ? due : (due = addMonths(l.next_due, i)) })),
    payments: pays.map(p => ({ id: p.id, kind: p.kind, postedOn: p.posted_on, amount: toStr(p.amount_cents), principal: toStr(p.principal_cents), interest: toStr(p.interest_cents),
      from: p.from_account_id ? `${p.from_name} ··${p.from_last4}` : 'External bank (ACH autopay)' })) };
}

async function loanFor(c, u, id, roles) {
  const a = await accountFor(c, u.id, id, roles);
  const l = a.kind === 'loan' && (await c.query(`SELECT * FROM loans WHERE account_id = $1${roles === MOVE_MONEY ? ' FOR UPDATE' : ''}`, [a.id])).rows[0];
  if (!l) throw new AppError(404, 'not_found', 'Loan not found.');
  return { a, l };
}
async function payFrom(c, u, id) {
  const a = await accountFor(c, u.id, id, OWN);
  if (!DEPOSIT.includes(a.kind)) throw new AppError(400, 'bad_account', 'Choose one of your checking or savings accounts.');
  return a;
}
const depositAccounts = async (c, u) => (await c.query(`SELECT a.id, a.name, a.number_last4, a.balance_cents FROM accounts a JOIN account_owners o ON o.account_id = a.id
   WHERE o.user_id = $1 AND o.role IN ('owner','joint_owner') AND a.kind = ANY($2) AND a.status = 'open' ORDER BY a.kind, a.opened_at`, [u.id, DEPOSIT])).rows
  .map(a => ({ id: a.id, name: a.name, last4: a.number_last4, balance: toStr(a.balance_cents) }));

async function offersFor(c, score) {
  const ps = (await c.query('SELECT * FROM loan_products ORDER BY sort')).rows;
  const bands = (await c.query('SELECT * FROM loan_rate_bands')).rows, rules = (await c.query("SELECT * FROM loan_rules WHERE rule = 'min_score'")).rows;
  const expires = addDays(today(), OFFER_DAYS);
  const note = 'Prequalified from a soft check: no effect on your score. Not a commitment to lend.';
  const loans = ps.filter(p => score >= (rules.find(r => r.product_code === p.code)?.limit_value ?? 999)).map(p => {
    const bps = aprFor(bands.filter(b => b.product_code === p.code), score);
    return { product: p.code, kind: 'loan', name: p.name, apr: apr(bps), upTo: toStr(p.max_amount_cents), terms: `${p.min_term}–${p.max_term} months`, expiresOn: expires,
      href: `/app/loans?apply=${p.code}`, note };
  });
  const cp = (await c.query('SELECT name, min_score, apr_min_bp FROM card_products WHERE code = $1', [CARD_OFFER.product])).rows[0];
  const card = cp && score >= cp.min_score ? [{ product: CARD_OFFER.product, kind: 'card', name: cp.name, apr: apr(cp.apr_min_bp), upTo: CARD_OFFER.upTo,
    terms: 'Revolving credit line', expiresOn: expires, href: CARD_OFFER.href, note }] : [];
  return [...card, ...loans];
}

const alertView = a => ({ id: String(a.id), kind: a.kind, title: a.title, body: a.body, createdAt: a.created_at, read: !!a.read_at });

/** Monitoring: a score that moved SCORE_ALERT_POINTS or more since last month raises one alert for the month. */
async function scoreAlert(c, userId, score, last) {
  if (last == null || Math.abs(score - last) < SCORE_ALERT_POINTS) return;
  const up = score > last;
  await creditAlert(c, userId, { kind: 'score_change', ref: `score:${today().slice(0, 7)}`, title: `Your score ${up ? 'rose' : 'fell'} ${Math.abs(score - last)} points`,
    body: `Your simulated score is ${score}, ${up ? 'up' : 'down'} from ${last} last month. See what's shaping it below.` });
}

/** Four display digits for a new loan account that no other account shows (the shared generator, under its lock). */
const freeLast4 = newLast4;

export function register(r) {
  r.add('GET', '/api/loans/products', async ({ req, pool }) => tx(pool, async c => {
    await requireUser(c, req);
    const codes = (await c.query('SELECT code FROM loan_products ORDER BY sort')).rows;
    return { products: await Promise.all(codes.map(async ({ code }) => productView(await product(c, code)))), simulated: SIMULATED };
  }));

  // Soft check: an estimate, no effect on the score. Recorded as a soft inquiry only the customer sees.
  r.add('POST', '/api/loans/prequalify', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u);
    const p = await product(c, body.product), f = readForm(p, body, { full: false });
    await ensureFile(c, u);
    const { score, inputs } = await liveScore(c, u.id);
    const d = decide({ product: p, rules: p.rules, bands: p.bands, score, amountCents: f.amountCents, term: f.term, annualIncomeCents: f.annualIncomeCents,
      otherDebtCents: await monthlyDebts(c, u.id, f.housingCents, inputs), collateralValueCents: f.collateral?.valueCents, lienCents: f.collateral?.lienCents });
    await recordPull(c, u.id, { kind: 'soft', source: 'prequalify', label: `${p.name} prequalification`, score });
    const hi = Math.min(...p.bands.filter(b => b.apr_bps > d.aprBps).map(b => b.apr_bps), p.apr_max_bps);
    const out = { likely: d.decision, score, scoreBand: band(score), aprLow: apr(d.aprBps), aprHigh: apr(Math.max(hi, d.aprBps)),
      payment: toStr(monthlyPayment(f.amountCents, d.aprBps, f.term)), amount: toStr(f.amountCents), term: f.term,
      offer: d.offer ? { amount: toStr(d.offer.amountCents), term: d.offer.term, payment: toStr(d.offer.paymentCents) } : null,
      reasons: d.reasons.map(x => x.text), softCheck: true, simulated: SIMULATED };
    await audit(c, req, u.id, 'loan.prequalify', { product: p.code, amount: out.amount, term: f.term, annualIncome: toStr(f.annualIncomeCents), score, likely: d.decision });
    return out;
  }));

  // Apply: step-up, hard check (an inquiry on the file), then the decision. Every decision is audited with its inputs.
  r.add('POST', '/api/loans/applications', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u); requireStepUp(u);
    // The page sends a request id: a double submit returns the first application, with no second hard pull. Callers without one behave as before.
    const k = body.idempotencyKey == null ? null : key(u, body);
    if (k) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [k]);                         // two identical requests at once: the second waits, then replays
      const prev = (await c.query('SELECT a.*, l.account_id loan_id FROM loan_applications a LEFT JOIN loans l ON l.application_id = a.id WHERE a.user_id = $1 AND a.idempotency_key = $2', [u.id, k])).rows[0];
      if (prev) {
        if (prev.idempotency_fingerprint && prev.idempotency_fingerprint !== fingerprintOf({}, body)) throw conflict();   // same id, different request (also when two arrive at once)
        return { ...appView(prev, await product(c, prev.product_code)), replayed: true };
      }
    }
    const p = await product(c, body.product), f = readForm(p, body, { full: true });
    await ensureFile(c, u);
    const { score, inputs } = await liveScore(c, u.id);                                         // the score as pulled, before this inquiry
    const debts = await monthlyDebts(c, u.id, f.housingCents, inputs);
    const flagged = /DECLINE/.test(f.legalName) || /DECLINE/.test(u.displayName);
    const d = decide({ product: p, rules: p.rules, bands: p.bands, score, amountCents: f.amountCents, term: f.term, annualIncomeCents: f.annualIncomeCents,
      otherDebtCents: debts, collateralValueCents: f.collateral?.valueCents, lienCents: f.collateral?.lienCents, flagged });
    const pull = await recordPull(c, u.id, { kind: 'hard', source: 'loan', label: `${p.name} application`, score });
    const id = newId(), o = d.offer;
    const collateral = f.collateral ? { value: toStr(f.collateral.valueCents), ...(p.collateral === 'home' ? { mortgageBalance: toStr(f.collateral.lienCents) } : {}),
      ...(body.vehicle ? { vehicle: String(body.vehicle).slice(0, 80) } : {}) } : null;
    const a = (await c.query(`INSERT INTO loan_applications (id, user_id, product_code, amount_cents, term_months, annual_income_cents, housing_cents, employment, collateral,
        score, dti_bps, ltv_bps, pull_id, decision, reasons, offer_amount_cents, offer_term, offer_apr_bps, offer_payment_cents, offer_expires_at, idempotency_key, idempotency_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, CASE WHEN $16::bigint IS NULL THEN NULL ELSE now() + make_interval(days => $20) END, $21, $22) RETURNING *`,
      [id, u.id, p.code, f.amountCents, f.term, f.annualIncomeCents, f.housingCents, f.employment, collateral, score, d.dtiBps, d.ltvBps, pull, d.decision,
        JSON.stringify(d.reasons.map(x => x.text)), o?.amountCents ?? null, o?.term ?? null, o ? d.aprBps : null, o?.paymentCents ?? null, OFFER_DAYS, k, k ? fingerprintOf({}, body) : null])).rows[0];
    await audit(c, req, u.id, 'loan.decision', {                                               // inputs and reasons; no SSN is ever collected
      application: id, product: p.code, amount: toStr(f.amountCents), term: f.term, annualIncome: toStr(f.annualIncomeCents), housingPayment: toStr(f.housingCents),
      otherMonthlyDebts: toStr(debts), employment: f.employment, collateral, score, dtiBps: d.dtiBps, ltvBps: d.ltvBps, hardPull: pull, bureau: 'Simulated', flagged,
      decision: d.decision, reasons: d.reasons.map(x => x.text), offer: o ? { amount: toStr(o.amountCents), term: o.term, aprBps: d.aprBps, payment: toStr(o.paymentCents) } : null });
    return appView(a, p);
  }));

  r.add('GET', '/api/loans/applications/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = /^[0-9a-f-]{36}$/i.test(params.id) && (await c.query('SELECT a.*, l.account_id loan_id FROM loan_applications a LEFT JOIN loans l ON l.application_id = a.id WHERE a.id = $1 AND a.user_id = $2', [params.id, u.id])).rows[0];
    if (!a) throw new AppError(404, 'not_found', 'Application not found.');
    return { application: appView(a, await product(c, a.product_code)), depositAccounts: await depositAccounts(c, u) };
  }));

  // Accept: step-up, an unexpired offer, then one loan account and one disbursement. The application row is locked and
  // the ledger keys are the request's, so a retry returns the same loan and a second accept is refused.
  r.add('POST', '/api/loans/applications/:id/accept', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u); requireStepUp(u);
    const k = key(u, body);
    const a = /^[0-9a-f-]{36}$/i.test(params.id) && (await c.query('SELECT * FROM loan_applications WHERE id = $1 AND user_id = $2 FOR UPDATE', [params.id, u.id])).rows[0];
    if (!a) throw new AppError(404, 'not_found', 'Application not found.');
    if (a.status === 'accepted') {
      const l = (await c.query('SELECT * FROM loans WHERE application_id = $1', [a.id])).rows[0];
      if (a.accept_key !== k) throw new AppError(409, 'already_accepted', 'You already accepted this offer. Your loan is open.', { loanId: l.account_id });
      const acct = (await c.query('SELECT * FROM accounts WHERE id = $1', [l.account_id])).rows[0];
      return { loan: await loanView(c, acct, l), replayed: true };
    }
    if (a.decision === 'declined') throw new AppError(409, 'declined', "This application was declined, so there's no offer to accept.");
    if (new Date(a.offer_expires_at) <= new Date()) throw new AppError(410, 'offer_expired', `This offer expired. Offers last ${OFFER_DAYS} days; please apply again.`);
    const to = await payFrom(c, u, body.depositAccountId);
    const p = await product(c, a.product_code);
    const P = BigInt(a.offer_amount_cents), on = today(), loanId = newId(), last4 = await freeLast4(c);
    const label = a.collateral?.vehicle ?? null;
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, payment_due) VALUES ($1, 'loan', $2, $3, true, $4)`, [loanId, p.name, last4, addMonths(on, 1)]);
    await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [loanId, u.id]);
    await c.query(`INSERT INTO loans (account_id, application_id, product_code, principal_cents, apr_bps, term_months, payment_cents, originated_on, next_due, disbursed_to, collateral_label)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [loanId, a.id, p.code, P, a.offer_apr_bps, a.offer_term, a.offer_payment_cents, on, addMonths(on, 1), to.id, label]);
    const funding = await systemAccount(c, 'loan_disbursement');
    const booked = await post(c, { key: `${k}:originate`, kind: 'loan_origination', createdBy: u.id, memo: `application ${a.id}`, lines: [
      { accountId: loanId, amountCents: -P, description: `${p.name} opened`, category: 'Loans', postedOn: on },
      { accountId: funding, amountCents: P, description: `Loan booked ··${last4}`, postedOn: on }] });
    const paid = await post(c, { key: `${k}:disburse`, kind: 'loan_disbursement', createdBy: u.id, memo: `application ${a.id}`, lines: [
      { accountId: funding, amountCents: -P, description: `Loan disbursed ··${last4}`, postedOn: on },
      { accountId: to.id, amountCents: P, description: `${p.name} ··${last4} disbursement`, category: 'Loans', postedOn: on }] });
    await c.query("UPDATE loan_applications SET status = 'accepted', accept_key = $2 WHERE id = $1", [a.id, k]);
    await audit(c, req, u.id, 'loan.accept', { application: a.id, loan: loanId, amount: toStr(P), term: a.offer_term, aprBps: a.offer_apr_bps, payment: toStr(a.offer_payment_cents) });
    await creditAlert(c, u.id, { kind: 'new_account', ref: `loan:${loanId}`, title: 'New account on your file',
      body: `${p.name} ··${last4} for ${toStr(P)} opened ${on}. (Simulated: no real credit bureau.)` });
    await audit(c, req, u.id, 'loan.disburse', { loan: loanId, amount: toStr(P), toLast4: to.number_last4, entries: [booked.entryId, paid.entryId] });
    const acct = (await c.query('SELECT * FROM accounts WHERE id = $1', [loanId])).rows[0], l = (await c.query('SELECT * FROM loans WHERE account_id = $1', [loanId])).rows[0];
    return { loan: await loanView(c, acct, l), replayed: false };
  }));

  r.add('GET', '/api/loans', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT a.*, l.* FROM loans l JOIN accounts a ON a.id = l.account_id JOIN account_owners o ON o.account_id = a.id
       WHERE o.user_id = $1 ORDER BY (l.status = 'active') DESC, l.originated_on DESC`, [u.id])).rows;
    const apps = (await c.query(`SELECT a.*, p.name, l.account_id loan_id FROM loan_applications a JOIN loan_products p ON p.code = a.product_code
       LEFT JOIN loans l ON l.application_id = a.id WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 10`, [u.id])).rows;
    return { loans: await Promise.all(rows.map(x => loanView(c, x, x))), applications: apps.map(a => appView(a, { code: a.product_code, name: a.name })) };
  }));

  r.add('GET', '/api/loans/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a, l } = await loanFor(c, u, params.id);
    return { loan: await loanView(c, a, l, { full: true }), depositAccounts: await depositAccounts(c, u) };
  }));

  r.add('GET', '/api/loans/:id/payoff', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a, l } = await loanFor(c, u, params.id);
    if (l.status !== 'active') throw new AppError(409, 'paid_off', 'This loan is paid off.');
    const q = await payoffQuote(l, -BigInt(a.balance_cents));
    return { principal: toStr(q.principal), interest: toStr(q.interest), total: toStr(q.total), asOf: today(), days: q.days };
  }));

  // Repay from a deposit account: scheduled installment, extra principal or payoff. Interest goes to loan_interest_income.
  r.add('POST', '/api/loans/:id/payments', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const k = key(u, body);
    const { a, l } = await loanFor(c, u, params.id, MOVE_MONEY);
    const prev = (await c.query('SELECT * FROM loan_payments WHERE idempotency_key = $1', [k])).rows[0];
    if (prev) {
      if (prev.loan_account_id !== a.id) throw new AppError(422, 'idempotency_conflict', 'This request id was already used for something else.');
      return { payment: { id: prev.id, kind: prev.kind, amount: toStr(prev.amount_cents), principal: toStr(prev.principal_cents), interest: toStr(prev.interest_cents) }, replayed: true,
        loan: await loanView(c, (await c.query('SELECT * FROM accounts WHERE id = $1', [a.id])).rows[0], (await c.query('SELECT * FROM loans WHERE account_id = $1', [a.id])).rows[0]) };
    }
    if (l.status !== 'active') throw new AppError(409, 'paid_off', 'This loan is already paid off.');
    const from = await payFrom(c, u, body.fromAccountId);
    const owed = -BigInt(a.balance_cents), kind = String(body.kind ?? '');
    // Every payment pays the interest accrued since the last one first (daily, actual/365), then principal.
    let principal, interest;
    if (kind === 'scheduled') {
      interest = accrued(l, owed).interest; principal = BigInt(l.payment_cents) - interest;
      if (principal >= owed) principal = owed;                                                     // the last installment pays exactly what's left
      if (principal < 0n) principal = 0n;                                                          // very late: the installment covers the interest
    } else if (kind === 'extra') {
      const q = await payoffQuote(l, owed);
      const total = parseAmount(body.amount, { field: 'the extra payment', max: q.total });
      interest = q.interest; principal = total - interest;
      if (principal <= 0n) throw new AppError(422, 'too_small', `Pay more than the interest owed so far (${toStr(interest)}), so some of it reduces the balance.`, { interest: toStr(interest) });
      if (principal >= owed) throw new AppError(422, 'use_payoff', `That pays off the loan. Choose "Pay off" to include interest to today: ${toStr(q.total)}.`, { payoff: toStr(q.total) });
    } else if (kind === 'payoff') {
      const q = await payoffQuote(l, owed); principal = q.principal; interest = q.interest;
    } else throw new AppError(400, 'bad_kind', 'Choose a payment type.');
    const amount = principal + interest, on = today(), id = newId();
    const lines = [{ accountId: from.id, amountCents: -amount, description: `${a.name} ··${a.number_last4} payment`, category: 'Loans', postedOn: on }];
    if (principal) lines.push({ accountId: a.id, amountCents: principal, description: kind === 'extra' ? 'Extra principal payment' : kind === 'payoff' ? 'Payoff' : 'Payment, principal', category: 'Loans', postedOn: on });
    if (interest) lines.push({ accountId: await systemAccount(c, 'loan_interest_income'), amountCents: interest, description: `Interest, loan ··${a.number_last4}`, postedOn: on });
    const { entryId } = await post(c, { key: k, kind: 'loan_payment', createdBy: u.id, memo: `${kind} payment`, lines });
    await c.query(`INSERT INTO loan_payments (id, loan_account_id, from_account_id, kind, amount_cents, principal_cents, interest_cents, entry_id, idempotency_key, posted_on, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, a.id, from.id, kind, amount, principal, interest, entryId, k, on, u.id]);
    const done = principal === owed;
    const next = done ? null : kind === 'scheduled' ? addMonths(l.next_due, 1) : l.next_due;
    await c.query(`UPDATE loans SET last_paid_on = $2, installments_paid = installments_paid + $3, next_due = $4, status = $5, paid_off_on = $6 WHERE account_id = $1`,
      [a.id, on, kind === 'scheduled' ? 1 : 0, next, done ? 'paid_off' : 'active', done ? on : null]);
    await c.query(`UPDATE accounts SET payment_due = $2, status = CASE WHEN $3 THEN 'closed' ELSE status END WHERE id = $1`, [a.id, next, done]);
    await audit(c, req, u.id, 'loan.payment', { loan: a.id, kind, amount: toStr(amount), principal: toStr(principal), interest: toStr(interest), fromLast4: from.number_last4, entry: entryId });
    if (done) {
      await audit(c, req, u.id, 'loan.paid_off', { loan: a.id, on });
      await creditAlert(c, u.id, { kind: 'paid_off', ref: `paidoff:${a.id}`, title: 'Loan paid off', body: `${a.name} ··${a.number_last4} was paid in full on ${on}. Nice work.` });
    }
    const acct = (await c.query('SELECT * FROM accounts WHERE id = $1', [a.id])).rows[0], nl = (await c.query('SELECT * FROM loans WHERE account_id = $1', [a.id])).rows[0];
    return { payment: { id, kind, amount: toStr(amount), principal: toStr(principal), interest: toStr(interest) }, replayed: false, loan: await loanView(c, acct, nl) };
  }));

  // ---------- credit tools (simulated) ----------
  r.add('GET', '/api/credit', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u);
    await ensureFile(c, u);
    const { score, factors, inputs } = await liveScore(c, u.id);
    const hist = (await c.query(`SELECT month, score FROM credit_score_history WHERE user_id = $1 AND month < date_trunc('month', $2::date) ORDER BY month DESC LIMIT 11`, [u.id, today()])).rows.reverse();
    await scoreAlert(c, u.id, score, hist.at(-1)?.score);
    const pulls = (await c.query("SELECT * FROM credit_pulls WHERE user_id = $1 AND at > now() - interval '24 months' ORDER BY at DESC", [u.id])).rows;
    const alerts = (await c.query('SELECT * FROM credit_alerts WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [u.id])).rows;
    const thisMonth = today().slice(0, 8) + '01';
    return { score, band: band(score), range: { min: 300, max: 850 }, model: 'Simulated USA Banc score (VantageScore-style, 300–850)', asOf: today(),
      change: hist.length ? score - hist.at(-1).score : 0,
      history: [...hist.map(h => ({ month: h.month, score: h.score })), { month: thisMonth, score }],
      factors, cards: { owed: toStr(inputs.owedCents), limit: toStr(inputs.limitCents) },
      inquiries: pulls.map(i => ({ id: i.id, kind: i.kind, source: i.source, bureau: i.bureau, label: i.label, on: bankDateOf(i.at),
        note: i.kind === 'hard' ? 'Hard pull: counts for 12 months' : 'Soft pull: only you see it; no effect' })),
      alerts: alerts.map(alertView), unread: alerts.filter(a => !a.read_at).length,
      offers: await offersFor(c, score), simulated: SIMULATED };
  }));

  // Mark monitoring alerts read: { ids: [...] } or { all: true }. Only the caller's own alerts change.
  r.add('POST', '/api/credit/alerts/read', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(x => /^\d{1,18}$/.test(x)) : [];
    if (body.all !== true && !ids.length) throw new AppError(400, 'bad_ids', 'Choose an alert to mark as read.');
    const r2 = body.all === true
      ? await c.query('UPDATE credit_alerts SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.id])
      : await c.query('UPDATE credit_alerts SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])', [u.id, ids]);
    const unread = (await c.query('SELECT count(*)::int n FROM credit_alerts WHERE user_id = $1 AND read_at IS NULL', [u.id])).rows[0].n;
    return { marked: r2.rowCount, unread };
  }));

  r.add('POST', '/api/credit/simulate', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u);
    await ensureFile(c, u);
    const inputs = await inputsFor(c, u.id), now = (await liveScore(c, u.id)).score;
    const payDownCents = body.payDown ? parseAmount(body.payDown, { field: 'the pay-down amount', min: 0n }) : 0n;
    const newCardLimitCents = body.newCardLimit ? parseAmount(body.newCardLimit, { field: 'the new card limit', min: 0n }) : 0n;
    const s = simulate(inputs, { payDownCents, newCardLimitCents, missPayment: body.missPayment === true });
    return { score: s.score, current: now, change: s.score - now, band: band(s.score), factors: s.factors, simulated: SIMULATED };
  }));
}
