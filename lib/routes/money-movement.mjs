// M4 money movement: transfers between your accounts (now, scheduled, recurring), external accounts + ACH, USA Pay,
// domestic wires and bill pay. Money moves only through post(); every send has an idempotency key, a limit check,
// an overdraft check and an audit row. Scheduled and settling items run when due: on any read of /api/pay or POST /api/pay/run-due.
// Simulated: no real ACH, wire, bill payment or USA Pay network is involved.
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError, refuse } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor, VIEW, MOVE_MONEY } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { parseAmount, toStr } from '../money.mjs';
import { ageOf } from './accounts.mjs';
import { clock, today, addDays, addMonth, addBusinessDays, processingDay } from '../money-movement/calendar.mjs';
import { seal, routing, accountNumber } from '../money-movement/vault.mjs';
import { RAILS, checkLimit, limitsFor, limitView, usd, stepUpFor, useLimit, releaseLimit, setUserLimit } from '../money-movement/limits.mjs';
import { checkCustodianMove } from '../controls.mjs';
import { isDate } from '../dates.mjs';
import { bankDateOf } from '../bank-date.mjs';
import { lockHolds, availableOf } from '../wire-screening/holds.mjs';

const FEATURE = 'money-movement';
const DEPOSIT = ['checking', 'savings', 'money_market', 'teen_checking', 'custodial_savings'];
const FUND = ['owner', 'joint_owner'];                  // money leaving the bank comes only from accounts you own (not a minor's)
export const WIRE_FEE = 2500n;                          // $25 outgoing domestic wire (RESEARCH.md §2.3: industry-typical ~$30; demo value $25)
const COUNTED = ['completed', 'pending', 'processing', 'scheduled', 'sent', 'settled', 'paid'];   // statuses that use up a limit
export const ACH_DAYS = { out: 1, in: 3 };              // business days to settle after processing (RESEARCH.md §2.2: standard 1–3)
export const HOLD_DAYS = 3;                             // a newly verified external account can't receive outgoing ACH for 3 days
export const LINK_DAYS = 15, MD_TRIES = 3;              // micro-deposits: 15 calendar days and 3 tries (RESEARCH.md §2.2)
export const P2P_EXPIRY_DAYS = 14;                      // USA Pay to someone not enrolled: refunded after 14 days (RESEARCH.md §2.4)
// Enrolling an email or phone proves it first: a 6-digit code sent to it (simulated), 10 minutes, 5 tries (like sign-in codes).
export const ENROLL_CODE_MINUTES = 10, ENROLL_CODE_TRIES = 5;
// Across codes, in any rolling 24 hours (a new code never resets them): at most 5 codes asked for per customer, and at most
// 10 wrong codes per customer and 10 per email or phone (whoever enters them). 10 guesses at a 6-digit code a day is a
// 1-in-100,000 chance. Demo values, like the 5-a-day lookup throttle (RESEARCH.md §1 (d) asks for an abuse throttle).
export const ENROLL_CODES_PER_DAY = 5, ENROLL_WRONG_PER_DAY = 10;
export const BILL_DAYS = 2;                             // electronic bill payment delivery: ~1–2 business days (RESEARCH.md §2.5)
const RETURNS = { '0001': ['R01', 'Returned by the other bank: insufficient funds (R01).'], '0003': ['R03', 'Returned by the other bank: no account found (R03).'] };
const MINOR_MSG = "Teens can't move money out of their account in the app yet. Ask your parent or guardian to move it for you.";
const P2P_WARNING = 'Only send money to people you know and trust. USA Pay payments to an enrolled person are instant and can’t be canceled.';
const WIRE_WARNING = 'Wires are irrevocable: once sent, the money can’t be recalled or canceled. Check the name, routing and account number carefully.';
const revealDemo = () => process.env.DEMO_REVEAL_CODES !== '0';
// Simulated instant verification: a mock sign-in to one of these fictional banks. The demo sign-in is user_good / pass_good.
export const INSTANT_BANKS = { lakeside: ['Lakeside Credit Union', '123456780'], prairie: ['Prairie National Bank', '111111118'], summit: ['Summit Savings Bank', '222222226'] };
export const INSTANT_DEMO = { username: 'user_good', password: 'pass_good' };

// ---------- small helpers ----------
const now = () => clock.now();
const label = a => `${a.name} ··${a.number_last4}`;
const lock = (c, s) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s]);
const keyOf = (user, body) => `${user.id}:${FEATURE}:${requestKey(body)}`;
const text = (v, max = 140) => { const s = String(v ?? '').trim().replace(/\s+/g, ' '); return s ? s.slice(0, max) : null; };
function dateIn(v, { min, max }) {
  const d = String(v ?? '');
  if (!isDate(d)) throw new AppError(400, 'bad_date', 'Choose a date.');
  if (d < min || d > max) throw new AppError(400, 'bad_date', `Choose a date from ${min} to ${max}.`);
  return d;
}
const isMinorUser = u => !!u.dateOfBirth && ageOf(u.dateOfBirth) < 18;

/** An account the user can move money out of. Not theirs: 404. A minor's own account: refused in plain words. */
async function source(c, req, user, id, roles = MOVE_MONEY) {
  const a = await accountFor(c, user.id, id, VIEW);
  if (a.role === 'minor') { await audit(c, req, user.id, 'transfer.refused', { reason: 'minor', account: a.number_last4 }); throw refuse(403, 'minor_not_allowed', MINOR_MSG); }
  if (a.role === 'custodian' && !roles.includes('custodian')) throw new AppError(403, 'not_allowed', `Money in ${label(a)} can only move to and from your own accounts at USA Banc.`);
  if (!roles.includes(a.role)) throw new AppError(404, 'not_found', 'Account not found.');
  if (!DEPOSIT.includes(a.kind)) throw new AppError(400, 'bad_account', 'Choose a checking or savings account to send from.');
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open for transfers.`);
  return a;
}
async function target(c, user, id) {
  const a = await accountFor(c, user.id, id, MOVE_MONEY);
  if (![...DEPOSIT, 'credit_card'].includes(a.kind)) throw new AppError(400, 'bad_account', 'Choose a checking, savings or card account to send to.');
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open for transfers.`);
  return a;
}
/** Refuses (and audits) a send the account can't cover. Cards and system accounts may go negative. Money held by a waiting wire (lib/wire-screening/holds.mjs) can't be spent. */
async function enough(c, req, user, a, cents, rail) {
  if (a.allow_negative) return;
  await lockHolds(c, a.id);
  const { held, available } = await availableOf(c, a.id);
  if (available >= cents) return;
  await audit(c, req, user.id, 'transfer.refused', { rail, reason: 'insufficient_funds', account: a.number_last4, amount: toStr(cents), held: held ? toStr(held) : undefined });
  const has = held ? `${usd(available)} available (${usd(held)} is held for a wire that is waiting)` : usd(available);
  throw refuse(409, 'insufficient_funds', `${label(a)} has ${has}, which isn't enough for this. Choose a smaller amount or another account.`);
}
async function ledger(c, req, user, args) {
  try { return await post(c, { createdBy: user?.id ?? null, ...args }); }
  catch (e) {
    if (e.code !== 'insufficient_funds') throw e;
    await audit(c, req, user?.id ?? null, 'transfer.refused', { reason: 'insufficient_funds', kind: args.kind });
    throw refuse(409, 'insufficient_funds', "There isn't enough money in that account. Choose a smaller amount or another account.");
  }
}
async function record(c, t) {
  const cols = Object.keys(t), at = now();
  const r = await c.query(`INSERT INTO transfers (id, ${cols.join(', ')}, created_at, updated_at) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, $${cols.length + 2}, $${cols.length + 2}) RETURNING *`,
    [newId(), ...Object.values(t), at]);
  const row = r.rows[0];
  if (COUNTED.includes(row.status)) await useLimit(c, row);
  return row;
}
const setStatus = (c, id, fields) => c.query(`UPDATE transfers SET ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${Object.keys(fields).length + 2} WHERE id = $1`,
  [id, ...Object.values(fields), now()]);
async function replay(c, key) {
  const t = (await c.query('SELECT * FROM transfers WHERE idempotency_key = $1', [key])).rows[0];
  return t ? { transfer: view(t), replayed: true } : null;
}

/** What can still happen to a transfer: cancel (ACH before its cut-off, a wire not yet sent) or finish it early (simulated). */
const canCancel = t => (t.rail === 'ach' && t.status === 'pending') || (t.rail === 'wire' && t.status === 'scheduled');
const inFlight = t => (t.rail === 'ach' && ['pending', 'processing'].includes(t.status)) || (t.rail === 'wire' && t.status === 'scheduled') || (t.rail === 'billpay' && t.status === 'sent');
const view = t => ({ id: t.id, rail: t.rail, direction: t.direction, status: t.status, amount: toStr(t.amount_cents), fee: toStr(t.fee_cents),
  counterparty: t.counterparty, memo: t.memo, processOn: t.process_on, settlesOn: t.settles_on, returnCode: t.return_code, note: t.note,
  settledAt: t.settled_at ?? null, simulated: !!t.simulated, canCancel: canCancel(t), canSimulate: inFlight(t),
  from: t.from_name ? `${t.from_name} ··${t.from_last4}` : null, to: t.to_name ? `${t.to_name} ··${t.to_last4}` : null, createdAt: t.created_at });
