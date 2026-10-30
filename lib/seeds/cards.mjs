// Cards demo data: a debit card on every checking and teen account, card terms + card + a statement for each existing
// credit card (Nizam's Cash+ Card ··0088, Asim's ··6122, Zak's ··7132), the cash back their purchases earned, and a few
// things to look at per demo login (controls, a trip, autopay, a dispute). Safe to run again, on a fresh database and on
// production data alike (a deploy that changes any seed file re-runs every seed once): each step checks for what it would
// add first, at the account level (so a replaced card doesn't get the demo controls again), and never moves money or
// adds rewards for anything a customer did in the app.
import { issueCard, closeStatement, rewardFor, settlementIds, setControl, reverseRewards } from '../cards.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { newId } from '../auth.mjs';

export async function seed(c) {
  // debit cards: the minor holds a teen card; otherwise the first owner
  const debit = (await c.query(`SELECT a.id, (SELECT o.user_id FROM account_owners o WHERE o.account_id = a.id
      ORDER BY CASE o.role WHEN 'minor' THEN 0 WHEN 'owner' THEN 1 ELSE 2 END, o.added_at LIMIT 1) holder
    FROM accounts a WHERE a.kind IN ('checking', 'teen_checking') AND a.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM cards k WHERE k.account_id = a.id)`)).rows;
  for (const a of debit) if (a.holder) await issueCard(c, { accountId: a.id, holderId: a.holder, type: 'debit' });

  const credit = (await c.query(`SELECT a.*, (SELECT o.user_id FROM account_owners o WHERE o.account_id = a.id AND o.role = 'owner' LIMIT 1) holder
    FROM accounts a WHERE a.kind = 'credit_card' AND NOT EXISTS (SELECT 1 FROM credit_accounts ca WHERE ca.account_id = a.id)`)).rows;
  for (const a of credit) {
    await c.query(`INSERT INTO credit_accounts (account_id, product_code, apr_bp) VALUES ($1, 'cash_plus', 2224)`, [a.id]);
    if (a.holder && !(await c.query('SELECT 1 FROM cards WHERE account_id = $1', [a.id])).rowCount)
      await issueCard(c, { accountId: a.id, holderId: a.holder, type: 'credit', want: a.number_last4 });
    if (a.payment_due && !(await c.query('SELECT 1 FROM card_statements WHERE account_id = $1', [a.id])).rowCount) {
      // the last statement closed 25 days before the due date the account already shows
      const d = (await c.query(`SELECT ($1::date - 25) e, ($1::date - 54) s`, [a.payment_due])).rows[0];
      await closeStatement(c, a.id, d.e, { periodStart: d.s, dueDate: a.payment_due });
    }
  }

  // cash back on the seeded card history (lines settled through a card settlement account by a 'seed' entry). Keyed on the
  // purchase line (ref seed:<line id>) and checked first: a purchase made in the app (it has an authorization, and earned
  // its rewards then, even $0 for cash) or one that already has rewards of any kind is never given rewards again.
  const settle = await settlementIds(c);
  const buys = (await c.query(`SELECT l.id, l.account_id, l.amount_cents, l.category, l.description, p.rewards FROM ledger_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN credit_accounts ca ON ca.account_id = l.account_id JOIN card_products p ON p.code = ca.product_code
    WHERE l.amount_cents < 0 AND e.kind = 'seed' AND EXISTS (SELECT 1 FROM ledger_lines s WHERE s.entry_id = l.entry_id AND s.account_id = ANY($1))
      AND NOT EXISTS (SELECT 1 FROM card_authorizations x WHERE x.entry_id = l.entry_id)
      AND NOT EXISTS (SELECT 1 FROM card_rewards r WHERE r.account_id = l.account_id AND r.ref = 'seed:' || l.id)`, [settle])).rows;
  for (const b of buys) {
    const cents = rewardFor({ rewards: b.rewards }, b.category, -BigInt(b.amount_cents));
    if (cents > 0n) await c.query(`INSERT INTO card_rewards (account_id, cents, kind, ref, description) VALUES ($1,$2,'earn',$3,$4) ON CONFLICT (ref) DO NOTHING`,
      [b.account_id, cents, `seed:${b.id}`, `Rewards on ${b.description}`]);
  }

  await demoLogins(c);
}

const card = async (c, username, last4) => (await c.query(`SELECT k.*, a.id account_id, u.id user_id FROM cards k JOIN accounts a ON a.id = k.account_id
  JOIN users u ON u.id = k.holder_user_id WHERE u.username = $1 AND a.number_last4 = $2 AND k.status <> 'closed'`, [username, last4])).rows[0];
const account = async (c, username, last4) => (await c.query(`SELECT a.* FROM accounts a JOIN account_owners o ON o.account_id = a.id
  JOIN users u ON u.id = o.user_id WHERE u.username = $1 AND a.number_last4 = $2`, [username, last4])).rows[0];
