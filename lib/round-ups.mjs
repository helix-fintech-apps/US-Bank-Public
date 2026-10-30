// Round-up savings: the rounding math, collecting change on a debit-card purchase, and the views. Routes: lib/routes/round-ups.mjs.
// Amounts are BigInt cents inside; the API gives them out as JSON integers (cents), never strings.
import { audit } from './audit.mjs';
import { bankToday } from './bank-date.mjs';

export const STEPS = [100n, 200n, 500n];
export const DEFAULTS = { stepCents: 100n, thresholdCents: 500n, monthlyCapCents: 50000n };
export const FEATURE = 'round-ups';

/** The change of a purchase of `amount` cents for a step of `step` cents: (s - a mod s) mod s. */
export const changeFor = (amount, step) => (step - (amount % step)) % step;

/** Is this approved authorization rounded up? A debit card, not an ATM withdrawal. (The round-up itself must be active.) */
export const roundsUp = (card, channel) => card.type === 'debit' && channel !== 'atm';

/**
 * Collects the change of an approved purchase, inside the purchase's own transaction (the purchase already holds the
 * account row). Does nothing when the account has no active round-up. Returns the purchase record row or null.
 */
export async function accrue(c, req, { authorizationId, accountId, amountCents }) {
  const r = (await c.query(`SELECT * FROM round_ups WHERE account_id = $1 AND status = 'active' FOR UPDATE`, [accountId])).rows[0];
  if (!r) return null;
  const change = changeFor(amountCents, BigInt(r.step_cents)), today = bankToday();
  const p = (await c.query(`INSERT INTO round_up_purchases (authorization_id, account_id, purchase_cents, change_cents, accrued_on)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [authorizationId, accountId, amountCents, change, today])).rows[0];
  if (change > 0n) await c.query(`UPDATE round_ups SET pending_cents = pending_cents + $2, accrued_cents = accrued_cents + $2,
    pending_since = CASE WHEN pending_cents = 0 THEN $3::date ELSE pending_since END WHERE account_id = $1`, [accountId, change, today]);
  await audit(c, req, r.user_id, 'roundup.accrue', { account: accountId, authorizationId, changeCents: Number(change) });
  return p;
}

/** Posted sweeps in the bank month of `today` ('YYYY-MM'). */
export async function sweptInMonth(c, accountId, today = bankToday()) {
  return (await c.query(`SELECT coalesce(sum(amount_cents), 0)::bigint s FROM round_up_sweeps WHERE account_id = $1 AND to_char(sweep_date, 'YYYY-MM') = $2`,
    [accountId, today.slice(0, 7)])).rows[0].s;
}

const n = v => Number(v);                                            // ok-number: cents as a JSON integer (all well inside 2^53)
export async function roundUpView(c, r) {
  const last = (await c.query('SELECT max(sweep_date)::text d FROM round_up_sweeps WHERE account_id = $1', [r.account_id])).rows[0].d;
  return { accountId: r.account_id, destinationAccountId: r.destination_account_id, stepCents: n(r.step_cents), thresholdCents: n(r.threshold_cents),
    monthlyCapCents: n(r.monthly_cap_cents), status: r.status, pendingCents: n(r.pending_cents), pendingSince: r.pending_since ?? null,
    accruedCents: n(r.accrued_cents), reversedCents: n(r.reversed_cents), sweptCents: n(r.swept_cents),
    sweptThisMonthCents: n(await sweptInMonth(c, r.account_id)), lastSweepDate: last ?? null, createdAt: new Date(r.created_at).toISOString() };
}
export const purchaseView = p => ({ authorizationId: p.authorization_id, purchaseCents: n(p.purchase_cents), changeCents: n(p.change_cents),
  refundedCents: n(p.refunded_cents), reversedCents: n(p.reversed_cents), accruedOn: p.accrued_on });
export const sweepView = s => ({ id: s.id, accountId: s.account_id, destinationAccountId: s.destination_account_id, sweepDate: s.sweep_date,
  status: 'posted', amountCents: n(s.amount_cents), entryId: s.entry_id, reason: null });
export const refundView = f => ({ id: f.id, authorizationId: f.authorization_id, amountCents: n(f.amount_cents), entryId: f.entry_id,
  reversedCents: n(f.reversed_cents), createdAt: new Date(f.created_at).toISOString() });
