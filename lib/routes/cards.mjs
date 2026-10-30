// Cards (M6): debit card controls, the credit card lineup, prequalify → apply → decide → issue, statements, payments,
// autopay, simulated purchases, disputes and rewards. Plan: docs/RESEARCH.md §3. Rules and math live in lib/cards.mjs.
import { AppError, refuse } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor, VIEW, MOVE_MONEY } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { parseAmount, toStr, usd } from '../money.mjs';
import { ageOf } from './accounts.mjs';
import { recordPull, ensureFile, liveScore } from '../loans-credit/credit.mjs';
import { checkMinorSpend, controlsFor as familyControlsFor } from '../controls.mjs';
import { decide, declineFlag, issueCard, freeCardPair, cardSecrets, closeStatement, statementLines, dueInfo, latestStatement,
  rewardFor, rewardsBalance, SECURED_DEPOSIT, MIN_DUE, GRACE_DAYS, bankCharge, SETTLEMENT, settlementIds, controlsFor, setControl, usedToday,
  controlDecline, CHANNELS, PURCHASE_CHANNELS, MAX_DAILY_LIMIT, setCardFrozen, reverseRewards, restoreRewards, decideDispute, DISPUTE_RULES } from '../cards.mjs';
import { isCategory, CONTROL_CATEGORIES } from '../categories.mjs';
import { isDate } from '../dates.mjs';
import { bankToday, bankDateOf, addDays } from '../bank-date.mjs';
import { accrue, roundsUp } from '../round-ups.mjs';

const FEATURE = 'cards';
const DEPOSIT = ['checking', 'savings', 'money_market', 'teen_checking', 'custodial_savings'];
const DEBIT_KINDS = ['checking', 'teen_checking'];
const OWN = ['owner', 'joint_owner'];                     // pay a card or take rewards with your own money, not a child's
const SPEND = ['owner', 'joint_owner', 'custodian', 'minor'];
const LOCKERS = ['owner', 'joint_owner', 'custodian', 'minor']; // a minor can lock their card; only an adult can unlock it
const PURCHASE_MAX = 5_000_00n;                           // simulated purchases: demo cap per purchase
const OFFER_DAYS = 30;                                    // a counteroffer can be accepted for 30 days
const PAY_TYPES = ['minimum', 'statement', 'current', 'custom'];
const AUTOPAY_TYPES = ['minimum', 'statement', 'fixed'];
const DISPUTE_REASONS = { unrecognized: "I don't recognize this charge", not_received: "I didn't receive what I paid for",
  not_as_described: "It wasn't as described", duplicate: 'I was charged twice', wrong_amount: 'I was charged the wrong amount', canceled: 'I canceled and was still charged' };
const REPLACE_REASONS = ['lost', 'stolen', 'damaged'];
const DECLINES = {
  card_closed: "This card was replaced or closed and can't be used.",
  card_locked: 'This card is locked. Unlock it to use it again.',
  channel_off: 'This kind of purchase is turned off in the card controls.',
  international_off: 'International use is turned off for this card. Turn it on, or add a travel notice for your trip.',
  channel_limit: "This would go over the card's daily limit for this kind of purchase.",
  over_limit: 'This purchase is more than the available credit on the card.',
  insufficient_funds: "There isn't enough money in the account for this purchase."
};

