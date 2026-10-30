// Auto loan workflow: apply (decided at once by the loans module's engine), a staff review queue for referred
// applications, 7-day offers with a cost disclosure, adverse action notices, and accept + fund through the ledger.
// Unlike the rest of the API, amounts here are JSON integers in cents (fields ending in Cents) and rates are integer
// basis points, as the Auto Loan Workflow requirements specify. Products, rules and APR bands are data (migration 040).
import { AppError, refuse, isUuid } from '../http.mjs';
import { fingerprintOf, conflict, requestKey } from '../idempotency.mjs';
import { tx } from '../db.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { ageOf } from './accounts.mjs';
import { monthlyDebts } from './loans-credit.mjs';
import { monthlyPayment, schedule, addMonths } from '../loans-credit/amortize.mjs';
import { decide } from '../loans-credit/decide.mjs';
import { ensureFile, liveScore, recordPull, creditAlert } from '../loans-credit/credit.mjs';
import { bankToday, addDays } from '../bank-date.mjs';
import { newLast4 } from '../onboarding.mjs';

const F = 'auto-loans';
const PRODUCTS = ['auto_new', 'auto_used'];
const OFFER_DAYS = 7;                                          // an offer can be accepted from its issue date to issue date + 7
const REVIEW_ABOVE_CENTS = 7_500_000n;                         // the engine approved more than $75,000.00: loan staff review it
const DAILY_LIMIT = 3;                                         // applications per customer per bank date
const COUNTER_APR_SPREAD = 200;                                // a counter-offer's APR: the engine APR up to +2.00 points
const MAX_PRICE = 100_000_000, MAX_INCOME = 10_000_000_000, MAX_HOUSING = 100_000_000;
const EMPLOYMENT = ['employed', 'self_employed', 'retired', 'unemployed', 'other'];
const DEPOSIT = ['checking', 'savings', 'money_market'];
const OWN = ['owner', 'joint_owner'];
const STAFF_ROLE = 'loan_officer';
const FIELDS = new Set(['idempotencyKey', 'product', 'vehicle', 'priceCents', 'downPaymentCents', 'amountCents', 'termMonths',
  'annualIncomeCents', 'housingCostCents', 'employment', 'disbursementAccountId', 'creditConsent']);
// Never asked for and never used in a credit decision (ECOA / Regulation B). A request carrying one is refused unread.
const PROHIBITED = new Set(['race', 'color', 'religion', 'nationalOrigin', 'sex', 'gender', 'maritalStatus', 'age', 'dateOfBirth',
  'familyStatus', 'disability', 'publicAssistance']);
const VEHICLE_KEYS = ['year', 'make', 'model', 'vehicleId'];
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;                           // 17 characters, no I, O or Q
// Principal reasons for an adverse action, in plain words.
const REASONS = {
  low_credit_score: 'Your credit score is below our minimum for this loan.',
  high_debt_to_income: 'Your debt payments are too high compared with your income.',
  high_loan_to_value: 'The loan amount is too high compared with the value of the vehicle.',
  insufficient_income: 'Your income is not enough for the amount of credit requested.',
  employment_not_verified: 'We could not verify your employment.',
  vehicle_not_eligible: 'The vehicle does not meet our requirements for this loan.',
  limited_credit_history: 'Your credit history is too limited.',
  recent_credit_inquiries: 'There are too many recent requests for credit on your credit file.',
  other_policy: 'The application does not meet our lending policy.'
};
const RULE_REASON = { min_score: 'low_credit_score', max_dti: 'high_debt_to_income', max_ltv: 'high_loan_to_value' };
const CREDITOR = 'USA Banc';
const ECOA = 'Notice: The federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of '
  + 'race, color, religion, national origin, sex, marital status, age (provided the applicant has the capacity to enter into a binding contract); '
  + 'because all or part of the applicant\'s income derives from any public assistance program; or because the applicant has in good faith '
  + 'exercised any right under the Consumer Credit Protection Act. The federal agency that administers compliance with this law concerning this '
  + 'creditor is the Consumer Financial Protection Bureau, 1700 G Street NW, Washington, DC 20552. (Simulated: USA Banc is a fictional demo bank.)';

