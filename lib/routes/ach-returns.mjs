// ACH debit returns and returned-item fees (db/migrations/065_ach_returns.sql). An item is one ACH debit that can come back:
// an outgoing debit (a customer's ACH pull whose credit was posted; its id is the pull's transfer id) or an incoming debit
// (an outside company pulling from a customer's account, recorded here by ACH operations staff). Staff post returns with a
// reason code; a return reverses the money, an outgoing one gives its ACH limit back and, for R01/R02, charges a
// returned-item fee capped per customer per bank day. An R01 return may be presented again once. Holds on pulled money:
// lib/money-movement/holds.mjs. An item's state is worked out on every read and write, never stored.
// Money in this API is whole cents as JSON integers (at most 100,000,000, exact as a JSON number), never strings.
// Simulated: no real ACH file, trace number or network is involved.
import { AppError, refuse, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { usd } from '../money.mjs';
import { clock, today, isBusinessDay, addBusinessDays } from '../money-movement/calendar.mjs';
import { seal, accountNumber } from '../money-movement/vault.mjs';
import { useLimit, releaseLimit } from '../money-movement/limits.mjs';
import { heldOn, finalDate } from '../money-movement/holds.mjs';

const FEATURE = 'ach-returns';
const OWNERS = ['owner', 'joint_owner'];
const DEBIT_KINDS = ['checking', 'savings', 'money_market'];
export const MAX_DEBIT_CENTS = 100_000_000;
// Reason codes: who they apply to, the return window in business days after posting, and whether they charge the fee
export const REASONS = {
  R01: { text: 'Insufficient funds', allowed: ['outgoing'], window: 2, fee: true },
  R02: { text: 'Account closed', allowed: ['outgoing'], window: 2, fee: true },
  R08: { text: 'Payment stopped', allowed: ['outgoing', 'incoming'], window: 3, fee: false },
  R10: { text: 'Customer advises not authorized', allowed: ['outgoing', 'incoming'], window: 5, fee: false }
};
// Returned-item fee: 2.5% of the amount (halves rounded up), at least $5 and at most $35; at most $70 per customer per bank day
export const FEE_MIN = 500n, FEE_MAX = 3500n, FEE_DAILY_CAP = 7000n;
// An R01 return may be presented again from 2 through 10 business days after the day it was returned
export const REPRESENT_FROM = 2, REPRESENT_UNTIL = 10;

/** The base returned-item fee for an amount, in BigInt cents. */
export function baseFee(amountCents) {
  const f = (BigInt(amountCents) * 25n + 500n) / 1000n;
  return f < FEE_MIN ? FEE_MIN : f > FEE_MAX ? FEE_MAX : f;
}

// ---------- small helpers ----------
const now = () => clock.now();
const lock = (c, s) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s]);
const cents = v => Number(v);                                       // BigInt cents -> JSON integer (never more than MAX_DEBIT_CENTS)
const min = (a, b) => (a < b ? a : b), max0 = v => (v < 0n ? 0n : v);
const notFound = () => new AppError(404, 'not_found', 'Not found.');
const trimmed = v => (typeof v === 'string' ? v.trim() : '');

async function staffUser(c, req) {
  const u = await requireUser(c, req);
  if (!(await c.query("SELECT 1 FROM staff_roles WHERE user_id = $1 AND role = 'ach_operations'", [u.id])).rowCount)
    throw new AppError(403, 'forbidden', 'Only ACH operations staff can do this.');
  return u;
}
const ownsAccount = async (c, userId, accountId) =>
  (await c.query('SELECT 1 FROM account_owners WHERE account_id = $1 AND user_id = $2 AND role = ANY($3)', [accountId, userId, OWNERS])).rowCount > 0;
async function noConflict(c, u, accountId) {
  if (await ownsAccount(c, u.id, accountId))
    throw new AppError(403, 'conflict_of_interest', 'You own or jointly own this account, so another member of ACH operations has to handle it.');
}
async function notifyOwners(c, accountId, { ref, title, body }) {
  await c.query(`INSERT INTO notifications (user_id, kind, ref, title, body) SELECT o.user_id, 'ach_return', $2, $3, $4 FROM account_owners o
     WHERE o.account_id = $1 AND o.role = ANY($5) ON CONFLICT (user_id, ref) DO NOTHING`, [accountId, ref, title, body, OWNERS]);
}