const apr = bp => `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;   // ok-number: basis points to "19.24"
const isMinor = u => !!u.dateOfBirth && ageOf(u.dateOfBirth) < 18;
const idem = requestKey;
const uuid = v => /^[0-9a-f-]{36}$/i.test(String(v));
const notFound = (what = 'Card') => new AppError(404, 'not_found', `${what} not found.`);

// ---------- views ----------
const productView = p => p && ({ code: p.code, name: p.name, kind: p.kind, tagline: p.tagline, annualFee: toStr(p.annual_fee_cents),
  aprMin: apr(p.apr_min_bp), aprMax: apr(p.apr_max_bp), introOffer: p.intro_offer, rewardsText: p.rewards_text, secured: p.secured,
  ...(p.secured ? { depositMin: toStr(SECURED_DEPOSIT.min), depositMax: toStr(SECURED_DEPOSIT.max) } : {}) });
const cardView = k => k && ({ id: k.id, type: k.type, last4: k.last4, masked: `•••• •••• •••• ${k.last4}`, accountId: k.account_id,
  exp: `${String(k.exp_month).padStart(2, '0')}/${String(k.exp_year).slice(-2)}`, status: k.status, closedReason: k.closed_reason,
  holder: k.holder_name ?? undefined });
const stmtView = s => s && ({ id: s.id, periodStart: s.period_start, periodEnd: s.period_end, balance: toStr(s.new_balance_cents),
  interest: toStr(s.interest_cents), minimumDue: toStr(s.min_due_cents), dueDate: s.due_date });
const lineView = l => ({ id: String(l.id), postedOn: l.posted_on, description: l.description, category: l.category, amount: toStr(l.amount_cents) });
const authView = a => ({ id: a.id, merchant: a.merchant, category: a.category, channel: a.channel, international: a.international, amount: toStr(a.amount_cents),
  result: a.result, reason: a.reason, reasonText: a.reason ? DECLINES[a.reason] ?? 'Declined by a family control set by a parent.' : null, at: a.created_at });
async function controlsView(c, cardId) {
  const out = [];
  for (const x of await controlsFor(c, cardId))
    out.push({ channel: x.channel, label: x.label, hint: x.hint, enabled: x.enabled, dailyLimit: x.limitCents == null ? null : toStr(x.limitCents),
      ...(x.channel === 'international' ? {} : { usedToday: toStr(await usedToday(c, cardId, x.channel)) }) });
  return out;
}
const disputeView = d => ({ id: d.id, lineId: String(d.line_id), description: d.description, amount: toStr(d.amount_cents), reason: d.reason,
  reasonText: DISPUTE_REASONS[d.reason], status: d.status, openedAt: d.created_at, resolvedAt: d.resolved_at,
  decidedBy: d.decided_by ?? null, decision: d.decided_by ? DISPUTE_RULES.find(r => r.code === d.decided_by)?.text ?? null : null });
const payView = p => ({ id: p.id, amount: toStr(p.amount_cents), type: p.type, autopay: p.autopay, postedOn: p.posted_on, fromAccountId: p.from_account_id });

const products = async c => (await c.query('SELECT * FROM card_products ORDER BY sort')).rows;
function appView(a, ps) {
  const name = code => ps.find(p => p.code === code)?.name;
  const o = a.offer ?? {};
  const expires = new Date(new Date(a.created_at).getTime() + OFFER_DAYS * 86400_000);
  return { id: a.id, stage: a.stage, check: a.check_kind, productCode: a.product_code, productName: name(a.product_code), score: a.score,
    decision: a.decision, reasons: a.reasons, accountId: a.account_id, createdAt: a.created_at,
    offer: a.stage === 'application' && o.productCode ? { productCode: o.productCode, productName: name(o.productCode), secured: !!o.secured,
      creditLimit: o.limitCents != null ? toStr(BigInt(o.limitCents)) : null, apr: apr(o.aprBp),
      ...(a.decision === 'counteroffer' ? { expiresOn: bankDateOf(expires) } : {}) } : null };
}

// ---------- lookups (every id goes through accountFor; someone else's card is a 404) ----------
async function cardFor(c, u, cardId, roles = VIEW) {
  if (!uuid(cardId)) throw notFound();
  const k = (await c.query('SELECT k.*, u.display_name holder_name FROM cards k JOIN users u ON u.id = k.holder_user_id WHERE k.id = $1', [cardId])).rows[0];
  if (!k) throw notFound();
  const a = await accountFor(c, u.id, k.account_id, VIEW).catch(() => { throw notFound(); });
  if (!roles.includes(a.role)) throw notFound();
  return { card: k, account: a };
}
async function creditFor(c, u, accountId, roles = VIEW, { lock = false } = {}) {
  const a = await accountFor(c, u.id, accountId, roles).catch(() => { throw notFound('Card account'); });
  if (a.kind !== 'credit_card') throw notFound('Card account');
  if (lock) Object.assign(a, (await c.query('SELECT balance_cents, credit_limit_cents FROM accounts WHERE id = $1 FOR UPDATE', [a.id])).rows[0]);
  const ca = (await c.query('SELECT * FROM credit_accounts WHERE account_id = $1', [a.id])).rows[0] ?? null;
  const p = (await c.query('SELECT * FROM card_products WHERE code = $1', [ca?.product_code ?? 'cash_plus'])).rows[0];
  return { acct: a, ca, product: p, aprBp: ca?.apr_bp ?? p.apr_min_bp };
}
async function fundingFor(c, u, id) {
  const a = await accountFor(c, u.id, id, OWN);
  if (!DEPOSIT.includes(a.kind)) throw new AppError(400, 'not_deposit', 'Choose a checking or savings account.');
  return a;
}
const fundingAccounts = async (c, u) => (await c.query(`SELECT a.id, a.name, a.number_last4, a.balance_cents, a.kind FROM accounts a JOIN account_owners o ON o.account_id = a.id
  WHERE o.user_id = $1 AND o.role = ANY($2) AND a.kind = ANY($3) AND a.status = 'open' ORDER BY a.kind, a.opened_at`, [u.id, OWN, DEPOSIT])).rows
  .map(a => ({ id: a.id, name: a.name, last4: a.number_last4, balance: toStr(a.balance_cents) }));
const openCard = async (c, accountId) =>
  (await c.query(`SELECT k.*, u.display_name holder_name FROM cards k JOIN users u ON u.id = k.holder_user_id WHERE k.account_id = $1 AND k.status <> 'closed' ORDER BY k.created_at DESC LIMIT 1`, [accountId])).rows[0] ?? null;
const priorEntry = async (c, key) => (await c.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [key])).rows[0]?.id ?? null;
const today = async () => bankToday();                     // the bank date (Central Time), the same "today" as every feature
/** The family mode of a minor's account (null for an adult's account). */
const familyMode = async (c, accountId) => (await c.query('SELECT mode FROM family_controls WHERE account_id = $1', [accountId])).rows[0]?.mode ?? null;
/** A custodian can't change a card on a view-only minor account (R10): watching only. Audited. */
async function notViewOnly(c, req, u, card, a, what) {
  if (a.role !== 'custodian' || (await familyMode(c, a.id)) !== 'view_only') return;
  await audit(c, req, u.id, 'cards.view_only_refused', { cardId: card.id, last4: card.last4, accountId: a.id, what });
  throw refuse(409, 'view_only', 'This account is in view-only mode. Switch to managed mode on the Family page to change its card.');
}
/** The simulated score, the same one /app/credit shows (lib/loans-credit/credit.mjs). */
async function cardScore(c, u) { await ensureFile(c, u); return (await liveScore(c, u.id)).score; }

function creditSummary(a, ca, p, info) {
  const limit = BigInt(a.credit_limit_cents ?? 0), bal = BigInt(a.balance_cents);
  return { id: a.id, name: a.name, last4: a.number_last4, role: a.role, status: a.status, product: p.code,
    owed: toStr(bal < 0n ? -bal : 0n), creditLimit: toStr(limit), available: toStr(limit + bal > 0n ? limit + bal : 0n),
    apr: apr(ca?.apr_bp ?? p.apr_min_bp), paymentDue: a.payment_due, securityDeposit: toStr(ca?.security_deposit_cents ?? 0n),
    ...(info ? { statementBalance: info.statement ? toStr(info.statement.new_balance_cents) : null, minimumLeft: toStr(info.minimumLeft), statementLeft: toStr(info.statementLeft) } : {}) };
}

// ---------- issuing ----------
async function issue(c, req, u, app, offer, { deposit, from }) {
  const p = (await c.query('SELECT * FROM card_products WHERE code = $1', [offer.productCode])).rows[0];
  const limit = p.secured ? deposit : BigInt(offer.limitCents);
  const id = newId(), num = await freeCardPair(c);                 // a last 4 no other account shows
  await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents) VALUES ($1,'credit_card',$2,$3,true,$4)`, [id, p.name, num.last4, limit]);
  await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [id, u.id]);
  await c.query('INSERT INTO credit_accounts (account_id, product_code, apr_bp, security_deposit_cents, application_id) VALUES ($1,$2,$3,$4,$5)',
    [id, p.code, offer.aprBp, p.secured ? deposit : 0n, app.id]);
  const card = await issueCard(c, { accountId: id, holderId: u.id, type: 'credit', pair: num });
  if (p.secured) await post(c, { key: `${u.id}:${FEATURE}:secured-deposit:${app.id}`, kind: 'secured_deposit', createdBy: u.id, lines: [
    { accountId: from.id, amountCents: -deposit, description: `Security deposit for ${p.name} ··${num.last4}`, category: 'Transfers' },
    { accountId: await systemAccount(c, 'card_secured_deposits'), amountCents: deposit, description: `Security deposit ··${num.last4}` }] });
  if (p.annual_fee_cents > 0n) await post(c, { key: `${FEATURE}:annual-fee:${id}:1`, kind: 'card_fee', createdBy: u.id, lines: [
    { accountId: id, amountCents: -BigInt(p.annual_fee_cents), description: 'Annual fee', category: 'Fees & Charges' },
    { accountId: await systemAccount(c, 'fee_income'), amountCents: BigInt(p.annual_fee_cents), description: `Annual fee ··${num.last4}` }] });
  await c.query('UPDATE credit_applications SET account_id = $2 WHERE id = $1', [app.id, id]);
  await audit(c, req, u.id, 'cards.issue', { applicationId: app.id, accountId: id, product: p.code, creditLimit: toStr(limit), aprBp: offer.aprBp,
    cardId: card.id, last4: num.last4, ...(p.secured ? { securityDeposit: toStr(deposit), fromAccountId: from.id } : {}),
    ...(p.annual_fee_cents > 0n ? { annualFee: toStr(p.annual_fee_cents) } : {}) });
  return id;
}
async function securedInputs(c, u, body) {
  const deposit = parseAmount(body.deposit, { field: 'deposit', min: SECURED_DEPOSIT.min, max: SECURED_DEPOSIT.max });
  if (!body.fromAccountId) throw new AppError(400, 'bad_request', 'Choose the account the deposit comes from.');
  const from = await fundingFor(c, u, body.fromAccountId);
  if (BigInt(from.balance_cents) < deposit) throw new AppError(409, 'insufficient_funds', "There isn't enough money in that account for the deposit.");
  return { deposit, from };
}
async function refuseMinor(c, req, u, what) {
  if (!isMinor(u)) return;
  await audit(c, req, u.id, 'cards.minor_refused', { what });
  throw refuse(403, 'minor', 'Credit cards are for customers 18 and older. A parent can help you with a debit card instead.');
}
const appInputs = body => ({
  incomeCents: parseAmount(body.income, { field: 'yearly income', min: 0n }),
  housingCents: parseAmount(body.housing ?? '0', { field: 'monthly housing payment', min: 0n })
});

