// Recurring transfers: a fixed amount between two of the customer's own accounts, weekly or monthly, from a start date until
// an end date, a number of transfers, or cancel. POST /api/recurring-transfers/run carries out every occurrence that has come
// due (oldest first, at most MAX_PER_RUN per schedule per call). An occurrence that can't go (account not open, over a limit,
// not enough money) is recorded as failed and skipped; the schedule carries on with its next date.
// Money moves only through post(); each occurrence has its own ledger idempotency key, so it is posted at most once.
// Amounts in this API are JSON integers of cents (amountCents), not dollar strings (the feature's spec).
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post } from '../ledger.mjs';
import { toStr, usd } from '../money.mjs';
import { clock, bankToday, addDays } from '../bank-date.mjs';
import { isDate } from '../dates.mjs';
import { checkLimit, stepUpFor } from '../money-movement/limits.mjs';
import { occurrence, firstOnOrAfter } from '../recurring-transfers/occurrences.mjs';

const FEATURE = 'recurring-transfers';
const OWN = ['owner', 'joint_owner'];                          // only accounts the customer owns (not custodian, minor or viewer)
const KINDS = ['checking', 'savings', 'money_market'];
const CADENCES = ['weekly', 'monthly'];
const STATUSES = ['active', 'paused', 'completed', 'canceled'];
export const MAX_AMOUNT = 10_000_000_000;                       // cents: $100,000,000.00
export const MAX_AHEAD_DAYS = 365;                              // a schedule starts from today up to a year ahead
export const MAX_RUNS = 520;                                    // ten years of weekly transfers
export const MAX_MEMO = 140;
export const MAX_OPEN = 25;                                     // active or paused schedules per customer
export const MAX_PER_RUN = 12;                                  // occurrences of one schedule processed per run call

