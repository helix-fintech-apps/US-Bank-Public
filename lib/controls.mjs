// Family controls on a minor's account: the spend check other features call before a minor spends, and the
// allowance runner. Limits are data (docs/RESEARCH.md §1 "Minor parental controls"; demo values).
import { AppError, refuse } from './http.mjs';
import { audit } from './auth.mjs';
import { post } from './ledger.mjs';
import { toStr, usd } from './money.mjs';
import { bankToday, addDays } from './bank-date.mjs';
import { CONTROL_CATEGORIES } from './categories.mjs';

// Merchant categories a parent can turn off: the shared list's control subset (lib/categories.mjs).
export const CATEGORIES = CONTROL_CATEGORIES;
// New minor accounts start here; a parent can set limits up to the max (minors get stricter limits, RESEARCH §1 (e)).
export const DEFAULT_LIMITS = { daily: 50_00n, weekly: 150_00n };
export const MAX_LIMITS = { daily: 500_00n, weekly: 1_500_00n };
export const MAX_ALLOWANCE = 200_00n, MAX_CHORE = 100_00n, MAX_GOALS = 5;
export const ALLOWANCE_CATCH_UP = 6;                       // most missed allowances paid in one run
// Ledger entry kinds on a minor's account that are not the minor spending.
const NOT_SPEND = ['account_opening'];