const extView = e => ({ id: e.id, nickname: e.nickname, kind: e.kind, routing: e.routing_number, last4: e.number_last4, status: e.status, triesLeft: e.tries_left,
  method: e.method, institution: e.institution,
  verifiedAt: e.verified_at, removeBy: e.status === 'pending' ? addDays(bankDateOf(e.created_at), LINK_DAYS) : null,
  holdUntil: e.verified_at ? new Date(e.verified_at.getTime() + HOLD_DAYS * 86400_000).toISOString() : null,
  onHold: !!e.verified_at && now() < new Date(e.verified_at.getTime() + HOLD_DAYS * 86400_000) });
const payeeView = p => ({ id: p.id, name: p.name, address: p.address, accountLast4: p.account_last4 });
const schedView = s => ({ id: s.id, rail: s.rail, cadence: s.cadence, amount: toStr(s.amount_cents), nextRun: s.next_run, status: s.status, memo: s.memo,
  from: `${s.from_name} ··${s.from_last4}`, to: s.payee_name ?? `${s.to_name} ··${s.to_last4}` });

// ---------- USA Pay tokens ----------
/** An email (lowercased) or a US phone (10 digits). */
export function token(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(s) && s.length <= 254) return s;
  let d = s.replace(/[\s().+-]/g, '');
  if (/^1\d{10}$/.test(d)) d = d.slice(1);
  if (/^\d{10}$/.test(d)) return d;
  throw new AppError(400, 'bad_recipient', 'Enter an email address or a 10-digit US mobile number.');
}
const showToken = t => (/^\d{10}$/.test(t) ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : t);
/** The enrollment that routes money for a token: only one proven with a code (rows from the old no-code path don't count). */
const enrolled = async (c, t) => (await c.query(`SELECT e.*, u.display_name FROM p2p_enrollments e JOIN users u ON u.id = e.user_id
  WHERE e.token = $1 AND e.verified_at IS NOT NULL`, [t])).rows[0];

// ---------- the work done when things come due ----------
/** Runs this user's due schedules, settles or returns ACH, sends next-day wires, expires USA Pay and removes stale links. */
export async function runDue(c, req, user) {
  const t = today(), at = now(), out = { ran: 0 };
  await lock(c, `mm:${user.id}`);
  const due = (await c.query(`SELECT * FROM scheduled_transfers WHERE user_id = $1 AND status = 'active' AND next_run <= $2 ORDER BY next_run FOR UPDATE`, [user.id, t])).rows;
  for (const s of due) {
    for (let n = 0; s.status === 'active' && s.next_run <= t && n < 60; n++) {
      await runSchedule(c, req, user, s); out.ran++;
      if (s.cadence === 'once') s.status = 'done';
      else s.next_run = s.cadence === 'weekly' ? addDays(s.next_run, 7) : addMonth(s.next_run, s.anchor_day);
    }
    await c.query('UPDATE scheduled_transfers SET next_run = $2, status = $3 WHERE id = $1', [s.id, s.next_run, s.status]);
  }
  // ACH: once its cut-off has passed it can't be canceled (processing); on its settlement day it settles or comes back
  for (const x of (await c.query(`UPDATE transfers SET status = 'processing', updated_at = $3 WHERE user_id = $1 AND rail = 'ach' AND status = 'pending'
      AND process_on < $2 RETURNING id`, [user.id, processingDay('ach'), at])).rows)
    await audit(c, req, user.id, 'ach.processing', { transfer: x.id });
  for (const x of (await c.query(`SELECT * FROM transfers WHERE user_id = $1 AND rail = 'ach' AND status IN ('pending', 'processing') AND settles_on <= $2 FOR UPDATE`, [user.id, t])).rows)
    await settleAch(c, req, user, x);
  // wires held for the next business day after the cut-off go out (and can't be recalled after that)
  for (const w of (await c.query(`SELECT * FROM transfers WHERE user_id = $1 AND rail = 'wire' AND status = 'scheduled' AND process_on <= $2 FOR UPDATE`, [user.id, t])).rows)
    await sendWire(c, req, user, w);
  // bill payments are paid on their deliver-by day
  for (const b of (await c.query(`SELECT * FROM transfers WHERE user_id = $1 AND rail = 'billpay' AND status = 'sent' AND settles_on <= $2 FOR UPDATE`, [user.id, t])).rows)
    await payBill(c, req, user, b);
  // USA Pay sent to someone who never enrolled: refunded after 14 days
  for (const p of (await c.query(`SELECT * FROM transfers WHERE user_id = $1 AND rail = 'p2p' AND status = 'pending' AND settles_on <= $2 FOR UPDATE`, [user.id, t])).rows) {
    const r = await post(c, { key: `${p.idempotency_key}:expire`, kind: 'p2p_refund', createdBy: user.id, lines: [
      { accountId: p.from_account_id, amountCents: p.amount_cents, description: `USA Pay refund: ${p.counterparty} didn't enroll in ${P2P_EXPIRY_DAYS} days`, category: 'Transfers', postedOn: t },
      { accountId: await systemAccount(c, 'p2p_unclaimed'), amountCents: -p.amount_cents, description: 'USA Pay unclaimed refund', postedOn: t }] });
    await setStatus(c, p.id, { status: 'expired', reversal_entry_id: r.entryId, settled_at: at, note: `Not claimed in ${P2P_EXPIRY_DAYS} days, so the money came back.` });
    await releaseLimit(c, p, 'expired');
    await audit(c, req, user.id, 'p2p.expired', { transfer: p.id, amount: toStr(p.amount_cents) });
  }
  // links never verified within 15 days are removed
  for (const e of (await c.query(`UPDATE external_accounts SET status = 'removed', removed_at = $2, removed_reason = 'not verified in time'
      WHERE user_id = $1 AND status = 'pending' AND created_at <= $2::timestamptz - make_interval(days => $3) RETURNING id, number_last4`, [user.id, at, LINK_DAYS])).rows)
    await audit(c, req, user.id, 'ach.link_removed', { external_account: e.id, last4: e.number_last4, reason: 'expired' });
  return out;
}

// ---------- settlement (on the due day, or now with "Simulate settlement") ----------
/** ACH settles, or (simulated by the external account's last 4: 0001 = R01, 0003 = R03) comes back. */
async function settleAch(c, req, user, x, { simulated = false } = {}) {
  const t = today(), at = now();
  const ext = (await c.query('SELECT number_last4 FROM external_accounts WHERE id = $1', [x.external_account_id])).rows[0];
  const ret = RETURNS[ext?.number_last4];
  const acct = x.direction === 'out' ? x.from_account_id : x.to_account_id;
  const how = { settled_at: at, simulated };
  if (ret && x.direction === 'out') {        // the money comes back: a new entry reverses the first one (lines are never edited)
    const r = await post(c, { key: `${x.idempotency_key}:return`, kind: 'ach_return', createdBy: user.id, lines: [
      { accountId: await systemAccount(c, 'mm_ach_out'), amountCents: -x.amount_cents, description: `ACH return ${ret[0]}`, postedOn: t },
      { accountId: acct, amountCents: x.amount_cents, description: `ACH return ${ret[0]}: ${x.counterparty}`, category: 'Transfers', postedOn: t }] });
    await setStatus(c, x.id, { status: 'returned', return_code: ret[0], note: ret[1], reversal_entry_id: r.entryId, ...how });
  } else if (ret) {                          // a pull that bounces never credits us
    await setStatus(c, x.id, { status: 'returned', return_code: ret[0], note: ret[1], ...how });
  } else if (x.direction === 'out') {        // in transit -> the (simulated) network
    await post(c, { key: `${x.idempotency_key}:settle`, kind: 'ach_settle', createdBy: user.id, lines: [
      { accountId: await systemAccount(c, 'mm_ach_out'), amountCents: -x.amount_cents, description: `ACH out settled: ${x.counterparty}`, postedOn: t },
      { accountId: await systemAccount(c, 'mm_network'), amountCents: x.amount_cents, description: `ACH out settled: ${x.counterparty}`, postedOn: t }] });
    await setStatus(c, x.id, { status: 'settled', ...how });
  } else {                                   // a pull: credited when it settles
    const e = await post(c, { key: `${x.idempotency_key}:settle`, kind: 'ach_in', createdBy: user.id, lines: [
      { accountId: await systemAccount(c, 'mm_ach_in'), amountCents: -x.amount_cents, description: `ACH in: ${x.counterparty}`, postedOn: t },
      { accountId: acct, amountCents: x.amount_cents, description: `ACH transfer from ${x.counterparty}`, category: 'Transfers', postedOn: t }] });
    await setStatus(c, x.id, { status: 'settled', entry_id: e.entryId, ...how });
  }
  if (ret) await releaseLimit(c, x, 'returned');
  await audit(c, req, user.id, ret ? 'ach.returned' : 'ach.settled', { transfer: x.id, direction: x.direction, amount: toStr(x.amount_cents), return_code: ret?.[0] ?? null, simulated });
}

