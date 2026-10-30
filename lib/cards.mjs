// Cards (M6): decision rules, the simulated credit score, card numbers, minimum due, statements and the ledger moves
// shared by the API (lib/routes/cards.mjs) and the seed (lib/seeds/cards.mjs). Plan: docs/RESEARCH.md §3.
import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from './http.mjs';
import { post, systemAccount } from './ledger.mjs';
import { newId } from './auth.mjs';
import { toStr, usd } from './money.mjs';
import { DEMO_FALLBACKS } from './demo-keys.mjs';
import { bankToday, BANK_TZ, addDays } from './bank-date.mjs';
import { newLast4 } from './onboarding.mjs';
import { dailyInterest } from './loans-credit/amortize.mjs';

// ---------- simulated credit score ----------
// Card decisions use the same simulated score as /app/credit: lib/loans-credit/credit.mjs liveScore (the credit file plus
// factors, including every hard pull in the last 12 months). No real bureau is contacted. A name with DECLINE always declines.
export const declineFlag = (user) => /decline/i.test(`${user.username} ${user.displayName ?? ''}`);

// ---------- decision rules (data) ----------
// Demo underwriting from docs/RESEARCH.md §3.2 (d) "decisioning on score/income/DTI; secured line = deposit".
// Rules run in order; the first decline wins, then counteroffers, else approve. Reasons are the plain words shown to
// the customer (the adverse-action notice for a decline).
export const INCOME_MIN_CENTS = 10_000_00n;                           // yearly
export const LIMIT_INCOME_BP = 1000n;                                 // a limit is at most 10% of yearly income
export const DECISION_RULES = [
  { code: 'file_flag', outcome: 'decline', when: a => a.declineFlag,
    reason: 'Your credit file (simulated) shows a serious late payment or collection account.' },
  { code: 'score_floor', outcome: 'decline', when: a => a.score < 540,
    reason: 'Your credit score (simulated) is below 540, the lowest we can approve for any card.' },
  { code: 'income_min', outcome: 'decline', when: a => a.incomeCents < INCOME_MIN_CENTS,
    reason: 'Your yearly income is below $10,000, so a card payment could be hard to keep up with.' },
  { code: 'housing_high', outcome: 'decline', when: a => a.housingBp > 5000n,
    reason: 'Your housing payment is more than half of your income.' },
  { code: 'score_for_product', outcome: 'counteroffer_secured', when: a => !a.product.secured && a.score < a.product.min_score,
    reason: a => `Your credit score (simulated, ${a.score}) is below ${a.product.min_score}, the minimum for the ${a.product.name}. We can offer the Secured Card instead.` },
  { code: 'housing_share', outcome: 'counteroffer_limit', when: a => a.housingBp > 4000n,
    reason: 'Your housing payment is a large share of your income, so we can offer a lower limit.' },
  { code: 'requested_limit', outcome: 'counteroffer_limit', when: a => a.requestedCents != null && a.requestedCents > a.limitCents,
    reason: a => `We can't offer the ${usd(a.requestedCents)} limit you asked for, based on your income and credit score (simulated).` }
];
// Limit and APR by score tier. APR steps from the product's lowest APR (step 0) to its highest (step 3).
export const SCORE_TIERS = [
  { minScore: 760, limitCents: 10_000_00n, aprStep: 0 },
  { minScore: 720, limitCents: 6_000_00n, aprStep: 1 },
  { minScore: 680, limitCents: 3_000_00n, aprStep: 2 },
  { minScore: 0, limitCents: 1_000_00n, aprStep: 3 }
];
export const SECURED_DEPOSIT = { min: 300_00n, max: 5_000_00n };       // §3.2: secured deposit $300–$5,000 = credit line

const floor100 = c => c / 100_00n * 100_00n;                            // limits are whole hundreds of dollars
const minB = (a, b) => (a < b ? a : b), maxB = (a, b) => (a > b ? a : b);