/** Makes sure a minor's account has a controls row (defaults), and returns it. Accounts with no minor owner get null. */
export async function controlsFor(c, accountId, { lock = false } = {}) {
  const minor = (await c.query("SELECT 1 FROM account_owners WHERE account_id = $1 AND role = 'minor'", [accountId])).rowCount;
  if (!minor) return null;
  await c.query('INSERT INTO family_controls (account_id, daily_limit_cents, weekly_limit_cents) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [accountId, DEFAULT_LIMITS.daily, DEFAULT_LIMITS.weekly]);
  return (await c.query(`SELECT * FROM family_controls WHERE account_id = $1${lock ? ' FOR UPDATE' : ''}`, [accountId])).rows[0];
}

/**
 * What the minor has spent today and in the last 7 days (today included, bank dates), from the ledger. Only the minor's
 * own spending counts: entries the minor created, or that no user created (simulated card network, seeded purchases).
 * Money a parent moved (a transfer between the child's accounts) is not the minor spending.
 */
export async function spent(c, accountId, today = bankToday()) {
  const r = (await c.query(`SELECT coalesce(sum(-l.amount_cents) FILTER (WHERE l.posted_on = $3::date), 0)::bigint AS today,
       coalesce(sum(-l.amount_cents), 0)::bigint AS week
     FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND l.amount_cents < 0 AND l.posted_on > $4::date AND l.posted_on <= $3::date AND e.kind <> ALL($2)
       AND (e.created_by IS NULL OR e.created_by IN (SELECT user_id FROM account_owners WHERE account_id = $1 AND role = 'minor'))`,
    [accountId, NOT_SPEND, today, addDays(today, -7)])).rows[0];
  return { today: BigInt(r.today), week: BigInt(r.week) };
}

const CHILDS_MONEY = (name, a) => `Money in ${a.name} ··${a.number_last4} belongs to ${name}. It can only move to another of ${name}'s accounts that you manage.`;
/**
 * The custodian rule for money leaving a minor's account. A custodian may move it only
 * to another account of the same minor that they also manage, and never while the account is in view-only mode.
 * `from` and `to` are accountFor() rows (with the caller's role). Refusals are audited and keep their audit row.
 * Returns nothing when allowed (and for anyone who isn't a custodian of `from`).
 */
export async function checkCustodianMove(c, req, userId, from, to, { what = 'transfer' } = {}) {
  if (from.role !== 'custodian') return;
  const ctl = await controlsFor(c, from.id);
  const child = (await c.query(`SELECT u.id, u.display_name FROM account_owners o JOIN users u ON u.id = o.user_id
     WHERE o.account_id = $1 AND o.role = 'minor'`, [from.id])).rows[0];
  const name = child?.display_name?.split(' ')[0] ?? 'the child';
  let no = null;
  if (ctl?.mode === 'view_only') no = ['view_only', `${from.name} ··${from.number_last4} is in view-only mode. Switch to managed mode to move ${name}'s money.`];
  else if (!to || to.role !== 'custodian' || !child ||
    !(await c.query("SELECT 1 FROM account_owners WHERE account_id = $1 AND user_id = $2 AND role = 'minor'", [to.id, child.id])).rowCount)
    no = ['childs_money', CHILDS_MONEY(name, from)];
  if (!no) return;
  await audit(c, req, userId, 'transfer.refused', { reason: no[0], what, account: from.number_last4, to: to?.number_last4 ?? null, accountId: from.id });
  throw refuse(403, no[0], no[1]);
}

/**
 * May the minor spend this? Call it BEFORE writing anything in the transaction: a "no" is thrown with refuse(),
 * which commits the transaction so the audit row survives.
 *   c          a client inside tx()
 *   accountId  the account the money leaves
 *   amountCents BigInt > 0
 *   category   merchant category (see CATEGORIES); null if unknown
 *   opts       { channel: 'card' (default) | 'p2p' | 'transfer', req, userId } — card freeze applies only to 'card'
 * Returns nothing when allowed (and for accounts with no minor owner). Throws a plain-words AppError (422) when a control says no.
 */
export async function checkMinorSpend(c, accountId, amountCents, category, { channel = 'card', req = null, userId = null } = {}) {
  if (typeof amountCents !== 'bigint' || amountCents <= 0n) throw new AppError(400, 'bad_amount', 'Enter an amount more than $0.00.');
  const a = (await c.query('SELECT id, status FROM accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];   // one spend at a time per account
  if (!a) throw new AppError(404, 'not_found', 'Account not found.');
  const ctl = await controlsFor(c, a.id);
  if (!ctl) return;
  const cat = category ? String(category) : null, held = ctl.held_categories.find(h => cat && h.toLowerCase() === cat.toLowerCase());
  let no = null;
  if (a.status === 'frozen') no = ['account_frozen', 'This account is frozen by a parent. Ask them to unfreeze it.'];
  else if (a.status !== 'open') no = ['account_unavailable', "This account can't be used right now."];
  else if (channel === 'card' && ctl.card_frozen) no = ['card_frozen', 'This card is frozen by a parent. Ask them to unfreeze it.'];
  else if (held) no = ['category_off', `Purchases in ${held} are turned off by a parent.`];
  let s = null;
  if (!no) {
    s = await spent(c, a.id);
    const leftDay = ctl.daily_limit_cents - s.today, leftWeek = ctl.weekly_limit_cents - s.week;
    if (amountCents > leftDay) no = ['daily_limit', `That's over the daily spending limit of ${usd(ctl.daily_limit_cents)}. ${usd(leftDay > 0n ? leftDay : 0n)} left today.`];
    else if (amountCents > leftWeek) no = ['weekly_limit', `That's over the 7-day spending limit of ${usd(ctl.weekly_limit_cents)}. ${usd(leftWeek > 0n ? leftWeek : 0n)} left this week.`];
  }
  await audit(c, req, userId, no ? 'family.spend.declined' : 'family.spend.allowed',
    { accountId: a.id, amount: toStr(amountCents), category: cat, channel, ...(no ? { reason: no[0] } : {}) });
  if (no) throw refuse(422, no[0], no[1]);
}

const nextDate = async (c, d, cadence) =>
  (await c.query(`SELECT ($1::date + CASE WHEN $2 = 'weekly' THEN interval '7 days' ELSE interval '1 month' END)::date AS d`, [d, cadence])).rows[0].d;

/**
 * Pays every allowance that is due (on or before today), oldest first, through the ledger. No cron: pages call it on read.
 * The key is the allowance and its date, so a run can never pay twice. Not enough money: the run is skipped and recorded.
 * accountIds: limit to these minor accounts (null = all). Returns [{ allowanceId, runOn, status, reason }].
 */
export async function runDueAllowances(c, accountIds = null) {
  const today = bankToday(), out = [];
  const due = (await c.query(`SELECT al.*, t.name AS to_name, t.number_last4 AS to_last4, t.status AS to_status, f.name AS from_name, f.number_last4 AS from_last4,
       f.status AS from_status, u.display_name AS parent_name
     FROM allowances al JOIN accounts t ON t.id = al.account_id JOIN accounts f ON f.id = al.from_account_id JOIN users u ON u.id = al.created_by
     WHERE al.active AND al.next_run_on <= $1::date ${accountIds ? 'AND al.account_id = ANY($2)' : ''}
     ORDER BY al.next_run_on FOR UPDATE OF al SKIP LOCKED`, accountIds ? [today, accountIds] : [today])).rows;
  for (const al of due) {
    let runOn = al.next_run_on;
    for (let n = 0; runOn <= today && n < ALLOWANCE_CATCH_UP; n++) {
      if ((await c.query('SELECT 1 FROM allowance_runs WHERE allowance_id = $1 AND run_on = $2', [al.id, runOn])).rowCount) { runOn = await nextDate(c, runOn, al.cadence); continue; }
      const payer = (await c.query("SELECT 1 FROM account_owners WHERE account_id = $1 AND user_id = $2 AND role IN ('owner', 'joint_owner')", [al.from_account_id, al.created_by])).rowCount;
      let status = 'paid', reason = null, entryId = null;
      if (!payer || al.from_status !== 'open') { status = 'skipped'; reason = `${al.from_name} ··${al.from_last4} can't be used for the allowance any more.`; }
      else if (al.to_status === 'closed') { status = 'skipped'; reason = 'The account is closed.'; }
      else {
        try {
          entryId = (await post(c, { key: `allowance:${al.id}:${runOn}`, kind: 'allowance', createdBy: al.created_by, lines: [
            { accountId: al.from_account_id, amountCents: -al.amount_cents, description: `Allowance to ${al.to_name} ··${al.to_last4}`, category: 'Transfers', postedOn: runOn },
            { accountId: al.account_id, amountCents: al.amount_cents, description: `Allowance from ${al.parent_name}`, category: 'Income', postedOn: runOn }] })).entryId;
        } catch (e) {
          if (e.code !== 'insufficient_funds') throw e;
          status = 'skipped'; reason = `Not enough money in ${al.from_name} ··${al.from_last4}.`;
        }
      }
      await c.query('INSERT INTO allowance_runs (allowance_id, run_on, status, reason, entry_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [al.id, runOn, status, reason, entryId]);
      await audit(c, null, al.created_by, status === 'paid' ? 'family.allowance.paid' : 'family.allowance.skipped',
        { accountId: al.account_id, allowanceId: al.id, runOn, amount: toStr(al.amount_cents), ...(reason ? { reason } : {}) });
      out.push({ allowanceId: al.id, runOn, status, reason });
      runOn = await nextDate(c, runOn, al.cadence);
    }
    await c.query('UPDATE allowances SET next_run_on = $2 WHERE id = $1', [al.id, runOn]);
  }
  return out;
}