const now = () => clock.now();
const label = a => `${a.name} ··${a.number_last4}`;
const lock = (c, userId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:${userId}`]);
const bad = (code, message) => new AppError(400, code, message);

const view = s => ({
  id: s.id, fromAccountId: s.from_account_id, toAccountId: s.to_account_id, amountCents: Number(s.amount_cents), cadence: s.cadence,
  startDate: s.start_date, endDate: s.end_date ?? null, maxRuns: s.max_runs ?? null, memo: s.memo ?? null, status: s.status,
  nextRunDate: s.status === 'active' ? s.next_run : null, runsPosted: s.runs_posted, runsFailed: s.runs_failed,
  createdAt: new Date(s.created_at).toISOString()
});
const runView = r => ({
  id: r.id, scheduleId: r.schedule_id, scheduledFor: r.scheduled_for, status: r.status, amountCents: Number(r.amount_cents),
  entryId: r.entry_id ?? null, failureCode: r.failure_code ?? null, failureMessage: r.failure_message ?? null,
  executedAt: new Date(r.executed_at).toISOString()
});

/** The caller's schedule (locked for the change), or a 404 for someone else's, an unknown or a malformed id. */
async function mine(c, userId, id) {
  const s = isUuid(id) ? (await c.query('SELECT * FROM recurring_transfers WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId])).rows[0] : null;
  if (!s) throw new AppError(404, 'not_found', 'Recurring transfer not found.');
  return s;
}

// ---------- create ----------
/** The request's fields, checked in the documented order (amount, cadence, start date, end condition, memo, account ids). */
function readCreate(body) {
  const amount = body.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT)
    throw bad('bad_amount', `Enter the amount in whole cents, from 1 to ${MAX_AMOUNT} (${usd(BigInt(MAX_AMOUNT))}).`);
  if (!CADENCES.includes(body.cadence)) throw bad('bad_cadence', 'Choose weekly or monthly.');
  const t = bankToday(), last = addDays(t, MAX_AHEAD_DAYS);
  const start = body.startDate;
  if (typeof start !== 'string' || !isDate(start)) throw bad('bad_date', 'Start date: enter a real date, like 2026-11-15.');
  if (start < t || start > last) throw bad('bad_date', `Choose a start date from ${t} to ${last}.`);
  const endDate = body.endDate ?? null, maxRuns = body.maxRuns ?? null;
  if (endDate !== null && maxRuns !== null) throw bad('bad_end', 'Choose an end date or a number of transfers, not both.');
  if (endDate !== null && (typeof endDate !== 'string' || !isDate(endDate) || endDate < start))
    throw bad('bad_end', 'End date: enter a real date on or after the start date.');
  if (maxRuns !== null && (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS))
    throw bad('bad_end', `Number of transfers: choose a whole number from 1 to ${MAX_RUNS}.`);
  let memo = body.memo ?? null;
  if (memo !== null) {
    if (typeof memo !== 'string') throw bad('bad_memo', 'The note must be text.');
    memo = memo.trim() || null;
    if (memo && [...memo].length > MAX_MEMO) throw bad('bad_memo', `Keep the note to ${MAX_MEMO} characters or fewer.`);
  }
  for (const k of ['fromAccountId', 'toAccountId'])
    if (typeof body[k] !== 'string' || !body[k]) throw bad('bad_account', 'Choose the account to send from and the account to send to.');
  return { amount: BigInt(amount), cadence: body.cadence, start, endDate, maxRuns, memo, fromId: body.fromAccountId, toId: body.toAccountId };
}

async function create(c, req, u, body) {
  const key = requestKey(body), fingerprint = fingerprintOf({}, body);
  await lock(c, u.id);                                          // two requests at once: the second waits, then replays or is refused
  const prev = (await c.query('SELECT * FROM recurring_transfers WHERE user_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
  if (prev) {
    if (prev.idempotency_fingerprint !== fingerprint) throw conflict();
    return { schedule: view(prev), replayed: true };
  }
  const f = readCreate(body);
  const from = await accountFor(c, u.id, f.fromId, OWN), to = await accountFor(c, u.id, f.toId, OWN);
  if (!KINDS.includes(from.kind) || !KINDS.includes(to.kind)) throw bad('bad_account', 'Choose checking, savings or money market accounts.');
  if (from.id === to.id) throw bad('same_account', 'Choose two different accounts.');
  for (const a of [from, to]) if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${label(a)} isn't open for transfers.`);
  await stepUpFor(c, u, 'internal', f.amount);                  // the one-off threshold between your own accounts ($5,000)
  const open = (await c.query("SELECT count(*)::int n FROM recurring_transfers WHERE user_id = $1 AND status IN ('active', 'paused')", [u.id])).rows[0].n;
  if (open >= MAX_OPEN) throw new AppError(422, 'schedule_limit', `You can have up to ${MAX_OPEN} active or paused recurring transfers. Cancel one to add another.`);
  const id = newId(), at = now();
  const s = (await c.query(`INSERT INTO recurring_transfers (id, user_id, from_account_id, to_account_id, amount_cents, cadence, start_date, end_date, max_runs, memo,
      status, next_index, next_run, idempotency_key, idempotency_fingerprint, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',0,$7,$11,$12,$13,$13) RETURNING *`,
    [id, u.id, from.id, to.id, f.amount, f.cadence, f.start, f.endDate, f.maxRuns, f.memo, key, fingerprint, at])).rows[0];
  await audit(c, req, u.id, 'recurring.create', { schedule: id, from: from.number_last4, to: to.number_last4, amount: toStr(f.amount), cadence: f.cadence,
    startDate: f.start, endDate: f.endDate, maxRuns: f.maxRuns });
  return { schedule: view(s), replayed: false };
}

