// Round-up savings: enable, list, detail, pause/resume/disable, sweep, and simulated merchant refunds of debit-card purchases.
// Change is collected by the purchase endpoint (lib/routes/cards.mjs -> accrue in lib/round-ups.mjs). Sweeps run only when
// the customer calls POST /api/round-ups/sweep; there is no server schedule.
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { SETTLEMENT } from '../cards.mjs';
import { bankToday } from '../bank-date.mjs';
import { STEPS, DEFAULTS, FEATURE, sweptInMonth, roundUpView, purchaseView, sweepView, refundView } from '../round-ups.mjs';

const OWNER = ['owner'];                                     // round-ups are set up and run by the account's owner
const REFUNDERS = ['owner', 'joint_owner'];                  // a refund returns money to an account the caller holds
const LIMITS = { min: 100n, max: 1_000_000n };               // threshold and monthly cap, cents (requirements R3)

const notFound = (what = 'Round-up') => new AppError(404, 'not_found', `${what} not found.`);
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);
const given = v => v !== undefined && v !== null;

/** A setting: absent (or null) takes the default; otherwise an integer in range, or a 400 with that setting's code. */
function setting(v, dflt, ok, code, message) {
  if (!given(v)) return dflt;
  if (!isInt(v) || !ok(BigInt(v))) throw new AppError(400, code, message);
  return BigInt(v);
}

/** The caller's own round-up (role owner on its checking account), or a 404. `lock` locks the account, then the round-up. */
async function ownRoundUp(c, u, accountId, { lock = false } = {}) {
  if (!isUuid(accountId)) throw notFound();
  await accountFor(c, u.id, accountId, OWNER).catch(() => { throw notFound(); });
  if (lock) await c.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const r = (await c.query(`SELECT * FROM round_ups WHERE account_id = $1${lock ? ' FOR UPDATE' : ''}`, [accountId])).rows[0];
  if (!r) throw notFound();
  return r;
}