/** a: { score, declineFlag, incomeCents, housingCents, requestedCents, product }. Returns { decision, offer, reasons }. */
export function decide(a, products) {
  const p = a.product, tier = SCORE_TIERS.find(t => a.score >= t.minScore);
  const housingBp = a.incomeCents > 0n ? a.housingCents * 12n * 10000n / a.incomeCents : 10000n;
  let limitCents = p.secured ? null : floor100(minB(minB(tier.limitCents, BigInt(p.max_limit_cents)), a.incomeCents * LIMIT_INCOME_BP / 10000n));
  if (limitCents != null) limitCents = maxB(limitCents, BigInt(p.min_limit_cents));
  const aprBp = p.apr_min_bp + Math.round((p.apr_max_bp - p.apr_min_bp) * tier.aprStep / 3);   // ok-number: basis points, not money
  const ctx = { ...a, housingBp, limitCents };
  const hits = DECISION_RULES.filter(r => r.when(ctx)).map(r => ({ ...r, text: typeof r.reason === 'function' ? r.reason(ctx) : r.reason }));
  const why = list => list.map(r => ({ code: r.code, text: r.text }));
  const declines = hits.filter(r => r.outcome === 'decline');
  if (declines.length) return { decision: 'decline', offer: null, reasons: why(declines) };
  const secured = hits.find(r => r.outcome === 'counteroffer_secured');
  if (secured) {
    const s = products.find(x => x.secured);
    return { decision: 'counteroffer', offer: { productCode: s.code, limitCents: null, aprBp: s.apr_min_bp, secured: true }, reasons: why([secured]) };
  }
  const lower = hits.filter(r => r.outcome === 'counteroffer_limit');
  if (lower.length && !p.secured) {
    let offered = limitCents;
    if (hits.some(r => r.code === 'housing_share')) offered = maxB(floor100(offered / 2n), BigInt(p.min_limit_cents));
    return { decision: 'counteroffer', offer: { productCode: p.code, limitCents: offered, aprBp }, reasons: why(lower) };
  }
  const reasons = [{ code: 'approved', text: p.secured ? 'Approved: your deposit sets your credit limit.'
    : `Approved: your credit score (simulated, ${a.score}) and income support a ${usd(limitCents)} limit.` }];
  return { decision: 'approve', offer: { productCode: p.code, limitCents, aprBp, secured: p.secured }, reasons };
}

// ---------- minimum payment ----------
// Demo rule (docs/RESEARCH.md §3.2 (d) "payment types compute from statement"): the greater of $35 or
// 1% of the statement balance (rounded to the nearest cent) plus that period's interest, never more than the balance.
export const MIN_DUE = { floorCents: 35_00n, pctBp: 100n };
export const GRACE_DAYS = 25;                                          // due date = statement closing date + 25 days
export function minimumDue(balanceCents, interestCents = 0n) {
  const b = BigInt(balanceCents), i = BigInt(interestCents);
  if (b <= 0n) return 0n;
  const pct = (b * MIN_DUE.pctBp + 5000n) / 10000n;
  return minB(b, maxB(MIN_DUE.floorCents, pct + i));
}
/** One month's interest: unpaid × APR / 12, rounded to the nearest cent (shown in the minimum-due examples). */
export const monthlyInterest = (unpaidCents, aprBp) => (BigInt(unpaidCents) * BigInt(aprBp) + 60000n) / 120000n;
/**
 * Statement interest (R5): the daily rate (APR / 365) for the days a statement's balance was the latest statement balance,
 * from its closing date to the next statement's closing date, rounded half up: unpaid × APR_bp × days / 3,650,000, the same
 * actual/365 rule as loans (lib/loans-credit/amortize.mjs dailyInterest). Statements a month apart charge about a month;
 * statements closed closer together each charge for fewer days, so the total follows the days that passed, never the
 * number of statements.
 */
export const statementInterest = (unpaidCents, aprBp, days) => dailyInterest(BigInt(unpaidCents), aprBp, days);

