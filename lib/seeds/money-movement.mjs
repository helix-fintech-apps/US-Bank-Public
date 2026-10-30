// Money movement demo data. Safe to run again: every row is checked or keyed first.
// - Nizam: a verified external account past its hold, two payees, USA Pay by email and phone, a request from Jordan
//   waiting for him, and his recent transfer, USA Pay and bill payment listed on the Pay page (linked to the core
//   seed's ledger entries, so no balance changes).
// - Jordan: USA Pay by email and phone.
// - Asim and Zak: USA Pay, an instantly linked external account, a payee, a USA Pay lunch between them, a request,
//   a monthly savings transfer (Asim), a bill payment on its way (Asim) and an ACH pull waiting to settle (Zak), so
//   "Simulate settlement" has something to finish.
import { newId } from '../auth.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { seal, hasKey } from '../money-movement/vault.mjs';
import { today, addDays, addBusinessDays, processingDay, addMonth } from '../money-movement/calendar.mjs';

const ENROLL = [
  ['nizam@helixbots.ai', '4471', ['nizam@helixbots.ai', '2025550142']],
  ['jordan@usabanc.example', '3388', ['jordan@usabanc.example', '2025550117']],
  ['asim@helixbots.ai', '6120', ['asim@helixbots.ai']],
  ['zak@helixbots.ai', '7130', ['zak@helixbots.ai']]
];