// ---------- run ----------
/** The account as the customer may use it now (own role only), or null when it is gone from them. */
const ownAccount = async (c, userId, id) => (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
  WHERE a.id = $1 AND o.user_id = $2 AND o.role = ANY($3) AND a.kind <> 'system'`, [id, userId, OWN])).rows[0] ?? null;

/** Processes one occurrence: posts it, or records why it failed. Returns the run row. */
async function processOccurrence(c, req, u, s, index, date) {
  const t = bankToday(), amount = BigInt(s.amount_cents), runId = newId();
  const from = await ownAccount(c, u.id, s.from_account_id), to = await ownAccount(c, u.id, s.to_account_id);
  let failure = null, entryId = null;
  if (!from || !to || from.status !== 'open' || to.status !== 'open') {
    const which = !from || from.status !== 'open' ? from : to;
    failure = ['account_not_open', which ? `${label(which)} isn't open for transfers, so this transfer was skipped.` : 'One of the accounts is no longer available, so this transfer was skipped.'];
  }
  if (!failure) {
    try { await checkLimit(c, req, u.id, 'internal', amount); }              // per-transfer, daily and 30-day, as for a one-off transfer
    catch (e) { if (!(e instanceof AppError) || e.code !== 'over_limit') throw e; failure = ['over_limit', `${e.message} This transfer was skipped.`]; }
  }
  if (!failure && BigInt(from.balance_cents) < amount)
    failure = ['insufficient_funds', `${label(from)} had ${usd(from.balance_cents)}, not enough for ${usd(amount)}, so this transfer was skipped.`];
  if (!failure) {
    try {
      entryId = (await post(c, { key: `${u.id}:${FEATURE}:${s.id}:${date}`, kind: 'recurring_transfer', memo: s.memo, createdBy: u.id, lines: [
        { accountId: from.id, amountCents: -amount, description: `Recurring transfer to ${label(to)}`, category: 'Transfers', postedOn: t },
        { accountId: to.id, amountCents: amount, description: `Recurring transfer from ${label(from)}`, category: 'Transfers', postedOn: t }] })).entryId;
    } catch (e) {                                                              // the balance moved under us: the database refused the overdraft
      if (!(e instanceof AppError) || e.code !== 'insufficient_funds') throw e;
      failure = ['insufficient_funds', `${label(from)} didn't have enough for ${usd(amount)}, so this transfer was skipped.`];
    }
  }
  const r = (await c.query(`INSERT INTO recurring_transfer_runs (id, schedule_id, occurrence, scheduled_for, status, amount_cents, entry_id, failure_code, failure_message, executed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [runId, s.id, index, date, failure ? 'failed' : 'posted', amount, entryId, failure?.[0] ?? null, failure?.[1] ?? null, now()])).rows[0];
  if (failure) {
    s.runs_failed++;
    await audit(c, req, u.id, 'recurring.run_failed', { schedule: s.id, scheduledFor: date, run: runId, amount: toStr(amount), reason: failure[0] });
  } else {
    s.runs_posted++;
    await c.query(`INSERT INTO limit_usage (user_id, rail, recurring_run_id, amount_cents, booked_on, reason) VALUES ($1,'internal',$2,$3,$4,'used')`, [u.id, runId, amount, t]);
    await audit(c, req, u.id, 'recurring.run_posted', { schedule: s.id, scheduledFor: date, run: runId, entry: entryId, amount: toStr(amount),
      from: from.number_last4, to: to.number_last4 });
  }
  return r;
}

/** Where a schedule goes after occurrence `next` - 1 was processed: on to its next date, or completed. */
function advance(s) {
  const done = s.runs_posted + s.runs_failed, date = occurrence(s.start_date, s.cadence, s.next_index);
  if ((s.max_runs != null && done >= s.max_runs) || (s.end_date && date > s.end_date)) { s.status = 'completed'; s.next_run = null; }
  else s.next_run = date;
}

export async function runDue(c, req, u) {
  const t = bankToday(), out = [];
  await lock(c, u.id);                                          // two runs at once: the second waits and finds nothing left to do
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mm:${u.id}`]);   // limits are shared with one-off transfers (lib/routes/money-movement.mjs)
  const due = (await c.query(`SELECT * FROM recurring_transfers WHERE user_id = $1 AND status = 'active' AND next_run <= $2
    ORDER BY next_run, created_at, seq FOR UPDATE`, [u.id, t])).rows;
  for (const s of due) {
    for (let n = 0; n < MAX_PER_RUN && s.status === 'active' && s.next_run <= t; n++) {
      out.push(await processOccurrence(c, req, u, s, s.next_index, s.next_run));
      s.next_index++;
      advance(s);
    }
    await c.query(`UPDATE recurring_transfers SET status = $2, next_index = $3, next_run = $4, runs_posted = $5, runs_failed = $6, updated_at = $7 WHERE id = $1`,
      [s.id, s.status, s.next_index, s.next_run, s.runs_posted, s.runs_failed, now()]);
  }
  out.sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : a.scheduled_for > b.scheduled_for ? 1 : 0));
  const runs = out.map(runView);
  return { runs, posted: runs.filter(r => r.status === 'posted').length, failed: runs.filter(r => r.status === 'failed').length };
}