const today = bankToday;
const cents = v => (v == null ? null : Number(v));             // ok-number: amounts are capped far below 2^53, so the JSON integer is exact
const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const key = (u, body) => `${u.id}:${F}:${requestKey(body)}`;
const OPEN_OFFER = ['approved', 'countered', 'funding_failed'];
/** The status shown: an open offer past its expiry date reads 'expired'. */
const statusOf = a => (OPEN_OFFER.includes(a.status) && today() > a.offer_expires_on ? 'expired' : a.status);

function adultOnly(u) {
  if (u.dateOfBirth && ageOf(u.dateOfBirth) < 18) throw new AppError(403, 'not_eligible', 'You must be 18 or older to apply for a loan.');
}

async function product(c, code) {
  const p = (await c.query('SELECT * FROM loan_products WHERE code = $1', [code])).rows[0];
  p.rules = (await c.query('SELECT * FROM loan_rules WHERE product_code = $1 ORDER BY rank', [code])).rows;
  p.bands = (await c.query('SELECT * FROM loan_rate_bands WHERE product_code = $1 ORDER BY min_score DESC', [code])).rows;
  return p;
}

/** The offer with its cost disclosure, from the schedule amortize.mjs builds for its own amount, APR and term. */
export function disclosure(type, amountCents, aprBps, termMonths, issuedOn) {
  const P = BigInt(amountCents), rows = schedule(P, aprBps, termMonths);
  const finance = rows.reduce((s, r) => s + r.interest, 0n);
  return { type, amountFinancedCents: cents(P), termMonths, aprBps, paymentCents: cents(monthlyPayment(P, aprBps, termMonths)),
    finalPaymentCents: cents(rows.at(-1).payment), financeChargeCents: cents(finance), totalOfPaymentsCents: cents(P + finance),
    issuedOn, expiresOn: addDays(issuedOn, OFFER_DAYS) };
}
const offerOf = a => (a.offer_type ? disclosure(a.offer_type, a.offer_amount_cents, a.offer_apr_bps, a.offer_term, a.offer_issued_on) : null);

function appView(a) {
  const status = statusOf(a);
  return { id: a.id, status, decision: a.decision, product: a.product_code,
    vehicle: { year: a.vehicle_year, make: a.vehicle_make, model: a.vehicle_model, vehicleId: a.vehicle_id },
    priceCents: cents(a.price_cents), downPaymentCents: cents(a.down_payment_cents), amountCents: cents(a.amount_cents), termMonths: a.term_months,
    annualIncomeCents: cents(a.annual_income_cents), housingCostCents: cents(a.housing_cents), employment: a.employment,
    disbursementAccountId: a.disbursement_account_id, offer: offerOf(a), loanId: a.loan_id ?? null,
    failureCode: status === 'funding_failed' ? a.failure_code : null, createdAt: a.created_at };
}
const loanOut = a => ({ id: a.loan_id, principalCents: cents(a.offer_amount_cents), aprBps: a.offer_apr_bps, termMonths: a.offer_term,
  paymentCents: cents(monthlyPayment(a.offer_amount_cents, a.offer_apr_bps, a.offer_term)), disbursedToAccountId: a.disbursed_to,
  originationEntryId: a.origination_entry_id, disbursementEntryId: a.disbursement_entry_id });

