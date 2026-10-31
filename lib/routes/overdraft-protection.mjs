// Overdraft protection: a savings or money-market backup account linked to a checking account, and a courtesy line.
// When a covered debit (card, internal transfer, bill pay, ACH out, wire) is more than the checking balance, money moves
// in first, in the same transaction: from the backup account (the shortfall rounded up to $10), or else the exact
// shortfall advanced from the courtesy line. Deposits into the checking account repay the line, fees first.
// money-movement.mjs and cards.mjs call coverDebit(), lockForTransfer() and repayDeposit() at their money checks.
// Lock order, so debits, deposits and backup withdrawals never wait on each other in a circle: the protected checking
// account row, then its protection row, then the backup account row, then system accounts (through post()).
// Simulated: no real money moves.
import { createHash } from 'node:crypto';
import { AppError } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { usd } from '../money.mjs';
import { clock, bankToday } from '../bank-date.mjs';

const FEATURE = 'overdraft-protection';
const OWNERS = ['owner', 'joint_owner'];
const BACKUP_KINDS = ['savings', 'money_market'];
// Fixed values of the product requirements (Overdraft Protection PRD §5.1).
export const STEP = 1000n;                      // a protection transfer is the shortfall rounded up to the next $10.00
export const FREE_TRANSFERS = 3, TRANSFER_FEE = 1200n;          // per checking account per month; then $12.00 each
export const BACKUP_WITHDRAWALS = 6;            // a backup account with 6 withdrawals this month isn't used until next month
export const MAX_LINE = 100000n, LINE_FEE = 1500n;              // courtesy line: up to $1,000.00; $15.00 a use
export const LINE_FEES_PER_DAY = 3, LINE_FEES_PER_MONTH = 10000n;
export const COVERED = ['card', 'internal', 'billpay', 'ach', 'wire'];

// ---------- small helpers ----------
const label = a => `${a.name} ··${a.number_last4}`;
const lock = (c, s) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s]);
const min = (x, y) => (x < y ? x : y);
const up = s => ((s + STEP - 1n) / STEP) * STEP;
const cents = v => (v == null ? null : Number(v));                  // JSON integers out (amounts here are far below 2^53)
const sha = s => createHash('sha256').update(s).digest('hex');
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);
/** [first day of this month, first day of next month] for a bank date. */
function monthOf(d) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  return [`${d.slice(0, 7)}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`];
}
function readLimit(v, { required = false } = {}) {
  if (v == null && !required) return 0n;
  if (!isInt(v) || v < 0 || v > Number(MAX_LINE) || v % Number(STEP) !== 0)
    throw new AppError(400, 'bad_limit', `Choose a courtesy line limit from $0.00 to ${usd(MAX_LINE)}, in steps of ${usd(STEP)}.`);
  return BigInt(v);
}
const noProtection = () => new AppError(404, 'not_found', 'This account has no overdraft protection.');