// Checked across every card the account ever had (closed ones too), so a customer who replaced or changed a card doesn't
// get the demo setup put back on the new one when the seed runs again.
const hasControls = async (c, k) => (await c.query('SELECT 1 FROM card_controls x JOIN cards o ON o.id = x.card_id WHERE o.account_id = $1', [k.account_id])).rowCount > 0;
const trip = async (c, k, destination, startIn, days) => {
  if ((await c.query('SELECT 1 FROM card_travel_notices n JOIN cards o ON o.id = n.card_id WHERE o.account_id = $1', [k.account_id])).rowCount) return;
  await c.query(`INSERT INTO card_travel_notices (id, card_id, destination, start_on, end_on, created_by) VALUES ($1,$2,$3, current_date + $4::int, current_date + $5::int, $6)`,
    [newId(), k.id, destination, startIn, startIn + days, k.user_id]);
};

async function demoLogins(c) {
  // Nizam: international off on the everyday debit card; a parent's rules on Ava's teen card (no online, $40 a day at ATMs)
  const nd = await card(c, 'nizam@helixbots.ai', '4471');
  if (nd && !(await hasControls(c, nd))) {
    await setControl(c, nd.id, 'international', { enabled: false, limitCents: null }, nd.user_id);
    await setControl(c, nd.id, 'atm', { enabled: true, limitCents: 300_00n }, nd.user_id);
  }
  const teen = (await c.query(`SELECT k.* FROM cards k JOIN accounts a ON a.id = k.account_id WHERE a.kind = 'teen_checking' AND a.number_last4 = '5120' AND k.status <> 'closed'`)).rows[0];
  const parent = (await c.query(`SELECT id FROM users WHERE username = 'nizam@helixbots.ai'`)).rows[0];
  if (teen && parent && !(await hasControls(c, teen))) {
    await setControl(c, teen.id, 'online', { enabled: false, limitCents: null }, parent.id);
    await setControl(c, teen.id, 'atm', { enabled: true, limitCents: 40_00n }, parent.id);
    await setControl(c, teen.id, 'in_store', { enabled: true, limitCents: 50_00n }, parent.id);
  }
  const nc = await card(c, 'nizam@helixbots.ai', '0088');
  if (nc) await trip(c, nc, 'Lisbon, Portugal', 21, 9);

  // Asim: autopay of the statement balance from checking, and a trip on the debit card
  const ac = await account(c, 'asim@helixbots.ai', '6122'), achk = await account(c, 'asim@helixbots.ai', '6120');
  if (ac && achk) await c.query(`INSERT INTO card_autopay (account_id, from_account_id, type, updated_by)
    SELECT $1, $2, 'statement', o.user_id FROM account_owners o WHERE o.account_id = $1 ON CONFLICT (account_id) DO NOTHING`, [ac.id, achk.id]);
  const ad = await card(c, 'asim@helixbots.ai', '6120');
  if (ad) await trip(c, ad, 'Toronto, Canada', 10, 5);

  // Zak: an open dispute on the airline charge (provisional credit posted), and a locked debit card
  const zc = await account(c, 'zak@helixbots.ai', '7132');
  if (zc && !(await c.query('SELECT 1 FROM card_disputes WHERE account_id = $1', [zc.id])).rowCount) {
    const line = (await c.query(`SELECT * FROM ledger_lines WHERE account_id = $1 AND description = 'Airline tickets' AND amount_cents < 0`, [zc.id])).rows[0];
    const zak = (await c.query(`SELECT id FROM users WHERE username = 'zak@helixbots.ai'`)).rows[0];
    if (line) {
      const amount = -BigInt(line.amount_cents), key = `seed:cards:dispute:${zc.id}`;
      const r = await post(c, { key, kind: 'card_dispute_credit', createdBy: zak.id, lines: [
        { accountId: zc.id, amountCents: amount, description: `Provisional credit: ${line.description}`, category: 'Disputes' },
        { accountId: await systemAccount(c, 'card_disputes'), amountCents: -amount, description: `Provisional credit ··${zc.number_last4}` }] });
      const did = newId();
      await c.query(`INSERT INTO card_disputes (id, account_id, line_id, amount_cents, reason, details, idempotency_key, provisional_entry_id, created_by)
        VALUES ($1,$2,$3,$4,'not_received','Flight was canceled by the airline; no refund yet.',$5,$6,$7)`, [did, zc.id, line.id, amount, key, r.entryId, zak.id]);
      await reverseRewards(c, { id: did, account_id: zc.id, amount_cents: amount }, line, { userId: zak.id, last4: zc.number_last4 });   // held while disputed
    }
  }
  const zd = await card(c, 'zak@helixbots.ai', '7130');
  if (zd && zd.status === 'active' && !(await hasControls(c, zd))) {
    await c.query(`UPDATE cards SET status = 'locked', updated_at = now() WHERE id = $1`, [zd.id]);
    await setControl(c, zd.id, 'contactless', { enabled: false, limitCents: null }, zd.user_id);
  }
}
