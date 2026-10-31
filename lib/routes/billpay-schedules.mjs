// Scheduled bill payments: once, every week, every two weeks or every month, to one of your saved payees from one of your
// own accounts. Each payment gets a send date (business days, 2:00 pm CT cut-off), a hold date (the business day before,
// from which its amount is held on the account) and a deliver-by date (1 business day electronic, 5 by check).
// POST /api/billpay/run-due sends what has reached its cut-off, once each; too little money is retried once on the next
// business day, then the payment fails and a fee is charged. Money moves only through post().
// Simulated: no real bill payment network is involved.
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { usd } from '../money.mjs';
import { isDate } from '../dates.mjs';
import { clock, today, addDays, isBusinessDay, nextBusinessDay, previousBusinessDay, addBusinessDays, cutoffAt } from '../money-movement/calendar.mjs';
import { limitsFor, useLimit } from '../money-movement/limits.mjs';

const FEATURE = 'billpay-schedules';
const FREQUENCIES = ['once', 'weekly', 'biweekly', 'monthly'];
const STATUSES = ['active', 'completed', 'canceled'];
const OPEN = ['scheduled', 'retrying'];
const OWN = ['owner', 'joint_owner'];                     // bill payments come only from accounts you own
const KINDS = ['checking', 'savings', 'money_market'];
// Product rules for scheduled bill pay (docs/RESEARCH.md §2.5: delivery depends on the method; insufficient funds -> failed
// + alert). The figures are the Money Movement requirements' demo values.
export const MAX_PAYMENT = 500_000n;                      // $5,000.00 per payment
export const NSF_FEE = 1_500n;                            // $15.00 when the retry also finds too little money
export const DELIVERY_DAYS = { electronic: 1, check: 5 }; // business days from sending to the payee
const MAX_AMOUNT = 10_000_000_000, DAYS_AHEAD = 365, MAX_COUNT = 520, MEMO_MAX = 140;

// ---------- small helpers ----------
const now = () => clock.now();
const lock = (c, userId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mm:${userId}`]);   // the /api/pay lock: one customer's money moves one at a time
const bad = (code, message, extra) => new AppError(400, code, message, extra);
const label = a => `${a.name} ··${a.number_last4}`;
const methodOf = s => (s.payee_last4 ? 'electronic' : 'check');                 // an account number at the biller: paid electronically
const pastCutoff = d => now() >= cutoffAt('billpay', d);
const cents = v => Number(v);                                                    // JSON integers (at most $100,000,000.00, exact as a Number)

/** The send date of an occurrence: its first business day; a new schedule's first payment due today after the cut-off goes tomorrow. */
function sendOnFor(d, first) {
  const s = isBusinessDay(d) ? d : nextBusinessDay(d);
  return first && s === today() && pastCutoff(s) ? nextBusinessDay(s) : s;
}
const pad = n => String(n).padStart(2, '0');
/** The day of `d` in the k-th month after it, or that month's last day when it is shorter. */
function monthsAfter(d, k) {
  const [y, m, day] = d.split('-').map(Number), i = m - 1 + k, ny = y + Math.floor(i / 12), nm = (i % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(day, new Date(Date.UTC(ny, nm, 0)).getUTCDate()))}`;
}
/** The date of occurrence k (0, 1, 2 ...) of a schedule, or null when the schedule has no such occurrence. */
export function occurrence(s, k) {
  if (s.count != null && k >= s.count) return null;
  const d = s.frequency === 'once' ? (k === 0 ? s.start_date : null) : s.frequency === 'weekly' ? addDays(s.start_date, 7 * k)
    : s.frequency === 'biweekly' ? addDays(s.start_date, 14 * k) : monthsAfter(s.start_date, k);
  return d && (!s.end_date || d <= s.end_date) ? d : null;
}

/** Money held on an account for open scheduled bill payments from their hold date on, whoever scheduled them. */
export async function heldCents(c, accountId) {
  return (await c.query(`SELECT coalesce(sum(p.amount_cents), 0)::bigint AS held FROM billpay_payments p JOIN billpay_schedules s ON s.id = p.schedule_id
     WHERE s.from_account_id = $1 AND p.status IN ('scheduled', 'retrying') AND p.hold_on <= $2`, [accountId, today()])).rows[0].held;
}