/** Per-customer request ids for enable and refund: the earlier result, a conflict, or null for a new request. */
async function priorRequest(c, u, key, fingerprint) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:req:${u.id}:${key}`]);   // the same id twice at once runs one after the other
  const row = (await c.query('SELECT * FROM round_up_requests WHERE user_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
  if (row && row.fingerprint !== fingerprint) throw conflict();
  return row ?? null;
}

// ---------- enable ----------
async function enable(c, req, u, body) {
  const key = requestKey(body);
  const want = { accountId: body.accountId, destinationAccountId: body.destinationAccountId, stepCents: body.stepCents ?? undefined,
    thresholdCents: body.thresholdCents ?? undefined, monthlyCapCents: body.monthlyCapCents ?? undefined };
  const prior = await priorRequest(c, u, key, fingerprintOf({ action: 'enable' }, want));
  if (prior) {
    const r = (await c.query('SELECT * FROM round_ups WHERE account_id = $1', [prior.account_id])).rows[0];
    return { roundUp: await roundUpView(c, r), replayed: true };
  }
  if (typeof body.accountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the checking account to round up.');
  if (typeof body.destinationAccountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the savings account that receives the savings.');
  const step = setting(body.stepCents, DEFAULTS.stepCents, v => STEPS.includes(v), 'bad_step', 'Round up to $1, $2 or $5.');
  const threshold = setting(body.thresholdCents, DEFAULTS.thresholdCents, v => v >= LIMITS.min && v <= LIMITS.max, 'bad_threshold',
    'Choose a sweep threshold from $1.00 to $10,000.00.');
  const cap = setting(body.monthlyCapCents, DEFAULTS.monthlyCapCents, v => v >= LIMITS.min && v <= LIMITS.max, 'bad_cap',
    'Choose a monthly limit from $1.00 to $10,000.00.');
  const chk = await accountFor(c, u.id, body.accountId, OWNER);
  if (chk.kind !== 'checking') throw new AppError(400, 'bad_account', 'Round-ups work on a checking account.');
  if (chk.status !== 'open') throw new AppError(409, 'account_not_open', 'That checking account is not open.');
  const sav = await accountFor(c, u.id, body.destinationAccountId, OWNER);
  if (sav.kind !== 'savings') throw new AppError(400, 'bad_account', 'Round-up savings go to a savings account.');
  if (sav.status !== 'open') throw new AppError(409, 'account_not_open', 'That savings account is not open.');
  requireStepUp(u);
  await c.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [chk.id]);    // one enable per account at a time
  const cur = (await c.query('SELECT * FROM round_ups WHERE account_id = $1 FOR UPDATE', [chk.id])).rows[0];
  if (cur && cur.status !== 'disabled') throw new AppError(409, 'already_enabled', 'Round-ups are already on for this account.');
  if (cur) await c.query(`UPDATE round_ups SET status = 'active', user_id = $2, destination_account_id = $3, step_cents = $4, threshold_cents = $5,
    monthly_cap_cents = $6 WHERE account_id = $1`, [chk.id, u.id, sav.id, step, threshold, cap]);
  else await c.query(`INSERT INTO round_ups (account_id, user_id, destination_account_id, step_cents, threshold_cents, monthly_cap_cents)
    VALUES ($1,$2,$3,$4,$5,$6)`, [chk.id, u.id, sav.id, step, threshold, cap]);
  await c.query('INSERT INTO round_up_requests (user_id, idempotency_key, fingerprint, account_id) VALUES ($1,$2,$3,$4)',
    [u.id, key, fingerprintOf({ action: 'enable' }, want), chk.id]);
  await audit(c, req, u.id, 'roundup.enable', { account: chk.id, destinationAccount: sav.id, stepCents: Number(step),
    thresholdCents: Number(threshold), monthlyCapCents: Number(cap), again: !!cur });
  const r = (await c.query('SELECT * FROM round_ups WHERE account_id = $1', [chk.id])).rows[0];
  return { roundUp: await roundUpView(c, r), replayed: false };
}

// ---------- pause, resume, disable ----------
const MOVES = {
  pause: { from: ['active'], to: 'paused', action: 'roundup.pause', message: 'Only an active round-up can be paused.' },
  resume: { from: ['paused'], to: 'active', action: 'roundup.resume', message: 'Only a paused round-up can be resumed.' },
  disable: { from: ['active', 'paused'], to: 'disabled', action: 'roundup.disable', message: 'This round-up is already turned off.' }
};
async function move(c, req, u, accountId, name) {
  const m = MOVES[name], r = await ownRoundUp(c, u, accountId, { lock: true });
  if (!m.from.includes(r.status)) throw new AppError(409, 'invalid_state', m.message);
  const next = (await c.query('UPDATE round_ups SET status = $2 WHERE account_id = $1 RETURNING *', [r.account_id, m.to])).rows[0];
  await audit(c, req, u.id, m.action, { account: r.account_id, from: r.status, to: m.to });
  return { roundUp: await roundUpView(c, next) };
}

// ---------- sweep ----------
/**
 * One round-up's sweep, if it is due. Locks the checking account, then the round-up (the purchase endpoint takes them in
 * the same order), so two sweep calls at once post one entry and only one of them reports it. Returns a sweep view or null.
 */
async function sweepOne(c, req, u, accountId, today) {
  const chk = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
  const r = (await c.query('SELECT * FROM round_ups WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0];
  if (!r || r.status !== 'active') return null;
  if ((await c.query('SELECT 1 FROM round_up_sweeps WHERE account_id = $1 AND sweep_date = $2', [accountId, today])).rowCount) return null;
  const pending = BigInt(r.pending_cents);
  const due = pending > 0n && (pending >= BigInt(r.threshold_cents) || today > r.pending_since);
  if (!due) return null;
  const sav = (await c.query('SELECT * FROM accounts WHERE id = $1', [r.destination_account_id])).rows[0];
  const room = BigInt(r.monthly_cap_cents) - await sweptInMonth(c, accountId, today);
  const amount = pending < room ? pending : room;
  const reason = chk.status !== 'open' || sav.status !== 'open' ? 'account_not_open'
    : amount <= 0n ? 'monthly_cap'
      : BigInt(chk.balance_cents) < amount ? 'insufficient_funds' : null;
  const base = { accountId, destinationAccountId: sav.id, sweepDate: today };
  if (reason) {
    const shown = amount > 0n ? amount : 0n;
    await audit(c, req, r.user_id, 'roundup.sweep_deferred', { account: accountId, sweepDate: today, reason, amountCents: Number(shown) });
    return { id: null, ...base, status: 'deferred', amountCents: Number(shown), entryId: null, reason };
  }
  const { entryId } = await post(c, { key: `${u.id}:${FEATURE}:sweep:${accountId}:${today}`, kind: 'round_up_sweep', memo: 'Round-up savings', createdBy: u.id, lines: [
    { accountId, amountCents: -amount, description: `Round-up savings to ${sav.name} ··${sav.number_last4}`, category: 'Transfers', postedOn: today },
    { accountId: sav.id, amountCents: amount, description: `Round-up savings from ${chk.name} ··${chk.number_last4}`, category: 'Transfers', postedOn: today }] });
  const id = newId();
  const s = (await c.query(`INSERT INTO round_up_sweeps (id, account_id, destination_account_id, sweep_date, amount_cents, entry_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, accountId, sav.id, today, amount, entryId])).rows[0];
  await c.query(`UPDATE round_ups SET pending_cents = pending_cents - $2, swept_cents = swept_cents + $2,
    pending_since = CASE WHEN pending_cents - $2 = 0 THEN NULL ELSE pending_since END WHERE account_id = $1`, [accountId, amount]);
  await audit(c, req, r.user_id, 'roundup.sweep_posted', { account: accountId, sweepDate: today, amountCents: Number(amount), entryId });
  return sweepView(s);
}