/** A wire goes out: from wires in transit to the (simulated) network. From here it is irrevocable. Also used by lib/routes/wire-screening.mjs. */
export async function sendWire(c, req, user, w, { simulated = false } = {}) {
  const t = today();
  await post(c, { key: `${w.idempotency_key}:send`, kind: 'wire_send', createdBy: user.id, lines: [
    { accountId: await systemAccount(c, 'mm_wire_out'), amountCents: -w.amount_cents, description: `Wire sent: ${w.counterparty}`, postedOn: t },
    { accountId: await systemAccount(c, 'mm_network'), amountCents: w.amount_cents, description: `Wire sent: ${w.counterparty}`, postedOn: t }] });
  await setStatus(c, w.id, { status: 'sent', settled_at: now(), simulated });
  await audit(c, req, user.id, 'wire.sent', { transfer: w.id, amount: toStr(w.amount_cents), simulated });
}

/** A bill payment reaches the payee: from bill pay in transit to the (simulated) network. */
async function payBill(c, req, user, b, { simulated = false } = {}) {
  const t = today();
  await post(c, { key: `${b.idempotency_key}:paid`, kind: 'bill_pay_settle', createdBy: user.id, lines: [
    { accountId: await systemAccount(c, 'mm_billpay'), amountCents: -b.amount_cents, description: `Bill paid: ${b.counterparty}`, postedOn: t },
    { accountId: await systemAccount(c, 'mm_network'), amountCents: b.amount_cents, description: `Bill paid: ${b.counterparty}`, postedOn: t }] });
  await setStatus(c, b.id, { status: 'paid', settled_at: now(), simulated });
  await audit(c, req, user.id, 'billpay.paid', { transfer: b.id, amount: toStr(b.amount_cents), simulated });
}

async function runSchedule(c, req, user, s) {
  const key = `${s.idempotency_key}:${s.next_run}`;
  if ((await c.query('SELECT 1 FROM transfers WHERE idempotency_key = $1', [key])).rowCount) return;
  try {
    if (s.rail === 'internal') await internalNow(c, req, user, { fromId: s.from_account_id, toId: s.to_account_id, amount: s.amount_cents, memo: s.memo, key, scheduleId: s.id });
    else await billNow(c, req, user, { fromId: s.from_account_id, payeeId: s.payee_id, amount: s.amount_cents, memo: s.memo, key, scheduleId: s.id });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await record(c, { user_id: user.id, rail: s.rail, from_account_id: s.from_account_id, to_account_id: s.to_account_id, payee_id: s.payee_id, schedule_id: s.id,
      counterparty: s.rail === 'billpay' ? 'Bill payment' : 'Scheduled transfer', amount_cents: s.amount_cents, memo: s.memo, status: 'failed', note: e.message,
      booked_on: today(), idempotency_key: key });
    await audit(c, req, user.id, 'transfer.failed', { schedule: s.id, rail: s.rail, amount: toStr(s.amount_cents), reason: e.code });
  }
}

// ---------- the sends ----------
async function internalNow(c, req, user, { fromId, toId, amount, memo, key, scheduleId = null }) {
  const from = await source(c, req, user, fromId), to = await target(c, user, toId);
  if (from.id === to.id) throw new AppError(400, 'same_account', 'Choose two different accounts.');
  await checkCustodianMove(c, req, user.id, from, to);     // a child's money stays the child's (and not in view-only mode)
  if (to.kind === 'credit_card' && amount > -BigInt(to.balance_cents)) throw new AppError(400, 'over_owed', `You owe ${usd(-BigInt(to.balance_cents))} on ${label(to)}. Pay that much or less.`);
  await checkLimit(c, req, user.id, 'internal', amount);
  await enough(c, req, user, from, amount, 'internal');
  const t = today();
  const e = await ledger(c, req, user, { key, kind: 'transfer', memo, lines: [
    { accountId: from.id, amountCents: -amount, description: `Transfer to ${label(to)}`, category: 'Transfers', postedOn: t },
    { accountId: to.id, amountCents: amount, description: `Transfer from ${label(from)}`, category: 'Transfers', postedOn: t }] });
  const row = await record(c, { user_id: user.id, rail: 'internal', from_account_id: from.id, to_account_id: to.id, schedule_id: scheduleId, counterparty: label(to),
    amount_cents: amount, memo, status: 'completed', process_on: t, booked_on: t, idempotency_key: key, entry_id: e.entryId });
  await audit(c, req, user.id, 'transfer.internal', { transfer: row.id, from: from.number_last4, to: to.number_last4, amount: toStr(amount), role: from.role, schedule: scheduleId });
  return row;
}

async function payee(c, user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new AppError(404, 'not_found', 'Payee not found.');
  const p = (await c.query('SELECT * FROM payees WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', [id, user.id])).rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Payee not found.');
  return p;
}
async function billNow(c, req, user, { fromId, payeeId, amount, memo, key, scheduleId = null }) {
  const from = await source(c, req, user, fromId, FUND), p = await payee(c, user, payeeId);
  await checkLimit(c, req, user.id, 'billpay', amount);
  await enough(c, req, user, from, amount, 'billpay');
  const t = today(), sendOn = processingDay('ach');
  const e = await ledger(c, req, user, { key, kind: 'bill_pay', memo, lines: [
    { accountId: from.id, amountCents: -amount, description: `Bill pay: ${p.name}`, category: 'Bills & Utilities', postedOn: t },
    { accountId: await systemAccount(c, 'mm_billpay'), amountCents: amount, description: `Bill pay: ${p.name}`, postedOn: t }] });
  const row = await record(c, { user_id: user.id, rail: 'billpay', from_account_id: from.id, payee_id: p.id, schedule_id: scheduleId, counterparty: p.name,
    amount_cents: amount, memo, status: 'sent', process_on: sendOn, settles_on: addBusinessDays(sendOn, BILL_DAYS), booked_on: t, idempotency_key: key, entry_id: e.entryId });
  await audit(c, req, user.id, 'billpay.send', { transfer: row.id, payee: p.id, from: from.number_last4, amount: toStr(amount), schedule: scheduleId });
  return row;
}

/** USA Pay: instant to an enrolled person through p2p_clearing; otherwise held in p2p_unclaimed until they enroll (14 days). */
async function p2pSend(c, req, user, { fromId, to, amount, memo, key }) {
  const from = await source(c, req, user, fromId, FUND);
  const who = to.userId ? to : await enrolled(c, to.token);
  if ((who?.user_id ?? who?.userId) === user.id) throw new AppError(400, 'self', "That's you. To move money between your own accounts, use Transfer.");
  await checkLimit(c, req, user.id, 'p2p', amount);
  await enough(c, req, user, from, amount, 'p2p');
  const t = today();
  if (who) {
    const toAcct = who.account_id ?? who.accountId, name = who.display_name ?? who.name, toUser = who.user_id ?? who.userId;
    const clearing = await systemAccount(c, 'mm_p2p');
    const e = await ledger(c, req, user, { key, kind: 'p2p', memo, lines: [
      { accountId: from.id, amountCents: -amount, description: `USA Pay to ${name}`, category: 'Transfers', postedOn: t },
      { accountId: clearing, amountCents: amount, description: `USA Pay from ${user.displayName}`, postedOn: t },
      { accountId: clearing, amountCents: -amount, description: `USA Pay to ${name}`, postedOn: t },
      { accountId: toAcct, amountCents: amount, description: `USA Pay from ${user.displayName}`, category: 'Transfers', postedOn: t }] });
    const row = await record(c, { user_id: user.id, rail: 'p2p', from_account_id: from.id, to_account_id: toAcct, to_user_id: toUser, p2p_token: to.token ?? null,
      counterparty: name, amount_cents: amount, memo, status: 'completed', process_on: t, booked_on: t, idempotency_key: key, entry_id: e.entryId });
    await audit(c, req, user.id, 'p2p.send', { transfer: row.id, to_user: toUser, from: from.number_last4, amount: toStr(amount) });
    return row;
  }
  const e = await ledger(c, req, user, { key, kind: 'p2p', memo, lines: [
    { accountId: from.id, amountCents: -amount, description: `USA Pay to ${showToken(to.token)} (waiting for them to enroll)`, category: 'Transfers', postedOn: t },
    { accountId: await systemAccount(c, 'p2p_unclaimed'), amountCents: amount, description: 'USA Pay unclaimed', postedOn: t }] });
  const row = await record(c, { user_id: user.id, rail: 'p2p', from_account_id: from.id, p2p_token: to.token, counterparty: showToken(to.token), amount_cents: amount, memo,
    status: 'pending', process_on: t, settles_on: addDays(t, P2P_EXPIRY_DAYS), booked_on: t, idempotency_key: key, entry_id: e.entryId });
  await audit(c, req, user.id, 'p2p.pending', { transfer: row.id, from: from.number_last4, amount: toStr(amount), expires: row.settles_on });
  return row;
}

