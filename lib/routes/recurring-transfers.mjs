// Recurring transfers: a fixed amount moved weekly or monthly between two of the customer's own accounts, with pause,
// resume, cancel and a run that carries out every occurrence that has come due. An occurrence that can't go (not open,
// over a limit, not enough money) is recorded as failed and skipped; the schedule carries on with its next date.
// Amounts are BigInt cents inside; this API's contract sends them as JSON integers (amountCents), at most $100,000,000.00,
// so they convert exactly at the edge (cents in, cents out).
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post } from '../ledger.mjs';
import { toStr, usd } from '../money.mjs';
import { isDate } from '../dates.mjs';
import { clock, bankToday, addDays } from '../bank-date.mjs';
import { checkLimit, stepUpFor, useLimit } from '../money-movement/limits.mjs';

const FEATURE = 'recurring-transfers';
const OWN = ['owner', 'joint_owner'];                     // only accounts the customer owns, never a child's or a viewer's
const KINDS = ['checking', 'savings', 'money_market'];
const CADENCES = ['weekly', 'monthly'];
const STATUSES = ['active', 'paused', 'completed', 'canceled'];
export const MAX_AMOUNT = 10_000_000_000;                 // $100,000,000.00 in cents
export const MAX_RUNS = 520, MAX_SCHEDULES = 25, PER_RUN = 12, MEMO_MAX = 140, START_WITHIN_DAYS = 365;

const now = () => clock.now();
const label = a => `${a.name} ··${a.number_last4}`;
const lock = (c, userId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:${userId}`]);
const bad = (code, msg) => new AppError(400, code, msg);
const given = v => v !== undefined && v !== null;                // null counts as absent
const pad = n => String(n).padStart(2, '0');

/** Occurrence k (0 = startDate): every 7 days, or the start's day of the month k months on, clamped to short months. */
export function occurrence(cadence, start, k) {
  if (cadence === 'weekly') return addDays(start, 7 * k);
  const [y, m, d] = start.split('-').map(Number), mi = m - 1 + k;
  const ny = y + Math.floor(mi / 12), nm = (mi % 12) + 1, last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

const scheduleView = s => ({ id: s.id, fromAccountId: s.from_account_id, toAccountId: s.to_account_id, amountCents: Number(s.amount_cents),
  cadence: s.cadence, startDate: s.start_date, endDate: s.end_date, maxRuns: s.max_runs, memo: s.memo, status: s.status,
  nextRunDate: s.status === 'active' ? s.next_on : null, runsPosted: s.runs_posted, runsFailed: s.runs_failed,
  createdAt: new Date(s.created_at).toISOString() });
const runView = r => ({ id: r.id, scheduleId: r.schedule_id, scheduledFor: r.scheduled_for, status: r.status, amountCents: Number(r.amount_cents),
  entryId: r.entry_id, failureCode: r.failure_code, failureMessage: r.failure_message, executedAt: new Date(r.executed_at).toISOString() });

/** The caller's schedule, locked, or a 404 (someone else's, unknown or malformed id: all the same). */
async function mine(c, userId, id) {
  if (!isUuid(id)) throw new AppError(404, 'not_found', 'Recurring transfer not found.');
  const s = (await c.query('SELECT * FROM recurring_transfers WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId])).rows[0];
  if (!s) throw new AppError(404, 'not_found', 'Recurring transfer not found.');
  return s;
}
const invalidState = s => new AppError(409, 'invalid_state', `This recurring transfer is ${s.status}, so it can't be changed that way.`);

// ---------- create: checks in the order the requirements give ----------
function readFields(body, today) {
  const a = body.amountCents;
  if (typeof a !== 'number' || !Number.isInteger(a) || a < 1 || a > MAX_AMOUNT)
    throw bad('bad_amount', `Enter the amount in whole cents, from 1 to ${MAX_AMOUNT} (${usd(BigInt(MAX_AMOUNT))}).`);
  if (!CADENCES.includes(body.cadence)) throw bad('bad_cadence', 'Choose weekly or monthly.');
  const latest = addDays(today, START_WITHIN_DAYS);
  if (typeof body.startDate !== 'string' || !isDate(body.startDate)) throw bad('bad_date', 'Start date: enter a real date, like 2026-11-15.');
  if (body.startDate < today || body.startDate > latest) throw bad('bad_date', `Choose a start date from ${today} to ${latest}.`);
  if (given(body.endDate) && given(body.maxRuns)) throw bad('bad_end', 'Choose an end date or a number of transfers, not both.');
  if (given(body.endDate) && (typeof body.endDate !== 'string' || !isDate(body.endDate) || body.endDate < body.startDate))
    throw bad('bad_end', 'End date: enter a real date on or after the start date.');
  if (given(body.maxRuns) && (typeof body.maxRuns !== 'number' || !Number.isInteger(body.maxRuns) || body.maxRuns < 1 || body.maxRuns > MAX_RUNS))
    throw bad('bad_end', `Number of transfers: enter a whole number from 1 to ${MAX_RUNS}.`);
  let memo = null;
  if (given(body.memo)) {
    if (typeof body.memo !== 'string') throw bad('bad_memo', 'The note must be text.');
    memo = body.memo.trim() || null;
    if (memo && [...memo].length > MEMO_MAX) throw bad('bad_memo', `Keep the note to ${MEMO_MAX} characters or fewer.`);
  }
  for (const k of ['fromAccountId', 'toAccountId'])
    if (typeof body[k] !== 'string' || !body[k]) throw bad('bad_account', 'Choose an account to transfer from and one to transfer to.');
  return { amount: BigInt(a), cadence: body.cadence, start: body.startDate, end: given(body.endDate) ? body.endDate : null,
    maxRuns: given(body.maxRuns) ? body.maxRuns : null, memo };
}

/** What makes two create requests "the same": the fields, with null treated as absent. */
const fingerprint = body => fingerprintOf({}, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)));