/** The month and day figures of a protection (PRD §5.2), counted from events, including those of earlier links. */
async function figures(c, p, t = bankToday()) {
  const [from, to] = monthOf(t);
  const r = (await c.query(`SELECT
      (SELECT count(*) FROM overdraft_protection_events WHERE account_id = $1 AND type = 'sweep' AND on_date >= $2 AND on_date < $3)::int AS transfers,
      (SELECT count(*) FROM overdraft_protection_events WHERE account_id = $1 AND type = 'line_draw' AND fee_cents > 0 AND on_date = $4)::int AS fees_today,
      (SELECT coalesce(sum(fee_cents), 0) FROM overdraft_protection_events WHERE account_id = $1 AND type = 'line_draw' AND on_date >= $2 AND on_date < $3)::bigint AS fees_month,
      (SELECT count(DISTINCT entry_id) FROM ledger_lines WHERE account_id = $5 AND amount_cents < 0 AND posted_on >= $2 AND posted_on < $3)::int AS withdrawals`,
  [p.account_id, from, to, t, p.backup_account_id])).rows[0];
  return { transfers: r.transfers, feesToday: r.fees_today, feesMonth: BigInt(r.fees_month), withdrawals: r.withdrawals };
}
async function view(c, p) {
  if (!p) return null;
  const f = await figures(c, p);
  return { accountId: p.account_id, backupAccountId: p.backup_account_id, courtesyLimitCents: cents(p.courtesy_limit_cents),
    lineUsedCents: cents(p.line_used_cents), feesOwedCents: cents(p.fees_owed_cents),
    lineAvailableCents: cents(BigInt(p.courtesy_limit_cents) - BigInt(p.line_used_cents)),
    transfersThisMonth: f.transfers, freeTransfersLeft: Math.max(0, FREE_TRANSFERS - f.transfers), backupWithdrawalsThisMonth: f.withdrawals,
    lineFeesToday: f.feesToday, lineFeesThisMonthCents: cents(f.feesMonth), linkedBy: p.linked_by, createdAt: p.created_at };
}
const eventView = e => ({ id: e.id, type: e.type, accountId: e.account_id, date: e.on_date, createdAt: e.created_at, actorId: e.actor_id, rail: e.rail,
  shortfallCents: cents(e.shortfall_cents), amountCents: cents(e.amount_cents), feeCents: cents(e.fee_cents),
  feesRepaidCents: cents(e.fees_repaid_cents), principalRepaidCents: cents(e.principal_repaid_cents),
  backupAccountId: e.backup_account_id, entryId: e.entry_id });

/** Owners of the backup account who are not owners of the checking account (PRD R6). */
const notShared = async (c, checkingId, backupId) => (await c.query(`SELECT count(*)::int n FROM account_owners b WHERE b.account_id = $2 AND b.role = ANY($3)
    AND NOT EXISTS (SELECT 1 FROM account_owners k WHERE k.account_id = $1 AND k.user_id = b.user_id AND k.role = ANY($3))`, [checkingId, backupId, OWNERS])).rows[0].n;

async function addEvent(c, e) {
  const row = { id: newId(), on_date: bankToday(), created_at: clock.now(), fee_cents: 0n, fees_repaid_cents: 0n, principal_repaid_cents: 0n,
    shortfall_cents: null, backup_account_id: null, ...e };
  const cols = Object.keys(row);
  return (await c.query(`INSERT INTO overdraft_protection_events (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`,
    Object.values(row))).rows[0];
}
async function notifyOwners(c, accountId, ref, title, body) {
  await c.query(`INSERT INTO notifications (user_id, kind, ref, title, body)
    SELECT user_id, 'overdraft_protection', $2, $3, $4 FROM account_owners WHERE account_id = $1 AND role = ANY($5) ON CONFLICT (user_id, ref) DO NOTHING`,
  [accountId, ref, title, body, OWNERS]);
}

// ---------- covering a debit ----------
/**
 * Called where a covered route checks the money, before it refuses. When `a` is a protected checking account and `total`
 * is more than its balance, moves the shortfall in (backup account first, else the courtesy line). Leaves a.balance_cents
 * at the balance the debit now sees, so the route's own check passes, or refuses exactly as before.
 * `to`: an internal transfer's destination (a transfer to the account's own backup account is not covered).
 */
