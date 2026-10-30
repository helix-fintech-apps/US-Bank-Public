// Helix team demo logins. Each signs straight in (no one-time code) and gets their own checking, savings and card.
// Runs after the core data on every start; adds only the people who are missing, so it is safe to run again.
import { hashPassword, newId } from '../auth.mjs';
import { post, systemAccount } from '../ledger.mjs';

export const TEAM = [
  { username: 'asim@helixbots.ai', password: 'asim', name: 'Asim', phone: '31', last4: ['6120', '6121', '6122'] },
  { username: 'zak@helixbots.ai', password: 'zak', name: 'Zak', phone: '57', last4: ['7130', '7131', '7132'] }
];

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

export async function seed(c) {
  for (const t of TEAM) {
    if ((await c.query('SELECT 1 FROM users WHERE username = $1', [t.username])).rowCount) continue;
    const uid = newId();
    await c.query('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
      [uid, t.username, t.name, await hashPassword(t.password), t.phone]);
    const acct = async (kind, name, last4, extra = {}) => {
      const id = newId();
      await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents, apy_bp, payment_due, opened_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE current_date + $8::int END, now() - interval '200 days')`,
        [id, kind, name, last4, !!extra.allowNegative, extra.limit ?? null, extra.apy ?? null, extra.dueIn ?? null]);
      await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [id, uid]);
      return id;
    };
    const chk = await acct('checking', 'Smart Checking', t.last4[0]);
    const sav = await acct('savings', 'Bright Savings', t.last4[1], { apy: 410 });
    const card = await acct('credit_card', 'Cash+ Card', t.last4[2], { allowNegative: true, limit: 500000n, dueIn: 20 });
    let n = 0;
    const one = async (account, other, cents, description, category, daysAgo) => post(c, { key: `team:${t.username}:${n++}`, kind: 'seed', lines: [
      { accountId: account, amountCents: cents, description, category, postedOn: day(daysAgo) },
      { accountId: await systemAccount(c, other), amountCents: -cents, description, postedOn: day(daysAgo) }] });
    await one(chk, 'equity', 350000n, 'Opening deposit', 'Transfers', 30);
    await one(sav, 'equity', 1200000n, 'Opening deposit', 'Transfers', 30);
    await one(chk, 'ach_clearing', 260000n, 'Direct deposit, Helix payroll', 'Income', 12);
    await one(chk, 'billpay_clearing', -180000n, 'Rent', 'Housing', 10);
    await one(chk, 'card_settlement', -8640n, 'Grocery store', 'Groceries', 6);
    await one(card, 'card_settlement', -12500n, 'Airline tickets', 'Travel', 8);
    await one(card, 'card_settlement', -2350n, 'Lunch', 'Food & Dining', 3);
    await one(chk, 'ach_clearing', 260000n, 'Direct deposit, Helix payroll', 'Income', 1);
  }
}