// ---------- reading ----------
const SCHEDULE = `SELECT s.*, p.name payee_name, p.account_last4 payee_last4, p.removed_at payee_removed_at
  FROM billpay_schedules s JOIN payees p ON p.id = s.payee_id`;
/** The caller's schedule, or a 404 (someone else's, unknown or malformed: the same answer). */
async function mine(c, u, id, forUpdate = false) {
  const s = isUuid(id) ? (await c.query(`${SCHEDULE} WHERE s.id = $1 AND s.user_id = $2${forUpdate ? ' FOR UPDATE OF s' : ''}`, [id, u.id])).rows[0] : null;
  if (!s) throw new AppError(404, 'not_found', 'Scheduled payment not found.');
  return s;
}
const openPayment = async (c, scheduleId, forUpdate = false) => (await c.query(`SELECT * FROM billpay_payments WHERE schedule_id = $1
  AND status IN ('scheduled', 'retrying')${forUpdate ? ' FOR UPDATE' : ''}`, [scheduleId])).rows[0] ?? null;

function paymentView(p, s) {
  const open = OPEN.includes(p.status);
  return { id: p.id, scheduleId: p.schedule_id, sequence: p.sequence, scheduledFor: p.scheduled_for, sendOn: p.send_on, holdOn: p.hold_on,
    deliverBy: addBusinessDays(p.sent_on ?? p.send_on, DELIVERY_DAYS[methodOf(s)]),
    editableUntil: open ? cutoffAt('billpay', p.send_on).toISOString() : null,
    amountCents: cents(p.amount_cents), status: p.status, holdCents: open && today() >= p.hold_on ? cents(p.amount_cents) : 0,
    attempts: p.attempts, sentOn: p.sent_on, entryId: p.entry_id, feeCents: cents(p.fee_cents), failureCode: p.failure_code };
}
async function scheduleView(c, s) {
  const n = (await c.query(`SELECT count(*) FILTER (WHERE status = 'sent')::int sent, count(*) FILTER (WHERE status = 'failed')::int failed
     FROM billpay_payments WHERE schedule_id = $1`, [s.id])).rows[0];
  const p = s.status === 'active' ? await openPayment(c, s.id) : null;
  return { id: s.id, payeeId: s.payee_id, payeeName: s.payee_name, method: methodOf(s), fromAccountId: s.from_account_id,
    amountCents: cents(s.amount_cents), frequency: s.frequency, startDate: s.start_date, endDate: s.end_date, count: s.count, memo: s.memo,
    status: s.status, paymentsSent: n.sent, paymentsFailed: n.failed, nextPayment: p ? paymentView(p, s) : null, createdAt: s.created_at };
}

// ---------- request checks ----------
function readAmount(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_AMOUNT) throw bad('bad_amount', 'Enter the amount in whole cents, like 12550 for $125.50.');
  return BigInt(v);
}
function readStart(v) {
  const t = today(), max = addDays(t, DAYS_AHEAD);
  if (typeof v !== 'string' || !isDate(v) || v < t || v > max) throw bad('bad_date', `Choose a start date from ${t} to ${max}.`);
  return v;
}
function readMemo(v) {
  if (v == null) return null;
  const m = typeof v === 'string' ? v.trim() : null;
  if (m === null || [...m].length > MEMO_MAX) throw bad('bad_memo', `Keep the note to ${MEMO_MAX} characters or fewer.`);
  return m || null;
}
function readEnd(frequency, start, endDate, count) {
  const end = endDate ?? null, n = count ?? null;
  if (frequency === 'once') {
    if (end !== null || n !== null) throw bad('bad_end', 'A one-time payment has no end date or number of payments.');
  } else {
    if (end !== null && n !== null) throw bad('bad_end', 'Choose an end date or a number of payments, not both.');
    if (end !== null && (typeof end !== 'string' || !isDate(end) || end < start)) throw bad('bad_end', 'Choose an end date on or after the start date.');
    if (n !== null && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_COUNT)) throw bad('bad_end', `Choose 1 to ${MAX_COUNT} payments.`);
  }
  return { end, n };
}
async function payeeFor(c, u, id) {
  const p = isUuid(id) ? (await c.query('SELECT * FROM payees WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', [id, u.id])).rows[0] : null;
  if (!p) throw new AppError(404, 'not_found', 'Payee not found.');
  return p;
}
const overPerPayment = amount => {
  if (amount > MAX_PAYMENT) throw new AppError(422, 'over_limit', `Each scheduled bill payment can be up to ${usd(MAX_PAYMENT)}.`, { limit: 'per_payment' });
};
/**
 * A payment must fit the customer's bill pay daily limit for its send date, together with their other open payments due
 * that day and the bill pay limit already used on it. Exactly at the limit is allowed.
 */