export async function coverDebit(c, req, user, a, total, rail, { to = null } = {}) {
  if (a.kind !== 'checking' || !COVERED.includes(rail)) return;
  if (!(await c.query('SELECT 1 FROM overdraft_protections WHERE account_id = $1', [a.id])).rowCount) return;
  const balance = BigInt((await c.query('SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE', [a.id])).rows[0].balance_cents);
  a.balance_cents = balance;                             // what earlier debits (by any owner) left, not what was read before the lock
  if (total <= balance) return;
  const p = (await c.query('SELECT * FROM overdraft_protections WHERE account_id = $1 FOR UPDATE', [a.id])).rows[0];
  if (!p || to === p.backup_account_id) return;
  const S = total - balance, t = bankToday();
  const b = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [p.backup_account_id])).rows[0];
  const f = await figures(c, p, t);                      // after the backup lock: counts every withdrawal made before this one
  let moved = null;
  if (b.status === 'open' && f.withdrawals < BACKUP_WITHDRAWALS && !(await notShared(c, a.id, b.id))) {
    const F = f.transfers >= FREE_TRANSFERS ? TRANSFER_FEE : 0n;
    const A = min(up(S), BigInt(b.balance_cents) - F);
    if (A >= S) moved = await sweep(c, req, user, { a, b, S, A, F, rail, t });
  }
  if (!moved && BigInt(p.courtesy_limit_cents) - BigInt(p.line_used_cents) >= S) moved = await lineDraw(c, req, user, { a, S, f, rail, t });
  if (moved) a.balance_cents = balance + moved;
}

async function sweep(c, req, user, { a, b, S, A, F, rail, t }) {
  const id = newId(), fees = await systemAccount(c, 'od_fees');
  const { entryId } = await post(c, { key: `${a.id}:${FEATURE}:${id}`, kind: 'od_sweep', memo: 'Overdraft protection', createdBy: user.id, lines: [
    { accountId: b.id, amountCents: -A, description: `Overdraft protection transfer to ${label(a)}`, category: 'Transfers', postedOn: t },
    { accountId: a.id, amountCents: A, description: `Overdraft protection transfer from ${label(b)}`, category: 'Transfers', postedOn: t },
    ...(F > 0n ? [
      { accountId: b.id, amountCents: -F, description: 'Overdraft protection transfer fee', category: 'Fees & Charges', postedOn: t },
      { accountId: fees, amountCents: F, description: 'Overdraft protection transfer fee', postedOn: t }] : [])] });
  await addEvent(c, { id, type: 'sweep', account_id: a.id, on_date: t, actor_id: user.id, rail, shortfall_cents: S, amount_cents: A, fee_cents: F,
    backup_account_id: b.id, entry_id: entryId });
  await audit(c, req, user.id, 'overdraft_protection.sweep', { account: a.id, event: id, backup: b.id, rail, shortfallCents: cents(S), amountCents: cents(A),
    feeCents: cents(F), entry: entryId });
  await notifyOwners(c, a.id, `${FEATURE}:${id}`, `Overdraft protection transfer: ${usd(A)} from ${label(b)}`,
    `We moved ${usd(A)} from ${label(b)} to ${label(a)} to cover a payment.${F > 0n ? ` A ${usd(F)} transfer fee was taken from ${label(b)}.` : ''}`);
  return A;
}

async function lineDraw(c, req, user, { a, S, f, rail, t }) {
  const G = f.feesToday >= LINE_FEES_PER_DAY ? 0n : min(LINE_FEE, LINE_FEES_PER_MONTH - f.feesMonth > 0n ? LINE_FEES_PER_MONTH - f.feesMonth : 0n);
  const id = newId(), line = await systemAccount(c, 'od_courtesy_line');
  const { entryId } = await post(c, { key: `${a.id}:${FEATURE}:${id}`, kind: 'od_line_draw', memo: 'Courtesy overdraft line', createdBy: user.id, lines: [
    { accountId: line, amountCents: -S, description: 'Courtesy overdraft line advance', postedOn: t },
    { accountId: a.id, amountCents: S, description: 'Courtesy overdraft line advance', category: 'Transfers', postedOn: t },
    ...(G > 0n ? [
      { accountId: line, amountCents: -G, description: 'Courtesy overdraft fee', postedOn: t },
      { accountId: await systemAccount(c, 'od_fees'), amountCents: G, description: 'Courtesy overdraft fee', postedOn: t }] : [])] });
  await c.query('UPDATE overdraft_protections SET line_used_cents = line_used_cents + $2, fees_owed_cents = fees_owed_cents + $3 WHERE account_id = $1', [a.id, S, G]);
  await addEvent(c, { id, type: 'line_draw', account_id: a.id, on_date: t, actor_id: user.id, rail, shortfall_cents: S, amount_cents: S, fee_cents: G, entry_id: entryId });
  await audit(c, req, user.id, 'overdraft_protection.line_draw', { account: a.id, event: id, rail, shortfallCents: cents(S), amountCents: cents(S), feeCents: cents(G), entry: entryId });
  await notifyOwners(c, a.id, `${FEATURE}:${id}`, `Courtesy overdraft line used: ${usd(S)}`,
    `We advanced ${usd(S)} from your courtesy overdraft line to ${label(a)} to cover a payment.${G > 0n ? ` A ${usd(G)} fee was added to what you owe on the line.` : ''} Deposits into ${label(a)} repay it.`);
  return S;
}

