// Money held on an account by wires that wait (for a second approver or a compliance review). A hold never touches
// the ledger: the available money is the ledger balance less what is held. Every outbound payment checks the available
// money, so held money can't be spent twice (lib/routes/money-movement.mjs `enough`, lib/routes/wire-screening.mjs).
export const WAITING = ['awaiting_approval', 'under_review'];

/** Serializes everything that spends an account's available money. Take it after any per-user lock (`mm:<user>`). */
export const lockHolds = (c, accountId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`holds:${accountId}`]);

/** { balance, held, available } in BigInt cents, read in one statement so a release can't fall between the two. */
export async function availableOf(c, accountId) {
  const r = (await c.query(`SELECT a.balance_cents AS balance, coalesce((SELECT sum(w.amount_cents + w.fee_cents) FROM wire_requests w
      WHERE w.from_account_id = a.id AND w.status = ANY($2)), 0)::bigint AS held FROM accounts a WHERE a.id = $1`, [accountId, WAITING])).rows[0];
  const balance = BigInt(r.balance), held = BigInt(r.held);
  return { balance, held, available: balance - held };
}