async function checkDaily(c, userId, sendOn, amount, exceptPayment = null) {
  const l = await limitsFor(c, userId, 'billpay');
  const r = (await c.query(`SELECT
      (SELECT coalesce(sum(p.amount_cents), 0) FROM billpay_payments p JOIN billpay_schedules s ON s.id = p.schedule_id
        WHERE s.user_id = $1 AND p.status IN ('scheduled', 'retrying') AND p.send_on = $2 AND p.id IS DISTINCT FROM $3::uuid)::bigint AS open,
      (SELECT coalesce(sum(amount_cents), 0) FROM limit_usage WHERE user_id = $1 AND rail = 'billpay' AND booked_on = $2)::bigint AS used`,
  [userId, sendOn, exceptPayment])).rows[0];
  const left = l.daily - r.open - r.used;
  if (amount > left) throw new AppError(422, 'over_limit', `That's over your daily bill pay limit of ${usd(l.daily)} for ${sendOn}. You can schedule up to ${usd(left < 0n ? 0n : left)} more for that day.`, { limit: 'daily' });
}

// ---------- payments ----------
async function addPayment(c, s, k, scheduledFor) {
  const sendOn = sendOnFor(scheduledFor, k === 0), at = now();
  return (await c.query(`INSERT INTO billpay_payments (id, schedule_id, sequence, scheduled_for, send_on, hold_on, amount_cents, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [newId(), s.id, k + 1, scheduledFor, sendOn, previousBusinessDay(sendOn), s.amount_cents, at])).rows[0];
}
/** After payment n is final: payment n + 1 if that occurrence exists, otherwise the schedule is completed. */
async function advance(c, s, p) {
  const d = occurrence(s, p.sequence);
  if (d) return addPayment(c, s, p.sequence, d);
  await c.query("UPDATE billpay_schedules SET status = 'completed', updated_at = $2 WHERE id = $1", [s.id, now()]);
  return null;
}
const update = (c, id, fields) => c.query(`UPDATE billpay_payments SET ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${Object.keys(fields).length + 2}
  WHERE id = $1 RETURNING *`, [id, ...Object.values(fields), now()]).then(r => r.rows[0]);
const notify = (c, userId, p, event, kind, title, body) => c.query(`INSERT INTO notifications (user_id, kind, ref, title, body) VALUES ($1,$2,$3,$4,$5)
  ON CONFLICT (user_id, ref) DO NOTHING`, [userId, kind, `billpay:${p.id}:${event}`, title, body]);

const WHY = { over_limit: "it's over your daily or 30-day bill pay limit", account_not_open: "the account it comes from isn't open",
  payee_removed: 'the payee was removed, so the schedule was canceled', insufficient_funds: "there still wasn't enough money in the account" };

/** One attempt at a due payment: sent, retried (too little money the first time) or failed. Returns the payment as it is now. */
async function attempt(c, req, u, p0) {
  const s = await mine(c, u, p0.schedule_id, true);
  const acct = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [s.from_account_id])).rows[0];
  const t = today(), amount = BigInt(p0.amount_cents), tries = p0.attempts + 1, balance = BigInt(acct.balance_cents);
  const ref = { schedule: s.id, payment: p0.id };
  let reason = s.payee_removed_at ? 'payee_removed' : acct.status !== 'open' ? 'account_not_open' : null;
  if (!reason) { const l = await limitsFor(c, u.id, 'billpay'); if (amount > l.leftDay || amount > l.leftMonth) reason = 'over_limit'; }
  if (!reason && balance < amount) {
    if (tries === 1) {                                     // the first time: try again on the next business day, still held
      const retryOn = nextBusinessDay(t);
      const p = await update(c, p0.id, { status: 'retrying', attempts: tries, failure_code: 'insufficient_funds', send_on: retryOn, hold_on: previousBusinessDay(retryOn) });
      await audit(c, req, u.id, 'billpay.payment_retry', { ...ref, reason: 'insufficient_funds', retryOn, amountCents: cents(amount) });
      await notify(c, u.id, p, 'retry', 'billpay_retry', `Bill payment will be retried: ${s.payee_name}`,
        `There wasn't enough money in ${label(acct)} for your ${usd(amount)} payment to ${s.payee_name}. We'll try again on ${retryOn} at 2:00 pm CT; add money before then. The amount stays held until then.`);
      return p;
    }
    reason = 'insufficient_funds';
  }
  if (reason) {
    let fee = 0n, feeEntry = null;
    if (reason === 'insufficient_funds' && balance > 0n) {  // the fee never takes the account below zero
      fee = balance < NSF_FEE ? balance : NSF_FEE;
      feeEntry = (await post(c, { key: `${s.user_id}:${FEATURE}:${p0.id}:fee`, kind: 'bill_pay_fee', createdBy: u.id, lines: [
        { accountId: acct.id, amountCents: -fee, description: `Insufficient funds fee: bill payment to ${s.payee_name}`, category: 'Fees & Charges', postedOn: t },
        { accountId: await systemAccount(c, 'billpay_fees'), amountCents: fee, description: `Insufficient funds fee: bill payment to ${s.payee_name}`, postedOn: t }] })).entryId;
    }
    const p = await update(c, p0.id, { status: 'failed', attempts: tries, failure_code: reason, fee_cents: fee, fee_entry_id: feeEntry });
    if (reason === 'payee_removed') await c.query("UPDATE billpay_schedules SET status = 'canceled', updated_at = $2 WHERE id = $1", [s.id, now()]);
    else await advance(c, s, p);
    await audit(c, req, u.id, 'billpay.payment_failed', { ...ref, reason, feeCents: cents(fee), amountCents: cents(amount), entry: feeEntry });
    await notify(c, u.id, p, 'failed', 'billpay_failed', `Bill payment failed: ${s.payee_name}`,
      `Your ${usd(amount)} payment to ${s.payee_name} from ${label(acct)} was not sent because ${WHY[reason]}.${fee ? ` An insufficient funds fee of ${usd(fee)} was charged.` : ''}`);
    return p;
  }
  const key = `${s.user_id}:${FEATURE}:${p0.id}:send`, deliverBy = addBusinessDays(t, DELIVERY_DAYS[methodOf(s)]), at = now();
  const e = await post(c, { key, kind: 'bill_pay', memo: s.memo, createdBy: u.id, lines: [
    { accountId: acct.id, amountCents: -amount, description: `Bill pay: ${s.payee_name}`, category: 'Bills & Utilities', postedOn: t },
    { accountId: await systemAccount(c, 'mm_billpay'), amountCents: amount, description: `Bill pay: ${s.payee_name}`, postedOn: t }] });
  // a billpay transfer like the ones /api/pay/bills makes, so /api/pay/run-due pays it out on its deliver-by day
  const tr = (await c.query(`INSERT INTO transfers (id, user_id, rail, from_account_id, payee_id, counterparty, amount_cents, memo, status, process_on, settles_on,
      booked_on, idempotency_key, entry_id, created_at, updated_at) VALUES ($1,$2,'billpay',$3,$4,$5,$6,$7,'sent',$8,$9,$8,$10,$11,$12,$12) RETURNING *`,
  [newId(), s.user_id, acct.id, s.payee_id, s.payee_name, amount, s.memo, t, deliverBy, key, e.entryId, at])).rows[0];
  await useLimit(c, tr);
  const p = await update(c, p0.id, { status: 'sent', attempts: tries, sent_on: t, entry_id: e.entryId, transfer_id: tr.id, failure_code: null });
  await advance(c, s, p);
  await audit(c, req, u.id, 'billpay.payment_sent', { ...ref, entry: e.entryId, transfer: tr.id, amountCents: cents(amount), sentOn: t, deliverBy });
  await notify(c, u.id, p, 'sent', 'billpay_sent', `Bill payment sent: ${s.payee_name}`,
    `Your ${usd(amount)} payment to ${s.payee_name} was sent from ${label(acct)} on ${t}. It should arrive by ${deliverBy}.`);
  return p;
}

/** Sends every payment of this customer whose send date's cut-off has come, oldest first, until none is due. */
async function runDue(c, req, u) {
  await lock(c, u.id);
  const out = [];
  for (let i = 0; i < 10_000; i++) {
    const t = today(), dueThrough = pastCutoff(t) ? t : addDays(t, -1);
    const p = (await c.query(`SELECT p.* FROM billpay_payments p JOIN billpay_schedules s ON s.id = p.schedule_id
       WHERE s.user_id = $1 AND s.status = 'active' AND p.status IN ('scheduled', 'retrying') AND p.send_on <= $2
       ORDER BY p.send_on, s.created_at, s.seq LIMIT 1 FOR UPDATE OF p`, [u.id, dueThrough])).rows[0];
    if (!p) break;
    const done = await attempt(c, req, u, p);
    out.push(paymentView(done, await mine(c, u, done.schedule_id)));
  }
  const n = st => out.filter(p => p.status === st).length;
  return { payments: out, sent: n('sent'), retrying: n('retrying'), failed: n('failed') };
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body, query }) => tx(pool, async c => fn(c, req, await requireUser(c, req), { body, params, query }));

  r.add('POST', '/api/billpay/schedules', h(async (c, req, u, { body }) => {
    const key = `${u.id}:${FEATURE}:${requestKey(body)}`;
    const fingerprint = fingerprintOf({}, { payeeId: body.payeeId ?? null, fromAccountId: body.fromAccountId ?? null, amountCents: body.amountCents ?? null,
      frequency: body.frequency ?? null, startDate: body.startDate ?? null, endDate: body.endDate ?? null, count: body.count ?? null, memo: body.memo ?? null });
    await lock(c, u.id);
    const prev = (await c.query('SELECT id, fingerprint FROM billpay_schedules WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) {
      if (prev.fingerprint !== fingerprint) throw conflict();
      return { schedule: await scheduleView(c, await mine(c, u, prev.id)), replayed: true };
    }
    const amount = readAmount(body.amountCents);
    if (!FREQUENCIES.includes(body.frequency)) throw bad('bad_frequency', 'Choose once, weekly, every two weeks or monthly.');
    const start = readStart(body.startDate), { end, n } = readEnd(body.frequency, start, body.endDate, body.count), memo = readMemo(body.memo);
    if (typeof body.payeeId !== 'string') throw bad('bad_payee', 'Choose a payee.');
    if (typeof body.fromAccountId !== 'string') throw bad('bad_account', 'Choose an account to pay from.');
    const p = await payeeFor(c, u, body.payeeId);
    const a = await accountFor(c, u.id, body.fromAccountId, OWN);
    if (!KINDS.includes(a.kind)) throw bad('bad_account', 'Choose a checking, savings or money market account to pay from.');
    if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open for payments.`);
    requireStepUp(u);
    overPerPayment(amount);
    const first = sendOnFor(start, true);
    await checkDaily(c, u.id, first, amount);
    const id = newId(), at = now();
    const s = (await c.query(`INSERT INTO billpay_schedules (id, user_id, payee_id, from_account_id, amount_cents, frequency, start_date, end_date, count, memo,
        idempotency_key, fingerprint, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
    [id, u.id, p.id, a.id, amount, body.frequency, start, end, n, memo, key, fingerprint, at])).rows[0];
    const pay = await addPayment(c, s, 0, start);
    await audit(c, req, u.id, 'billpay.schedule_create', { schedule: id, payee: p.id, from: a.number_last4, amountCents: cents(amount), frequency: s.frequency,
      startDate: start, endDate: end, count: n, payment: pay.id, sendOn: pay.send_on });
    return { schedule: await scheduleView(c, await mine(c, u, id)), replayed: false };
  }));

  r.add('GET', '/api/billpay/schedules', h(async (c, req, u, { query }) => {
    if (query.status !== undefined && !STATUSES.includes(query.status)) throw bad('bad_status', 'Choose active, completed or canceled.');
    const rows = (await c.query(`${SCHEDULE} WHERE s.user_id = $1 AND ($2::text IS NULL OR s.status = $2) ORDER BY s.created_at DESC, s.seq DESC`,
      [u.id, query.status ?? null])).rows;
    const out = []; for (const s of rows) out.push(await scheduleView(c, s));
    return { schedules: out };
  }));

  r.add('GET', '/api/billpay/schedules/:id', h(async (c, req, u, { params }) => {
    const s = await mine(c, u, params.id);
    const payments = (await c.query('SELECT * FROM billpay_payments WHERE schedule_id = $1 ORDER BY sequence', [s.id])).rows;
    return { schedule: await scheduleView(c, s), payments: payments.map(p => paymentView(p, s)) };
  }));

  r.add('POST', '/api/billpay/schedules/:id/edit', h(async (c, req, u, { body, params }) => {
    await lock(c, u.id);
    const s = await mine(c, u, params.id, true);
    if (body.amountCents === undefined && body.memo === undefined) throw bad('bad_edit', 'Change the amount, the note or both.');
    const old = BigInt(s.amount_cents);
    const amount = body.amountCents === undefined ? old : readAmount(body.amountCents);
    const memo = body.memo === undefined ? s.memo : readMemo(body.memo);
    if (s.status !== 'active') throw new AppError(409, 'invalid_state', `This schedule is ${s.status}, so it can't be changed.`);
    const p = await openPayment(c, s.id, true);
    if (pastCutoff(p.send_on)) throw new AppError(409, 'cutoff_passed', `The next payment is being sent on ${p.send_on} (2:00 pm CT cut-off), so it can't be changed now.`);
    if (amount === old && memo === s.memo) return { schedule: await scheduleView(c, s) };
    if (amount > old) requireStepUp(u);                       // raising what leaves the account needs a fresh code
    if (amount !== old) { overPerPayment(amount); await checkDaily(c, u.id, p.send_on, amount, p.id); }
    await c.query('UPDATE billpay_schedules SET amount_cents = $2, memo = $3, updated_at = $4 WHERE id = $1', [s.id, amount, memo, now()]);
    await update(c, p.id, { amount_cents: amount });
    await audit(c, req, u.id, 'billpay.schedule_edit', { schedule: s.id, payment: p.id, amountCents: cents(amount), previousAmountCents: cents(old), memoChanged: memo !== s.memo });
    return { schedule: await scheduleView(c, await mine(c, u, s.id)) };
  }));

  r.add('POST', '/api/billpay/schedules/:id/cancel', h(async (c, req, u, { params }) => {
    await lock(c, u.id);
    const s = await mine(c, u, params.id, true);
    if (s.status !== 'active') throw new AppError(409, 'invalid_state', `This schedule is already ${s.status}.`);
    const p = await openPayment(c, s.id, true);
    if (pastCutoff(p.send_on)) throw new AppError(409, 'cutoff_passed', `The next payment is being sent on ${p.send_on} (2:00 pm CT cut-off), so it can't be canceled now.`);
    await update(c, p.id, { status: 'canceled' });
    await c.query("UPDATE billpay_schedules SET status = 'canceled', updated_at = $2 WHERE id = $1", [s.id, now()]);
    await audit(c, req, u.id, 'billpay.schedule_cancel', { schedule: s.id, payment: p.id, amountCents: cents(p.amount_cents) });
    return { schedule: await scheduleView(c, await mine(c, u, s.id)) };
  }));

  r.add('POST', '/api/billpay/run-due', h(async (c, req, u) => runDue(c, req, u)));

  r.add('GET', '/api/billpay/availability/:accountId', h(async (c, req, u, { params }) => {
    const a = await accountFor(c, u.id, params.accountId, OWN);
    const balance = BigInt(a.balance_cents), held = await heldCents(c, a.id);
    return { accountId: a.id, balanceCents: cents(balance), heldCents: cents(held), availableCents: cents(balance - held) };
  }));

  r.add('GET', '/api/billpay/quote', h(async (c, req, u, { query }) => {
    const start = readStart(query.startDate);
    if (!query.payeeId) throw bad('bad_payee', 'Choose a payee.');
    const p = await payeeFor(c, u, query.payeeId), method = p.account_last4 ? 'electronic' : 'check', sendOn = sendOnFor(start, true);
    return { method, sendOn, holdOn: previousBusinessDay(sendOn), deliverBy: addBusinessDays(sendOn, DELIVERY_DAYS[method]),
      editableUntil: cutoffAt('billpay', sendOn).toISOString() };
  }));
}
