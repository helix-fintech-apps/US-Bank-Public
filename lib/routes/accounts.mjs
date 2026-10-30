// The signed-in customer, their accounts (with their role on each) and account activity.
import { tx } from '../db.mjs';
import { requireUser } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { toStr } from '../money.mjs';

const DEPOSIT = ['checking', 'savings', 'money_market', 'cd', 'teen_checking', 'custodial_savings'];

export const accountView = a => ({
  id: a.id, kind: a.kind, name: a.name, last4: a.number_last4, status: a.status, role: a.role,
  balance: toStr(a.balance_cents),
  // cards and loans: what's owed and (cards) what's available
  ...(a.kind === 'credit_card' ? { owed: toStr(-a.balance_cents), available: toStr(BigInt(a.credit_limit_cents ?? 0) + BigInt(a.balance_cents)), creditLimit: toStr(a.credit_limit_cents ?? 0), paymentDue: a.payment_due } : {}),
  ...(a.kind === 'loan' ? { owed: toStr(-a.balance_cents), paymentDue: a.payment_due } : {}),
  ...(a.apy_bp != null ? { apy: (a.apy_bp / 100).toFixed(2) } : {})                       // ok-number: basis points to a display string
});
// category: the user's own choice (category_overrides) when they made one, as in /api/activity
const lineView = l => ({ id: String(l.id), postedOn: l.posted_on, description: l.description, category: l.override ?? l.category, amount: toStr(l.amount_cents) });

export function register(r) {
  r.add('GET', '/api/me', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const accts = (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
       WHERE o.user_id = $1 AND a.status <> 'closed' ORDER BY CASE a.kind WHEN 'checking' THEN 1 WHEN 'savings' THEN 2 WHEN 'credit_card' THEN 3 ELSE 4 END, a.opened_at, a.name`, [u.id])).rows;
    const owned = accts.filter(a => DEPOSIT.includes(a.kind) && ['owner', 'joint_owner'].includes(a.role));
    const total = owned.reduce((s, a) => s + BigInt(a.balance_cents), 0n);
    return { user: { displayName: u.displayName, username: u.username, phoneLast2: u.phoneLast2, isMinor: !!u.dateOfBirth && ageOf(u.dateOfBirth) < 18 },
      totalDeposits: toStr(total), accounts: accts.map(accountView) };
  }));

  r.add('GET', '/api/accounts/:id/transactions', async ({ req, pool, params, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await accountFor(c, u.id, params.id);
    const limit = Math.min(Math.max(parseInt(query.limit ?? '25', 10) || 25, 1), 200);
    const lines = (await c.query(`SELECT l.*, o.category AS override FROM ledger_lines l
       LEFT JOIN category_overrides o ON o.line_id = l.id AND o.user_id = $3
       WHERE l.account_id = $1 ORDER BY l.posted_on DESC, l.id DESC LIMIT $2`, [a.id, limit, u.id])).rows;
    return { account: accountView(a), transactions: lines.map(lineView) };
  }));
}

export function ageOf(dob, on = new Date()) {
  const d = new Date(dob + 'T00:00:00Z');
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  if (on.getUTCMonth() < d.getUTCMonth() || (on.getUTCMonth() === d.getUTCMonth() && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