// ---------- items ----------
/** An item with its presentments, returns and state, or null. */
async function loadItem(c, id) {
  if (!isUuid(id)) return null;
  let it;
  const t = (await c.query(`SELECT t.*, l.posted_on AS credited_on FROM transfers t
       JOIN ledger_lines l ON l.entry_id = t.entry_id AND l.account_id = t.to_account_id AND l.amount_cents > 0
     WHERE t.id = $1 AND t.rail = 'ach' AND t.direction = 'in' AND NOT EXISTS (SELECT 1 FROM ach_representments r WHERE r.transfer_id = t.id)
     ORDER BY l.id LIMIT 1`, [id])).rows[0];       // a pull is an item once its credit is posted (pending and simulated returns have no entry)
  if (t) {
    const rep = (await c.query('SELECT * FROM ach_representments WHERE item_id = $1', [id])).rows[0] ?? null;
    it = { id, direction: 'outgoing', accountId: t.to_account_id, amount: BigInt(t.amount_cents), counterparty: t.counterparty, customerId: t.user_id,
      createdAt: t.created_at, pull: t, rep, presentments: [{ n: 1, postedOn: t.credited_on, transferId: t.id }] };
    if (rep) it.presentments.push({ n: 2, postedOn: rep.presented_on, transferId: rep.transfer_id });
  } else {
    const d = (await c.query('SELECT * FROM ach_incoming_debits WHERE id = $1', [id])).rows[0];
    if (!d) return null;
    it = { id, direction: 'incoming', accountId: d.account_id, amount: BigInt(d.amount_cents), counterparty: `${d.company_name} ··${d.company_last4}`, customerId: null,
      createdAt: d.created_at, rep: null, presentments: [{ n: 1, postedOn: d.posted_on }] };
  }
  it.returns = (await c.query('SELECT * FROM ach_returns WHERE item_id = $1 ORDER BY created_at, seq', [id])).rows;
  it.current = it.presentments.at(-1);
  it.finalOn = finalDate(it.current.postedOn);
  it.state = it.returns.some(r => r.presentment === it.current.n) ? 'returned'
    : today() <= it.finalOn ? (it.current.n === 1 ? 'posted' : 're_presented') : 'settled';
  it.held = it.direction === 'outgoing' && (it.state === 'posted' || it.state === 're_presented') ? it.amount : 0n;
  return it;
}

const returnView = r => ({ id: r.id, itemId: r.item_id, presentment: r.presentment, reasonCode: r.reason_code, reasonText: REASONS[r.reason_code].text,
  amountCents: cents(r.amount_cents), feeCents: cents(r.fee_cents), feeWaived: !!r.fee_waiver_entry_id, returnedOn: r.returned_on, createdAt: r.created_at });
const staffReturnView = r => ({ ...returnView(r), postedBy: r.posted_by, note: r.note, entryId: r.entry_id, feeEntryId: r.fee_entry_id ?? null,
  feeWaivedBy: r.fee_waived_by ?? null, feeWaiverReason: r.fee_waiver_reason ?? null, feeWaiverEntryId: r.fee_waiver_entry_id ?? null });
const itemView = it => ({ id: it.id, direction: it.direction, accountId: it.accountId, amountCents: cents(it.amount), counterparty: it.counterparty,
  state: it.state, presentment: it.current.n, postedOn: it.current.postedOn, finalOn: it.finalOn, heldCents: cents(it.held),
  rePresentment: it.rep ? { transferId: it.rep.transfer_id, presentedOn: it.rep.presented_on } : null,
  returns: it.returns.map(returnView), createdAt: it.createdAt });
async function staffItemView(c, it) {
  const history = (await c.query("SELECT at, action, user_id, detail FROM audit_events WHERE detail->>'item' = $1 ORDER BY id", [it.id])).rows
    .map(e => ({ at: e.at, action: e.action, actorId: e.user_id, detail: e.detail }));
  return { ...itemView(it), returns: it.returns.map(staffReturnView), customerId: it.customerId, history };
}

