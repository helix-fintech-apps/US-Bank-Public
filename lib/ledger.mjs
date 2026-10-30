// Double-entry posting. Each entry's lines sum to zero (checked here and again by the database).
// The same idempotency key posts once: a retry gets the first entry back instead of moving money twice.
import { AppError } from './http.mjs';
import { newId } from './auth.mjs';
import { bankToday } from './bank-date.mjs';

const systemIds = new Map();
export async function systemAccount(c, code) {
  if (!systemIds.has(code)) {
    const r = (await c.query('SELECT id FROM accounts WHERE system_code = $1', [code])).rows[0];
    if (!r) throw new Error(`no system account ${code}`);
    systemIds.set(code, r.id);
  }
  return systemIds.get(code);
}

/**
 * lines: [{ accountId, amountCents: BigInt (+ in / - out), description, category?, postedOn? (default: today's bank date) }]
 * Returns { entryId, replayed }. Throws 409 insufficient_funds if a deposit account would go below zero, and 409 over_limit
 * if a credit card would go past its credit limit (db/migrations/030_cards.sql).
 */
export async function post(c, { key, kind, memo = null, createdBy = null, lines }) {
  if (!key) throw new Error('post() needs an idempotency key');
  if (!lines?.length || lines.length < 2) throw new Error('an entry needs at least two lines');
  let sum = 0n;
  for (const l of lines) { if (typeof l.amountCents !== 'bigint' || l.amountCents === 0n) throw new Error('amounts must be non-zero BigInt cents'); sum += l.amountCents; }
  if (sum !== 0n) throw new Error(`entry does not balance (${sum})`);
  const id = newId();
  await c.query('SAVEPOINT post_entry');                       // a refused overdraft leaves neither the entry nor its lines
  const ins = await c.query('INSERT INTO journal_entries (id, idempotency_key, kind, memo, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
    [id, key, kind, memo, createdBy]);
  if (!ins.rowCount) {
    const prev = (await c.query('SELECT id, kind FROM journal_entries WHERE idempotency_key = $1', [key])).rows[0];
    if (prev.kind !== kind) throw new AppError(422, 'idempotency_conflict', 'This request id was already used for something else.');
    return { entryId: prev.id, replayed: true };
  }
  const on = bankToday();                                       // a line with no date posts on today's bank date (Central Time)
  try {
    for (const l of lines)
      await c.query('INSERT INTO ledger_lines (entry_id, account_id, amount_cents, description, category, posted_on) VALUES ($1,$2,$3,$4,$5,$6::date)',
        [id, l.accountId, l.amountCents, l.description, l.category ?? null, l.postedOn ?? on]);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT post_entry');
    if (e.code === '23514' && e.constraint === 'accounts_credit_limit') throw new AppError(409, 'over_limit', 'This is more than the available credit on the card.');
    if (e.code === '23514' && /accounts_check|balance/.test(e.message + (e.constraint ?? ''))) throw new AppError(409, 'insufficient_funds', "There isn't enough money in that account.");
    throw e;
  }
  return { entryId: id, replayed: false };
}