// ---------- card numbers ----------
// Simulated vault: a card stores a random token; the number is HMAC(key, token) under a demo prefix that no real
// network uses, with a Luhn check digit. Only the last 4 are stored; the full number exists only in a step-up response.
// Used exactly as set (never trimmed): card numbers already shown were derived from the raw value, so trimming a key that
// has a stray space or newline would change every customer's card number. Unset falls back to the demo key, as before.
const PAN_KEY = () => process.env.CARD_PAN_KEY ?? DEMO_FALLBACKS.CARD_PAN_KEY;
export const DEMO_BIN = '990042';
export function luhnDigit(body) {
  let s = 0;
  for (let i = 0; i < body.length; i++) {
    let d = body.charCodeAt(body.length - 1 - i) - 48;
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    s += d;
  }
  return String((10 - s % 10) % 10);
}
export const luhnValid = n => /^\d{12,19}$/.test(n) && luhnDigit(n.slice(0, -1)) === n.slice(-1);
export function cardSecrets(token) {
  const h = createHmac('sha256', PAN_KEY()).update('pan:' + token).digest();
  let body = DEMO_BIN; for (let i = 0; body.length < 15; i++) body += String(h[i] % 10);
  return { number: body + luhnDigit(body), cvv: [h[20], h[21], h[22]].map(x => x % 10).join('') };
}
/** A new token. `want` forces the last 4 (seed only); `avoid` makes sure a replacement looks different. */
export function newCardToken({ want, avoid } = {}) {
  for (;;) {
    const token = 'tok_' + randomBytes(16).toString('base64url'), last4 = cardSecrets(token).number.slice(-4);
    if ((!want || last4 === want) && last4 !== avoid) return { token, last4 };
  }
}
/** A card number pair whose last 4 no account shows yet (a new credit card account takes its card's last 4). Takes the
 *  account-number lock (lib/onboarding.mjs newLast4), so two openings can't pick the same digits. */
