import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const acct = async last4 => (await env.q('SELECT id, balance_cents FROM accounts WHERE number_last4 = $1', [last4])).rows[0];

test('every balance equals the sum of its ledger lines, and every entry sums to zero', async () => {
  const bad = await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY 1) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`);
  assert.equal(bad.rowCount, 0);
  const unbalanced = await env.q('SELECT entry_id FROM ledger_lines GROUP BY entry_id HAVING sum(amount_cents) <> 0');
  assert.equal(unbalanced.rowCount, 0);
});

test('the same idempotency key moves money once', async () => {
  const chk = await acct('4471'), sav = await acct('9302');
  const move = () => tx(env.pool, c => post(c, { key: 'test:once', kind: 'transfer', lines: [
    { accountId: chk.id, amountCents: -1000n, description: 'to savings' }, { accountId: sav.id, amountCents: 1000n, description: 'from checking' }] }));
  const a = await move(), b = await move();
  assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(b.entryId, a.entryId);
  assert.equal((await acct('4471')).balance_cents, chk.balance_cents - 1000n);
});

test('an overdraft is refused and leaves nothing behind', async () => {
  const teen = await acct('5120');
  await assert.rejects(tx(env.pool, async c => post(c, { key: 'test:overdraft', kind: 'transfer', lines: [
    { accountId: teen.id, amountCents: -999999n, description: 'too much' }, { accountId: await systemAccount(c, 'p2p_clearing'), amountCents: 999999n, description: 'x' }] })),
    e => e.code === 'insufficient_funds');
  assert.equal((await acct('5120')).balance_cents, teen.balance_cents);
  assert.equal((await env.q("SELECT 1 FROM journal_entries WHERE idempotency_key = 'test:overdraft'")).rowCount, 0);
});

test('an unbalanced entry is refused by the database itself', async () => {
  const chk = await acct('4471');
  await assert.rejects(tx(env.pool, async c => {
    await c.query("INSERT INTO journal_entries (id, idempotency_key, kind) VALUES ('11111111-1111-4111-8111-111111111111', 'test:raw', 'x')");
    await c.query("INSERT INTO ledger_lines (entry_id, account_id, amount_cents, description) VALUES ('11111111-1111-4111-8111-111111111111', $1, 500, 'free money')", [chk.id]);
  }), /does not balance/);
});

test('ledger lines, journal entries and the audit trail cannot be edited, deleted or truncated', async () => {
  await env.q("INSERT INTO audit_events (action) VALUES ('test.row')");
  await assert.rejects(env.q('UPDATE ledger_lines SET amount_cents = amount_cents + 1'), /append-only/);
  await assert.rejects(env.q('DELETE FROM journal_entries'), /append-only/);
  await assert.rejects(env.q("UPDATE audit_events SET action = 'x'"), /append-only/);
  await assert.rejects(env.q('DELETE FROM audit_events'), /append-only/);
  for (const t of ['ledger_lines', 'journal_entries', 'audit_events']) await assert.rejects(env.q(`TRUNCATE ${t} CASCADE`), /append-only/);
});