// ---------- repaying the courtesy line ----------
async function repay(c, req, user, p, R, rail) {
  const feesRepaid = min(R, BigInt(p.fees_owed_cents)), principal = R - feesRepaid, id = newId(), t = bankToday();
  const { entryId } = await post(c, { key: `${p.account_id}:${FEATURE}:${id}`, kind: 'od_repayment', memo: 'Courtesy overdraft line repayment', createdBy: user.id, lines: [
    { accountId: p.account_id, amountCents: -R, description: 'Courtesy overdraft line repayment', category: 'Transfers', postedOn: t },
    { accountId: await systemAccount(c, 'od_courtesy_line'), amountCents: R, description: 'Courtesy overdraft line repayment', postedOn: t }] });
  await c.query('UPDATE overdraft_protections SET fees_owed_cents = fees_owed_cents - $2, line_used_cents = line_used_cents - $3 WHERE account_id = $1',
    [p.account_id, feesRepaid, principal]);
  const e = await addEvent(c, { id, type: 'repayment', account_id: p.account_id, on_date: t, actor_id: user.id, rail, amount_cents: R,
    fees_repaid_cents: feesRepaid, principal_repaid_cents: principal, entry_id: entryId });
  await audit(c, req, user.id, 'overdraft_protection.repayment', { account: p.account_id, event: id, rail, amountCents: cents(R),
    feesRepaidCents: cents(feesRepaid), principalRepaidCents: cents(principal), entry: entryId });
  return e;
}