// ---------- pause, resume, cancel ----------
const invalid = (s, what) => new AppError(409, 'invalid_state', `This recurring transfer is ${s.status}, so it can't be ${what}.`);
async function setState(c, req, u, s, action, fields) {
  const r = (await c.query(`UPDATE recurring_transfers SET status = $2, next_index = $3, next_run = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
    [s.id, fields.status, fields.next_index ?? s.next_index, fields.next_run ?? null, now()])).rows[0];
  await audit(c, req, u.id, action, { schedule: s.id, was: s.status, status: r.status, nextRunDate: r.next_run ?? null });
  return { schedule: view(r) };
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body, query }) => tx(pool, async c => fn(c, req, await requireUser(c, req), body, params, query));

  r.add('POST', '/api/recurring-transfers', h(async (c, req, u, body) => create(c, req, u, body)));

  r.add('GET', '/api/recurring-transfers', h(async (c, req, u, body, params, query) => {
    const status = query.status;
    if (status !== undefined && !STATUSES.includes(status)) throw bad('bad_status', 'Choose active, paused, completed or canceled.');
    const rows = (await c.query(`SELECT * FROM recurring_transfers WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, seq DESC`,
      [u.id, status ?? null])).rows;
    return { schedules: rows.map(view) };
  }));

  r.add('POST', '/api/recurring-transfers/run', h(async (c, req, u) => runDue(c, req, u)));

  r.add('GET', '/api/recurring-transfers/:id', h(async (c, req, u, body, { id }) => {
    const s = await mine(c, u.id, id);
    const runs = (await c.query('SELECT * FROM recurring_transfer_runs WHERE schedule_id = $1 ORDER BY scheduled_for, occurrence', [s.id])).rows;
    return { schedule: view(s), runs: runs.map(runView) };
  }));

  r.add('POST', '/api/recurring-transfers/:id/pause', h(async (c, req, u, body, { id }) => {
    await lock(c, u.id);
    const s = await mine(c, u.id, id);
    if (s.status !== 'active') throw invalid(s, 'paused');
    return setState(c, req, u, s, 'recurring.pause', { status: 'paused' });
  }));

  r.add('POST', '/api/recurring-transfers/:id/resume', h(async (c, req, u, body, { id }) => {
    await lock(c, u.id);
    const s = await mine(c, u.id, id);
    if (s.status !== 'paused') throw invalid(s, 'resumed');
    await stepUpFor(c, u, 'internal', BigInt(s.amount_cents));     // the same threshold as creating it
    // the first occurrence not yet processed and dated today or later; ones that fell while paused are skipped, not counted
    const i = firstOnOrAfter(s.start_date, s.cadence, s.next_index, bankToday()), date = occurrence(s.start_date, s.cadence, i);
    if (s.end_date && date > s.end_date) return setState(c, req, u, s, 'recurring.resume', { status: 'completed', next_index: i });
    return setState(c, req, u, s, 'recurring.resume', { status: 'active', next_index: i, next_run: date });
  }));

  r.add('POST', '/api/recurring-transfers/:id/cancel', h(async (c, req, u, body, { id }) => {
    await lock(c, u.id);
    const s = await mine(c, u.id, id);
    if (!['active', 'paused'].includes(s.status)) throw invalid(s, 'canceled');
    return setState(c, req, u, s, 'recurring.cancel', { status: 'canceled' });
  }));
}