export async function freeCardPair(c) {
  const last4 = await newLast4(c);
  return newCardToken({ want: last4 });
}
export async function issueCard(c, { accountId, holderId, type, want, avoid, replaces = null, pair }) {
  const { token, last4 } = pair ?? newCardToken({ want, avoid });
  const exp = new Date(); exp.setUTCFullYear(exp.getUTCFullYear() + 4);
  const id = newId();
  await c.query(`INSERT INTO cards (id, account_id, holder_user_id, type, last4, pan_token, exp_month, exp_year, replaces_card_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, accountId, holderId, type, last4, token, exp.getUTCMonth() + 1, exp.getUTCFullYear(), replaces]);
  return { id, last4 };
}

// ---------- credit limit ----------
/**
 * Customer spending can't take a card past its limit (db/migrations/030_cards.sql trigger accounts_credit_limit).
 * Charges the bank makes (interest, re-billing a lost dispute) may, as on real cards: run them inside bankCharge().
 */
export async function bankCharge(c, fn) {
  await c.query(`SELECT set_config('usabanc.allow_over_limit', 'on', true)`);
  try { return await fn(); }
  finally { await c.query(`SELECT set_config('usabanc.allow_over_limit', '', true)`).catch(() => {}); }
}

// ---------- card purchases: settlement and channel controls ----------
// Simulated purchases settle through our own system account (UUID …34); seeded history used the shared card_settlement.
export const SETTLEMENT = 'card_network_settlement';
export const settlementIds = async c => [await systemAccount(c, SETTLEMENT), await systemAccount(c, 'card_settlement')];

// Channel controls (docs/RESEARCH.md §3.1 "channel toggles (ATM, online, international, contactless)"; reused as a
// parent's spend rules on a teen card, §1). Defaults when a card has no row: every channel on, ATM limited to $500 a day
// (a typical daily ATM limit). A daily limit can be set up to MAX_DAILY_LIMIT; raising one or turning a channel back on
// needs step-up (docs/CONTRIBUTING.md: raising a limit is risky).
export const CHANNELS = [
  { code: 'in_store', label: 'In-store purchases', hint: 'Chip or swipe at a register', limitCents: null },
  { code: 'online', label: 'Online and phone purchases', hint: 'Card number typed in', limitCents: null },
  { code: 'contactless', label: 'Contactless (tap to pay)', hint: 'Tap at a register', limitCents: null },
  { code: 'atm', label: 'ATM withdrawals', hint: 'Cash from an ATM (a cash advance on a credit card)', limitCents: 500_00n },
  { code: 'international', label: 'International use', hint: 'Purchases outside the US. A travel notice allows them during your trip', limitCents: null }
];
export const PURCHASE_CHANNELS = ['in_store', 'online', 'contactless', 'atm'];
export const MAX_DAILY_LIMIT = 10_000_00n;

/** The card's controls, defaults filled in: [{ channel, label, hint, enabled, limitCents }]. */
export async function controlsFor(c, cardId) {
  const rows = new Map((await c.query('SELECT * FROM card_controls WHERE card_id = $1', [cardId])).rows.map(r => [r.channel, r]));
  return CHANNELS.map(ch => {
    const r = rows.get(ch.code);
    return { channel: ch.code, label: ch.label, hint: ch.hint, enabled: r ? r.enabled : true,
      limitCents: r ? (r.daily_limit_cents == null ? null : BigInt(r.daily_limit_cents)) : ch.limitCents };
  });
}
export async function setControl(c, cardId, channel, { enabled, limitCents }, userId) {
  await c.query(`INSERT INTO card_controls (card_id, channel, enabled, daily_limit_cents, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (card_id, channel) DO UPDATE SET enabled = $3, daily_limit_cents = $4, updated_by = $5, updated_at = now()`, [cardId, channel, enabled, limitCents, userId]);
}
/** Approved today on a channel (for its daily limit). */
/** Approved today (the bank date, from Central Time midnight) on a channel, for its daily limit. */
export const usedToday = async (c, cardId, channel) => BigInt((await c.query(`SELECT coalesce(sum(amount_cents), 0)::bigint s FROM card_authorizations
  WHERE card_id = $1 AND channel = $2 AND result = 'approved' AND created_at >= ($3::date)::timestamp AT TIME ZONE '${BANK_TZ}'`, [cardId, channel, bankToday()])).rows[0].s);
export const onTrip = async (c, cardId) => (await c.query(`SELECT 1 FROM card_travel_notices WHERE card_id = $1 AND canceled_at IS NULL
  AND $2::date BETWEEN start_on AND end_on`, [cardId, bankToday()])).rowCount > 0;

/**
 * The one card lock: a parent's Family "freeze card" and the Cards "lock" are the same
 * state. Freezing locks every open card on the account and sets the family flag; unfreezing undoes both.
 */
export async function setCardFrozen(c, accountId, frozen, userId) {
  await c.query(`UPDATE cards SET status = $2, updated_at = now() WHERE account_id = $1 AND status = $3`, [accountId, frozen ? 'locked' : 'active', frozen ? 'active' : 'locked']);
  await c.query('UPDATE family_controls SET card_frozen = $2, updated_by = $3, updated_at = now() WHERE account_id = $1', [accountId, frozen, userId]);
}

/**
 * Why a simulated purchase is declined, or null. Checked in this order: card status, channel off, international off with
 * no trip on file, the channel's daily limit. Credit limit and funds are checked by the ledger when it posts.
 */
export async function controlDecline(c, card, { channel, international, amountCents }) {
  if (card.status === 'closed') return 'card_closed';
  if (card.status === 'locked') return 'card_locked';
  const ctl = await controlsFor(c, card.id), get = code => ctl.find(x => x.channel === code);
  if (!get(channel).enabled) return 'channel_off';
  if (international && !get('international').enabled && !(await onTrip(c, card.id))) return 'international_off';
  const lim = get(channel).limitCents;
  if (lim != null && await usedToday(c, card.id, channel) + amountCents > lim) return 'channel_limit';
  return null;
}

// ---------- statements ----------
// A statement covers the account's ledger lines up to `last_line_id`. Every credit to the card after it closed counts
// against it: card payments, payments from /app/pay, autopay and dispute credits (all positive lines on the account).
export const latestStatement = async (c, accountId) =>
  (await c.query('SELECT * FROM card_statements WHERE account_id = $1 ORDER BY period_end DESC, created_at DESC LIMIT 1', [accountId])).rows[0] ?? null;
/** Credits to the card account after statement `st` closed, up to the bank date `until` (null: up to now). */
export const creditsAfter = async (c, st, until = null) =>
  BigInt((await c.query(`SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1 AND id > $2 AND amount_cents > 0
    AND ($3::date IS NULL OR posted_on <= $3)`, [st.account_id, st.last_line_id, until])).rows[0].s);

/**
 * Closes a statement period ending `periodEnd` (R5). First it charges interest for every earlier statement whose due date
 * has passed (the grace period is over) and whose interest hasn't been decided yet, whatever the spacing of the closes:
 * if the credits to the card after that statement closed, up to its due date, are less than its balance, the unpaid part
 * is charged statementInterest() for the days from its close to the next statement's close. Each statement is decided
 * once (card_statements.interest_assessed). Then it records balance, minimum and due date.
 */
export async function closeStatement(c, accountId, periodEnd, { periodStart, dueDate } = {}) {
  const prev = await latestStatement(c, accountId);
  const ca = (await c.query('SELECT * FROM credit_accounts WHERE account_id = $1', [accountId])).rows[0];
  const start = periodStart ?? (prev ? (await c.query(`SELECT ($1::date + 1)::date d`, [prev.period_end])).rows[0].d
    : (await c.query(`SELECT (opened_at AT TIME ZONE '${BANK_TZ}')::date d FROM accounts WHERE id = $1`, [accountId])).rows[0].d);   // the bank date, not UTC
  if (periodEnd < start) throw new AppError(409, 'too_soon', 'This card already has a statement for that period.');
  let interest = 0n;
  const came = (await c.query(`SELECT s.*, coalesce((SELECT n.period_end FROM card_statements n WHERE n.account_id = s.account_id
        AND (n.period_end, n.created_at) > (s.period_end, s.created_at) ORDER BY n.period_end, n.created_at LIMIT 1), $2::date) AS next_end
      FROM card_statements s WHERE s.account_id = $1 AND NOT s.interest_assessed AND s.due_date < $2::date
      ORDER BY s.period_end, s.created_at FOR UPDATE`, [accountId, periodEnd])).rows;
  for (const st of came) {                                            // grace period over: decided once each
    const unpaid = BigInt(st.new_balance_cents) - await creditsAfter(c, st, st.due_date);
    const days = (await c.query('SELECT ($1::date - $2::date)::int d', [st.next_end, st.period_end])).rows[0].d;
    if (ca && unpaid > 0n) interest += statementInterest(unpaid, ca.apr_bp, days);
    await c.query('UPDATE card_statements SET interest_assessed = true WHERE id = $1', [st.id]);
  }
  if (interest > 0n) await bankCharge(c, async () => post(c, { key: `cards:interest:${accountId}:${periodEnd}`, kind: 'card_interest', lines: [
    { accountId, amountCents: -interest, description: 'Interest charge on purchases', category: 'Fees & Charges', postedOn: periodEnd },
    { accountId: await systemAccount(c, 'card_interest_income'), amountCents: interest, description: 'Card interest', postedOn: periodEnd }] }));
  const t = (await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint s, coalesce(max(id), 0)::bigint last FROM ledger_lines WHERE account_id = $1 AND posted_on <= $2', [accountId, periodEnd])).rows[0];
  const balance = maxB(0n, -BigInt(t.s));
  const due = dueDate ?? (await c.query(`SELECT ($1::date + $2::int)::date d`, [periodEnd, GRACE_DAYS])).rows[0].d;
  const id = newId();
  await c.query(`INSERT INTO card_statements (id, account_id, period_start, period_end, new_balance_cents, interest_cents, min_due_cents, due_date, last_line_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, accountId, start, periodEnd, balance, interest, minimumDue(balance, interest), due, t.last]);
  await c.query('UPDATE accounts SET payment_due = $2 WHERE id = $1', [accountId, due]);
  return (await c.query('SELECT * FROM card_statements WHERE id = $1', [id])).rows[0];
}

/** The ledger lines a statement covers: after the previous statement's last line (or from the period start), up to its own. */
export async function statementLines(c, st) {
  const prev = (await c.query('SELECT last_line_id FROM card_statements WHERE account_id = $1 AND period_end < $2 ORDER BY period_end DESC LIMIT 1', [st.account_id, st.period_end])).rows[0];
  return (await c.query(`SELECT * FROM ledger_lines WHERE account_id = $1 AND id <= $2 AND id > $3 AND ($4::date IS NULL OR posted_on >= $4) AND posted_on <= $5 ORDER BY posted_on, id`,
    [st.account_id, st.last_line_id, prev?.last_line_id ?? 0, prev ? null : st.period_start, st.period_end])).rows;
}

/** What's owed now and what's left of a statement's balance and minimum (default: the latest) after credits since it closed. */
export async function dueInfo(c, acct, statement = undefined) {
  const owed = maxB(0n, -BigInt(acct.balance_cents));
  const st = statement === undefined ? await latestStatement(c, acct.id) : statement;
  if (!st) return { owed, statement: null, statementLeft: 0n, minimumLeft: 0n, paidSince: 0n };
  const paid = await creditsAfter(c, st);
  return { owed, statement: st, paidSince: paid,
    statementLeft: minB(owed, maxB(0n, BigInt(st.new_balance_cents) - paid)),
    minimumLeft: minB(owed, maxB(0n, BigInt(st.min_due_cents) - paid)) };
}

// ---------- rewards ----------
export function rewardFor(product, category, amountCents) {
  const r = product.rewards ?? {}, bp = BigInt(r.categories?.[category] ?? r.base_bp ?? 0);
  return BigInt(amountCents) * bp / 10000n;                            // rounded down to the cent
}
export const rewardsBalance = async (c, accountId) =>
  BigInt((await c.query('SELECT coalesce(sum(cents), 0)::bigint s FROM card_rewards WHERE account_id = $1', [accountId])).rows[0].s);
/** What a purchase line earned: its simulated authorization's rewards, or a seeded line's. */
export const purchaseRewards = async (c, line) => BigInt((await c.query(`SELECT coalesce(sum(cents), 0)::bigint s FROM card_rewards
  WHERE account_id = $1 AND kind = 'earn' AND (ref = 'seed:' || $2::text OR ref IN (SELECT 'auth:' || id FROM card_authorizations WHERE entry_id = $3))`,
  [line.account_id, String(line.id), line.entry_id])).rows[0].s);

/**
 * Takes back a disputed purchase's rewards (R4). The rewards balance never goes below zero: when the customer already
 * redeemed some of them, the shortfall is charged back to the card account through the ledger (card → card_rewards
 * system account, like a redemption in reverse) and recorded as a `clawback` row, so the rows still sum to the balance.
 * Returns { reversed, clawback } in cents. Safe to repeat: the refs are unique per dispute.
 */
export async function reverseRewards(c, d, line, { userId, last4 }) {
  const earned = await purchaseRewards(c, line);
  if (earned <= 0n) return { reversed: 0n, clawback: 0n };
  await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [d.account_id]);         // one rewards change at a time per card
  const bal = await rewardsBalance(c, d.account_id), short = earned > bal ? earned - (bal > 0n ? bal : 0n) : 0n;
  const ins = await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description) VALUES ($1,$2,'reverse',$3,$4) ON CONFLICT (ref) DO NOTHING`,
    [d.account_id, -earned, `dispute:${d.id}:reverse`, `Rewards held while ${line.description} is disputed`]);
  if (!ins.rowCount) return { reversed: 0n, clawback: 0n };
  if (short > 0n) {
    const r = await bankCharge(c, async () => post(c, { key: `cards:dispute:${d.id}:clawback`, kind: 'rewards_clawback', createdBy: userId, lines: [
      { accountId: d.account_id, amountCents: -short, description: `Rewards clawback: already-redeemed rewards on disputed ${line.description}`, category: 'Fees & Charges' },
      { accountId: await systemAccount(c, 'card_rewards'), amountCents: short, description: `Rewards clawback ··${last4}` }] }));
    await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description, entry_id) VALUES ($1,$2,'clawback',$3,$4,$5) ON CONFLICT (ref) DO NOTHING`,
      [d.account_id, short, `dispute:${d.id}:clawback`, `Redeemed rewards charged back to the card`, r.entryId]);
  }
  return { reversed: earned, clawback: short };
}
/** A lost dispute gives the purchase's rewards back (once). */
export async function restoreRewards(c, d, line) {
  const r = (await c.query(`SELECT -cents AS cents FROM card_rewards WHERE ref = $1`, [`dispute:${d.id}:reverse`])).rows[0];
  if (!r) return 0n;
  await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description) VALUES ($1,$2,'restore',$3,$4) ON CONFLICT (ref) DO NOTHING`,
    [d.account_id, r.cents, `dispute:${d.id}:restore`, `Rewards back: dispute on ${line.description} closed for the merchant`]);
  return BigInt(r.cents);
}

// ---------- dispute outcome (simulated) ----------
// The customer never chooses the outcome. "Simulate resolution" (a labeled demo action) applies these rules in order;
// the first that matches decides, and its code is stored on the dispute. Demo values: RESEARCH.md §3 gives no figures.
export const SMALL_CLAIM_CENTS = 25_00n;                               // claims this small are written off, not contested
export const DUPLICATE_DAYS = 3;                                       // a duplicate is the same charge within 3 days
export const DISPUTE_RULES = [
  { code: 'small_claim', outcome: 'won', text: 'Claims of $25.00 or less are credited for good without asking the merchant.',
    when: async (c, d) => BigInt(d.amount_cents) <= SMALL_CLAIM_CENTS },
  { code: 'duplicate_found', outcome: 'won', text: 'We found the same charge from the same merchant within 3 days.',
    when: async (c, d, line) => d.reason === 'duplicate' && (await c.query(`SELECT 1 FROM ledger_lines o WHERE o.account_id = $1 AND o.id <> $2
      AND o.description = $3 AND o.amount_cents = $4 AND o.posted_on BETWEEN $5::date AND $6::date
      AND NOT EXISTS (SELECT 1 FROM card_disputes x WHERE x.line_id = o.id)`,
      [line.account_id, line.id, line.description, line.amount_cents, addDays(line.posted_on, -DUPLICATE_DAYS), addDays(line.posted_on, DUPLICATE_DAYS)])).rowCount > 0 },
  // Only a charge made on the reported card BEFORE it was reported: the simulated purchase's authorization names the card
  // and the time; a seeded history line (no authorization) counts if it posted on a bank date before the report. A charge
  // on the replacement card, or after the report, is not covered by the report.
  { code: 'card_reported', outcome: 'won', text: 'The card was reported lost or stolen, and this charge was made on it before the report, so a charge you don\'t recognize is treated as fraud.',
    when: async (c, d, line) => d.reason === 'unrecognized' && (await c.query(`SELECT 1 FROM cards k WHERE k.account_id = $1 AND k.closed_reason IN ('lost', 'stolen')
      AND k.closed_at IS NOT NULL AND (
        EXISTS (SELECT 1 FROM card_authorizations x WHERE x.entry_id = $2 AND x.card_id = k.id AND x.created_at < k.closed_at)
        OR (NOT EXISTS (SELECT 1 FROM card_authorizations x WHERE x.entry_id = $2) AND $3::date < (k.closed_at AT TIME ZONE '${BANK_TZ}')::date))`,
      [d.account_id, line.entry_id, line.posted_on])).rowCount > 0 },
  { code: 'merchant_proof', outcome: 'lost', text: 'The merchant sent proof of the sale (simulated), so the charge stands.', when: async () => true }
];
/** The first rule that matches: { code, outcome, text }. */
export async function decideDispute(c, d, line) {
  for (const r of DISPUTE_RULES) if (await r.when(c, d, line)) return { code: r.code, outcome: r.outcome, text: r.text };
}