async function create(c, req, u, body) {
  const key = requestKey(body), fp = fingerprint(body);
  await lock(c, u.id);                                    // one create, run or state change per customer at a time
  const prev = (await c.query('SELECT * FROM recurring_transfers WHERE user_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
  if (prev) {
    if (prev.fingerprint !== fp) throw conflict();
    return { schedule: scheduleView(prev), replayed: true };
  }
  const t = bankToday(), f = readFields(body, t);
  const from = await accountFor(c, u.id, body.fromAccountId, OWN), to = await accountFor(c, u.id, body.toAccountId, OWN);
  for (const a of [from, to]) if (!KINDS.includes(a.kind)) throw bad('bad_account', `${label(a)} can't be used for recurring transfers. Choose a checking, savings or money market account.`);
  if (from.id === to.id) throw bad('same_account', 'Choose two different accounts.');
  for (const a of [from, to]) if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open for transfers.`);
  await stepUpFor(c, u, 'internal', f.amount);            // the same threshold as a one-off transfer between your own accounts
  const live = (await c.query("SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1 AND status IN ('active', 'paused')", [u.id])).rows[0].n;
  if (live >= MAX_SCHEDULES) throw new AppError(422, 'schedule_limit', `You can have up to ${MAX_SCHEDULES} active or paused recurring transfers. Cancel one to set up another.`);
  const id = newId(), at = now();
  const s = (await c.query(`INSERT INTO recurring_transfers (id, user_id, from_account_id, to_account_id, amount_cents, cadence, start_date, end_date, max_runs,
      memo, next_on, idempotency_key, fingerprint, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7,$11,$12,$13,$13) RETURNING *`,
    [id, u.id, from.id, to.id, f.amount, f.cadence, f.start, f.end, f.maxRuns, f.memo, key, fp, at])).rows[0];
  await audit(c, req, u.id, 'recurring.create', { schedule: id, from: from.number_last4, to: to.number_last4, amount: toStr(f.amount),
    cadence: f.cadence, start: f.start, end: f.end, maxRuns: f.maxRuns });
  return { schedule: scheduleView(s), replayed: false };
}

// ---------- run ----------
/** An account as it is now, with the caller's role on it (null when they no longer have one). */
const accountNow = async (c, userId, id) => (await c.query(`SELECT a.*, o.role FROM accounts a
  LEFT JOIN account_owners o ON o.account_id = a.id AND o.user_id = $2 WHERE a.id = $1`, [id, userId])).rows[0];

/** Carries out one occurrence: posts it, or records why it couldn't go. Returns the run row. */
async function occur(c, req, u, s, t) {
  const on = s.next_on, key = `${u.id}:${FEATURE}:${s.id}:${on}`;
  const from = await accountNow(c, u.id, s.from_account_id), to = await accountNow(c, u.id, s.to_account_id);
  const amount = BigInt(s.amount_cents);
  let failure = null;
  const closed = [from, to].find(a => a.status !== 'open' || !OWN.includes(a.role));
  if (closed) failure = ['account_not_open', `${label(closed)} isn't open for transfers, so this transfer was skipped.`];
  if (!failure) {
    try { await checkLimit(c, req, u.id, 'internal', amount); }      // per-transfer, daily and 30-day, as a one-off transfer
    catch (e) { if (!(e instanceof AppError) || e.code !== 'over_limit') throw e; failure = ['over_limit', `${e.message} This transfer was skipped.`]; }
  }
  const short = `${label(from)} didn't have enough money for this ${usd(amount)} transfer, so it was skipped.`;
  if (!failure && !from.allow_negative && BigInt(from.balance_cents) < amount) failure = ['insufficient_funds', short];
  let entryId = null, transferId = null;
  if (!failure) {
    try {
      entryId = (await post(c, { key, kind: 'recurring_transfer', memo: s.memo, createdBy: u.id, lines: [
        { accountId: from.id, amountCents: -amount, description: `Recurring transfer to ${label(to)}`, category: 'Transfers', postedOn: t },
        { accountId: to.id, amountCents: amount, description: `Recurring transfer from ${label(from)}`, category: 'Transfers', postedOn: t }] })).entryId;
    } catch (e) { if (!(e instanceof AppError) || e.code !== 'insufficient_funds') throw e; failure = ['insufficient_funds', short]; }
  }
  if (!failure) {                                         // the transfer row is what the limit usage ledger counts, like a one-off transfer
    const at = now();
    const tr = (await c.query(`INSERT INTO transfers (id, user_id, rail, from_account_id, to_account_id, counterparty, amount_cents, memo, status, process_on, booked_on,
        idempotency_key, entry_id, created_at, updated_at) VALUES ($1,$2,'internal',$3,$4,$5,$6,$7,'completed',$8,$8,$9,$10,$11,$11) RETURNING *`,
      [newId(), u.id, from.id, to.id, label(to), amount, s.memo, t, key, entryId, at])).rows[0];
    await useLimit(c, tr);
    transferId = tr.id;
  }
  const run = (await c.query(`INSERT INTO recurring_transfer_runs (id, schedule_id, user_id, scheduled_for, status, amount_cents, entry_id, transfer_id,
      failure_code, failure_message, executed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [newId(), s.id, u.id, on, failure ? 'failed' : 'posted', amount, entryId, transferId, failure?.[0] ?? null, failure?.[1] ?? null, now()])).rows[0];
  if (failure) s.runs_failed++; else s.runs_posted++;
  await audit(c, req, u.id, failure ? 'recurring.run_failed' : 'recurring.run_posted', { schedule: s.id, scheduledFor: on, amount: toStr(amount),
    from: from.number_last4, to: to.number_last4, ...(failure ? { failureCode: failure[0] } : { entry: entryId }) });
  // move on to the next occurrence, or finish: the maxRuns-th one, or the last one on or before endDate
  s.next_index++;
  const next = occurrence(s.cadence, s.start_date, s.next_index);
  if ((s.max_runs != null && s.runs_posted + s.runs_failed >= s.max_runs) || (s.end_date != null && next > s.end_date)) s.status = 'completed';
  else s.next_on = next;
  return run;
}

/** Every occurrence due today or earlier on the caller's active schedules, oldest first (at most PER_RUN per schedule). */
export async function runDue(c, req, u) {
  const t = bankToday();
  await lock(c, u.id);                                    // two runs at once: the second waits, then finds nothing left to do
  const due = (await c.query(`SELECT * FROM recurring_transfers WHERE user_id = $1 AND status = 'active' AND next_on <= $2 ORDER BY next_on, seq FOR UPDATE`, [u.id, t])).rows;
  const count = new Map(due.map(s => [s.id, 0])), runs = [];
  for (;;) {
    const ready = due.filter(s => s.status === 'active' && s.next_on <= t && count.get(s.id) < PER_RUN);
    if (!ready.length) break;
    const s = ready.reduce((a, b) => (b.next_on < a.next_on ? b : a));   // in date order across schedules, so money is used in the order it came due
    runs.push(await occur(c, req, u, s, t));
    count.set(s.id, count.get(s.id) + 1);
  }
  for (const s of due) if (count.get(s.id))
    await c.query(`UPDATE recurring_transfers SET status = $2, next_index = $3, next_on = $4, runs_posted = $5, runs_failed = $6, updated_at = $7 WHERE id = $1`,
      [s.id, s.status, s.next_index, s.next_on, s.runs_posted, s.runs_failed, now()]);
  runs.sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : a.scheduled_for > b.scheduled_for ? 1 : 0));
  const views = runs.map(runView);
  return { runs: views, posted: views.filter(r => r.status === 'posted').length, failed: views.filter(r => r.status === 'failed').length };
}

// ---------- pause, resume, cancel ----------
async function setState(c, req, u, s, fields, action) {
  const cols = Object.keys(fields);
  const row = (await c.query(`UPDATE recurring_transfers SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${cols.length + 2} WHERE id = $1 RETURNING *`,
    [s.id, ...Object.values(fields), now()])).rows[0];
  await audit(c, req, u.id, action, { schedule: s.id, from: s.status, to: row.status });
  return { schedule: scheduleView(row) };
}

/** Resuming skips what fell due while paused: the next occurrence is the first one not yet processed dated today or later. */
async function resume(c, req, u, s) {
  if (s.status !== 'paused') throw invalidState(s);
  await stepUpFor(c, u, 'internal', BigInt(s.amount_cents));
  const t = bankToday();
  let k = s.next_index, on = occurrence(s.cadence, s.start_date, k);
  while (on < t) on = occurrence(s.cadence, s.start_date, ++k);
  if (s.end_date != null && on > s.end_date) return setState(c, req, u, s, { status: 'completed' }, 'recurring.resume');
  return setState(c, req, u, s, { status: 'active', next_index: k, next_on: on }, 'recurring.resume');
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body, query }) => tx(pool, async c => fn(c, req, await requireUser(c, req), body, params, query));
  const change = fn => h(async (c, req, u, body, { id }) => { await lock(c, u.id); return fn(c, req, u, await mine(c, u.id, id)); });

  r.add('POST', '/api/recurring-transfers/run', h(async (c, req, u) => runDue(c, req, u)));
  r.add('POST', '/api/recurring-transfers', h(async (c, req, u, body) => create(c, req, u, body)));

  r.add('GET', '/api/recurring-transfers', h(async (c, req, u, body, params, query) => {
    if (query.status !== undefined && !STATUSES.includes(query.status)) throw bad('bad_status', 'Choose active, paused, completed or canceled.');
    const rows = (await c.query(`SELECT * FROM recurring_transfers WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, seq DESC`,
      [u.id, query.status ?? null])).rows;
    return { schedules: rows.map(scheduleView) };
  }));
  r.add('GET', '/api/recurring-transfers/:id', h(async (c, req, u, body, { id }) => {
    const s = await mine(c, u.id, id);
    const runs = (await c.query('SELECT * FROM recurring_transfer_runs WHERE schedule_id = $1 ORDER BY scheduled_for', [s.id])).rows;
    return { schedule: scheduleView(s), runs: runs.map(runView) };
  }));

  r.add('POST', '/api/recurring-transfers/:id/pause', change(async (c, req, u, s) => {
    if (s.status !== 'active') throw invalidState(s);
    return setState(c, req, u, s, { status: 'paused' }, 'recurring.pause');
  }));
  r.add('POST', '/api/recurring-transfers/:id/resume', change(resume));
  r.add('POST', '/api/recurring-transfers/:id/cancel', change(async (c, req, u, s) => {
    if (!['active', 'paused'].includes(s.status)) throw invalidState(s);
    return setState(c, req, u, s, { status: 'canceled' }, 'recurring.cancel');
  }));
}