// ---------- the staff actions ----------
async function recordDebit(c, req, u, body) {
  const key = `${u.id}:${FEATURE}:debit:${requestKey(body)}`, fp = fingerprintOf({}, body);
  await lock(c, key);
  const prev = (await c.query('SELECT id, fingerprint FROM ach_incoming_debits WHERE idempotency_key = $1', [key])).rows[0];
  if (prev) {
    if (prev.fingerprint !== fp) throw conflict();
    return { item: await staffItemView(c, await loadItem(c, prev.id)), replayed: true };
  }
  if (typeof body.accountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the account the debit is from.');
  const amount = body.amountCents;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_DEBIT_CENTS) throw new AppError(400, 'bad_amount', 'Enter the amount in whole cents, from 1 to 100,000,000.');
  const company = trimmed(body.companyName);
  if (company.length < 2 || company.length > 80) throw new AppError(400, 'bad_company', "Enter the company's name (2 to 80 characters).");
  if (typeof body.companyAccountNumber !== 'string') throw new AppError(400, 'bad_account_number', "Enter the company's account number: 4 to 17 digits.");
  const num = accountNumber(body.companyAccountNumber, "company's account number");
  const a = isUuid(body.accountId) ? (await c.query("SELECT * FROM accounts WHERE id = $1 AND kind <> 'system' FOR UPDATE", [body.accountId])).rows[0] : null;
  if (!a) throw new AppError(404, 'not_found', 'Account not found.');
  await noConflict(c, u, a.id);
  if (!DEBIT_KINDS.includes(a.kind)) throw new AppError(400, 'bad_account', 'An ACH debit can only come from a checking, savings or money market account.');
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', `The account ending ${a.number_last4} isn't open.`);
  const t = today();
  if (!isBusinessDay(t)) throw new AppError(409, 'not_business_day', `${t} isn't a business day, so no ACH debits are posted today.`);
  const available = BigInt(a.balance_cents) - await heldOn(c, a.id);
  if (BigInt(amount) > available) throw new AppError(409, 'insufficient_funds', `The account ending ${a.number_last4} has ${usd(max0(available))} available, which isn't enough for this debit.`);
  const id = newId(), cp = `${company} ··${num.slice(-4)}`, amt = BigInt(amount);
  const e = await post(c, { key: `${FEATURE}:${id}:p1:post`, kind: 'ach_debit_in', createdBy: u.id, lines: [
    { accountId: a.id, amountCents: -amt, description: `ACH debit: ${cp}`, category: 'Transfers', postedOn: t },
    { accountId: await systemAccount(c, 'mm_network'), amountCents: amt, description: `ACH debit: ${cp}`, postedOn: t }] });
  await c.query(`INSERT INTO ach_incoming_debits (id, account_id, amount_cents, company_name, company_last4, company_account_enc, posted_on, entry_id, recorded_by,
      idempotency_key, fingerprint, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id, a.id, amt, company, num.slice(-4), seal(num, id), t, e.entryId, u.id, key, fp, now()]);
  await audit(c, req, u.id, 'ach_return.debit_recorded', { item: id, amountCents: amount, account: a.number_last4 });
  return { item: await staffItemView(c, await loadItem(c, id)), replayed: false };
}

async function postReturn(c, req, u, body, id) {
  await lock(c, `ach-item:${id}`);                                   // one item at a time: one return per presentment
  const first = await loadItem(c, id);
  if (!first) throw notFound();
  if (first.customerId) await lock(c, `ach-fees:${first.customerId}`);   // one customer at a time: the daily fee cap holds
  const it = await loadItem(c, id);
  await noConflict(c, u, it.accountId);
  const key = `${u.id}:${FEATURE}:return:${requestKey(body)}`, fp = fingerprintOf({ id }, body);
  await lock(c, key);
  const prev = (await c.query('SELECT * FROM ach_returns WHERE idempotency_key = $1', [key])).rows[0];
  if (prev) {
    if (prev.fingerprint !== fp) throw conflict();
    return { return: staffReturnView(prev), item: await staffItemView(c, it), replayed: true };
  }
  const p = body.presentment;
  if (p !== 1 && p !== 2) throw new AppError(400, 'bad_presentment', 'Choose presentment 1 or 2.');
  const code = body.reasonCode;
  if (typeof code !== 'string' || !Object.hasOwn(REASONS, code)) throw new AppError(400, 'bad_reason_code', 'Choose a reason code: R01, R02, R08 or R10.');
  const note = trimmed(body.note);
  if (note.length < 5 || note.length > 500) throw new AppError(400, 'note_required', 'Add a note of 5 to 500 characters about this return.');
  const why = REASONS[code];
  if (!why.allowed.includes(it.direction)) throw new AppError(422, 'reason_not_allowed', `${code} (${why.text}) can't be used to return an ${it.direction} debit.`);
  const t = today();
  if (!isBusinessDay(t)) throw new AppError(409, 'not_business_day', `${t} isn't a business day, so no returns are posted today.`);
  const pres = it.presentments.find(x => x.n === p);
  if (!pres) throw new AppError(409, 'invalid_state', 'This debit was not presented again, so there is no presentment 2 to return.');
  if (p < it.current.n || it.returns.some(r => r.presentment === p)) throw new AppError(409, 'already_returned', `Presentment ${p} of this debit was already returned.`);
  const deadline = addBusinessDays(pres.postedOn, why.window);
  if (t > deadline) {
    await audit(c, req, u.id, 'ach_return.late_refused', { item: id, presentment: p, reasonCode: code, deadline });
    throw refuse(422, 'return_window_closed', `The window for an ${code} return of this debit closed on ${deadline}.`);
  }
  const a = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [it.accountId])).rows[0];
  const out = it.direction === 'outgoing', amt = it.amount, cp = it.counterparty;
  if (out && BigInt(a.balance_cents) < amt) throw new AppError(409, 'insufficient_funds', `The account ending ${a.number_last4} has ${usd(a.balance_cents)}, less than the ${usd(amt)} to return. Nothing was posted.`);

  const desc = out ? `ACH return ${code}: ${cp}` : `ACH debit returned ${code}: ${cp}`;
  const e = await post(c, { key: `${FEATURE}:${id}:p${p}:return`, kind: 'ach_return', createdBy: u.id, lines: out ? [
    { accountId: a.id, amountCents: -amt, description: desc, category: 'Transfers', postedOn: t },
    { accountId: await systemAccount(c, 'mm_ach_in'), amountCents: amt, description: desc, postedOn: t }] : [
    { accountId: await systemAccount(c, 'mm_network'), amountCents: -amt, description: desc, postedOn: t },
    { accountId: a.id, amountCents: amt, description: desc, category: 'Transfers', postedOn: t }] });
  let fee = 0n, feeEntry = null;
  if (out) {
    const tr = (await c.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [pres.transferId])).rows[0];
    await c.query(`UPDATE transfers SET status = 'returned', return_code = $2, reversal_entry_id = $3, note = $4, updated_at = $5 WHERE id = $1`,
      [tr.id, code, e.entryId, `Returned: ${why.text} (${code}).`, now()]);
    await releaseLimit(c, tr, 'returned');
    if (why.fee) {                                                   // base fee, then what is left under the day's cap, then the money left
      const charged = (await c.query(`SELECT coalesce(sum(fee_cents), 0)::bigint s FROM ach_returns
         WHERE customer_id = $1 AND returned_on = $2 AND fee_waiver_entry_id IS NULL`, [it.customerId, t])).rows[0].s;
      const balance = BigInt((await c.query('SELECT balance_cents FROM accounts WHERE id = $1', [a.id])).rows[0].balance_cents);
      fee = min(min(baseFee(amt), max0(FEE_DAILY_CAP - charged)), max0(balance - await heldOn(c, a.id)));
      if (fee > 0n) feeEntry = (await post(c, { key: `${FEATURE}:${id}:p${p}:fee`, kind: 'ach_return_fee', createdBy: u.id, lines: [
        { accountId: a.id, amountCents: -fee, description: `Returned item fee (${code})`, category: 'Fees & Charges', postedOn: t },
        { accountId: await systemAccount(c, 'ach_return_fees'), amountCents: fee, description: `Returned item fee (${code})`, postedOn: t }] })).entryId;
    }
  }
  const rid = newId();
  const row = (await c.query(`INSERT INTO ach_returns (id, item_id, direction, presentment, transfer_id, account_id, customer_id, reason_code, amount_cents, fee_cents,
      returned_on, posted_by, note, entry_id, fee_entry_id, idempotency_key, fingerprint, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
  [rid, id, it.direction, p, pres.transferId ?? null, a.id, it.customerId, code, amt, fee, t, u.id, note, e.entryId, feeEntry, key, fp, now()])).rows[0];
  await notifyOwners(c, a.id, out ? {
    ref: `ach-return:${rid}`, title: 'ACH transfer returned',
    body: `Your ACH transfer of ${usd(amt)} from ${cp} into your account ··${a.number_last4} was returned: ${code} ${why.text}. The money was taken back out of your account.`
      + (fee > 0n ? ` A returned item fee of ${usd(fee)} was charged.` : '')
  } : {
    ref: `ach-return:${rid}`, title: 'ACH debit returned',
    body: `The ACH debit of ${usd(amt)} by ${cp} from your account ··${a.number_last4} was returned: ${code} ${why.text}. The money is back in your account.`
  });
  await audit(c, req, u.id, 'ach_return.posted', { item: id, return: rid, presentment: p, reasonCode: code, amountCents: cents(amt), feeCents: cents(fee) });
  return { return: staffReturnView(row), item: await staffItemView(c, await loadItem(c, id)), replayed: false };
}

async function represent(c, req, u, id) {
  await lock(c, `ach-item:${id}`);
  const it = await loadItem(c, id);
  if (!it) throw notFound();
  await noConflict(c, u, it.accountId);
  if (it.rep) return { item: await staffItemView(c, it), replayed: true };
  const r1 = it.returns.find(r => r.presentment === 1);
  if (it.direction !== 'outgoing' || it.state !== 'returned' || r1?.reason_code !== 'R01')
    throw new AppError(409, 'not_representable', 'Only an ACH transfer returned for insufficient funds (R01) can be presented again.');
  const t = today();
  if (!isBusinessDay(t)) throw new AppError(409, 'not_business_day', `${t} isn't a business day, so nothing is presented today.`);
  const from = addBusinessDays(r1.returned_on, REPRESENT_FROM), until = addBusinessDays(r1.returned_on, REPRESENT_UNTIL);
  if (t < from) throw new AppError(409, 'too_early', `This can be presented again from ${from}.`);
  if (t > until) throw new AppError(409, 'too_late', `This could be presented again until ${until}.`);
  const a = (await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [it.accountId])).rows[0];
  if (a.status !== 'open') throw new AppError(409, 'account_not_open', `The account ending ${a.number_last4} isn't open.`);
  const o = it.pull, amt = it.amount, cp = it.counterparty;
  const e = await post(c, { key: `${FEATURE}:${id}:p2:post`, kind: 'ach_in', createdBy: u.id, lines: [
    { accountId: await systemAccount(c, 'mm_ach_in'), amountCents: -amt, description: `ACH in: ${cp} (presented again)`, postedOn: t },
    { accountId: a.id, amountCents: amt, description: `ACH transfer from ${cp} (presented again)`, category: 'Transfers', postedOn: t }] });
  const at = now();
  const tr = (await c.query(`INSERT INTO transfers (id, user_id, rail, direction, to_account_id, external_account_id, counterparty, amount_cents, memo, status,
      process_on, settles_on, booked_on, idempotency_key, entry_id, settled_at, created_at, updated_at)
    VALUES ($1,$2,'ach','in',$3,$4,$5,$6,$7,'settled',$8,$8,$8,$9,$10,$11,$11,$11) RETURNING *`,
  [newId(), o.user_id, o.to_account_id, o.external_account_id, o.counterparty, o.amount_cents, o.memo, t, `${FEATURE}:${id}:p2`, e.entryId, at])).rows[0];
  await useLimit(c, tr);                                              // counts against the customer's ACH limit (not checked: they asked for this once already)
  await c.query('INSERT INTO ach_representments (item_id, transfer_id, presented_on, presented_by, created_at) VALUES ($1,$2,$3,$4,$5)', [id, tr.id, t, u.id, at]);
  await audit(c, req, u.id, 'ach_return.represented', { item: id, transfer: tr.id, amountCents: cents(amt) });
  return { item: await staffItemView(c, await loadItem(c, id)), replayed: false };
}