// ---------- autopay ----------
/**
 * Runs autopay for every statement that has come due and autopay hasn't run for yet, oldest first (R15): a statement
 * that came due while a newer one closed is not skipped. Each statement pays once (its own idempotency key).
 */
async function runAutopay(c, req, acctId) {
  const ap = (await c.query('SELECT * FROM card_autopay WHERE account_id = $1 AND active FOR UPDATE', [acctId])).rows[0];
  if (!ap) return null;
  // statements due on or after the day autopay was set up (an older, already-late statement is the customer's to pay),
  // newer than the one autopay last ran for (compared in SQL, at full timestamp precision)
  const due = (await c.query(`SELECT * FROM card_statements s WHERE s.account_id = $1 AND s.due_date <= $2::date AND s.due_date >= $4::date
      AND ($3::uuid IS NULL OR (s.period_end, s.created_at) > (SELECT l.period_end, l.created_at FROM card_statements l WHERE l.id = $3))
      ORDER BY s.period_end, s.created_at`, [acctId, await today(), ap.last_statement_id, bankDateOf(ap.updated_at)])).rows;
  let out = null;
  for (const st of due) out = await autopayOne(c, req, ap, acctId, st);
  return out;
}
// Autopay runs lazily (on a page read or /api/cards/autopay/run), maybe days after the due date. The payment is dated the
// statement's due date, the day the bank would have drawn it, so the grace period counts it and no interest is charged.
async function autopayOne(c, req, ap, acctId, st) {
  const a = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [acctId])).rows[0];
  const info = await dueInfo(c, a, st);
  let amount = ap.type === 'minimum' ? info.minimumLeft : ap.type === 'statement' ? info.statementLeft : BigInt(ap.fixed_cents);
  if (amount > info.owed) amount = info.owed;
  const done = async (result, detail) => {
    await c.query('UPDATE card_autopay SET last_statement_id = $2, last_result = $3 WHERE account_id = $1', [acctId, st.id, result]);
    await audit(c, req, ap.updated_by, result === 'paid' ? 'cards.autopay.run' : 'cards.autopay.skip', { accountId: acctId, statementId: st.id, result, ...detail });
    return { result, statementId: st.id, ...detail };
  };
  if (amount <= 0n) return done('nothing_due', {});
  try {
    const r = await post(c, { key: `${FEATURE}:autopay:${st.id}`, kind: 'card_payment', createdBy: ap.updated_by, lines: [
      { accountId: ap.from_account_id, amountCents: -amount, description: `Autopay to ${a.name} ··${a.number_last4}`, category: 'Transfers', postedOn: st.due_date },
      { accountId: acctId, amountCents: amount, description: 'Autopay payment, thank you', category: 'Payments', postedOn: st.due_date }] });
    if (!r.replayed) await c.query(`INSERT INTO card_payments (id, account_id, from_account_id, amount_cents, type, autopay, statement_id, entry_id, created_by, posted_on)
      VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9)`, [newId(), acctId, ap.from_account_id, amount, ap.type, st.id, r.entryId, ap.updated_by, await today()]);
    return done('paid', { amount: toStr(amount), fromAccountId: ap.from_account_id });
  } catch (e) {
    if (e.code !== 'insufficient_funds') throw e;
    return done('failed_insufficient_funds', { amount: toStr(amount) });
  }
}
const autopayView = ap => ap && ap.active ? { type: ap.type, fixedAmount: ap.fixed_cents != null ? toStr(ap.fixed_cents) : null,
  fromAccountId: ap.from_account_id, lastResult: ap.last_result } : null;