// ---------- refunds ----------
async function refund(c, req, u, body) {
  const key = requestKey(body);
  const want = { authorizationId: body.authorizationId, amountCents: body.amountCents ?? undefined };
  const fingerprint = fingerprintOf({ action: 'refund' }, want);
  const prior = await priorRequest(c, u, key, fingerprint);
  if (prior) return { refund: refundView((await c.query('SELECT * FROM card_refunds WHERE id = $1', [prior.refund_id])).rows[0]), replayed: true };
  if (typeof body.authorizationId !== 'string') throw new AppError(400, 'bad_authorization', 'Choose the purchase to refund.');
  if (!isUuid(body.authorizationId)) throw notFound('Purchase');
  const auth = (await c.query(`SELECT a.*, k.type card_type, k.account_id FROM card_authorizations a JOIN cards k ON k.id = a.card_id WHERE a.id = $1`,
    [body.authorizationId])).rows[0];
  if (!auth) throw notFound('Purchase');
  await accountFor(c, u.id, auth.account_id, REFUNDERS).catch(() => { throw notFound('Purchase'); });
  if (given(body.amountCents) && (!isInt(body.amountCents) || body.amountCents < 1)) throw new AppError(400, 'bad_amount', 'Enter the refund in whole cents, at least 1.');
  if (auth.result !== 'approved' || auth.card_type !== 'debit' || auth.channel === 'atm')
    throw new AppError(422, 'not_refundable', 'Only an approved debit-card purchase can be refunded.');
  const acct = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [auth.account_id])).rows[0];   // the account first, then the round-up
  await c.query('SELECT id FROM card_authorizations WHERE id = $1 FOR UPDATE', [auth.id]);                     // refunds of one purchase one at a time
  if (acct.status !== 'open') throw new AppError(409, 'account_not_open', 'That account is not open.');
  const purchase = BigInt(auth.amount_cents);
  const before = (await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM card_refunds WHERE authorization_id = $1', [auth.id])).rows[0].s;
  const amount = given(body.amountCents) ? BigInt(body.amountCents) : purchase - before;
  if (amount < 1n || before + amount > purchase)
    throw new AppError(409, 'refund_exceeds_purchase', 'That is more than is left to refund on this purchase.');
  const { entryId } = await post(c, { key: `${u.id}:${FEATURE}:refund:${key}`, kind: 'card_refund', createdBy: u.id, lines: [
    { accountId: await systemAccount(c, SETTLEMENT), amountCents: -amount, description: `Refund ${auth.merchant} ··${acct.number_last4}` },
    { accountId: acct.id, amountCents: amount, description: `Refund: ${auth.merchant}`, category: auth.category }] });
  const reversed = await reverseChange(c, req, auth, before + amount);
  const id = newId();
  const f = (await c.query(`INSERT INTO card_refunds (id, authorization_id, account_id, amount_cents, reversed_cents, entry_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, auth.id, acct.id, amount, reversed, entryId, u.id])).rows[0];
  await c.query('INSERT INTO round_up_requests (user_id, idempotency_key, fingerprint, refund_id) VALUES ($1,$2,$3,$4)', [u.id, key, fingerprint, id]);
  await audit(c, req, u.id, 'roundup.refund', { authorizationId: auth.id, amountCents: Number(amount), entryId, simulated: true });
  return { refund: refundView(f), replayed: false };
}

/** Takes back the purchase's change in proportion to what is refunded (R22), never more than is still pending. */
async function reverseChange(c, req, auth, refundedTotal) {
  const p = (await c.query('SELECT * FROM round_up_purchases WHERE authorization_id = $1 FOR UPDATE', [auth.id])).rows[0];
  if (!p) return 0n;
  const r = (await c.query('SELECT * FROM round_ups WHERE account_id = $1 FOR UPDATE', [p.account_id])).rows[0];
  let back = BigInt(p.change_cents) * refundedTotal / BigInt(p.purchase_cents) - BigInt(p.reversed_cents);
  if (back > BigInt(r.pending_cents)) back = BigInt(r.pending_cents);
  if (back < 0n) back = 0n;
  await c.query('UPDATE round_up_purchases SET refunded_cents = $2, reversed_cents = reversed_cents + $3 WHERE authorization_id = $1', [auth.id, refundedTotal, back]);
  if (back > 0n) {
    await c.query(`UPDATE round_ups SET pending_cents = pending_cents - $2, reversed_cents = reversed_cents + $2,
      pending_since = CASE WHEN pending_cents - $2 = 0 THEN NULL ELSE pending_since END WHERE account_id = $1`, [r.account_id, back]);
    await audit(c, req, r.user_id, 'roundup.reverse', { account: r.account_id, authorizationId: auth.id, reversedCents: Number(back) });
  }
  return back;
}

export function register(r) {
  r.add('POST', '/api/round-ups', async ({ req, pool, body }) => tx(pool, async c => enable(c, req, await requireUser(c, req), body)));

  r.add('GET', '/api/round-ups', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT r.* FROM round_ups r JOIN account_owners o ON o.account_id = r.account_id AND o.user_id = $1 AND o.role = ANY($2)
      ORDER BY r.created_at DESC`, [u.id, OWNER])).rows;
    const roundUps = [];
    for (const x of rows) roundUps.push(await roundUpView(c, x));
    return { roundUps };
  }));

  r.add('POST', '/api/round-ups/sweep', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req), today = bankToday();
    const ids = (await c.query(`SELECT r.account_id FROM round_ups r JOIN account_owners o ON o.account_id = r.account_id AND o.user_id = $1 AND o.role = ANY($2)
      WHERE r.status = 'active' ORDER BY r.created_at`, [u.id, OWNER])).rows;
    const sweeps = [];
    for (const { account_id } of ids) { const s = await sweepOne(c, req, u, account_id, today); if (s) sweeps.push(s); }
    return { sweeps, posted: sweeps.filter(s => s.status === 'posted').length, deferred: sweeps.filter(s => s.status === 'deferred').length };
  }));

  r.add('POST', '/api/round-ups/refunds', async ({ req, pool, body }) => tx(pool, async c => refund(c, req, await requireUser(c, req), body)));

  r.add('GET', '/api/round-ups/:accountId', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const x = await ownRoundUp(c, u, params.accountId);
    const purchases = (await c.query('SELECT * FROM round_up_purchases WHERE account_id = $1 ORDER BY seq', [x.account_id])).rows.map(purchaseView);
    const sweeps = (await c.query('SELECT * FROM round_up_sweeps WHERE account_id = $1 ORDER BY sweep_date', [x.account_id])).rows.map(sweepView);
    return { roundUp: await roundUpView(c, x), purchases, sweeps };
  }));

  for (const name of Object.keys(MOVES))
    r.add('POST', `/api/round-ups/:accountId/${name}`, async ({ req, pool, params }) => tx(pool, async c => move(c, req, await requireUser(c, req), params.accountId, name)));
}