/** One of the caller's own applications, or a 404 (someone else's, unknown or malformed: never confirm it exists). */
async function own(c, u, id, { lock = false } = {}) {
  const a = isUuid(id) && (await c.query(`SELECT * FROM auto_loan_applications WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, u.id])).rows[0];
  if (!a) throw new AppError(404, 'not_found', 'Application not found.');
  return a;
}

/** A deposit account the customer owns (owner or joint owner) to pay the loan into. Status is checked by the caller. */
async function depositAccount(c, u, id) {
  const a = await accountFor(c, u.id, id, OWN);
  if (!DEPOSIT.includes(a.kind)) throw new AppError(400, 'bad_account', 'Choose one of your checking, savings or money market accounts.');
  return a;
}

/** Reads and checks an application, in the order the requirements give. Returns the clean form and the product. */
async function readForm(c, u, b) {
  const keys = Object.keys(b);
  if (keys.some(k => PROHIBITED.has(k))) throw new AppError(400, 'prohibited_field', "We don't ask for or use that information in a credit decision. Remove it and try again.");
  if (keys.some(k => !FIELDS.has(k))) throw new AppError(400, 'unknown_field', 'The application has a field we do not use. Remove it and try again.');
  if (!PRODUCTS.includes(b.product)) throw new AppError(400, 'bad_product', 'Choose New Auto Loan or Used Auto Loan.');
  const p = await product(c, b.product);
  const v = b.vehicle, maxYear = Number(today().slice(0, 4)) + 1;                                  // ok-number: a year
  const text = s => (typeof s === 'string' ? s.trim() : '');
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== VEHICLE_KEYS.length || !VEHICLE_KEYS.every(k => Object.hasOwn(v, k))
    || !isInt(v.year, 1990, maxYear) || !text(v.make) || text(v.make).length > 40 || !text(v.model) || text(v.model).length > 40
    || typeof v.vehicleId !== 'string' || !VIN.test(v.vehicleId))
    throw new AppError(400, 'bad_vehicle', `Enter the vehicle's year (1990 to ${maxYear}), make, model and 17-character vehicle id.`);
  if (!isInt(b.priceCents, 1, MAX_PRICE)) throw new AppError(400, 'bad_price', 'Enter the vehicle price, up to $1,000,000.00.');
  if (!isInt(b.downPaymentCents, 0, b.priceCents - 1)) throw new AppError(400, 'bad_down_payment', 'The down payment must be less than the vehicle price.');
  const minAmt = cents(p.min_amount_cents), maxAmt = Math.min(cents(p.max_amount_cents), b.priceCents - b.downPaymentCents);
  if (!isInt(b.amountCents, minAmt, maxAmt))
    throw new AppError(400, 'bad_amount', 'Choose an amount from $5,000.00 to $100,000.00 and no more than the price less the down payment.');
  if (!isInt(b.termMonths, p.min_term, p.max_term)) throw new AppError(400, 'bad_term', `Choose a term from ${p.min_term} to ${p.max_term} months.`);
  if (!isInt(b.annualIncomeCents, 0, MAX_INCOME)) throw new AppError(400, 'bad_income', 'Enter your yearly income.');
  if (!isInt(b.housingCostCents, 0, MAX_HOUSING)) throw new AppError(400, 'bad_housing', 'Enter your monthly housing cost.');
  if (!EMPLOYMENT.includes(b.employment)) throw new AppError(400, 'bad_employment', 'Tell us about your employment.');
  if (b.creditConsent !== true) throw new AppError(400, 'consent_required', 'We need your consent to check your credit before we can decide.');
  if (typeof b.disbursementAccountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the account to receive the loan.');
  const acct = await depositAccount(c, u, b.disbursementAccountId);
  if (acct.status !== 'open') throw new AppError(409, 'account_not_open', 'That account is not open. Choose an open account to receive the loan.');
  return { p, acct, vehicle: { year: v.year, make: text(v.make), model: text(v.model), vehicleId: v.vehicleId } };
}

// ---------- staff ----------
/** A signed-in user whose users.staff_role is loan_officer, read on every request. */
async function requireStaff(c, req) {
  const u = await requireUser(c, req);
  const s = (await c.query('SELECT staff_role FROM users WHERE id = $1', [u.id])).rows[0];
  if (s?.staff_role !== STAFF_ROLE) throw new AppError(403, 'staff_only', 'Only loan staff can do this.');
  return u;
}
/** Any application for review, except the reviewer's own. */
async function forReview(c, staff, id, { lock = false } = {}) {
  const a = isUuid(id) && (await c.query(`SELECT * FROM auto_loan_applications WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!a) throw new AppError(404, 'not_found', 'Application not found.');
  if (a.user_id === staff.id) throw new AppError(403, 'own_application', 'You cannot review your own application. Ask another loan officer.');
  return a;
}
const actionView = x => ({ id: x.id, action: x.action, actorId: x.actor_id, reason: x.reason, reasonCodes: x.reason_codes, offer: x.offer, at: x.at });

async function reviewView(c, a) {
  const name = (await c.query('SELECT display_name FROM users WHERE id = $1', [a.user_id])).rows[0].display_name;
  const actions = (await c.query('SELECT * FROM auto_loan_actions WHERE application_id = $1 ORDER BY at, id', [a.id])).rows;
  return { application: appView(a),
    review: { applicantId: a.user_id, applicantName: name, score: a.score, dtiBps: a.dti_bps, ltvBps: a.ltv_bps, engineOutcome: a.engine_outcome,
      engineReasons: a.engine_reasons, engineAprBps: a.engine_apr_bps, referralReason: a.referral_reason, suggestedOffer: a.suggested_offer },
    actions: actions.map(actionView) };
}

function readReason(b) {
  const r = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!r || r.length > 500) throw new AppError(400, 'bad_reason', 'Give a reason of 1 to 500 characters.');
  return r;
}
function readCodes(b) {
  const x = b.reasonCodes;
  if (!Array.isArray(x) || x.length < 1 || x.length > 4 || !x.every(k => typeof k === 'string' && Object.hasOwn(REASONS, k)) || new Set(x).size !== x.length)
    throw new AppError(400, 'bad_reason_codes', 'Choose 1 to 4 different reasons from the list.');
  return x;
}

/** Approve, decline or counter a referred application: one action only, decided under the application's row lock. */
async function review(c, req, params, body, action) {
  const staff = await requireStaff(c, req);
  const a = await forReview(c, staff, params.id, { lock: true });
  if (a.status !== 'referred') throw new AppError(409, 'invalid_state', 'This application is not waiting for review, so nothing was changed.');
  const reason = readReason(body), on = today();
  let set, codes = [], offer = null;
  if (action === 'approve') {
    offer = { amountCents: cents(a.amount_cents), termMonths: a.term_months, aprBps: a.engine_apr_bps };
    set = { status: 'approved', type: 'approved' };
  } else if (action === 'decline') {
    codes = readCodes(body);
    set = { status: 'declined', notice: 'decline' };
  } else {
    codes = readCodes(body);
    const p = await product(c, a.product_code), eng = a.engine_apr_bps, asked = cents(a.amount_cents);
    const { amountCents: amt, termMonths: term, aprBps: apr } = body;
    if (!isInt(amt, cents(p.min_amount_cents), asked) || !isInt(term, p.min_term, p.max_term) || !isInt(apr, eng, Math.min(eng + COUNTER_APR_SPREAD, p.apr_max_bps))
      || (amt === asked && term === a.term_months && apr === eng))
      throw new AppError(400, 'bad_counter', `A counter-offer needs an amount up to the amount asked for, a term from ${p.min_term} to ${p.max_term} months and an APR from the engine's rate up to 2 points more (at most the product maximum), with at least one change.`);
    offer = { amountCents: amt, termMonths: term, aprBps: apr };
    set = { status: 'countered', type: 'countered', notice: 'counter' };
  }
  const updated = (await c.query(`UPDATE auto_loan_applications SET status = $2,
       offer_type = $3, offer_amount_cents = $4, offer_term = $5, offer_apr_bps = $6, offer_issued_on = CASE WHEN $3::text IS NULL THEN NULL ELSE $7::date END,
       offer_expires_on = CASE WHEN $3::text IS NULL THEN NULL ELSE $7::date + $8::int END,
       notice_kind = $9, notice_issued_on = CASE WHEN $9::text IS NULL THEN NULL ELSE $7::date END, notice_reasons = $10
     WHERE id = $1 RETURNING *`,
    [a.id, set.status, set.type ?? null, offer?.amountCents ?? null, offer?.termMonths ?? null, offer?.aprBps ?? null, on, OFFER_DAYS,
      set.notice ?? null, set.notice ? JSON.stringify(codes) : null])).rows[0];
  await c.query('INSERT INTO auto_loan_actions (id, application_id, action, actor_id, reason, reason_codes, offer) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [newId(), a.id, action, staff.id, reason, JSON.stringify(codes), offer]);
  await audit(c, req, staff.id, `autoloan.${action}`, { application: a.id, applicant: a.user_id, reason, ...(action === 'approve' ? {} : { reasonCodes: codes }),
    ...(offer && action === 'counter' ? { offer } : {}) });
  return { application: appView(updated) };
}

export function register(r) {
  // ---------- customer ----------
  r.add('POST', '/api/auto-loans/applications', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req); adultOnly(u);
    const k = key(u, body);
    // One apply per customer at a time: a double submit waits and replays, and the daily count can't be raced.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${F}:apply:${u.id}`]);
    const fp = fingerprintOf({}, body);
    const prev = (await c.query('SELECT * FROM auto_loan_applications WHERE user_id = $1 AND idempotency_key = $2', [u.id, k])).rows[0];
    if (prev) {
      if (prev.idempotency_fingerprint !== fp) throw conflict();
      return { application: appView(prev), replayed: true };
    }
    const { p, acct, vehicle } = await readForm(c, u, body);
    const on = today();
    // One live application per vehicle, by any customer. The vehicle lock makes two at once create one.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${F}:vehicle:${vehicle.vehicleId}`]);
    const busy = (await c.query(`SELECT 1 FROM auto_loan_applications WHERE vehicle_id = $1
       AND (status IN ('referred', 'funded') OR (status IN ('approved', 'countered', 'funding_failed') AND offer_expires_on >= $2::date)) LIMIT 1`,
      [vehicle.vehicleId, on])).rowCount;
    if (busy) throw new AppError(409, 'vehicle_in_use', 'There is already an application for this vehicle.');
    const n = (await c.query('SELECT count(*)::int n FROM auto_loan_applications WHERE user_id = $1 AND submitted_on = $2::date', [u.id, on])).rows[0].n;
    if (n >= DAILY_LIMIT) throw new AppError(429, 'too_many_applications', `You can apply for up to ${DAILY_LIMIT} auto loans a day. Please try again tomorrow.`);

    // The decision: the score as it stands before this application's own hard pull, and only financial inputs.
    await ensureFile(c, u);
    const { score, inputs } = await liveScore(c, u.id);
    const amount = BigInt(body.amountCents);
    const debts = await monthlyDebts(c, u.id, BigInt(body.housingCostCents), inputs);
    const d = decide({ product: p, rules: p.rules, bands: p.bands, score, amountCents: amount, term: body.termMonths, annualIncomeCents: BigInt(body.annualIncomeCents),
      otherDebtCents: debts, collateralValueCents: BigInt(body.priceCents), lienCents: 0n });
    const pull = await recordPull(c, u.id, { kind: 'hard', source: 'loan', label: `${p.name} application`, score });
    let decision, referral = null, offered = false, codes = null;
    if (d.decision === 'approved' && amount <= REVIEW_ABOVE_CENTS) { decision = 'approved'; offered = true; }
    else if (d.decision === 'declined') {
      decision = 'declined';
      codes = [...new Set(d.reasons.map(x => RULE_REASON[x.rule] ?? 'other_policy'))].slice(0, 4);
      if (!codes.length) codes = ['other_policy'];
    } else { decision = 'referred'; referral = d.decision === 'counteroffer' ? 'counteroffer' : 'large_amount'; }
    const suggested = d.decision === 'counteroffer' && d.offer
      ? { amountCents: cents(d.offer.amountCents), termMonths: d.offer.term, aprBps: d.offer.aprBps, paymentCents: cents(d.offer.paymentCents) } : null;
    const id = newId();
    const a = (await c.query(`INSERT INTO auto_loan_applications (id, user_id, product_code, vehicle_year, vehicle_make, vehicle_model, vehicle_id, price_cents,
        down_payment_cents, amount_cents, term_months, annual_income_cents, housing_cents, employment, disbursement_account_id, submitted_on, decision, status,
        referral_reason, score, dti_bps, ltv_bps, engine_outcome, engine_reasons, engine_apr_bps, suggested_offer, pull_id,
        offer_type, offer_amount_cents, offer_term, offer_apr_bps, offer_issued_on, offer_expires_on, notice_kind, notice_issued_on, notice_reasons,
        idempotency_key, idempotency_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30, CASE WHEN $27::text IS NULL THEN NULL ELSE $16::date END, CASE WHEN $27::text IS NULL THEN NULL ELSE $16::date + $31::int END,
        $32, CASE WHEN $32::text IS NULL THEN NULL ELSE $16::date END, $33, $34, $35) RETURNING *`,
      [id, u.id, p.code, vehicle.year, vehicle.make, vehicle.model, vehicle.vehicleId, body.priceCents, body.downPaymentCents, body.amountCents, body.termMonths,
        body.annualIncomeCents, body.housingCostCents, body.employment, acct.id, on, decision, referral, score, d.dtiBps, d.ltvBps, d.decision,
        JSON.stringify(d.reasons), d.aprBps, suggested, pull, offered ? 'approved' : null, offered ? body.amountCents : null, offered ? body.termMonths : null,
        offered ? d.aprBps : null, OFFER_DAYS, codes ? 'decline' : null, codes ? JSON.stringify(codes) : null, k, fp])).rows[0];
    await audit(c, req, u.id, 'autoloan.apply', { application: id, decision });
    return { application: appView(a), replayed: false };
  }));

  r.add('GET', '/api/auto-loans/applications', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query('SELECT * FROM auto_loan_applications WHERE user_id = $1 ORDER BY created_at DESC, id', [u.id])).rows;
    return { applications: rows.map(appView) };
  }));

  r.add('GET', '/api/auto-loans/applications/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    return { application: appView(await own(c, u, params.id)) };
  }));

  r.add('GET', '/api/auto-loans/applications/:id/notice', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await own(c, u, params.id);
    if (!a.notice_kind) throw new AppError(404, 'no_notice', 'There is no adverse action notice for this application.');
    return { notice: { applicationId: a.id, kind: a.notice_kind, issuedOn: a.notice_issued_on, creditor: CREDITOR,
      reasons: a.notice_reasons.map(code => ({ code, text: REASONS[code] })),
      creditScore: { value: a.score, min: 300, max: 850, source: 'Simulated credit file' }, ecoaStatement: ECOA,
      counterOffer: a.notice_kind === 'counter' ? offerOf(a) : null } };
  }));

  // Accept: step-up, an open unexpired offer, then one loan account and two ledger entries in one transaction. The
  // application row is locked, so parallel accepts run one at a time: the first funds, the rest replay or are refused.
  r.add('POST', '/api/auto-loans/applications/:id/accept', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await own(c, u, params.id, { lock: true });
    const k = key(u, body);
    requireStepUp(u);
    const fp = fingerprintOf({}, body);
    if (a.status === 'funded') {
      if (a.accept_key !== k) throw new AppError(409, 'already_accepted', 'You already accepted this offer. Your loan is open.', { loanId: a.loan_id });
      if (a.accept_fingerprint !== fp) throw conflict();
      return { application: appView(a), loan: loanOut(a), replayed: true };
    }
    if (!OPEN_OFFER.includes(a.status)) throw new AppError(409, 'invalid_state', "This application has no offer to accept.");
    if (statusOf(a) === 'expired') throw new AppError(410, 'offer_expired', `This offer expired on ${a.offer_expires_on}. Offers last ${OFFER_DAYS} days; please apply again.`);
    const chosen = body.disbursementAccountId ?? null;
    if (chosen !== null && typeof chosen !== 'string') throw new AppError(400, 'bad_account', 'Choose the account to receive the loan.');
    const to = await depositAccount(c, u, chosen ?? a.disbursement_account_id);
    if (to.status !== 'open') {
      // Nothing is paid out; the application records the failure (kept although the request is refused) and can be accepted again.
      await c.query("UPDATE auto_loan_applications SET status = 'funding_failed', failure_code = 'account_not_open' WHERE id = $1", [a.id]);
      await audit(c, req, u.id, 'autoloan.funding_failed', { application: a.id, code: 'account_not_open' });
      throw refuse(409, 'account_not_open', 'That account is not open, so the loan could not be paid into it. Nothing was paid out. Choose an open account and accept again.');
    }
    const p = await product(c, a.product_code);
    const P = BigInt(a.offer_amount_cents), apr = a.offer_apr_bps, term = a.offer_term, on = today(), loanId = newId(), last4 = await newLast4(c);
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, payment_due) VALUES ($1, 'loan', $2, $3, true, $4)`, [loanId, p.name, last4, addMonths(on, 1)]);
    await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [loanId, u.id]);
    await c.query(`INSERT INTO loans (account_id, product_code, principal_cents, apr_bps, term_months, payment_cents, originated_on, next_due, disbursed_to, collateral_label)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [loanId, p.code, P, apr, term, monthlyPayment(P, apr, term), on, addMonths(on, 1), to.id,
      `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`]);
    const funding = await systemAccount(c, 'loan_disbursement');
    const booked = await post(c, { key: `${u.id}:${F}:${a.id}:originate`, kind: 'loan_origination', createdBy: u.id, memo: `auto loan application ${a.id}`, lines: [
      { accountId: loanId, amountCents: -P, description: `${p.name} opened`, category: 'Loans', postedOn: on },
      { accountId: funding, amountCents: P, description: `Loan booked ··${last4}`, postedOn: on }] });
    const paid = await post(c, { key: `${u.id}:${F}:${a.id}:disburse`, kind: 'loan_disbursement', createdBy: u.id, memo: `auto loan application ${a.id}`, lines: [
      { accountId: funding, amountCents: -P, description: `Loan disbursed ··${last4}`, postedOn: on },
      { accountId: to.id, amountCents: P, description: `${p.name} ··${last4} disbursement`, category: 'Loans', postedOn: on }] });
    const done = (await c.query(`UPDATE auto_loan_applications SET status = 'funded', loan_id = $2, failure_code = NULL, disbursed_to = $3,
        origination_entry_id = $4, disbursement_entry_id = $5, accept_key = $6, accept_fingerprint = $7 WHERE id = $1 RETURNING *`,
      [a.id, loanId, to.id, booked.entryId, paid.entryId, k, fp])).rows[0];
    await audit(c, req, u.id, 'autoloan.accept', { application: a.id, loan: loanId });
    await creditAlert(c, u.id, { kind: 'new_account', ref: `loan:${loanId}`, title: 'New account on your file',
      body: `${p.name} ··${last4} opened ${on}. (Simulated: no real credit bureau.)` });
    await audit(c, req, u.id, 'autoloan.disburse', { application: a.id, loan: loanId, amountCents: cents(P), toLast4: to.number_last4 });
    return { application: appView(done), loan: loanOut(done), replayed: false };
  }));

  // ---------- staff ----------
  r.add('GET', '/api/staff/auto-loans/queue', async ({ req, pool }) => tx(pool, async c => {
    const staff = await requireStaff(c, req);
    const rows = (await c.query(`SELECT a.*, u.display_name FROM auto_loan_applications a JOIN users u ON u.id = a.user_id
       WHERE a.status = 'referred' AND a.user_id <> $1 ORDER BY a.created_at, a.id`, [staff.id])).rows;
    return { queue: rows.map(a => ({ id: a.id, createdAt: a.created_at, applicantName: a.display_name, product: a.product_code,
      amountCents: cents(a.amount_cents), termMonths: a.term_months, score: a.score, referralReason: a.referral_reason })) };
  }));

  r.add('GET', '/api/staff/auto-loans/applications/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const staff = await requireStaff(c, req);
    return reviewView(c, await forReview(c, staff, params.id));
  }));

  for (const action of ['approve', 'decline', 'counter'])
    r.add('POST', `/api/staff/auto-loans/applications/:id/${action}`, async ({ req, pool, params, body }) => tx(pool, c => review(c, req, params, body, action)));
}