async function external(c, user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new AppError(404, 'not_found', 'External account not found.');
  const e = (await c.query("SELECT * FROM external_accounts WHERE id = $1 AND user_id = $2 AND status <> 'removed' FOR UPDATE", [id, user.id])).rows[0];
  if (!e) throw new AppError(404, 'not_found', 'External account not found.');
  return e;
}

// ---------- overview ----------
async function overview(c, req, user) {
  await runDue(c, req, user);
  const accts = (await c.query(`SELECT a.*, o.role, (SELECT m.user_id FROM account_owners m WHERE m.account_id = a.id AND m.role = 'minor') AS child_id,
       (SELECT cu.display_name FROM account_owners m JOIN users cu ON cu.id = m.user_id WHERE m.account_id = a.id AND m.role = 'minor') AS child_name,
       (SELECT fc.mode FROM family_controls fc WHERE fc.account_id = a.id) AS family_mode
     FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE o.user_id = $1 AND a.status = 'open' ORDER BY CASE a.kind WHEN 'checking' THEN 1 WHEN 'savings' THEN 2 WHEN 'credit_card' THEN 3 ELSE 4 END, a.opened_at, a.name`, [user.id])).rows;
  const limits = []; for (const r of RAILS) limits.push(limitView(await limitsFor(c, user.id, r)));
  const tokens = (await c.query('SELECT token, account_id, verified_at FROM p2p_enrollments WHERE user_id = $1 ORDER BY created_at', [user.id])).rows;
  const activity = (await c.query(`SELECT t.*, f.name from_name, f.number_last4 from_last4, a.name to_name, a.number_last4 to_last4, su.display_name sender_name FROM transfers t
       LEFT JOIN users su ON su.id = t.user_id
       LEFT JOIN accounts f ON f.id = t.from_account_id LEFT JOIN accounts a ON a.id = t.to_account_id
     WHERE t.user_id = $1 OR (t.to_user_id = $1 AND t.status = 'completed') ORDER BY t.created_at DESC, t.id LIMIT 40`, [user.id])).rows
    .map(t => ({ ...view(t), incoming: t.user_id !== user.id, ...(t.user_id !== user.id ? { counterparty: t.sender_name, from: null, direction: 'in', canCancel: false, canSimulate: false } : {}) }));
  const schedules = (await c.query(`SELECT s.*, f.name from_name, f.number_last4 from_last4, a.name to_name, a.number_last4 to_last4, p.name payee_name FROM scheduled_transfers s
       JOIN accounts f ON f.id = s.from_account_id LEFT JOIN accounts a ON a.id = s.to_account_id LEFT JOIN payees p ON p.id = s.payee_id
     WHERE s.user_id = $1 AND s.status = 'active' ORDER BY s.next_run, s.created_at`, [user.id])).rows.map(schedView);
  const reqIn = (await c.query(`SELECT r.*, u.display_name FROM p2p_requests r JOIN users u ON u.id = r.requester_id
     WHERE r.status = 'open' AND r.to_token = ANY($1) ORDER BY r.created_at DESC`, [tokens.filter(x => x.verified_at).map(x => x.token)])).rows;
  const reqOut = (await c.query(`SELECT * FROM p2p_requests WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 20`, [user.id])).rows;
  return {
    user: { displayName: user.displayName, isMinor: isMinorUser(user) }, today: today(),
    accounts: accts.map(a => ({ id: a.id, name: a.name, last4: a.number_last4, kind: a.kind, role: a.role,
      balance: toStr(a.balance_cents), ...(a.kind === 'credit_card' ? { owed: toStr(-BigInt(a.balance_cents)) } : {}),
      canMove: MOVE_MONEY.includes(a.role) && DEPOSIT.includes(a.kind) && !(a.role === 'custodian' && a.family_mode === 'view_only'), canReceive: MOVE_MONEY.includes(a.role) && [...DEPOSIT, 'credit_card'].includes(a.kind),
      canSend: FUND.includes(a.role) && DEPOSIT.includes(a.kind),
      ...(a.role === 'custodian' ? { childId: a.child_id, childName: a.child_name } : {}) })),
    limits, schedules, activity,
    externalAccounts: (await c.query("SELECT * FROM external_accounts WHERE user_id = $1 AND status <> 'removed' ORDER BY created_at", [user.id])).rows.map(extView),
    payees: (await c.query('SELECT * FROM payees WHERE user_id = $1 AND removed_at IS NULL ORDER BY name', [user.id])).rows.map(payeeView),
    p2p: { warning: P2P_WARNING, enrollments: tokens.map(x => ({ token: showToken(x.token), accountId: x.account_id, verified: !!x.verified_at })),
      requestsIn: reqIn.map(r => ({ id: r.id, from: r.display_name, amount: toStr(r.amount_cents), memo: r.memo, createdAt: r.created_at })),
      requestsOut: reqOut.map(r => ({ id: r.id, to: showToken(r.to_token), amount: toStr(r.amount_cents), memo: r.memo, status: r.status, splitId: r.split_id })) },
    wire: { fee: toStr(WIRE_FEE), cutoff: '4:30 pm CT', warning: WIRE_WARNING, sendsOn: processingDay('wire') },
    ach: { cutoff: '5:00 pm CT', processOn: processingDay('ach'), holdDays: HOLD_DAYS,
      instantBanks: Object.entries(INSTANT_BANKS).map(([id, [name]]) => ({ id, name })), ...(revealDemo() ? { instantDemo: INSTANT_DEMO } : {}) }
  };
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body }) => tx(pool, async c => fn(c, req, await requireUser(c, req), body, params));

  r.add('GET', '/api/pay', async ({ req, pool }) => tx(pool, async c => overview(c, req, await requireUser(c, req))));
  r.add('POST', '/api/pay/run-due', h(async (c, req, u) => runDue(c, req, u)));

  // limits: shown on screen; a customer may lower theirs, and raise them back (to the bank default at most) after step-up
  r.add('GET', '/api/pay/limits', h(async (c, req, u) => { const out = []; for (const x of RAILS) out.push(limitView(await limitsFor(c, u.id, x))); return { limits: out }; }));
  r.add('PUT', '/api/pay/limits/:rail', h(async (c, req, u, body, { rail }) => {
    if (!RAILS.includes(rail)) throw new AppError(404, 'not_found', 'Not found.');
    const cur = await limitsFor(c, u.id, rail);
    const daily = parseAmount(body.daily, { field: 'the daily limit' }), monthly = parseAmount(body.monthly, { field: 'the 30-day limit' });
    const decide = async (decision, why) => audit(c, req, u.id, 'limit.change', { rail, decision, reason: why ?? null,
      from: { daily: toStr(cur.daily), monthly: toStr(cur.monthly) }, to: { daily: toStr(daily), monthly: toStr(monthly) } });
    if (daily > cur.maxDaily || monthly > cur.maxMonthly) {
      await decide('refused', 'above_bank_limit');
      throw refuse(422, 'above_bank_limit', `The most USA Banc allows is ${usd(cur.maxDaily)} a day and ${usd(cur.maxMonthly)} per 30 days.`);
    }
    if (monthly < daily) throw new AppError(400, 'bad_limit', "The 30-day limit can't be lower than the daily limit.");
    if (daily > cur.daily || monthly > cur.monthly) requireStepUp(u);
    await setUserLimit(c, u.id, rail, daily, monthly);
    await decide('ok');
    return { limit: limitView(await limitsFor(c, u.id, rail)) };
  }));

  // ----- transfers between your accounts -----
  r.add('POST', '/api/pay/transfers', h(async (c, req, u, body) => {
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const amount = parseAmount(body.amount), memo = text(body.memo), when = body.when ?? 'now';
    await stepUpFor(c, u, 'internal', amount);              // your own accounts: a code only at or over the threshold
    if (when === 'now') {
      const row = await internalNow(c, req, u, { fromId: body.fromAccountId, toId: body.toAccountId, amount, memo, key });
      return { transfer: view(row), replayed: false };
    }
    if (!['date', 'weekly', 'monthly'].includes(when)) throw new AppError(400, 'bad_when', 'Choose now, a date, weekly or monthly.');
    const s0 = (await c.query('SELECT * FROM scheduled_transfers WHERE idempotency_key = $1', [key])).rows[0];
    if (s0) return { schedule: { id: s0.id, nextRun: s0.next_run, cadence: s0.cadence }, replayed: true };
    const from = await source(c, req, u, body.fromAccountId), to = await target(c, u, body.toAccountId);
    if (from.id === to.id) throw new AppError(400, 'same_account', 'Choose two different accounts.');
    await checkCustodianMove(c, req, u.id, from, to, { what: 'schedule' });
    const t = today(), start = dateIn(body.date, { min: when === 'date' ? addDays(t, 1) : t, max: addDays(t, 365) });
    const id = newId();
    await c.query(`INSERT INTO scheduled_transfers (id, user_id, rail, from_account_id, to_account_id, amount_cents, memo, cadence, anchor_day, next_run, idempotency_key, created_at)
      VALUES ($1,$2,'internal',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, u.id, from.id, to.id, amount, memo, when === 'date' ? 'once' : when, Number(start.slice(8)), start, key, now()]);
    await audit(c, req, u.id, 'transfer.scheduled', { schedule: id, from: from.number_last4, to: to.number_last4, amount: toStr(amount), cadence: when, start });
    if (start <= t) await runDue(c, req, u);              // a recurring transfer starting today makes its first run now
    const s = (await c.query('SELECT next_run, status FROM scheduled_transfers WHERE id = $1', [id])).rows[0];
    return { schedule: { id, cadence: when === 'date' ? 'once' : when, start, nextRun: s.next_run, status: s.status }, replayed: false };
  }));

  r.add('DELETE', '/api/pay/schedules/:id', h(async (c, req, u, body, { id }) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Not found.');
    await runDue(c, req, u);                               // anything already due runs first; a run can't be canceled
    const s = (await c.query('SELECT * FROM scheduled_transfers WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, u.id])).rows[0];
    if (!s) throw new AppError(404, 'not_found', 'Not found.');
    if (s.status !== 'active') throw new AppError(409, 'already_done', s.status === 'done' ? 'This transfer already ran, so it can’t be canceled.' : 'This was already canceled.');
    await c.query("UPDATE scheduled_transfers SET status = 'canceled' WHERE id = $1", [id]);
    await audit(c, req, u.id, 'transfer.canceled', { schedule: id, rail: s.rail, amount: toStr(s.amount_cents) });
    return { ok: true };
  }));

  // ----- cancel a transfer that hasn't gone yet -----
  r.add('DELETE', '/api/pay/transfers/:id', h(async (c, req, u, body, { id }) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Not found.');
    await lock(c, `mm:${u.id}`);
    await runDue(c, req, u);                               // anything already past its cut-off moves on first
    const t = (await c.query('SELECT * FROM transfers WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, u.id])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Not found.');
    if (!canCancel(t)) {
      const why = t.rail === 'wire' && t.status === 'sent' ? WIRE_WARNING
        : t.rail === 'ach' && t.status === 'processing' ? 'This transfer is already being processed, so it can’t be canceled.'
        : t.status === 'canceled' ? 'This was already canceled.' : 'This one can’t be canceled.';
      await audit(c, req, u.id, 'transfer.cancel_refused', { transfer: t.id, rail: t.rail, status: t.status });
      throw refuse(409, 'cannot_cancel', why);
    }
    let rev = null;
    if (t.entry_id) {                                      // money already left the account: a new entry puts it back
      const lines = (await c.query('SELECT account_id, amount_cents, description FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [t.entry_id])).rows;
      rev = (await post(c, { key: `${t.idempotency_key}:cancel`, kind: 'transfer_cancel', createdBy: u.id, lines: lines.map(l =>
        ({ accountId: l.account_id, amountCents: -BigInt(l.amount_cents), description: `Canceled: ${l.description}`, category: 'Transfers', postedOn: today() })) })).entryId;
    }
    await setStatus(c, t.id, { status: 'canceled', reversal_entry_id: rev, settled_at: now(), note: 'Canceled before it was sent.' });
    await releaseLimit(c, t, 'canceled');
    await audit(c, req, u.id, 'transfer.canceled', { transfer: t.id, rail: t.rail, amount: toStr(t.amount_cents), fee_refunded: toStr(t.fee_cents) });
    return { transfer: view((await c.query('SELECT * FROM transfers WHERE id = $1', [t.id])).rows[0]) };
  }));

  // ----- "Simulate settlement": finish this person's in-flight ACH, wires and bill payments now instead of on their day.
  // Simulated: in the demo nothing reaches a real network, so this only moves the status and the ledger forward.
  r.add('POST', '/api/pay/simulate-settlement', h(async (c, req, u, body) => {
    await lock(c, `mm:${u.id}`);
    await runDue(c, req, u);
    if (body.transferId != null && !/^[0-9a-f-]{36}$/i.test(String(body.transferId))) throw new AppError(404, 'not_found', 'Not found.');
    const rows = (await c.query(`SELECT * FROM transfers WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
      AND ((rail = 'ach' AND status IN ('pending', 'processing')) OR (rail = 'wire' AND status = 'scheduled') OR (rail = 'billpay' AND status = 'sent'))
      ORDER BY created_at FOR UPDATE`, [u.id, body.transferId ?? null])).rows;
    if (body.transferId && !rows.length) {
      if (!(await c.query('SELECT 1 FROM transfers WHERE id = $1 AND user_id = $2', [body.transferId, u.id])).rowCount) throw new AppError(404, 'not_found', 'Not found.');
      throw new AppError(409, 'nothing_to_settle', 'This one has already finished.');
    }
    for (const x of rows) {
      if (x.rail === 'ach') await settleAch(c, req, u, x, { simulated: true });
      else if (x.rail === 'wire') await sendWire(c, req, u, x, { simulated: true });
      else await payBill(c, req, u, x, { simulated: true });
    }
    await audit(c, req, u.id, 'settlement.simulated', { transfers: rows.map(x => x.id), count: rows.length });
    const done = rows.length ? (await c.query('SELECT * FROM transfers WHERE id = ANY($1) ORDER BY created_at', [rows.map(x => x.id)])).rows : [];
    return { settled: done.map(view) };
  }));

  // ----- external accounts and ACH -----
  r.add('POST', '/api/pay/external-accounts', h(async (c, req, u, body) => {
    requireStepUp(u);
    if (isMinorUser(u)) throw new AppError(403, 'minor_not_allowed', MINOR_MSG);
    const rt = routing(body.routing), num = accountNumber(body.accountNumber);
    const kind = body.kind === 'savings' ? 'savings' : 'checking', last4 = num.slice(-4);
    const nickname = text(body.nickname, 40) ?? `External ${kind}`;
    if ((await c.query("SELECT 1 FROM external_accounts WHERE user_id = $1 AND routing_number = $2 AND number_last4 = $3 AND status <> 'removed'", [u.id, rt, last4])).rowCount)
      throw new AppError(409, 'already_linked', `An account ending ${last4} at that bank is already linked.`);
    const id = newId(), md = [randomInt(1, 100), randomInt(1, 100)];
    await c.query(`INSERT INTO external_accounts (id, user_id, nickname, kind, routing_number, number_last4, number_enc, md1_cents, md2_cents, tries_left, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, u.id, nickname, kind, rt, last4, seal(num, `${u.id}:${id}`), md[0], md[1], MD_TRIES, now()]);
    await audit(c, req, u.id, 'ach.link', { external_account: id, last4, method: 'micro_deposits' });
    const e = (await c.query('SELECT * FROM external_accounts WHERE id = $1', [id])).rows[0];
    return { externalAccount: extView(e), ...(revealDemo() ? { demoMicroDeposits: md.map(x => toStr(BigInt(x))) } : {}) };
  }));

  // Simulated instant verification: a mock sign-in at the other bank finds the account and verifies it on the spot.
  r.add('POST', '/api/pay/external-accounts/instant', h(async (c, req, u, body) => {
    requireStepUp(u);
    if (isMinorUser(u)) throw new AppError(403, 'minor_not_allowed', MINOR_MSG);
    const bank = INSTANT_BANKS[body.bank];
    if (!bank) throw new AppError(400, 'bad_bank', 'Choose your other bank from the list.');
    if (body.username !== INSTANT_DEMO.username || body.password !== INSTANT_DEMO.password) {
      await audit(c, req, u.id, 'ach.link_instant_failed', { bank: body.bank });
      throw refuse(400, 'instant_failed', `${bank[0]} didn't accept that sign-in. Simulated: use ${INSTANT_DEMO.username} / ${INSTANT_DEMO.password}, or link with two small deposits instead.`);
    }
    const kind = body.kind === 'savings' ? 'savings' : 'checking';
    // the mock bank always "finds" the same account for this person, bank and type, so linking twice is caught
    let num = BigInt('0x' + createHash('sha256').update(`${u.id}:${body.bank}:${kind}`).digest('hex').slice(0, 12)).toString().slice(-10).padStart(10, '1');
    if (RETURNS[num.slice(-4)]) num = num.slice(0, -1) + '9';
    const last4 = num.slice(-4), rt = bank[1];
    if ((await c.query("SELECT 1 FROM external_accounts WHERE user_id = $1 AND routing_number = $2 AND number_last4 = $3 AND status <> 'removed'", [u.id, rt, last4])).rowCount)
      throw new AppError(409, 'already_linked', `Your ${bank[0]} ${kind} account ending ${last4} is already linked.`);
    const id = newId(), at = now();
    await c.query(`INSERT INTO external_accounts (id, user_id, nickname, kind, institution, method, routing_number, number_last4, number_enc, status, tries_left, created_at, verified_at)
      VALUES ($1,$2,$3,$4,$5,'instant',$6,$7,$8,'verified',0,$9,$9)`, [id, u.id, text(body.nickname, 40) ?? `${bank[0]} ${kind}`, kind, bank[0], rt, last4, seal(num, `${u.id}:${id}`), at]);
    await audit(c, req, u.id, 'ach.link', { external_account: id, last4, method: 'instant', bank: body.bank });
    await audit(c, req, u.id, 'ach.verify_ok', { external_account: id, last4, method: 'instant' });
    return { externalAccount: extView((await c.query('SELECT * FROM external_accounts WHERE id = $1', [id])).rows[0]) };
  }));

  r.add('POST', '/api/pay/external-accounts/:id/verify', h(async (c, req, u, body, { id }) => {
    await runDue(c, req, u);
    const e = await external(c, u, id);
    if (e.status === 'verified') return { externalAccount: extView(e) };
    const a = [body.amount1, body.amount2].map(v => parseAmount(v, { field: 'each amount', min: 1n, max: 99n })).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const want = [BigInt(e.md1_cents), BigInt(e.md2_cents)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (a[0] !== want[0] || a[1] !== want[1]) {
      const left = e.tries_left - 1;
      await c.query(`UPDATE external_accounts SET tries_left = $2 ${left ? '' : ", status = 'removed', removed_at = $3, removed_reason = 'too many tries'"} WHERE id = $1`,
        left ? [id, left] : [id, left, now()]);
      await audit(c, req, u.id, 'ach.verify_bad', { external_account: id, tries_left: left });
      if (!left) throw refuse(429, 'too_many_tries', "Those amounts didn't match 3 times, so we removed this link. You can link the account again.");
      throw refuse(400, 'bad_amounts', `Those amounts don't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    await c.query("UPDATE external_accounts SET status = 'verified', verified_at = $2 WHERE id = $1", [id, now()]);
    await audit(c, req, u.id, 'ach.verify_ok', { external_account: id, last4: e.number_last4 });
    return { externalAccount: extView((await c.query('SELECT * FROM external_accounts WHERE id = $1', [id])).rows[0]) };
  }));

  r.add('DELETE', '/api/pay/external-accounts/:id', h(async (c, req, u, body, { id }) => {
    const e = await external(c, u, id);
    await c.query("UPDATE external_accounts SET status = 'removed', removed_at = $2, removed_reason = 'removed by customer' WHERE id = $1", [e.id, now()]);
    await audit(c, req, u.id, 'ach.link_removed', { external_account: e.id, last4: e.number_last4, reason: 'customer' });
    return { ok: true };
  }));

  r.add('POST', '/api/pay/ach', h(async (c, req, u, body) => {
    const dir = body.direction === 'in' ? 'in' : 'out';
    const amount = parseAmount(body.amount), memo = text(body.memo);
    await stepUpFor(c, u, 'ach', amount, { always: dir === 'out' });   // money leaving the bank always; a pull at or over the threshold
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const acct = await source(c, req, u, body.accountId, FUND), e = await external(c, u, body.externalAccountId);
    if (e.status !== 'verified') throw new AppError(409, 'not_verified', 'Verify this account with the two small deposits before moving money.');
    const holdEnds = new Date(e.verified_at.getTime() + HOLD_DAYS * 86400_000);
    if (dir === 'out' && now() < holdEnds) {
      await audit(c, req, u.id, 'transfer.refused', { rail: 'ach', reason: 'new_account_hold', external_account: e.id });
      throw refuse(409, 'new_account_hold', `New external accounts have a ${HOLD_DAYS}-day hold before you can send money to them. You can send to ${e.nickname} ··${e.number_last4} from ${bankDateOf(holdEnds)}.`);
    }
    await checkLimit(c, req, u.id, 'ach', amount);         // one ACH limit covers money in and out
    const t = today(), processOn = processingDay('ach'), settlesOn = addBusinessDays(processOn, ACH_DAYS[dir]);
    const ext = `${e.nickname} ··${e.number_last4}`;
    let entry = null;
    if (dir === 'out') {                                   // out: the money leaves now and waits in ACH clearing until it settles
      await enough(c, req, u, acct, amount, 'ach');
      entry = (await ledger(c, req, u, { key, kind: 'ach_out', memo, lines: [
        { accountId: acct.id, amountCents: -amount, description: `ACH transfer to ${ext}`, category: 'Transfers', postedOn: t },
        { accountId: await systemAccount(c, 'mm_ach_out'), amountCents: amount, description: `ACH out: ${ext}`, postedOn: t }] })).entryId;
    }                                                      // in: credited when it settles (see runDue)
    const row = await record(c, { user_id: u.id, rail: 'ach', direction: dir, from_account_id: dir === 'out' ? acct.id : null, to_account_id: dir === 'in' ? acct.id : null,
      external_account_id: e.id, counterparty: ext, amount_cents: amount, memo, status: 'pending', process_on: processOn, settles_on: settlesOn, booked_on: t,
      idempotency_key: key, entry_id: entry });
    await audit(c, req, u.id, 'ach.send', { transfer: row.id, direction: dir, account: acct.number_last4, external_last4: e.number_last4, amount: toStr(amount), settles_on: settlesOn });
    return { transfer: view(row), replayed: false };
  }));

  // ----- USA Pay -----
  // Enrolling proves the email or phone first: a code is sent to it (simulated, shown on screen), and only the right code
  // enrolls it and releases USA Pay money that was waiting for it. Asking for a code answers the same whether or not the
  // email or phone (or a username) exists, so it can't be used to find customers; only the right code, which in a real
  // bank reaches only the owner of that email or phone, can learn that someone else has it. Codes and wrong guesses are
  // throttled across codes (ENROLL_CODES_PER_DAY, ENROLL_WRONG_PER_DAY), so asking for a new code never buys more guesses.
  const kindOf = tk => (tk.includes('@') ? 'email' : 'phone');
  const tokenTaken = async (c, req, u, tk) => {
    const row = (await c.query('SELECT * FROM p2p_enrollments WHERE token = $1', [tk])).rows[0];
    const isOtherUsername = (await c.query('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [tk, u.id])).rowCount;
    if ((row?.verified_at && row.user_id !== u.id) || isOtherUsername) {     // an unproven row from the old path can be taken over
      await audit(c, req, u.id, 'p2p.enroll_refused', { reason: 'token_taken', kind: kindOf(tk) });
      throw refuse(409, 'token_taken', 'That email or phone is already enrolled with USA Pay by someone else.');
    }
  };
  /** Wrong codes in the last 24 hours, by this customer and against this email or phone (by anyone). */
  const wrongToday = async (c, u, tk) => (await c.query(`SELECT
      coalesce(sum(wrong_tries) FILTER (WHERE user_id = $1), 0)::int AS mine, coalesce(sum(wrong_tries) FILTER (WHERE token = $2), 0)::int AS token
    FROM p2p_token_verifications WHERE (user_id = $1 OR token = $2) AND created_at > now() - interval '24 hours'`, [u.id, tk])).rows[0];
  const tooManyWrong = async (c, req, u, tk) => {
    const w = await wrongToday(c, u, tk);
    if (w.mine < ENROLL_WRONG_PER_DAY && w.token < ENROLL_WRONG_PER_DAY) return;
    await audit(c, req, u.id, 'p2p.enroll_throttled', { reason: 'wrong_codes', kind: kindOf(tk) });
    throw refuse(429, 'too_many_tries', `Too many wrong codes today (${ENROLL_WRONG_PER_DAY} in 24 hours). Try again tomorrow.`);
  };
  const releaseWaiting = async (c, req, u, tk, acct) => {
    let released = 0;
    for (const p of (await c.query("SELECT * FROM transfers WHERE rail = 'p2p' AND status = 'pending' AND p2p_token = $1 FOR UPDATE", [tk])).rows) {
      const sender = (await c.query('SELECT display_name FROM users WHERE id = $1', [p.user_id])).rows[0].display_name, t = today();
      const e = await post(c, { key: `${p.idempotency_key}:release`, kind: 'p2p_release', createdBy: u.id, lines: [
        { accountId: await systemAccount(c, 'p2p_unclaimed'), amountCents: -p.amount_cents, description: 'USA Pay unclaimed released', postedOn: t },
        { accountId: acct.id, amountCents: p.amount_cents, description: `USA Pay from ${sender}`, category: 'Transfers', postedOn: t }] });
      await setStatus(c, p.id, { status: 'completed', to_user_id: u.id, to_account_id: acct.id, counterparty: u.displayName, note: `Claimed when ${u.displayName} enrolled.` });
      await audit(c, req, u.id, 'p2p.released', { transfer: p.id, entry: e.entryId, amount: toStr(p.amount_cents) });
      released++;
    }
    return released;
  };
  const codeHash = (id, code) => createHash('sha256').update(`${id}:${code}`).digest('hex');

  r.add('POST', '/api/pay/p2p/enroll', h(async (c, req, u, body) => {
    requireStepUp(u);
    const tk = token(body.token), acct = await source(c, req, u, body.accountId, FUND);
    const kind = kindOf(tk);
    const mine = (await c.query('SELECT 1 FROM p2p_enrollments WHERE token = $1 AND user_id = $2 AND verified_at IS NOT NULL', [tk, u.id])).rowCount;
    if (mine) {                                         // already proven by this user: just change where the money goes
      await c.query('UPDATE p2p_enrollments SET account_id = $3 WHERE token = $1 AND user_id = $2', [tk, u.id, acct.id]);
      await audit(c, req, u.id, 'p2p.enroll', { account: acct.number_last4, kind, verified: 'earlier' });
      return { ok: true, enrolled: true, token: showToken(tk), released: await releaseWaiting(c, req, u, tk, acct) };
    }
    await lock(c, `p2p-enroll:${u.id}`);                 // one code request at a time per customer, so the counts hold
    const asked = (await c.query(`SELECT count(*)::int n FROM p2p_token_verifications WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [u.id])).rows[0].n;
    if (asked >= ENROLL_CODES_PER_DAY) {
      await audit(c, req, u.id, 'p2p.enroll_throttled', { reason: 'codes', kind });
      throw refuse(429, 'too_many_codes', `You asked for ${ENROLL_CODES_PER_DAY} codes today. Try again tomorrow.`);
    }
    await tooManyWrong(c, req, u, tk);
    // the same answer whether or not the email or phone is taken: nothing here says who has it
    const id = randomBytes(18).toString('base64url'), code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await c.query(`UPDATE p2p_token_verifications SET superseded_at = now() WHERE user_id = $1 AND token = $2 AND verified_at IS NULL AND superseded_at IS NULL`, [u.id, tk]);
    await c.query(`INSERT INTO p2p_token_verifications (id, user_id, token, account_id, code_hash, tries_left, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`, [id, u.id, tk, acct.id, codeHash(id, code), ENROLL_CODE_TRIES, ENROLL_CODE_MINUTES]);
    await audit(c, req, u.id, 'p2p.enroll_code_sent', { kind, account: acct.number_last4 });
    const where = kind === 'email' ? `an email to ${tk}` : `a text message to ${showToken(tk)}`;
    return { ok: true, enrolled: false, verificationId: id, token: showToken(tk), sentTo: where, minutes: ENROLL_CODE_MINUTES,
      note: `We sent a 6-digit code in ${where}. Enter it to finish enrolling. Simulated: no real ${kind === 'email' ? 'email' : 'text'} is sent.`,
      ...(revealDemo() ? { demoCode: code } : {}) };
  }));

  r.add('POST', '/api/pay/p2p/enroll/verify', h(async (c, req, u, body) => {
    const id = String(body.verificationId ?? '');
    const v = /^[\w-]{10,60}$/.test(id) ? (await c.query('SELECT * FROM p2p_token_verifications WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, u.id])).rows[0] : null;
    if (!v || v.verified_at) throw new AppError(404, 'not_found', 'Start enrolling again: that code request was not found.');
    if (v.superseded_at) throw new AppError(410, 'code_replaced', 'You asked for a newer code. Enter the latest code we sent.');
    if (new Date(v.expires_at) <= new Date()) throw new AppError(410, 'code_expired', `That code expired. Codes work for ${ENROLL_CODE_MINUTES} minutes; ask for a new one.`);
    if (v.tries_left <= 0) throw new AppError(429, 'too_many_tries', 'Too many wrong codes. Ask for a new code.');
    await lock(c, `p2p-token:${v.token}`);                    // guesses at one email or phone are counted one at a time
    await tooManyWrong(c, req, u, v.token);
    const want = Buffer.from(v.code_hash), got = Buffer.from(codeHash(v.id, String(body.code ?? '')));
    if (!/^\d{6}$/.test(String(body.code ?? '')) || !timingSafeEqual(want, got)) {
      const left = v.tries_left - 1;
      await c.query('UPDATE p2p_token_verifications SET tries_left = $2, wrong_tries = wrong_tries + 1 WHERE id = $1', [v.id, left]);
      await audit(c, req, u.id, 'p2p.enroll_code_bad', { kind: kindOf(v.token), tries_left: left });
      if (!left) throw refuse(429, 'too_many_tries', 'Too many wrong codes. Ask for a new code.');
      throw refuse(401, 'bad_code', `That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    await tokenTaken(c, req, u, v.token);                   // someone else may have it (proven), or it is another customer's username
    const acct = await source(c, req, u, v.account_id, FUND);
    const ins = await c.query(`INSERT INTO p2p_enrollments (token, user_id, account_id, verified_at) VALUES ($1,$2,$3, now())
      ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, account_id = EXCLUDED.account_id, verified_at = EXCLUDED.verified_at
      WHERE p2p_enrollments.user_id = EXCLUDED.user_id OR p2p_enrollments.verified_at IS NULL`, [v.token, u.id, acct.id]);
    if (!ins.rowCount) {                                     // never take over another user's proven enrollment, even in a race
      await audit(c, req, u.id, 'p2p.enroll_refused', { reason: 'token_taken', kind: kindOf(v.token) });
      throw refuse(409, 'token_taken', 'That email or phone is already enrolled with USA Pay by someone else.');
    }
    await c.query('UPDATE p2p_token_verifications SET verified_at = now() WHERE id = $1', [v.id]);
    await audit(c, req, u.id, 'p2p.enroll', { account: acct.number_last4, kind: kindOf(v.token), verified: 'code' });
    return { ok: true, enrolled: true, token: showToken(v.token), released: await releaseWaiting(c, req, u, v.token, acct) };
  }));

  r.add('POST', '/api/pay/p2p/send', h(async (c, req, u, body) => {
    requireStepUp(u);
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const row = await p2pSend(c, req, u, { fromId: body.fromAccountId, to: { token: token(body.to) }, amount: parseAmount(body.amount), memo: text(body.memo), key });
    return { transfer: view(row), replayed: false, warning: P2P_WARNING };
  }));

  const requestOne = async (c, req, u, { tk, acct, amount, memo, splitId = null }) => {
    const id = newId();
    await c.query('INSERT INTO p2p_requests (id, requester_id, deposit_account_id, to_token, amount_cents, memo, split_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, u.id, acct.id, tk, amount, memo, splitId, now()]);
    return { id, to: showToken(tk), amount: toStr(amount) };
  };
  const notSelf = async (c, u, tk) => {
    const e = await enrolled(c, tk);
    if (e?.user_id === u.id || tk === u.username) throw new AppError(400, 'self', "You can't request money from yourself.");
  };
  r.add('POST', '/api/pay/p2p/request', h(async (c, req, u, body) => {
    const tk = token(body.from), amount = parseAmount(body.amount), acct = await source(c, req, u, body.toAccountId, FUND);
    await notSelf(c, u, tk);
    await checkLimit(c, req, u.id, 'p2p', amount);         // requests are held to the same limit, but don't use it up
    const r1 = await requestOne(c, req, u, { tk, acct, amount, memo: text(body.memo) });
    await audit(c, req, u.id, 'p2p.request', { request: r1.id, amount: r1.amount });
    return { request: r1 };
  }));

  r.add('POST', '/api/pay/p2p/split', h(async (c, req, u, body) => {
    const total = parseAmount(body.total, { field: 'the total' }), acct = await source(c, req, u, body.toAccountId, FUND);
    const people = [...new Set((Array.isArray(body.people) ? body.people : []).map(token))];
    if (!people.length || people.length > 10) throw new AppError(400, 'bad_people', 'Add 1 to 10 people to split with.');
    for (const tk of people) await notSelf(c, u, tk);
    const n = BigInt(people.length + (body.includeMe === false ? 0 : 1));
    const share = total / n, extra = total % n;            // whole cents; the leftover cents go to the first people
    if (share < 1n) throw new AppError(400, 'bad_amount', 'That total is too small to split.');
    await checkLimit(c, req, u.id, 'p2p', share + (extra ? 1n : 0n));
    const splitId = newId(), memo = text(body.memo), out = [];
    for (const [i, tk] of people.entries()) out.push(await requestOne(c, req, u, { tk, acct, amount: share + (BigInt(i) < extra ? 1n : 0n), memo, splitId }));
    await audit(c, req, u.id, 'p2p.split', { split: splitId, total: toStr(total), people: people.length, include_me: body.includeMe !== false });
    return { splitId, total: toStr(total), yourShare: body.includeMe === false ? '0.00' : toStr(share), requests: out };
  }));

  const myRequest = async (c, u, id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Request not found.');
    const r1 = (await c.query(`SELECT r.*, u.display_name FROM p2p_requests r JOIN users u ON u.id = r.requester_id
       WHERE r.id = $1 AND (r.requester_id = $2 OR r.to_token IN (SELECT token FROM p2p_enrollments WHERE user_id = $2 AND verified_at IS NOT NULL)) FOR UPDATE OF r`, [id, u.id])).rows[0];
    if (!r1) throw new AppError(404, 'not_found', 'Request not found.');
    return r1;
  };
  r.add('POST', '/api/pay/p2p/requests/:id/pay', h(async (c, req, u, body, { id }) => {
    requireStepUp(u);
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const q = await myRequest(c, u, id);
    if (q.requester_id === u.id) throw new AppError(404, 'not_found', 'Request not found.');
    if (q.status !== 'open') throw new AppError(409, 'not_open', 'This request was already paid or declined.');
    const row = await p2pSend(c, req, u, { fromId: body.fromAccountId, to: { userId: q.requester_id, accountId: q.deposit_account_id, name: q.display_name }, amount: q.amount_cents, memo: q.memo, key });
    await c.query("UPDATE p2p_requests SET status = 'paid', transfer_id = $2 WHERE id = $1", [q.id, row.id]);
    return { transfer: view(row), replayed: false };
  }));
  r.add('POST', '/api/pay/p2p/requests/:id/decline', h(async (c, req, u, body, { id }) => {
    const q = await myRequest(c, u, id);
    if (q.status !== 'open') throw new AppError(409, 'not_open', 'This request was already paid or declined.');
    const st = q.requester_id === u.id ? 'canceled' : 'declined';
    await c.query('UPDATE p2p_requests SET status = $2 WHERE id = $1', [q.id, st]);
    await audit(c, req, u.id, `p2p.request_${st}`, { request: q.id });
    return { ok: true, status: st };
  }));

  // ----- wires (domestic only) -----
  const wireQuote = (amount) => {
    const sendsOn = processingDay('wire'), t = today();
    return { amount: toStr(amount), fee: toStr(WIRE_FEE), total: toStr(amount + WIRE_FEE), sendsOn, afterCutoff: sendsOn !== t, cutoff: '4:30 pm CT', warning: WIRE_WARNING };
  };
  r.add('POST', '/api/pay/wires/quote', h(async (c, req, u, body) => {
    await source(c, req, u, body.fromAccountId, FUND);
    return { quote: wireQuote(parseAmount(body.amount)) };
  }));
  r.add('POST', '/api/pay/wires', h(async (c, req, u, body) => {
    requireStepUp(u);
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const amount = parseAmount(body.amount), from = await source(c, req, u, body.fromAccountId, FUND);
    const name = text(body.recipientName, 80), bank = text(body.bankName, 80), rt = routing(body.routing), num = accountNumber(body.accountNumber, "recipient's account number");
    if (!name || !bank) throw new AppError(400, 'missing', "Enter the recipient's name and their bank's name.");
    if (body.confirmIrrevocable !== true) throw new AppError(400, 'confirm_required', `${WIRE_WARNING} Tick the box to confirm.`);
    await checkLimit(c, req, u.id, 'wire', amount);
    await enough(c, req, u, from, amount + WIRE_FEE, 'wire');
    const q = wireQuote(amount), t = today(), who = `${name} at ${bank} ··${num.slice(-4)}`;
    const e = await ledger(c, req, u, { key, kind: 'wire', memo: text(body.memo), lines: [
      { accountId: from.id, amountCents: -amount, description: `Domestic wire to ${who}`, category: 'Transfers', postedOn: t },
      { accountId: from.id, amountCents: -WIRE_FEE, description: 'Outgoing domestic wire fee', category: 'Fees & Charges', postedOn: t },
      { accountId: await systemAccount(c, 'mm_wire_out'), amountCents: amount, description: `Wire out: ${who}`, postedOn: t },
      { accountId: await systemAccount(c, 'mm_wire_fees'), amountCents: WIRE_FEE, description: 'Domestic wire fee', postedOn: t }] });
    const id = newId();
    const row = (await c.query(`INSERT INTO transfers (id, user_id, rail, from_account_id, counterparty, counterparty_routing, counterparty_last4, counterparty_enc, amount_cents, fee_cents,
        memo, status, process_on, booked_on, idempotency_key, entry_id, created_at, updated_at) VALUES ($1,$2,'wire',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
      [id, u.id, from.id, who, rt, num.slice(-4), seal(num, `${u.id}:${id}`), amount, WIRE_FEE, text(body.memo), 'scheduled', q.sendsOn, t, key, e.entryId, now()])).rows[0];
    await useLimit(c, row);
    await audit(c, req, u.id, 'wire.send', { transfer: id, from: from.number_last4, to_last4: num.slice(-4), amount: toStr(amount), fee: toStr(WIRE_FEE), sends_on: q.sendsOn, after_cutoff: q.afterCutoff });
    if (!q.afterCutoff) await sendWire(c, req, u, row);     // before the cut-off it goes out now, and can't be recalled
    return { transfer: view((await c.query('SELECT * FROM transfers WHERE id = $1', [id])).rows[0]), quote: q, replayed: false };
  }));

  // ----- bill pay -----
  r.add('POST', '/api/pay/payees', h(async (c, req, u, body) => {
    requireStepUp(u);
    if (isMinorUser(u)) throw new AppError(403, 'minor_not_allowed', MINOR_MSG);
    const name = text(body.name, 80), address = text(body.address, 200);
    const num = body.accountNumber ? accountNumber(body.accountNumber, 'account number at the biller') : null;
    if (!name) throw new AppError(400, 'missing', "Enter the payee's name.");
    if (!address && !num) throw new AppError(400, 'missing', 'Enter the address or your account number at the biller.');
    const id = newId();
    await c.query('INSERT INTO payees (id, user_id, name, address, account_last4, account_enc) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, u.id, name, address, num?.slice(-4) ?? null, num ? seal(num, `${u.id}:${id}`) : null]);
    await audit(c, req, u.id, 'payee.add', { payee: id, account_last4: num?.slice(-4) ?? null });
    return { payee: payeeView((await c.query('SELECT * FROM payees WHERE id = $1', [id])).rows[0]) };
  }));
  r.add('DELETE', '/api/pay/payees/:id', h(async (c, req, u, body, { id }) => {
    const p = await payee(c, u, id);
    await c.query('UPDATE payees SET removed_at = now() WHERE id = $1', [p.id]);
    await c.query("UPDATE scheduled_transfers SET status = 'canceled' WHERE payee_id = $1 AND status = 'active'", [p.id]);
    await audit(c, req, u.id, 'payee.remove', { payee: p.id });
    return { ok: true };
  }));
  r.add('POST', '/api/pay/bills', h(async (c, req, u, body) => {
    requireStepUp(u);
    const key = keyOf(u, body);
    await lock(c, `mm:${u.id}`);
    const prev = await replay(c, key); if (prev) return prev;
    const amount = parseAmount(body.amount), memo = text(body.memo), when = body.when ?? 'now';
    if (when === 'now') return { transfer: view(await billNow(c, req, u, { fromId: body.fromAccountId, payeeId: body.payeeId, amount, memo, key })), replayed: false };
    if (!['date', 'weekly', 'monthly'].includes(when)) throw new AppError(400, 'bad_when', 'Choose now, a date, weekly or monthly.');
    const s0 = (await c.query('SELECT * FROM scheduled_transfers WHERE idempotency_key = $1', [key])).rows[0];
    if (s0) return { schedule: { id: s0.id, nextRun: s0.next_run, cadence: s0.cadence }, replayed: true };
    const from = await source(c, req, u, body.fromAccountId, FUND), p = await payee(c, u, body.payeeId);
    const t = today(), start = dateIn(body.date, { min: when === 'date' ? addDays(t, 1) : t, max: addDays(t, 365) }), id = newId();
    await c.query(`INSERT INTO scheduled_transfers (id, user_id, rail, from_account_id, payee_id, amount_cents, memo, cadence, anchor_day, next_run, idempotency_key, created_at)
      VALUES ($1,$2,'billpay',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, u.id, from.id, p.id, amount, memo, when === 'date' ? 'once' : when, Number(start.slice(8)), start, key, now()]);
    await audit(c, req, u.id, 'billpay.scheduled', { schedule: id, payee: p.id, amount: toStr(amount), cadence: when, start });
    if (start <= t) await runDue(c, req, u);
    const s = (await c.query('SELECT next_run, status FROM scheduled_transfers WHERE id = $1', [id])).rows[0];
    return { schedule: { id, cadence: when === 'date' ? 'once' : when, start, nextRun: s.next_run, status: s.status,
      deliverBy: addBusinessDays(processingDay('ach', new Date(start + 'T15:00:00Z')), BILL_DAYS) }, replayed: false };
  }));
  r.add('POST', '/api/pay/bills/estimate', h(async (c, req, u, body) => {
    const t = today(), d = body.date ? dateIn(body.date, { min: t, max: addDays(t, 365) }) : t;
    const sendOn = d === t ? processingDay('ach') : processingDay('ach', new Date(d + 'T15:00:00Z'));
    return { sendOn, deliverBy: addBusinessDays(sendOn, BILL_DAYS) };
  }));
}

