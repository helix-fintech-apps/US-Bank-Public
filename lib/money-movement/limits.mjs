// The shared limit profile and limit-usage ledger for every rail (docs/RESEARCH.md §2 "Shared money-movement model").
// limit_profiles holds the bank default per rail (migration 020, values from RESEARCH.md §2.2 and §2.4) and a customer's
// own lower daily / 30-day amounts. limit_usage is append-only: each transfer adds what it used, and money that comes back
// adds a negative row dated to the original day. "Daily" is the CT calendar day; "30-day" is a rolling 30 days.
import { AppError, refuse } from '../http.mjs';
import { audit, requireStepUp } from '../auth.mjs';
import { toStr, usd } from '../money.mjs';
import { today, addDays } from './calendar.mjs';

/** 123456n -> '$1,234.56' for messages. */
export { usd };

export const RAILS = ['internal', 'ach', 'p2p', 'wire', 'billpay'];
export const RAIL_NAME = { internal: 'Transfers between your accounts', ach: 'External transfers (ACH)', p2p: 'USA Pay', wire: 'Wires', billpay: 'Bill pay' };

export async function limitsFor(c, userId, rail) {
  const d = (await c.query('SELECT * FROM limit_profiles WHERE rail = $1 AND user_id IS NULL', [rail])).rows[0];
  if (!d) throw new AppError(404, 'not_found', 'Not found.');
  const u = (await c.query('SELECT * FROM limit_profiles WHERE user_id = $1 AND rail = $2', [userId, rail])).rows[0];
  const t = today();
  const used = (await c.query(`SELECT coalesce(sum(amount_cents) FILTER (WHERE booked_on = $3), 0)::bigint AS day,
       coalesce(sum(amount_cents), 0)::bigint AS month FROM limit_usage
     WHERE user_id = $1 AND rail = $2 AND booked_on > $4 AND booked_on <= $3`, [userId, rail, t, addDays(t, -30)])).rows[0];
  const daily = u?.daily_cents ?? d.daily_cents, monthly = u?.rolling_30d_cents ?? d.rolling_30d_cents;
  const max0 = v => (v < 0n ? 0n : v);
  return { rail, perTxn: d.per_txn_cents, stepUp: d.step_up_cents, daily, monthly, maxDaily: d.daily_cents, maxMonthly: d.rolling_30d_cents,
    usedDay: used.day, usedMonth: used.month, leftDay: max0(daily - used.day), leftMonth: max0(monthly - used.month) };
}

export const limitView = l => ({ rail: l.rail, name: RAIL_NAME[l.rail], perTransfer: l.perTxn == null ? null : toStr(l.perTxn),
  stepUpFrom: l.stepUp == null ? null : toStr(l.stepUp),
  daily: toStr(l.daily), monthly: toStr(l.monthly), maxDaily: toStr(l.maxDaily), maxMonthly: toStr(l.maxMonthly),
  usedToday: toStr(l.usedDay), usedMonth: toStr(l.usedMonth), leftToday: toStr(l.leftDay), leftMonth: toStr(l.leftMonth),
  remaining: toStr(l.leftDay < l.leftMonth ? l.leftDay : l.leftMonth) });

/** Refuses (and audits) an amount over the per-transfer, daily or 30-day limit. Exactly at the limit is allowed. */
export async function checkLimit(c, req, userId, rail, amount) {
  const l = await limitsFor(c, userId, rail);
  const over = l.perTxn != null && amount > l.perTxn ? ['per_transfer', l.perTxn, `${RAIL_NAME[rail]} are limited to ${usd(l.perTxn)} per transfer.`]
    : amount > l.leftDay ? ['daily', l.leftDay, `That's over your daily limit. You can send up to ${usd(l.leftDay)} more today.`]
    : amount > l.leftMonth ? ['monthly', l.leftMonth, `That's over your 30-day limit. You can send up to ${usd(l.leftMonth)} more right now.`]
    : null;
  await audit(c, req, userId, 'limit.check', { rail, amount: toStr(amount), decision: over ? 'refused' : 'ok', limit: over?.[0] ?? null,
    left_today: toStr(l.leftDay), left_month: toStr(l.leftMonth) });
  if (over) throw refuse(422, 'over_limit', over[2], { limit: over[0], remaining: toStr(over[1]) });
  return l;
}

/**
 * Asks for a one-time code when the rail's rule says so: always for money to someone else or out of the bank
 * (`always`), otherwise at or over the bank profile's step_up_cents.
 */
export async function stepUpFor(c, user, rail, amount, { always = false } = {}) {
  if (always) return requireStepUp(user);
  const d = (await c.query('SELECT step_up_cents FROM limit_profiles WHERE rail = $1 AND user_id IS NULL', [rail])).rows[0];
  if (d?.step_up_cents != null && amount >= d.step_up_cents) requireStepUp(user);
}

/** Adds a transfer's use of its limit to the usage ledger (once per transfer). */
export const useLimit = (c, t) => c.query(`INSERT INTO limit_usage (user_id, rail, transfer_id, amount_cents, booked_on, reason)
  VALUES ($1,$2,$3,$4,$5,'used') ON CONFLICT (transfer_id, reason) DO NOTHING`, [t.user_id, t.rail, t.id, t.amount_cents, t.booked_on]);

/** Gives the room back when the money came back (returned, expired) or never left (canceled). Only once per transfer. */
export async function releaseLimit(c, t, reason) {
  await c.query(`INSERT INTO limit_usage (user_id, rail, transfer_id, amount_cents, booked_on, reason)
    SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM limit_usage WHERE transfer_id = $3 AND reason = 'used')
      AND NOT EXISTS (SELECT 1 FROM limit_usage WHERE transfer_id = $3 AND amount_cents < 0)`,
    [t.user_id, t.rail, t.id, -BigInt(t.amount_cents), t.booked_on, reason]);
}

/** A customer's own daily and 30-day amounts (the route checks they're not above the bank default). */
export async function setUserLimit(c, userId, rail, daily, monthly) {
  await c.query(`INSERT INTO limit_profiles (id, user_id, rail, daily_cents, rolling_30d_cents) VALUES (gen_random_uuid(), $1,$2,$3,$4)
    ON CONFLICT (user_id, rail) WHERE user_id IS NOT NULL DO UPDATE SET daily_cents = $3, rolling_30d_cents = $4, updated_at = now()`, [userId, rail, daily, monthly]);
}