/** Called right after a deposit (internal transfer in, ACH pull settled) credits `accountId`: repays what the line is owed. */
export async function repayDeposit(c, req, user, accountId, amount, rail) {
  const p = (await c.query('SELECT * FROM overdraft_protections WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0];
  const owed = p ? BigInt(p.fees_owed_cents) + BigInt(p.line_used_cents) : 0n;
  if (owed > 0n) await repay(c, req, user, p, min(BigInt(amount), owed), rail);
}

/** Before a transfer touches a protected checking account: locks it first (then the other accounts), in the order coverDebit uses. */
export async function lockForTransfer(c, ids) {
  const prot = (await c.query('SELECT account_id FROM overdraft_protections WHERE account_id = ANY($1::uuid[])', [ids])).rows.map(r => r.account_id).sort();
  if (!prot.length) return;
  for (const id of [...prot, ...ids.filter(x => !prot.includes(x)).sort()]) await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [id]);
}

// ---------- request ids (link and repay) ----------
// Per user, across sessions: `<userId>:overdraft-protection:<id>`. The fingerprint is the action, the path ids and the body.
async function previous(c, key, fingerprint) {
  await lock(c, `${FEATURE}:${key}`);                    // identical requests at the same moment: the second waits and replays
  const r = (await c.query('SELECT * FROM overdraft_protection_requests WHERE key = $1', [key])).rows[0];
  if (r && r.fingerprint !== fingerprint) throw conflict();
  return r ?? null;
}
const remember = (c, row) => c.query('INSERT INTO overdraft_protection_requests (key, fingerprint, protection_id, account_id, event_id) VALUES ($1,$2,$3,$4,$5)',
  [row.key, row.fingerprint, row.protectionId ?? null, row.accountId, row.eventId ?? null]);

/** One of the caller's own checking accounts with a protection, or a 404. */
async function protectionFor(c, u, accountId, { forUpdate = false } = {}) {
  const a = await accountFor(c, u.id, accountId, OWNERS).catch(() => { throw noProtection(); });
  const p = (await c.query(`SELECT * FROM overdraft_protections WHERE account_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [a.id])).rows[0];
  if (!p) throw noProtection();
  return { a, p };
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body }) => tx(pool, async c => fn(c, req, await requireUser(c, req), body, params));

  r.add('POST', '/api/overdraft-protection', h(async (c, req, u, body, params) => {
    const key = `${u.id}:${FEATURE}:${requestKey(body)}`, fingerprint = sha(`link\0${fingerprintOf(params, body)}`);
    const prev = await previous(c, key, fingerprint);
    if (prev) return { protection: await view(c, (await c.query('SELECT * FROM overdraft_protections WHERE id = $1', [prev.protection_id])).rows[0]), replayed: true };
    if (typeof body.accountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the checking account to protect.');
    if (typeof body.backupAccountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the savings or money market account to use as backup.');
    const limit = readLimit(body.courtesyLimitCents);
    const chk = await accountFor(c, u.id, body.accountId, OWNERS);
    if (chk.kind !== 'checking') throw new AppError(400, 'bad_account', 'Overdraft protection is for checking accounts.');
    if (chk.status !== 'open') throw new AppError(409, 'account_not_open', `${label(chk)} isn't open.`);
    const bak = await accountFor(c, u.id, body.backupAccountId, OWNERS);
    if (!BACKUP_KINDS.includes(bak.kind)) throw new AppError(400, 'bad_account', 'The backup account must be a savings or money market account.');
    if (bak.status !== 'open') throw new AppError(409, 'account_not_open', `${label(bak)} isn't open.`);
    if (await notShared(c, chk.id, bak.id))
      throw new AppError(422, 'backup_not_shared', `Everyone who owns ${label(bak)} must also own ${label(chk)}. Choose another backup account.`);
    requireStepUp(u);
    const id = newId();
    const ins = await c.query(`INSERT INTO overdraft_protections (account_id, id, backup_account_id, courtesy_limit_cents, linked_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO NOTHING RETURNING *`, [chk.id, id, bak.id, limit, u.id, clock.now()]);
    if (!ins.rowCount) throw new AppError(409, 'already_linked', `${label(chk)} already has overdraft protection. Unlink it first to choose another backup account.`);
    await remember(c, { key, fingerprint, protectionId: id, accountId: chk.id });
    await audit(c, req, u.id, 'overdraft_protection.link', { account: chk.id, backup: bak.id, courtesyLimitCents: cents(limit) });
    return { protection: await view(c, ins.rows[0]), replayed: false };
  }));

  r.add('GET', '/api/overdraft-protection', h(async (c, req, u) => {
    const rows = (await c.query(`SELECT p.* FROM overdraft_protections p JOIN account_owners o ON o.account_id = p.account_id
      WHERE o.user_id = $1 AND o.role = ANY($2) ORDER BY p.created_at DESC, p.account_id`, [u.id, OWNERS])).rows;
    const protections = []; for (const p of rows) protections.push(await view(c, p));
    return { protections };
  }));

  r.add('GET', '/api/overdraft-protection/:accountId', h(async (c, req, u, body, { accountId }) => {
    const { p } = await protectionFor(c, u, accountId);
    const events = (await c.query('SELECT * FROM overdraft_protection_events WHERE account_id = $1 ORDER BY seq', [p.account_id])).rows;
    return { protection: await view(c, p), events: events.map(eventView) };
  }));

  r.add('PUT', '/api/overdraft-protection/:accountId/line', h(async (c, req, u, body, { accountId }) => {
    const { p } = await protectionFor(c, u, accountId, { forUpdate: true });
    const limit = readLimit(body.courtesyLimitCents, { required: true }), from = BigInt(p.courtesy_limit_cents);
    if (limit > from) requireStepUp(u);                  // raising a limit is a risky action; keeping or lowering it is not
    if (limit < BigInt(p.line_used_cents))
      throw new AppError(409, 'line_in_use', `You're using ${usd(BigInt(p.line_used_cents))} of the courtesy line. Repay it before setting the limit below that.`);
    if (limit !== from) {
      await c.query('UPDATE overdraft_protections SET courtesy_limit_cents = $2 WHERE account_id = $1', [p.account_id, limit]);
      await audit(c, req, u.id, 'overdraft_protection.line_change', { account: p.account_id, from: cents(from), to: cents(limit) });
    }
    return { protection: await view(c, (await c.query('SELECT * FROM overdraft_protections WHERE account_id = $1', [p.account_id])).rows[0]) };
  }));

  r.add('DELETE', '/api/overdraft-protection/:accountId', h(async (c, req, u, body, { accountId }) => {
    const { p } = await protectionFor(c, u, accountId, { forUpdate: true });
    const owed = BigInt(p.fees_owed_cents) + BigInt(p.line_used_cents);
    if (owed > 0n) throw new AppError(409, 'balance_owed', `${usd(owed)} is still owed on the courtesy line. Repay it before turning off overdraft protection.`);
    await c.query('DELETE FROM overdraft_protections WHERE account_id = $1', [p.account_id]);
    await audit(c, req, u.id, 'overdraft_protection.unlink', { account: p.account_id, backup: p.backup_account_id });
    return { accountId: p.account_id, removed: true };
  }));

  r.add('POST', '/api/overdraft-protection/:accountId/repay', h(async (c, req, u, body, params) => {
    const { a } = await protectionFor(c, u, params.accountId);
    const key = `${u.id}:${FEATURE}:${requestKey(body)}`, fingerprint = sha(`repay\0${fingerprintOf(params, body)}`);
    const prev = await previous(c, key, fingerprint);
    const current = async () => view(c, (await c.query('SELECT * FROM overdraft_protections WHERE account_id = $1', [a.id])).rows[0]);
    if (prev) return { repayment: eventView((await c.query('SELECT * FROM overdraft_protection_events WHERE id = $1', [prev.event_id])).rows[0]),
      protection: await current(), replayed: true };
    const want = body.amountCents ?? null;
    if (want !== null && (!isInt(want) || want < 1)) throw new AppError(400, 'bad_amount', 'Enter the amount to repay in cents, at least 1.');
    const acct = (await c.query('SELECT balance_cents, status FROM accounts WHERE id = $1 FOR UPDATE', [a.id])).rows[0];
    const p = (await c.query('SELECT * FROM overdraft_protections WHERE account_id = $1 FOR UPDATE', [a.id])).rows[0];
    if (!p) throw noProtection();                         // unlinked while this request waited
    if (acct.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open.`);
    const owed = BigInt(p.fees_owed_cents) + BigInt(p.line_used_cents);
    if (owed === 0n) throw new AppError(409, 'nothing_owed', 'Nothing is owed on the courtesy line.');
    if (want !== null && BigInt(want) > owed) throw new AppError(422, 'more_than_owed', `Only ${usd(owed)} is owed on the courtesy line.`);
    const amount = want === null ? owed : BigInt(want);
    if (BigInt(acct.balance_cents) < amount)
      throw new AppError(409, 'insufficient_funds', `${label(a)} has ${usd(BigInt(acct.balance_cents))}, which isn't enough to repay ${usd(amount)}.`);
    const e = await repay(c, req, u, p, amount, 'manual');
    await remember(c, { key, fingerprint, accountId: a.id, eventId: e.id });
    return { repayment: eventView(e), protection: await current(), replayed: false };
  }));
}
