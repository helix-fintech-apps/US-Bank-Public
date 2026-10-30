// Accounts & family demo data. Safe to run again: each piece checks for itself first.
//  - Nizam: Ava's Teen Checking ··5120 (managed): controls, a weekly allowance from Smart Checking ··4471, a goal, a chore;
//    the Family Vacation Savings ··7781 he shares with Jordan.
//  - Asim: Custodial Savings ··6125 for Mia (8, no login), managed, with a monthly allowance and a college goal;
//    a pending invitation from Zak to co-own Team Trip Savings ··7133.
//  - Zak: Custodial Savings ··7135 for Leo (12, no login) in view-only mode, with a goal; Team Trip Savings ··7133.
import { newId } from '../auth.mjs';
import { post } from '../ledger.mjs';

const nextFriday = () => {                                  // always in the future, so seeding never moves money
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export async function seed(c) {
  await seedNizam(c);
  await seedTeam(c);
}

async function seedNizam(c) {
  const id = async (sql, args) => (await c.query(sql, args)).rows[0]?.id ?? null;
  const nizam = await id("SELECT id FROM users WHERE username = 'nizam@helixbots.ai'");
  const ava = await id("SELECT id FROM users WHERE username = 'ava@usabanc.example'");
  const teen = await id("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE a.number_last4 = '5120' AND o.user_id = $1 AND o.role = 'custodian'", [nizam]);
  const chk = await id("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE a.number_last4 = '4471' AND o.user_id = $1 AND o.role = 'owner'", [nizam]);
  if (!nizam || !ava || !teen || !chk) return;

  await c.query("INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent') ON CONFLICT DO NOTHING", [nizam, ava]);
  await c.query(`INSERT INTO family_controls (account_id, mode, daily_limit_cents, weekly_limit_cents, held_categories, updated_by)
    VALUES ($1, 'managed', 2500, 7500, '{Gaming}', $2) ON CONFLICT DO NOTHING`, [teen, nizam]);
  await c.query("INSERT INTO account_terms (account_id, product_code, ownership, opened_by) VALUES ($1, 'teen_checking', 'minor', $2) ON CONFLICT DO NOTHING", [teen, nizam]);
  if (!(await c.query('SELECT 1 FROM allowances WHERE account_id = $1', [teen])).rowCount)
    await c.query("INSERT INTO allowances (id, account_id, from_account_id, amount_cents, cadence, next_run_on, created_by) VALUES ($1,$2,$3,1000,'weekly',$4,$5)",
      [newId(), teen, chk, nextFriday(), nizam]);
  if (!(await c.query('SELECT 1 FROM savings_goals WHERE account_id = $1', [teen])).rowCount)
    await c.query("INSERT INTO savings_goals (id, account_id, name, target_cents, saved_cents, target_date, created_by) VALUES ($1,$2,'New bike',25000,4000, current_date + 120,$3)",
      [newId(), teen, ava]);
  if (!(await c.query('SELECT 1 FROM chores WHERE account_id = $1', [teen])).rowCount)
    await c.query("INSERT INTO chores (id, account_id, title, reward_cents, created_by) VALUES ($1,$2,'Walk the dog every day this week',500,$3)", [newId(), teen, nizam]);
  const joint = await id("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE a.number_last4 = '7781' AND o.user_id = $1", [nizam]);
  if (joint) await c.query("INSERT INTO account_terms (account_id, product_code, ownership, opened_by) VALUES ($1, 'bright_savings', 'joint', $2) ON CONFLICT DO NOTHING", [joint, nizam]);
}

const yearsAgo = (y, m = 3, d = 14) => { const t = new Date(); return `${t.getUTCFullYear() - y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

/** A new account owned by userId (role), funded from their checking through the ledger like a real opening. */
async function openSeeded(c, { userId, fromId, kind, product, ownership, name, last4, apy, cents, minor }) {
  const aid = newId();
  await c.query("INSERT INTO accounts (id, kind, name, number_last4, apy_bp, opened_at) VALUES ($1,$2,$3,$4,$5, now() - interval '20 days')", [aid, kind, name, last4, apy]);
  await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [aid, userId, minor ? 'custodian' : 'owner']);
  if (minor) await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [aid, minor]);
  await c.query('INSERT INTO account_terms (account_id, product_code, ownership, opened_by) VALUES ($1,$2,$3,$4)', [aid, product, ownership, userId]);
  const from = (await c.query('SELECT name, number_last4 FROM accounts WHERE id = $1', [fromId])).rows[0];
  await post(c, { key: `seed:accounts-family:open:${last4}`, kind: 'account_opening', createdBy: userId, memo: `Opening deposit for ··${last4}`, lines: [
    { accountId: fromId, amountCents: -cents, description: `Opening deposit to ${name} ··${last4}`, category: 'Transfers' },
    { accountId: aid, amountCents: cents, description: `Opening deposit from ${from.name} ··${from.number_last4}`, category: 'Transfers' }] });
  return aid;
}
async function minorProfile(c, guardian, name, dob) {
  const mid = newId();
  await c.query("INSERT INTO users (id, username, display_name, password_hash, mfa_required, date_of_birth) VALUES ($1,$2,$3,'!',true,$4)",
    [mid, `minor-${mid.slice(0, 8)}@profiles.usabanc.example`, name, dob]);
  await c.query("INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent') ON CONFLICT DO NOTHING", [guardian, mid]);
  return mid;
}

async function seedTeam(c) {
  const user = async u => (await c.query('SELECT id FROM users WHERE username = $1', [u])).rows[0]?.id ?? null;
  const acct = async (uid, last4) => (await c.query("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE a.number_last4 = $1 AND o.user_id = $2 AND o.role = 'owner'", [last4, uid])).rows[0]?.id ?? null;
  const exists = async last4 => (await c.query('SELECT 1 FROM accounts WHERE number_last4 = $1', [last4])).rowCount > 0;
  const asim = await user('asim@helixbots.ai'), zak = await user('zak@helixbots.ai');
  if (!asim || !zak) return;
  const asimChk = await acct(asim, '6120'), zakChk = await acct(zak, '7130');
  if (!asimChk || !zakChk) return;

  if (!(await exists('6125'))) {
    const mia = await minorProfile(c, asim, 'Mia', yearsAgo(8, 6, 2));
    const a = await openSeeded(c, { userId: asim, fromId: asimChk, kind: 'custodial_savings', product: 'custodial_savings', ownership: 'minor',
      name: "Mia's Custodial Savings (UTMA)", last4: '6125', apy: 410, cents: 15000n, minor: mia });
    await c.query("INSERT INTO family_controls (account_id, mode, daily_limit_cents, weekly_limit_cents, held_categories, updated_by) VALUES ($1,'managed',2000,5000,'{Gaming,Online marketplaces}',$2)", [a, asim]);
    await c.query("INSERT INTO allowances (id, account_id, from_account_id, amount_cents, cadence, next_run_on, created_by) VALUES ($1,$2,$3,2500,'monthly', (date_trunc('month', current_date) + interval '1 month')::date, $4)",
      [newId(), a, asimChk, asim]);
    await c.query("INSERT INTO savings_goals (id, account_id, name, target_cents, saved_cents, target_date, created_by) VALUES ($1,$2,'College fund',500000,5000,NULL,$3)", [newId(), a, asim]);
  }
  if (!(await exists('7135'))) {
    const leo = await minorProfile(c, zak, 'Leo', yearsAgo(12, 9, 21));
    const a = await openSeeded(c, { userId: zak, fromId: zakChk, kind: 'custodial_savings', product: 'custodial_savings', ownership: 'minor',
      name: "Leo's Custodial Savings (UTMA)", last4: '7135', apy: 410, cents: 30000n, minor: leo });
    await c.query("INSERT INTO family_controls (account_id, mode, daily_limit_cents, weekly_limit_cents, updated_by) VALUES ($1,'view_only',3000,9000,$2)", [a, zak]);
    await c.query("INSERT INTO savings_goals (id, account_id, name, target_cents, saved_cents, target_date, created_by) VALUES ($1,$2,'Summer camp',60000,12000, current_date + 200,$3)", [newId(), a, zak]);
  }
  if (!(await exists('7133'))) {
    const a = await openSeeded(c, { userId: zak, fromId: zakChk, kind: 'savings', product: 'bright_savings', ownership: 'joint',
      name: 'Team Trip Savings', last4: '7133', apy: 410, cents: 40000n });
    await c.query("INSERT INTO joint_invites (id, account_id, inviter_id, invitee_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [newId(), a, zak, asim]);
  }
}
