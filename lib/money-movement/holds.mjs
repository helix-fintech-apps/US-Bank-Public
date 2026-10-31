// Holds on money brought in by ACH pulls (ACH returns feature, db/migrations/065_ach_returns.sql). While a return can still
// arrive, the money a pull credited is in the balance but can't be spent through /api/pay: from its posting through its
// final date, 5 business days later. Holds are worked out here, never posted: the ledger balance includes held money.
// Every credited presentment that is not returned is a settled ACH-in transfer (the original pull, or its re-presentment).
import { today, addDays, addBusinessDays } from './calendar.mjs';

export const FINAL_DAYS = 5;                            // business days after posting until a debit can no longer be returned
export const finalDate = postedOn => addBusinessDays(postedOn, FINAL_DAYS);

/** Money held on an account today, as BigInt cents. */
export async function heldOn(c, accountId) {
  const t = today();
  const rows = (await c.query(`SELECT t.amount_cents, l.posted_on FROM transfers t
       JOIN ledger_lines l ON l.entry_id = t.entry_id AND l.account_id = t.to_account_id AND l.amount_cents > 0
     WHERE t.to_account_id = $1 AND t.rail = 'ach' AND t.direction = 'in' AND t.status = 'settled' AND l.posted_on > $2`,
  [accountId, addDays(t, -30)])).rows;                  // 5 business days are never more than 30 calendar days
  let held = 0n;
  for (const r of rows) if (t <= finalDate(r.posted_on)) held += BigInt(r.amount_cents);
  return held;
}
