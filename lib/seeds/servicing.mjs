// Servicing demo data: contact details, a few alert rules with inbox items, and a secure-message thread.
// Safe to run again: profiles and inbox items skip on conflict; rules and the thread are added only if the user has none.
import { newId } from '../auth.mjs';

const PROFILES = {
  'nizam@helixbots.ai': { phone: '5550100142', line1: '1200 Harbor View Dr', city: 'Austin', state: 'TX', zip: '78701' },
  'jordan@usabanc.example': { phone: '5550100117', line1: '48 Maple Ave', city: 'Columbus', state: 'OH', zip: '43215' },
  'ava@usabanc.example': { phone: '5550100108', line1: '1200 Harbor View Dr', city: 'Austin', state: 'TX', zip: '78701' }
};

export async function seed(c) {
  for (const [username, p] of Object.entries(PROFILES)) {
    const u = (await c.query('SELECT id FROM users WHERE username = $1', [username])).rows[0];
    if (!u) continue;
    await c.query(`INSERT INTO user_profiles (user_id, email, phone, address_line1, city, state, zip) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO NOTHING`, [u.id, username, p.phone, p.line1, p.city, p.state, p.zip]);
  }
  const nizam = (await c.query("SELECT id FROM users WHERE username = 'nizam@helixbots.ai'")).rows[0]?.id;
  if (!nizam) return;
  const chk = (await c.query("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.number_last4 = '4471'", [nizam])).rows[0]?.id ?? null;

  // only for someone who never had alert rules: a customer who deleted theirs doesn't get them back when the seed runs again
  if (!(await c.query(`SELECT 1 FROM alert_rules WHERE user_id = $1 UNION ALL SELECT 1 FROM audit_events WHERE user_id = $1 AND action LIKE 'alert_rule.%'`, [nizam])).rowCount) {
    // rules start watching from now, so the seeded history doesn't fire again; the inbox items below stand in for it
    for (const [kind, account, threshold, email] of [['low_balance', chk, 50000n, true], ['large_purchase', null, 10000n, false], ['deposit', null, null, true], ['new_device', null, null, true]])
      await c.query(`INSERT INTO alert_rules (id, user_id, kind, account_id, threshold_cents, email, checked_line_id, checked_audit_id)
         VALUES ($1,$2,$3,$4,$5,$6, (SELECT coalesce(max(id), 0) FROM ledger_lines), (SELECT coalesce(max(id), 0) FROM audit_events))`, [newId(), nizam, kind, account, threshold, email]);
  }
  const items = [
    ['seed:deposit-2', 'deposit', 'Deposit received: $1,842.55', 'Direct deposit, Northwind Robotics payroll to Smart Checking ··4471.', 2, true],
    ['seed:purchase-1', 'large_purchase', 'Purchase over $100.00', '$259.71 at Skyway Airlines on Cash+ Card ··0088.', 9, false],
    ['seed:purchase-2', 'large_purchase', 'Purchase over $100.00', '$112.38 at Whole Foods Market on Smart Checking ··4471.', 5, false],
    ['seed:welcome', 'security', 'Alerts are on', 'We\'ll let you know about low balances, large purchases, deposits and new sign-ins. Change them any time.', 20, false]
  ];
  for (const [ref, kind, title, body, daysAgo, email] of items)
    await c.query(`INSERT INTO notifications (user_id, kind, ref, title, body, email_to, created_at, read_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(days => $7), CASE WHEN $8 THEN now() - make_interval(days => $7) END) ON CONFLICT (user_id, ref) DO NOTHING`,
      [nizam, kind, ref, title, body, email ? 'nizam@helixbots.ai' : null, daysAgo, ref === 'seed:welcome']);

  if (!(await c.query('SELECT 1 FROM message_threads WHERE user_id = $1', [nizam])).rowCount) {
    const t = newId();
    await c.query("INSERT INTO message_threads (id, user_id, subject, created_at, updated_at) VALUES ($1,$2,'When does my paycheck arrive?', now() - interval '3 days', now() - interval '3 days')", [t, nizam]);
    await c.query(`INSERT INTO messages (thread_id, sender, body, created_at, read_at) VALUES
      ($1, 'customer', 'Hi, my employer moved payday. When will a direct deposit show up in Smart Checking?', now() - interval '3 days', NULL),
      ($1, 'bank', 'Hi Nizam, direct deposits usually post the morning the payroll file arrives, often a day before payday. This is a simulated reply in a demo bank.', now() - interval '3 days' + interval '2 hours', NULL)`, [t]);
  }
}