export async function seed(c) {
  const user = async name => (await c.query('SELECT id, display_name FROM users WHERE username = $1', [name])).rows[0];
  const acct = async (uid, last4) => (await c.query(`SELECT a.* FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.number_last4 = $2`, [uid, last4])).rows[0];
  const has = async (sql, args) => (await c.query(sql, args)).rowCount > 0;
  const nizam = await user('nizam@helixbots.ai');
  if (!nizam) return;

  for (const [name, last4, tokens] of ENROLL) {
    const u = await user(name); if (!u) continue;
    const a = await acct(u.id, last4); if (!a) continue;
    // the demo logins' own (fictional) email and phone, enrolled as proven; a row the same login already has (from before
    // codes, so unproven) is marked proven, and a token anyone else holds is left alone
    for (const t of tokens) await c.query(`INSERT INTO p2p_enrollments (token, user_id, account_id, verified_at) VALUES ($1,$2,$3, now())
      ON CONFLICT (token) DO UPDATE SET verified_at = now() WHERE p2p_enrollments.user_id = EXCLUDED.user_id AND p2p_enrollments.verified_at IS NULL`, [t, u.id, a.id]);
  }

  // the full number is stored only encrypted; without ACCOUNT_ENCRYPTION_KEY a demo row keeps just the last 4
  const external = async (u, { nickname, routing, number, method, institution }) => {
    const found = (await c.query('SELECT id FROM external_accounts WHERE user_id = $1 AND nickname = $2', [u.id, nickname])).rows[0];
    if (found) return found.id;
    const id = newId(), md = method === 'micro_deposits';
    await c.query(`INSERT INTO external_accounts (id, user_id, nickname, kind, institution, method, routing_number, number_last4, number_enc, status, md1_cents, md2_cents, tries_left, created_at, verified_at)
      VALUES ($1,$2,$3,'checking',$4,$5,$6,$7,$8,'verified',$9,$10,$11, now() - interval '32 days', now() - interval '30 days')`,
      [id, u.id, nickname, institution, method, routing, number.slice(-4), hasKey() ? seal(number, `${u.id}:${id}`) : null, md ? 17 : null, md ? 42 : null, md ? 3 : 0]);
    return id;
  };
  const payee = async (u, name, address) => {
    if (!(await has('SELECT 1 FROM payees WHERE user_id = $1 AND name = $2', [u.id, name])))
      await c.query('INSERT INTO payees (id, user_id, name, address) VALUES ($1,$2,$3,$4)', [newId(), u.id, name, address]);
    return (await c.query('SELECT id FROM payees WHERE user_id = $1 AND name = $2', [u.id, name])).rows[0].id;
  };
  /** A transfers row and its use of the limit, once. */
  const transfer = async row => {
    if (await has('SELECT 1 FROM transfers WHERE idempotency_key = $1', [row.idempotency_key])) return;
    const t = { id: newId(), direction: 'out', created_at: new Date(row.booked_on + 'T15:00:00Z'), ...row };
    t.updated_at = t.created_at;
    const cols = Object.keys(t);
    await c.query(`INSERT INTO transfers (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`, Object.values(t));
    await c.query(`INSERT INTO limit_usage (user_id, rail, transfer_id, amount_cents, booked_on, reason) VALUES ($1,$2,$3,$4,$5,'used')`, [t.user_id, t.rail, t.id, t.amount_cents, t.booked_on]);
  };
  const coreEntry = async (last4, description) => (await c.query(`SELECT l.entry_id, l.posted_on, -l.amount_cents AS amount FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
     WHERE a.number_last4 = $1 AND l.description = $2 ORDER BY l.id LIMIT 1`, [last4, description])).rows[0];

  // ----- Nizam -----
  await external(nizam, { nickname: 'Lakeside Credit Union checking', routing: '123456780', number: '000123456789', method: 'micro_deposits', institution: 'Lakeside Credit Union' });
  const power = await payee(nizam, 'City Power & Light', 'PO Box 1200, Springfield, IL 62701');
  await payee(nizam, 'Riverside Apartments', '400 River Rd, Springfield, IL 62702');
  const nChk = await acct(nizam.id, '4471'), nSav = await acct(nizam.id, '9302');
  if (nChk && nSav) {
    const history = [
      ['Transfer to Bright Savings ··9302', { rail: 'internal', to_account_id: nSav.id, counterparty: 'Bright Savings ··9302', status: 'completed' }],
      ['USA Pay to Sam Ortiz', { rail: 'p2p', p2p_token: 'sam.ortiz@example.com', counterparty: 'Sam Ortiz', status: 'completed', memo: 'Concert tickets' }],
      ['City Power & Light', { rail: 'billpay', payee_id: power, counterparty: 'City Power & Light', status: 'paid' }]
    ];
    for (const [desc, row] of history) {
      const e = await coreEntry('4471', desc); if (!e) continue;
      await transfer({ user_id: nizam.id, from_account_id: nChk.id, ...row, amount_cents: BigInt(e.amount), process_on: e.posted_on, settles_on: row.rail === 'billpay' ? e.posted_on : null,
        booked_on: e.posted_on, idempotency_key: `seed:mm:nizam:${row.rail}`, entry_id: e.entry_id, settled_at: new Date(e.posted_on + 'T18:00:00Z') });
    }
  }
  const jordan = await user('jordan@usabanc.example'), jChk = jordan && await acct(jordan.id, '3388');
  if (jChk && !(await has("SELECT 1 FROM p2p_requests WHERE requester_id = $1 AND memo = 'Pizza night'", [jordan.id])))
    await c.query("INSERT INTO p2p_requests (id, requester_id, deposit_account_id, to_token, amount_cents, memo) VALUES ($1,$2,$3,'nizam@helixbots.ai',2450,'Pizza night')", [newId(), jordan.id, jChk.id]);

  // ----- Asim and Zak -----
  const asim = await user('asim@helixbots.ai'), zak = await user('zak@helixbots.ai');
  if (!asim || !zak) return;
  const [aChk, aSav, zChk] = [await acct(asim.id, '6120'), await acct(asim.id, '6121'), await acct(zak.id, '7130')];
  if (!aChk || !aSav || !zChk) return;
  await external(asim, { nickname: 'Lakeside Credit Union checking', routing: '123456780', number: '4400129051', method: 'instant', institution: 'Lakeside Credit Union' });
  const zExt = await external(zak, { nickname: 'Prairie National Bank checking', routing: '111111118', number: '5500134417', method: 'instant', institution: 'Prairie National Bank' });
  const internet = await payee(asim, 'Northside Internet', 'PO Box 88, Austin, TX 78701');
  await payee(zak, 'Metro Water', '1 Reservoir Way, Denver, CO 80202');

  // a USA Pay lunch from Asim to Zak, 5 days ago (through USA Pay clearing)
  const lunchDay = addDays(today(), -5), lunch = 3200n, p2p = await systemAccount(c, 'mm_p2p');
  const lunchEntry = await post(c, { key: 'seed:mm:asim-zak-lunch', kind: 'p2p', createdBy: asim.id, memo: 'Team lunch', lines: [
    { accountId: aChk.id, amountCents: -lunch, description: 'USA Pay to Zak', category: 'Transfers', postedOn: lunchDay },
    { accountId: p2p, amountCents: lunch, description: 'USA Pay from Asim', postedOn: lunchDay },
    { accountId: p2p, amountCents: -lunch, description: 'USA Pay to Zak', postedOn: lunchDay },
    { accountId: zChk.id, amountCents: lunch, description: 'USA Pay from Asim', category: 'Transfers', postedOn: lunchDay }] });
  await transfer({ user_id: asim.id, rail: 'p2p', from_account_id: aChk.id, to_account_id: zChk.id, to_user_id: zak.id, p2p_token: 'zak@helixbots.ai', counterparty: 'Zak',
    amount_cents: lunch, memo: 'Team lunch', status: 'completed', process_on: lunchDay, booked_on: lunchDay, idempotency_key: 'seed:mm:asim-zak-lunch', entry_id: lunchEntry.entryId });
  if (!(await has("SELECT 1 FROM p2p_requests WHERE requester_id = $1 AND memo = 'Coffee run'", [zak.id])))
    await c.query("INSERT INTO p2p_requests (id, requester_id, deposit_account_id, to_token, amount_cents, memo) VALUES ($1,$2,$3,'asim@helixbots.ai',1800,'Coffee run')", [newId(), zak.id, zChk.id]);

  // Asim: $200 to savings on the 1st of every month
  if (!(await has("SELECT 1 FROM scheduled_transfers WHERE idempotency_key = 'seed:mm:asim-monthly-savings'")))
    await c.query(`INSERT INTO scheduled_transfers (id, user_id, rail, from_account_id, to_account_id, amount_cents, memo, cadence, anchor_day, next_run, idempotency_key)
      VALUES ($1,$2,'internal',$3,$4,20000,'Monthly savings','monthly',1,$5,'seed:mm:asim-monthly-savings')`, [newId(), asim.id, aChk.id, aSav.id, addMonth(today().slice(0, 8) + '01', 1)]);

  // Asim: an internet bill on its way (debited now; in bill pay in transit until it's delivered)
  const sendOn = processingDay('ach'), bill = 6500n;
  const billEntry = await post(c, { key: 'seed:mm:asim-internet', kind: 'bill_pay', createdBy: asim.id, lines: [
    { accountId: aChk.id, amountCents: -bill, description: 'Bill pay: Northside Internet', category: 'Bills & Utilities', postedOn: today() },
    { accountId: await systemAccount(c, 'mm_billpay'), amountCents: bill, description: 'Bill pay: Northside Internet', postedOn: today() }] });
  await transfer({ user_id: asim.id, rail: 'billpay', from_account_id: aChk.id, payee_id: internet, counterparty: 'Northside Internet', amount_cents: bill,
    status: 'sent', process_on: sendOn, settles_on: addBusinessDays(sendOn, 2), booked_on: today(), idempotency_key: 'seed:mm:asim-internet', entry_id: billEntry.entryId,
    created_at: new Date() });

  // Zak: $750 coming in from his other bank (nothing moves until it settles)
  await transfer({ user_id: zak.id, rail: 'ach', direction: 'in', to_account_id: zChk.id, external_account_id: zExt, counterparty: 'Prairie National Bank checking ··4417',
    amount_cents: 75000n, status: 'pending', process_on: sendOn, settles_on: addBusinessDays(sendOn, 3), booked_on: today(), idempotency_key: 'seed:mm:zak-ach-in', created_at: new Date() });
}