async function waiveFee(c, req, u, body, id) {
  const r0 = isUuid(id) ? (await c.query('SELECT item_id, customer_id FROM ach_returns WHERE id = $1', [id])).rows[0] : null;
  if (!r0) throw notFound();
  await lock(c, `ach-item:${r0.item_id}`);
  if (r0.customer_id) await lock(c, `ach-fees:${r0.customer_id}`);
  const r = (await c.query('SELECT * FROM ach_returns WHERE id = $1 FOR UPDATE', [id])).rows[0];
  await noConflict(c, u, r.account_id);
  const reason = trimmed(body.reason);
  if (reason.length < 5 || reason.length > 500) throw new AppError(400, 'reason_required', 'Say why the fee is refunded (5 to 500 characters).');
  if (r.fee_waiver_entry_id) return { return: staffReturnView(r), replayed: true };
  if (BigInt(r.fee_cents) === 0n) throw new AppError(409, 'no_fee', 'No returned item fee was charged on this return.');
  const fee = BigInt(r.fee_cents), t = today(), desc = `Returned item fee refunded (${r.reason_code})`;
  const e = await post(c, { key: `${FEATURE}:${r.item_id}:p${r.presentment}:fee-waiver`, kind: 'ach_return_fee_waiver', createdBy: u.id, lines: [
    { accountId: await systemAccount(c, 'ach_return_fees'), amountCents: -fee, description: desc, postedOn: t },
    { accountId: r.account_id, amountCents: fee, description: desc, category: 'Fees & Charges', postedOn: t }] });
  const row = (await c.query(`UPDATE ach_returns SET fee_waived_by = $2, fee_waiver_reason = $3, fee_waiver_entry_id = $4, fee_waived_at = $5 WHERE id = $1 RETURNING *`,
    [id, u.id, reason, e.entryId, now()])).rows[0];
  const last4 = (await c.query('SELECT number_last4 FROM accounts WHERE id = $1', [r.account_id])).rows[0].number_last4;
  await notifyOwners(c, r.account_id, { ref: `ach-fee-waiver:${id}`, title: 'Returned item fee refunded',
    body: `The returned item fee of ${usd(fee)} charged on your account ··${last4} was refunded.` });
  await audit(c, req, u.id, 'ach_return.fee_waived', { item: r.item_id, return: id, feeCents: cents(fee), reason });
  return { return: staffReturnView(row), replayed: false };
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body }) => tx(pool, async c => fn(c, req, body, params));

  // ----- customers: returns, items and availability on their own accounts (owner or joint owner) -----
  r.add('GET', '/api/ach-returns', h(async (c, req) => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT r.*, coalesce(t.counterparty, d.company_name || ' ··' || d.company_last4) AS counterparty FROM ach_returns r
         JOIN account_owners o ON o.account_id = r.account_id AND o.user_id = $1 AND o.role = ANY($2)
         LEFT JOIN transfers t ON t.id = r.item_id LEFT JOIN ach_incoming_debits d ON d.id = r.item_id
       ORDER BY r.created_at DESC, r.seq DESC`, [u.id, OWNERS])).rows;
    return { returns: rows.map(x => ({ ...returnView(x), direction: x.direction, accountId: x.account_id, counterparty: x.counterparty })) };
  }));
  r.add('GET', '/api/ach-returns/items/:id', h(async (c, req, body, { id }) => {
    const u = await requireUser(c, req);
    const it = await loadItem(c, id);
    if (!it || !(await ownsAccount(c, u.id, it.accountId))) throw notFound();
    return { item: itemView(it) };
  }));
  r.add('GET', '/api/ach-returns/availability/:accountId', h(async (c, req, body, { accountId }) => {
    const u = await requireUser(c, req);
    const a = await accountFor(c, u.id, accountId, OWNERS);
    const balance = BigInt(a.balance_cents), held = await heldOn(c, a.id);
    return { accountId: a.id, balanceCents: cents(balance), heldCents: cents(held), availableCents: cents(balance - held) };
  }));

  // ----- ACH operations staff -----
  r.add('POST', '/api/ach-ops/incoming-debits', { ownRequestIds: true }, h(async (c, req, body) => recordDebit(c, req, await staffUser(c, req), body)));
  r.add('GET', '/api/ach-ops/items/:id', h(async (c, req, body, { id }) => {
    await staffUser(c, req);
    const it = await loadItem(c, id);
    if (!it) throw notFound();
    return { item: await staffItemView(c, it) };
  }));
  r.add('POST', '/api/ach-ops/items/:id/returns', { ownRequestIds: true }, h(async (c, req, body, { id }) => postReturn(c, req, await staffUser(c, req), body, id)));
  r.add('POST', '/api/ach-ops/items/:id/represent', h(async (c, req, body, { id }) => represent(c, req, await staffUser(c, req), id)));
  r.add('POST', '/api/ach-ops/returns/:id/waive-fee', h(async (c, req, body, { id }) => waiveFee(c, req, await staffUser(c, req), body, id)));
}