export function register(r) {
  // ---------- overview and lineup ----------
  r.add('GET', '/api/cards', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const accts = (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
      WHERE o.user_id = $1 AND a.status <> 'closed' AND a.kind = ANY($2) ORDER BY a.opened_at, a.name`, [u.id, [...DEBIT_KINDS, 'credit_card']])).rows;
    const debit = [], credit = [];
    for (const a of accts) {
      if (a.kind === 'credit_card') {
        await runAutopay(c, req, a.id);
        const { acct, ca, product } = await creditFor(c, u, a.id);
        credit.push({ ...creditSummary(acct, ca, product, await dueInfo(c, acct)), productName: product.name, productKind: product.kind, card: cardView(await openCard(c, a.id)) });
      } else {
        const ks = (await c.query(`SELECT k.*, u.display_name holder_name FROM cards k JOIN users u ON u.id = k.holder_user_id
          WHERE k.account_id = $1 AND k.type = 'debit' AND k.status <> 'closed' ORDER BY k.created_at`, [a.id])).rows;
        for (const k of ks) debit.push({ ...cardView(k), account: { id: a.id, name: a.name, last4: a.number_last4, kind: a.kind, role: a.role } });
      }
    }
    const ps = await products(c);
    const apps = (await c.query(`SELECT * FROM credit_applications WHERE user_id = $1 AND stage = 'application' AND decision = 'counteroffer' AND account_id IS NULL
      AND created_at > now() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 3`, [u.id, OFFER_DAYS])).rows;
    return { debit, credit, canApply: !isMinor(u), openOffers: apps.map(a => appView(a, ps)) };
  }));

  r.add('GET', '/api/cards/products', async ({ req, pool }) => tx(pool, async c => {
    await requireUser(c, req);
    return { products: (await products(c)).map(productView), minimumRule: `The greater of ${usd(MIN_DUE.floorCents)} or 1% of the statement balance plus interest`, graceDays: GRACE_DAYS };
  }));

  // ---------- prequalify (soft check), apply (hard check), decide, issue ----------
  r.add('POST', '/api/cards/prequalify', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await refuseMinor(c, req, u, 'prequalify');
    const { incomeCents, housingCents } = appInputs(body);
    const score = await cardScore(c, u);                             // soft check: the /app/credit score, never lowers it
    const ps = await products(c), flag = declineFlag(u);
    const offers = ps.map(p => {
      const d = decide({ score, declineFlag: flag, incomeCents, housingCents, requestedCents: null, product: p }, ps);
      const result = d.decision === 'approve' ? 'likely' : d.decision === 'decline' ? 'unlikely' : d.offer.secured ? 'secured_instead' : 'likely_lower';
      return { productCode: p.code, productName: p.name, result, reasons: d.reasons,
        estimatedLimit: d.offer?.limitCents != null ? toStr(d.offer.limitCents) : null, estimatedApr: d.offer && !d.offer.secured ? apr(d.offer.aprBp) : null };
    });
    const id = newId();
    await c.query(`INSERT INTO credit_applications (id, user_id, stage, check_kind, score, income_cents, housing_cents, offer) VALUES ($1,$2,'prequal','soft',$3,$4,$5,$6)`,
      [id, u.id, score, incomeCents, housingCents, JSON.stringify({ offers: offers.map(o => ({ productCode: o.productCode, result: o.result })) })]);
    await recordPull(c, u.id, { kind: 'soft', source: 'card', label: 'Credit card prequalification', score });   // shows on the credit file, never moves it
    await audit(c, req, u.id, 'cards.prequalify', { applicationId: id, check: 'soft', score, results: offers.map(o => ({ product: o.productCode, result: o.result, reasons: o.reasons.map(x => x.code) })) });
    return { id, check: 'soft', score, scoreNote: 'Simulated soft check: no real credit bureau was contacted, and it does not change your score.', offers };
  }));

  r.add('POST', '/api/cards/applications', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = `${u.id}:${FEATURE}:app:${idem(body)}`;
    const ps = await products(c);
    const prev = (await c.query('SELECT * FROM credit_applications WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) return { application: appView(prev, ps), replayed: true };
    await refuseMinor(c, req, u, 'apply');
    requireStepUp(u);
    const p = ps.find(x => x.code === body.productCode);
    if (!p) throw new AppError(400, 'bad_product', 'Choose a card to apply for.');
    const { incomeCents, housingCents } = appInputs(body);
    const requestedCents = body.requestedLimit ? parseAmount(body.requestedLimit, { field: 'requested limit', min: 100_00n }) : null;
    const sec = p.secured ? await securedInputs(c, u, body) : {};   // checked before the hard check, so a typo costs nothing
    const score = await cardScore(c, u);                             // the score as pulled, before this hard inquiry
    const d = decide({ score, declineFlag: declineFlag(u), incomeCents, housingCents, requestedCents, product: p }, ps);
    const id = newId(), offer = d.offer && { ...d.offer, limitCents: d.offer.limitCents != null ? String(d.offer.limitCents) : null };
    await c.query(`INSERT INTO credit_applications (id, user_id, idempotency_key, stage, check_kind, product_code, score, income_cents, housing_cents, requested_limit_cents, decision, offer, reasons)
      VALUES ($1,$2,$3,'application','hard',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, u.id, key, p.code, score, incomeCents, housingCents, requestedCents, d.decision, offer && JSON.stringify(offer), JSON.stringify(d.reasons)]);
    await recordPull(c, u.id, { kind: 'hard', source: 'card', label: `${p.name} application`, score });
    await audit(c, req, u.id, 'cards.decision', { applicationId: id, check: 'hard', product: p.code, score, decision: d.decision, reasons: d.reasons,
      ...(offer ? { offer: { product: offer.productCode, creditLimit: offer.limitCents != null ? toStr(BigInt(offer.limitCents)) : null, aprBp: offer.aprBp } } : {}) });
    let app = (await c.query('SELECT * FROM credit_applications WHERE id = $1', [id])).rows[0];
    if (d.decision === 'approve') {
      await issue(c, req, u, app, offer, sec);
      app = (await c.query('SELECT * FROM credit_applications WHERE id = $1', [id])).rows[0];
    }
    return { application: appView(app, ps) };
  }));

  r.add('GET', '/api/cards/applications/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = uuid(params.id) ? (await c.query('SELECT * FROM credit_applications WHERE id = $1 AND user_id = $2', [params.id, u.id])).rows[0] : null;
    if (!a) throw notFound('Application');
    return { application: appView(a, await products(c)) };
  }));

  r.add('POST', '/api/cards/applications/:id/accept', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = uuid(params.id) ? (await c.query('SELECT * FROM credit_applications WHERE id = $1 AND user_id = $2 FOR UPDATE', [params.id, u.id])).rows[0] : null;
    if (!a) throw notFound('Application');
    const ps = await products(c);
    if (a.account_id) return { application: appView(a, ps), replayed: true };
    if (a.decision !== 'counteroffer') throw new AppError(409, 'not_an_offer', 'There is no offer to accept on this application.');
    if (Date.now() - new Date(a.created_at).getTime() > OFFER_DAYS * 86400_000) throw new AppError(409, 'offer_expired', `This offer expired. Offers last ${OFFER_DAYS} days; you can apply again.`);
    await refuseMinor(c, req, u, 'accept');
    requireStepUp(u);
    const p = ps.find(x => x.code === a.offer.productCode);
    const sec = p.secured ? await securedInputs(c, u, body) : {};
    await audit(c, req, u.id, 'cards.counteroffer_accept', { applicationId: a.id, product: p.code, creditLimit: p.secured ? toStr(sec.deposit) : toStr(BigInt(a.offer.limitCents)), aprBp: a.offer.aprBp });
    await issue(c, req, u, a, a.offer, sec);
    return { application: appView((await c.query('SELECT * FROM credit_applications WHERE id = $1', [a.id])).rows[0], ps) };
  }));

  // ---------- one card: controls ----------
  r.add('GET', '/api/cards/card/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id);
    const notices = (await c.query('SELECT * FROM card_travel_notices WHERE card_id = $1 AND canceled_at IS NULL AND end_on >= $2::date ORDER BY start_on', [card.id, await today()])).rows;
    const viewOnly = a.role === 'custodian' && (await familyMode(c, a.id)) === 'view_only';
    const auths = (await c.query('SELECT * FROM card_authorizations WHERE card_id = $1 ORDER BY created_at DESC LIMIT 10', [card.id])).rows;
    const lines = (await c.query('SELECT * FROM ledger_lines WHERE account_id = $1 ORDER BY posted_on DESC, id DESC LIMIT 15', [a.id])).rows;
    return { card: cardView(card), account: { id: a.id, name: a.name, last4: a.number_last4, kind: a.kind, role: a.role, balance: toStr(a.balance_cents) },
      canManage: MOVE_MONEY.includes(a.role) && !viewOnly, canUnlock: MOVE_MONEY.includes(a.role), viewOnly,
      canPurchase: SPEND.includes(a.role) && a.role !== 'custodian',  // a child's card spends the child's money: not the parent's to use
      controls: await controlsView(c, card.id), maxDailyLimit: toStr(MAX_DAILY_LIMIT), categories: CONTROL_CATEGORIES.filter(x => x !== 'ATM cash'),   // merchant categories (shared list); ATM is a channel
      travelNotices: notices.map(n => ({ id: n.id, destination: n.destination, startOn: n.start_on, endOn: n.end_on })),
      authorizations: auths.map(authView), transactions: lines.map(lineView) };
  }));

  r.add('POST', '/api/cards/card/:id/lock', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id, LOCKERS);
    if (card.status === 'closed') throw new AppError(409, 'card_closed', DECLINES.card_closed);
    const lock = body.locked === true;
    if (!lock && !MOVE_MONEY.includes(a.role)) throw new AppError(403, 'custodian_only', 'Ask your parent or guardian to unlock this card.');
    // unlocking loosens a control, like unfreezing: fresh code first, whenever the card is locked or the family freeze is
    // on (a card row can still say 'active' under a family freeze from before the two were one state; 061 syncs them)
    const familyFrozen = !!(await c.query('SELECT card_frozen FROM family_controls WHERE account_id = $1', [a.id])).rows[0]?.card_frozen;
    if (!lock && (card.status === 'locked' || familyFrozen)) requireStepUp(u);
    // a minor's card: the lock is the family "freeze card" too (one state on both pages)
    if (await familyMode(c, a.id)) await setCardFrozen(c, a.id, lock, u.id);
    else await c.query(`UPDATE cards SET status = $2, updated_at = now() WHERE id = $1`, [card.id, lock ? 'locked' : 'active']);
    await audit(c, req, u.id, lock ? 'cards.lock' : 'cards.unlock', { cardId: card.id, last4: card.last4, accountId: a.id });
    return { card: cardView({ ...card, status: lock ? 'locked' : 'active' }) };
  }));

  r.add('POST', '/api/cards/card/:id/travel', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id, MOVE_MONEY);
    await notViewOnly(c, req, u, card, a, 'travel_notice');
    const dest = String(body.destination ?? '').trim();
    if (dest.length < 2 || dest.length > 60) throw new AppError(400, 'bad_destination', 'Enter where you are going, like "Mexico" or "Paris, France".');
    const d = s => isDate(s) ? String(s) : null;                       // a real calendar date (lib/dates.mjs), never a 500
    const start = d(body.startOn), end = d(body.endOn), t = await today();
    if (!start || !end) throw new AppError(400, 'bad_dates', 'Enter the dates you leave and come back.');
    const ok = start >= t && end >= start && end <= addDays(t, 365);
    if (!ok) throw new AppError(400, 'bad_dates', 'Trips must start today or later, end after they start, and end within a year.');
    const id = newId();
    await c.query('INSERT INTO card_travel_notices (id, card_id, destination, start_on, end_on, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, card.id, dest, start, end, u.id]);
    await audit(c, req, u.id, 'cards.travel_notice.add', { cardId: card.id, last4: card.last4, noticeId: id, destination: dest, startOn: start, endOn: end });
    return { notice: { id, destination: dest, startOn: start, endOn: end } };
  }));

  r.add('DELETE', '/api/cards/card/:id/travel/:noticeId', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id, MOVE_MONEY);
    await notViewOnly(c, req, u, card, a, 'travel_notice_cancel');
    const n = uuid(params.noticeId) ? await c.query('UPDATE card_travel_notices SET canceled_at = now() WHERE id = $1 AND card_id = $2 AND canceled_at IS NULL', [params.noticeId, card.id]) : { rowCount: 0 };
    if (!n.rowCount) throw notFound('Travel notice');
    await audit(c, req, u.id, 'cards.travel_notice.cancel', { cardId: card.id, noticeId: params.noticeId });
    return { ok: true };
  }));

  // Channel controls: turn a channel off or on, set or clear its daily limit. Loosening (turning on, raising or removing
  // a limit) needs step-up; tightening never does. A parent (custodian) sets these on a teen card; the minor can't.
  r.add('POST', '/api/cards/card/:id/controls', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id, LOCKERS);
    if (!MOVE_MONEY.includes(a.role)) throw new AppError(403, 'custodian_only', 'Ask your parent or guardian to change the controls on this card.');
    if (card.status === 'closed') throw new AppError(409, 'card_closed', DECLINES.card_closed);
    await notViewOnly(c, req, u, card, a, 'controls');
    const ch = CHANNELS.find(x => x.code === body.channel);
    if (!ch) throw new AppError(400, 'bad_channel', 'Choose which kind of use to change.');
    const cur = (await controlsFor(c, card.id)).find(x => x.channel === ch.code);
    const enabled = body.enabled === undefined ? cur.enabled : body.enabled === true;
    let limitCents = cur.limitCents;
    if (body.dailyLimit !== undefined) {
      if (ch.code === 'international') throw new AppError(400, 'bad_limit', 'International use can be turned on or off; it has no limit of its own.');
      limitCents = body.dailyLimit === null || body.dailyLimit === '' ? null
        : parseAmount(body.dailyLimit, { field: 'daily limit', min: 1_00n, max: MAX_DAILY_LIMIT });
    }
    const loosens = (enabled && !cur.enabled) || (cur.limitCents != null && (limitCents == null || limitCents > cur.limitCents));
    if (loosens) requireStepUp(u);
    await setControl(c, card.id, ch.code, { enabled, limitCents }, u.id);
    await audit(c, req, u.id, 'cards.controls.set', { cardId: card.id, last4: card.last4, channel: ch.code,
      before: { enabled: cur.enabled, dailyLimit: cur.limitCents == null ? null : toStr(cur.limitCents) },
      after: { enabled, dailyLimit: limitCents == null ? null : toStr(limitCents) }, steppedUp: loosens });
    return { controls: await controlsView(c, card.id) };
  }));

  // Lost, stolen or damaged: the old card is closed for good and a new number is issued (step-up first).
  r.add('POST', '/api/cards/card/:id/replace', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account: a } = await cardFor(c, u, params.id, MOVE_MONEY);
    await notViewOnly(c, req, u, card, a, 'replace');
    if (!REPLACE_REASONS.includes(body.reason)) throw new AppError(400, 'bad_reason', 'Tell us whether the card was lost, stolen or damaged.');
    if (card.status === 'closed') throw new AppError(409, 'card_closed', 'This card was already replaced.');
    requireStepUp(u);
    await c.query(`UPDATE cards SET status = 'closed', closed_reason = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [card.id, body.reason]);
    const n = await issueCard(c, { accountId: card.account_id, holderId: card.holder_user_id, type: card.type, avoid: card.last4, replaces: card.id });
    if ((await c.query('SELECT card_frozen FROM family_controls WHERE account_id = $1', [card.account_id])).rows[0]?.card_frozen)
      await c.query(`UPDATE cards SET status = 'locked' WHERE id = $1`, [n.id]);   // a frozen child's card stays frozen when replaced (R16)
    await audit(c, req, u.id, 'cards.replace', { oldCardId: card.id, oldLast4: card.last4, newCardId: n.id, newLast4: n.last4, reason: body.reason });
    const k = (await c.query('SELECT k.*, u.display_name holder_name FROM cards k JOIN users u ON u.id = k.holder_user_id WHERE k.id = $1', [n.id])).rows[0];
    return { card: cardView(k), replaced: { id: card.id, last4: card.last4, status: 'closed', closedReason: body.reason },
      note: 'Simulated: a new card would be mailed in 5 to 7 business days. Nothing is really mailed.' };
  }));

  // Simulated purchase (labeled in the UI): an authorization that respects the lock, the channel controls, the daily limits
  // and the credit limit, posted through our card_network_settlement system account.
  r.add('POST', '/api/cards/card/:id/purchases', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { card, account } = await cardFor(c, u, params.id, SPEND);
    if (account.role === 'custodian') {                           // a child's card spends the child's money: only the child uses it
      await audit(c, req, u.id, 'cards.purchase.refused', { cardId: card.id, last4: card.last4, accountId: account.id, reason: 'custodian_card' });
      throw refuse(403, 'custodian_card', "This is your child's card and their money. Only they can make purchases with it.");
    }
    const key = `${u.id}:${FEATURE}:auth:${idem(body)}`;
    const prev = (await c.query('SELECT * FROM card_authorizations WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) { if (prev.result === 'declined') throw new AppError(422, prev.reason, authView(prev).reasonText, { authorization: authView(prev) }); return { authorization: authView(prev), replayed: true }; }
    const merchant = String(body.merchant ?? '').trim().slice(0, 60), category = String(body.category ?? 'Shopping').trim() || 'Shopping';
    if (merchant.length < 2) throw new AppError(400, 'bad_merchant', 'Enter a merchant name.');
    if (!isCategory(category)) throw new AppError(400, 'bad_category', 'Choose what kind of store it is.');
    const channel = body.channel ?? 'in_store', international = body.international === true;
    if (!PURCHASE_CHANNELS.includes(channel)) throw new AppError(400, 'bad_channel', 'Choose in store, online, contactless or ATM.');
    const amount = parseAmount(body.amount, { max: PURCHASE_MAX });
    const a = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id])).rows[0];
    const k = (await c.query('SELECT * FROM cards WHERE id = $1 FOR UPDATE', [card.id])).rows[0];
    let reason = await controlDecline(c, k, { channel, international, amountCents: amount }), familyMsg = null;
    if (!reason) {                                                 // a parent's family controls on a minor's account (lib/controls.mjs)
      try { await checkMinorSpend(c, a.id, amount, channel === 'atm' ? 'ATM cash' : category, { channel: 'card', req, userId: u.id }); }
      catch (e) { if (e.status !== 422) throw e; reason = e.code; familyMsg = e.message; }
    }
    let entryId = null;
    if (!reason) {
      try {                                                        // the ledger refuses over the credit limit or past the balance
        entryId = (await post(c, { key, kind: 'card_purchase', createdBy: u.id, lines: [
          { accountId: a.id, amountCents: -amount, description: channel === 'atm' ? `ATM withdrawal, ${merchant}` : merchant, category: channel === 'atm' ? 'ATM cash' : category },
          { accountId: await systemAccount(c, SETTLEMENT), amountCents: amount, description: `${merchant} ··${card.last4}` }] })).entryId;
      } catch (e) { if (!['insufficient_funds', 'over_limit'].includes(e.code)) throw e; reason = e.code; }
    }
    const id = newId();
    await c.query(`INSERT INTO card_authorizations (id, card_id, idempotency_key, merchant, category, channel, international, amount_cents, result, reason, entry_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, card.id, key, merchant, category, channel, international, amount, reason ? 'declined' : 'approved', reason, entryId]);
    let earned = 0n;
    if (!reason && a.kind === 'credit_card') {
      const { product } = await creditFor(c, u, a.id, SPEND);
      earned = channel === 'atm' ? 0n : rewardFor(product, category, amount);   // no rewards on cash
      if (earned > 0n) await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description) VALUES ($1,$2,'earn',$3,$4)`, [a.id, earned, `auth:${id}`, `Rewards on ${merchant}`]);
    }
    if (!reason && roundsUp(k, channel)) await accrue(c, req, { authorizationId: id, accountId: a.id, amountCents: amount });   // round-up savings, same transaction
    await audit(c, req, u.id, reason ? 'cards.purchase.declined' : 'cards.purchase.approved', { authorizationId: id, cardId: card.id, last4: card.last4, merchant, channel, international, amount: toStr(amount), reason, simulated: true });
    const auth = authView((await c.query('SELECT * FROM card_authorizations WHERE id = $1', [id])).rows[0]);
    if (reason) throw refuse(422, reason, familyMsg ?? DECLINES[reason], { authorization: auth });
    return { authorization: auth, rewardsEarned: toStr(earned) };
  }));

  // ---------- one credit card account ----------
  r.add('GET', '/api/cards/credit/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await creditFor(c, u, params.id);                                // access check before autopay runs on read
    const autopayRun = await runAutopay(c, req, params.id);
    const { acct, ca, product } = await creditFor(c, u, params.id);
    const info = await dueInfo(c, acct);
    const stmts = (await c.query('SELECT * FROM card_statements WHERE account_id = $1 ORDER BY period_end DESC LIMIT 12', [acct.id])).rows;
    const settle = await settlementIds(c);
    const lines = (await c.query(`SELECT l.*, d.id dispute_id, (l.amount_cents < 0 AND EXISTS (SELECT 1 FROM ledger_lines s WHERE s.entry_id = l.entry_id AND s.account_id = ANY($2))) purchase
      FROM ledger_lines l LEFT JOIN card_disputes d ON d.line_id = l.id WHERE l.account_id = $1 ORDER BY l.posted_on DESC, l.id DESC LIMIT 30`, [acct.id, settle])).rows;
    const disputes = (await c.query('SELECT d.*, l.description FROM card_disputes d JOIN ledger_lines l ON l.id = d.line_id WHERE d.account_id = $1 ORDER BY d.created_at DESC', [acct.id])).rows;
    const payments = (await c.query('SELECT * FROM card_payments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10', [acct.id])).rows;
    const ap = (await c.query('SELECT * FROM card_autopay WHERE account_id = $1', [acct.id])).rows[0];
    const earned = BigInt((await c.query(`SELECT coalesce(sum(cents), 0)::bigint s FROM card_rewards WHERE account_id = $1 AND kind = 'earn'`, [acct.id])).rows[0].s);
    const canManage = MOVE_MONEY.includes(acct.role);
    return {
      account: creditSummary(acct, ca, product, info), product: productView(product), card: cardView(await openCard(c, acct.id)), canManage,
      statement: info.statement ? { ...stmtView(info.statement), paidSince: toStr(info.paidSince), statementLeft: toStr(info.statementLeft), minimumLeft: toStr(info.minimumLeft) } : null,
      statements: stmts.map(stmtView), minimumRule: `Minimum due (demo rule): the greater of ${usd(MIN_DUE.floorCents)} or 1% of the statement balance plus interest, never more than the balance.`,
      autopay: autopayView(ap), autopayRun, payments: payments.map(payView),
      rewards: { balance: toStr(await rewardsBalance(c, acct.id)), earned: toStr(earned), rate: product.rewards_text },
      disputes: disputes.map(disputeView),
      transactions: lines.map(l => ({ ...lineView(l), disputable: !!l.purchase && !l.dispute_id && canManage, disputeId: l.dispute_id })),
      fundingAccounts: canManage ? await fundingAccounts(c, u) : []
    };
  }));

  r.add('GET', '/api/cards/credit/:id/statements/:sid', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { acct } = await creditFor(c, u, params.id);
    const s = uuid(params.sid) ? (await c.query('SELECT * FROM card_statements WHERE id = $1 AND account_id = $2', [params.sid, acct.id])).rows[0] : null;
    if (!s) throw notFound('Statement');
    return { statement: stmtView(s), transactions: (await statementLines(c, s)).map(lineView) };
  }));

  // Simulated: close the current statement period now (through today). Real statements close on a schedule.
  r.add('POST', '/api/cards/credit/:id/statements', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { acct } = await creditFor(c, u, params.id, MOVE_MONEY, { lock: true });
    const end = await today(c);
    const prev = await latestStatement(c, acct.id);
    if (prev && prev.period_end >= end) throw new AppError(409, 'too_soon', 'A statement already closed today. Try again tomorrow.');
    const s = await closeStatement(c, acct.id, end);
    await audit(c, req, u.id, 'cards.statement.close', { accountId: acct.id, statementId: s.id, balance: toStr(s.new_balance_cents), interest: toStr(s.interest_cents), minimumDue: toStr(s.min_due_cents), dueDate: s.due_date, simulated: true });
    return { statement: stmtView(s) };
  }));

  // The full virtual card number, only right after a one-time code. Never stored, never audited.
  r.add('POST', '/api/cards/credit/:id/virtual-number', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { acct } = await creditFor(c, u, params.id, OWN);
    const card = await openCard(c, acct.id);
    if (!card) throw notFound();
    requireStepUp(u);
    const s = cardSecrets(card.pan_token);
    await audit(c, req, u.id, 'cards.virtual_number.view', { accountId: acct.id, cardId: card.id, last4: card.last4 });
    return { number: s.number.replace(/(\d{4})(?=\d)/g, '$1 '), last4: card.last4, exp: cardView(card).exp, cvv: s.cvv,
      demo: true, note: 'DEMO number: made up for this demo bank. It is not a real card number and works nowhere.' };
  }));

  r.add('POST', '/api/cards/credit/:id/payments', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = `${u.id}:${FEATURE}:${idem(body)}`;
    const { acct } = await creditFor(c, u, params.id, MOVE_MONEY, { lock: true });
    const replay = async entryId => {
      const p = (await c.query('SELECT * FROM card_payments WHERE entry_id = $1 AND account_id = $2', [entryId, acct.id])).rows[0];
      if (!p) throw new AppError(422, 'idempotency_conflict', 'This request id was already used for something else.');
      return { payment: payView(p), replayed: true };
    };
    const prior = await priorEntry(c, key);
    if (prior) return replay(prior);
    if (!PAY_TYPES.includes(body.type)) throw new AppError(400, 'bad_type', 'Choose minimum, statement balance, current balance or another amount.');
    const from = await fundingFor(c, u, body.fromAccountId);
    const info = await dueInfo(c, acct);
    const amount = body.type === 'minimum' ? info.minimumLeft : body.type === 'statement' ? info.statementLeft : body.type === 'current' ? info.owed : parseAmount(body.amount);
    if (amount <= 0n) throw new AppError(422, 'nothing_due', 'Nothing is due for that choice. Pick another amount.');
    if (amount > info.owed) throw new AppError(422, 'overpay', `You can pay up to ${usd(info.owed)}, the balance you owe now.`);
    const r = await post(c, { key, kind: 'card_payment', createdBy: u.id, lines: [
      { accountId: from.id, amountCents: -amount, description: `Payment to ${acct.name} ··${acct.number_last4}`, category: 'Transfers' },
      { accountId: acct.id, amountCents: amount, description: 'Payment, thank you', category: 'Payments' }] });
    if (r.replayed) return replay(r.entryId);
    const id = newId();
    await c.query(`INSERT INTO card_payments (id, account_id, from_account_id, amount_cents, type, statement_id, entry_id, created_by, posted_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, acct.id, from.id, amount, body.type, info.statement?.id ?? null, r.entryId, u.id, await today()]);
    await audit(c, req, u.id, 'cards.payment', { paymentId: id, accountId: acct.id, fromAccountId: from.id, amount: toStr(amount), type: body.type });
    return { payment: payView((await c.query('SELECT * FROM card_payments WHERE id = $1', [id])).rows[0]) };
  }));

  r.add('POST', '/api/cards/credit/:id/autopay', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { acct } = await creditFor(c, u, params.id, MOVE_MONEY);
    if (!AUTOPAY_TYPES.includes(body.type)) throw new AppError(400, 'bad_type', 'Choose minimum due, statement balance or a fixed amount.');
    const from = await fundingFor(c, u, body.fromAccountId);
    const fixed = body.type === 'fixed' ? parseAmount(body.amount) : null;
    await c.query(`INSERT INTO card_autopay (account_id, from_account_id, type, fixed_cents, active, updated_by, updated_at) VALUES ($1,$2,$3,$4,true,$5,now())
      ON CONFLICT (account_id) DO UPDATE SET from_account_id = $2, type = $3, fixed_cents = $4, active = true, updated_by = $5, updated_at = now()`,
      [acct.id, from.id, body.type, fixed, u.id]);
    await audit(c, req, u.id, 'cards.autopay.set', { accountId: acct.id, fromAccountId: from.id, type: body.type, ...(fixed ? { amount: toStr(fixed) } : {}) });
    return { autopay: autopayView((await c.query('SELECT * FROM card_autopay WHERE account_id = $1', [acct.id])).rows[0]) };
  }));

  r.add('DELETE', '/api/cards/credit/:id/autopay', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { acct } = await creditFor(c, u, params.id, MOVE_MONEY);
    const n = await c.query('UPDATE card_autopay SET active = false, updated_by = $2, updated_at = now() WHERE account_id = $1 AND active', [acct.id, u.id]);
    if (n.rowCount) await audit(c, req, u.id, 'cards.autopay.cancel', { accountId: acct.id });
    return { autopay: null };
  }));

  // Runs any autopay that is due (on or after the statement due date) for the caller's cards.
  r.add('POST', '/api/cards/autopay/run', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ids = (await c.query(`SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.kind = 'credit_card'`, [u.id])).rows;
    const results = [];
    for (const { id } of ids) { const r = await runAutopay(c, req, id); if (r) results.push({ accountId: id, ...r }); }
    return { results };
  }));

  // ---------- disputes ----------
  r.add('POST', '/api/cards/credit/:id/disputes', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = `${u.id}:${FEATURE}:${idem(body)}`;
    const { acct } = await creditFor(c, u, params.id, MOVE_MONEY, { lock: true });
    const view = async id => disputeView((await c.query('SELECT d.*, l.description FROM card_disputes d JOIN ledger_lines l ON l.id = d.line_id WHERE d.id = $1', [id])).rows[0]);
    const prev = (await c.query('SELECT id FROM card_disputes WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) return { dispute: await view(prev.id), replayed: true };
    if (!DISPUTE_REASONS[body.reason]) throw new AppError(400, 'bad_reason', 'Choose why you are disputing this charge.');
    const line = /^\d{1,18}$/.test(String(body.lineId)) ? (await c.query(`SELECT l.* FROM ledger_lines l WHERE l.id = $1 AND l.account_id = $2 AND l.amount_cents < 0
      AND EXISTS (SELECT 1 FROM ledger_lines s WHERE s.entry_id = l.entry_id AND s.account_id = ANY($3))`, [body.lineId, acct.id, await settlementIds(c)])).rows[0] : null;
    if (!line) throw notFound('Transaction');
    if ((await c.query('SELECT 1 FROM card_disputes WHERE line_id = $1', [line.id])).rowCount) throw new AppError(409, 'already_disputed', 'This charge is already disputed.');
    const amount = -BigInt(line.amount_cents);
    const r = await post(c, { key, kind: 'card_dispute_credit', createdBy: u.id, lines: [
      { accountId: acct.id, amountCents: amount, description: `Provisional credit: ${line.description}`, category: 'Disputes' },
      { accountId: await systemAccount(c, 'card_disputes'), amountCents: -amount, description: `Provisional credit ··${acct.number_last4}` }] });
    const id = newId(), details = String(body.details ?? '').trim().slice(0, 500) || null;
    await c.query(`INSERT INTO card_disputes (id, account_id, line_id, amount_cents, reason, details, idempotency_key, provisional_entry_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, acct.id, line.id, amount, body.reason, details, key, r.entryId, u.id]);
    await audit(c, req, u.id, 'cards.dispute.open', { disputeId: id, accountId: acct.id, lineId: String(line.id), amount: toStr(amount), reason: body.reason, provisionalCredit: toStr(amount) });
    // the purchase's rewards are held while it is disputed (and charged back if they were already redeemed)
    const rw = await reverseRewards(c, { id, account_id: acct.id, amount_cents: amount }, line, { userId: u.id, last4: acct.number_last4 });
    if (rw.reversed > 0n) await audit(c, req, u.id, 'cards.rewards.reverse', { disputeId: id, accountId: acct.id, amount: toStr(rw.reversed) });
    if (rw.clawback > 0n) await audit(c, req, u.id, 'cards.rewards.clawback', { disputeId: id, accountId: acct.id, amount: toStr(rw.clawback) });
    return { dispute: await view(id), rewardsReversed: toStr(rw.reversed), rewardsClawback: toStr(rw.clawback) };
  }));

  // Demo: "Simulate resolution" stands in for the weeks a real dispute takes. The customer does not choose the outcome:
  // lib/cards.mjs DISPUTE_RULES decide it. Won keeps the credit (the bank recovers it from the merchant) and the rewards
  // stay reversed; lost re-bills with a new entry and gives the rewards back.
  r.add('POST', '/api/cards/disputes/:id/simulate-resolution', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const d = uuid(params.id) ? (await c.query('SELECT d.*, l.description FROM card_disputes d JOIN ledger_lines l ON l.id = d.line_id WHERE d.id = $1 FOR UPDATE OF d', [params.id])).rows[0] : null;
    if (!d) throw notFound('Dispute');
    const { acct } = await creditFor(c, u, d.account_id, MOVE_MONEY).catch(() => { throw notFound('Dispute'); });
    if (d.status !== 'open') throw new AppError(409, 'already_resolved', 'This dispute is already resolved.');
    const line = (await c.query('SELECT * FROM ledger_lines WHERE id = $1', [d.line_id])).rows[0];
    const rule = await decideDispute(c, d, line);
    const amount = BigInt(d.amount_cents), disputes = await systemAccount(c, 'card_disputes');
    const r = rule.outcome === 'won'
      ? await post(c, { key: `${FEATURE}:dispute:${d.id}:resolve`, kind: 'card_dispute_won', createdBy: u.id, lines: [
        { accountId: disputes, amountCents: amount, description: `Chargeback recovered: ${d.description}` },
        { accountId: await systemAccount(c, SETTLEMENT), amountCents: -amount, description: `Chargeback ··${acct.number_last4}` }] })
      : await bankCharge(c, async () => post(c, { key: `${FEATURE}:dispute:${d.id}:resolve`, kind: 'card_dispute_rebill', createdBy: u.id, lines: [
        { accountId: acct.id, amountCents: -amount, description: `Dispute closed, charge re-billed: ${d.description}`, category: 'Disputes' },
        { accountId: disputes, amountCents: amount, description: `Provisional credit reversed ··${acct.number_last4}` }] }));
    const restored = rule.outcome === 'lost' ? await restoreRewards(c, d, line) : 0n;
    // a dispute opened before rewards followed the purchase never had them reversed: a win takes them back now (once)
    const late = rule.outcome === 'won' ? await reverseRewards(c, d, line, { userId: u.id, last4: acct.number_last4 }) : { reversed: 0n, clawback: 0n };
    if (late.reversed > 0n) await audit(c, req, u.id, 'cards.rewards.reverse', { disputeId: d.id, accountId: acct.id, amount: toStr(late.reversed), atResolution: true });
    if (late.clawback > 0n) await audit(c, req, u.id, 'cards.rewards.clawback', { disputeId: d.id, accountId: acct.id, amount: toStr(late.clawback), atResolution: true });
    const status = rule.outcome === 'won' ? 'resolved_won' : 'resolved_lost';
    await c.query('UPDATE card_disputes SET status = $2, resolution_entry_id = $3, resolved_at = now(), decided_by = $4 WHERE id = $1', [d.id, status, r.entryId, rule.code]);
    await audit(c, req, u.id, 'cards.dispute.resolve', { disputeId: d.id, accountId: acct.id, outcome: status, rule: rule.code, amount: toStr(amount),
      rewardsRestored: toStr(restored), simulated: true });
    return { dispute: disputeView({ ...d, status, resolved_at: new Date(), decided_by: rule.code }), rule: { code: rule.code, text: rule.text }, rewardsRestored: toStr(restored),
      note: 'Simulated: in a real bank the merchant answers within weeks. Here the bank\'s dispute rules decide right away.' };
  }));

  // ---------- rewards ----------
  r.add('POST', '/api/cards/credit/:id/rewards/redeem', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = `${u.id}:${FEATURE}:${idem(body)}`;
    const { acct } = await creditFor(c, u, params.id, OWN, { lock: true });
    const prior = await priorEntry(c, key);
    const view = async () => ({ rewards: { balance: toStr(await rewardsBalance(c, acct.id)) } });
    if (prior) return { ...(await view()), replayed: true };
    const to = await fundingFor(c, u, body.toAccountId);
    const bal = await rewardsBalance(c, acct.id);
    const amount = body.amount ? parseAmount(body.amount) : bal;
    if (amount <= 0n) throw new AppError(422, 'no_rewards', 'There are no rewards to redeem yet.');
    if (amount > bal) throw new AppError(422, 'not_enough_rewards', `You can redeem up to ${usd(bal)}.`);
    const r = await post(c, { key, kind: 'rewards_redeem', createdBy: u.id, lines: [
      { accountId: await systemAccount(c, 'card_rewards'), amountCents: -amount, description: `Rewards from ${acct.name} ··${acct.number_last4}` },
      { accountId: to.id, amountCents: amount, description: `${acct.name} rewards redeemed`, category: 'Income' }] });
    if (!r.replayed) await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description, entry_id) VALUES ($1,$2,'redeem',$3,$4,$5)`,
      [acct.id, -amount, `redeem:${r.entryId}`, `Redeemed to ${to.name} ··${to.number_last4}`, r.entryId]);
    await audit(c, req, u.id, 'cards.rewards.redeem', { accountId: acct.id, toAccountId: to.id, amount: toStr(amount) });
    return { ...(await view()), redeemed: toStr(amount) };
  }));
}
