// Outbound wires, domestic and international, with sanctions screening, compliance review and a second approval from
// $10,000.00. A wire is screened once, when requested: a hit is stopped (a compliance case opens, nothing moves); a
// potential match is held for compliance staff to release or reject; a clear wire under the threshold is released at
// once, one at or over it waits for another owner of the account to approve. While a wire waits, its amount and fee are
// held on the source account (lib/wire-screening/holds.mjs). Releasing posts one ledger entry (amount to mm_wire_out,
// fee to mm_wire_fees), records a transfers row and the wire limit, and sends it like any other wire (money-movement.mjs).
// Simulated: the sanctions list is fictional and no real wire network is involved.
import { AppError, refuse, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { clock, today, processingDay } from '../money-movement/calendar.mjs';
import { seal, abaOk } from '../money-movement/vault.mjs';
import { limitsFor, useLimit, usd } from '../money-movement/limits.mjs';
import { sendWire } from './money-movement.mjs';
import { screen, rawTokens, COUNTRIES } from '../wire-screening/screening.mjs';
import { WAITING, lockHolds, availableOf } from '../wire-screening/holds.mjs';

const FEATURE = 'wire-screening';
const AUTHORIZED = ['owner', 'joint_owner'];             // who may request, see, approve and cancel a wire on an account
const SOURCE_KINDS = ['checking', 'savings', 'money_market'];
export const FEES = { domestic: 2500n, international: 4500n };   // domestic matches money-movement's WIRE_FEE ($25); international $45
export const SECOND_APPROVAL_CENTS = 1_000_000n;         // $10,000.00 and over needs a second approver
export const MAX_CENTS = 10_000_000_000;                 // $100,000,000.00: the largest amount a request may name
const STATUSES = ['awaiting_approval', 'under_review', 'stopped', 'released', 'rejected', 'canceled'];
const SWIFT = /^[A-Za-z]{4}[A-Za-z]{2}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/;

const now = () => clock.now();
const lock = (c, s) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s]);
const cents = v => (v == null ? null : Number(v));
const notFound = () => new AppError(404, 'not_found', 'Wire not found.');
const invalidState = what => new AppError(409, 'invalid_state', `This wire can't be ${what} now.`);
const trimmed = (v, min, max) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);

// ---------- views ----------
/** What the customer sees: the screening result and status only, never what matched or who reviewed it. */
const wireView = w => ({
  id: w.id, status: w.status, type: w.type, fromAccountId: w.from_account_id, amountCents: cents(w.amount_cents), feeCents: cents(w.fee_cents),
  beneficiary: { name: w.beneficiary_name, bankName: w.beneficiary_bank, bankIdentifier: w.bank_identifier, accountMasked: `****${w.account_last4}`, country: w.country },
  purpose: w.purpose, screening: { result: w.screening_result }, secondApprovalRequired: w.second_approval_required,
  requestedBy: w.requested_by, approvedBy: w.approved_by ?? null, approvedAt: w.approved_at ?? null,
  holdCents: WAITING.includes(w.status) ? cents(w.amount_cents) + cents(w.fee_cents) : 0,
  valueDate: w.value_date ?? null, entryId: w.entry_id ?? null, createdAt: w.created_at, releasedAt: w.released_at ?? null
});
/** What compliance staff see: also what matched, the case and the review decision. */
const staffView = w => {
  const v = wireView(w);
  return { ...v, screening: { result: w.screening_result, matches: w.screening_matches }, caseId: w.case_id ?? null,
    review: w.review_decision ? { reviewedBy: w.reviewed_by, decision: w.review_decision, reason: w.review_reason, reviewedAt: w.reviewed_at } : null };
};
const caseView = k => ({ id: k.id, wireId: k.wire_id, kind: k.kind, status: k.status, outcome: k.outcome ?? null, openedAt: k.opened_at,
  closedAt: k.closed_at ?? null, closedBy: k.closed_by ?? null, closeReason: k.close_reason ?? null });

const WIRE_SQL = 'SELECT w.*, k.id AS case_id FROM wire_requests w LEFT JOIN compliance_cases k ON k.wire_id = w.id';
const wireById = async (c, id) => (await c.query(`${WIRE_SQL} WHERE w.id = $1`, [id])).rows[0];

// ---------- access ----------
const isStaff = async (c, userId) => (await c.query("SELECT 1 FROM staff_roles WHERE user_id = $1 AND role = 'compliance'", [userId])).rowCount > 0;
async function requireStaff(c, user) {
  if (!(await isStaff(c, user.id))) throw new AppError(403, 'forbidden', 'Only compliance staff can do this.');
}
/** A wire the caller is an authorized user of (owner or joint owner of its source account), locked for the change. Anything else: 404. */
async function visibleWire(c, user, id, { forUpdate = false } = {}) {
  if (!isUuid(id)) throw notFound();
  const w = (await c.query(`SELECT w.id FROM wire_requests w JOIN account_owners o ON o.account_id = w.from_account_id
     WHERE w.id = $1 AND o.user_id = $2 AND o.role = ANY($3)`, [id, user.id, AUTHORIZED])).rows[0];
  if (!w) throw notFound();
  if (forUpdate) await c.query('SELECT 1 FROM wire_requests WHERE id = $1 FOR UPDATE', [id]);
  return wireById(c, id);
}
/** Any wire, for staff. Locked for the change. */
async function staffWire(c, id) {
  if (!isUuid(id)) throw notFound();
  if (!(await c.query('SELECT 1 FROM wire_requests WHERE id = $1 FOR UPDATE', [id])).rowCount) throw notFound();
  return wireById(c, id);
}
const reasonOf = body => {
  const r = trimmed(body.reason, 5, 500);
  if (!r) throw new AppError(400, 'reason_required', 'Give a reason of 5 to 500 characters.');
  return r;
};
/** Four eyes: staff can't review a wire they requested or approved. The refused attempt is kept in the audit trail. */
async function fourEyes(c, req, user, w, attempted) {
  if (w.requested_by !== user.id && w.approved_by !== user.id) return;
  await audit(c, req, user.id, 'wire.review_refused', { wire: w.id, reviewer: user.id, attempted, reason: 'conflict_of_interest' });
  throw refuse(403, 'conflict_of_interest', 'You requested or approved this wire, so another member of staff must review it.');
}

// ---------- validation (R5 to R9, in this order) ----------
function readRequest(body) {
  const type = body.type;
  if (type !== 'domestic' && type !== 'international') throw new AppError(400, 'bad_type', 'Choose a domestic or an international wire.');
  const amount = body.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_CENTS)
    throw new AppError(400, 'bad_amount', `Enter the amount in whole cents, from 1 to ${MAX_CENTS}.`);
  const name = trimmed(body.beneficiaryName, 2, 100);
  if (!name || !rawTokens(name).length) throw new AppError(400, 'bad_beneficiary', "Enter the beneficiary's name: 2 to 100 characters.");
  const bank = trimmed(body.beneficiaryBankName, 2, 80);
  if (!bank) throw new AppError(400, 'bad_bank', "Enter the name of the beneficiary's bank: 2 to 80 characters.");
  const bid = body.bankIdentifier;
  if (typeof bid !== 'string' || !(type === 'domestic' ? abaOk(bid) : SWIFT.test(bid)))
    throw new AppError(400, 'bad_bank_identifier', type === 'domestic' ? 'Enter the 9-digit routing number of the beneficiary bank.' : 'Enter the 8- or 11-character SWIFT code of the beneficiary bank.');
  const num = typeof body.accountNumber === 'string' ? body.accountNumber.replace(/[\s-]/g, '') : '';
  const [chars, longest] = type === 'domestic' ? [/^\d+$/, 17] : [/^[A-Za-z0-9]+$/, 34];
  if (!chars.test(num) || num.length < 8 || num.length > longest)
    throw new AppError(400, 'bad_account_number', type === 'domestic' ? 'Enter the account number: 8 to 17 digits.' : 'Enter the account number or IBAN: 8 to 34 letters and digits.');
  const country = body.country;
  if (typeof country !== 'string' || !(country in COUNTRIES) || (type === 'domestic') !== (country === 'US'))
    throw new AppError(400, 'bad_country', type === 'domestic' ? 'A domestic wire goes to the US.' : 'Choose the country of the beneficiary bank (not the US).');
  const purpose = trimmed(body.purpose, 3, 140);
  if (!purpose) throw new AppError(400, 'bad_purpose', 'Say what the wire is for: 3 to 140 characters.');
  if (typeof body.fromAccountId !== 'string') throw new AppError(400, 'bad_account', 'Choose the account to send from.');
  return { type, amount: BigInt(amount), name, bank, bankId: type === 'domestic' ? bid : bid.toUpperCase(), num, country, purpose, fromId: body.fromAccountId };
}

// ---------- releasing ----------
/**
 * Pays a wire, once: one ledger entry, a transfers row (same id as the wire), its use of the wire limit, and it goes out now
 * (before its cut-off on a business day) or on its value date through run-due. The caller holds the wire's row lock.
 * The ledger balance must still cover amount + fee; if not, 409 and the whole request (and whatever triggered it) rolls back.
 */
async function release(c, req, w, actorId) {
  const amount = BigInt(w.amount_cents), fee = BigInt(w.fee_cents);
  const { balance } = await availableOf(c, w.from_account_id);
  if (balance < amount + fee)
    throw new AppError(409, 'insufficient_funds', `The account has ${usd(balance)}, which isn't enough for this wire and its fee (${usd(amount + fee)}). Add money and try again.`);
  const t = today(), valueDate = processingDay(w.type === 'international' ? 'wire_intl' : 'wire'), at = now();
  const kind = w.type === 'international' ? 'International' : 'Domestic', who = `${w.beneficiary_name} at ${w.beneficiary_bank} ··${w.account_last4}`;
  const key = `${w.requested_by}:${FEATURE}:${w.id}:release`;
  const e = await post(c, { key, kind: 'wire', memo: w.purpose, createdBy: actorId, lines: [
    { accountId: w.from_account_id, amountCents: -amount, description: `${kind} wire to ${who}`, category: 'Transfers', postedOn: t },
    { accountId: w.from_account_id, amountCents: -fee, description: `Outgoing ${kind.toLowerCase()} wire fee`, category: 'Fees & Charges', postedOn: t },
    { accountId: await systemAccount(c, 'mm_wire_out'), amountCents: amount, description: `Wire out: ${who}`, postedOn: t },
    { accountId: await systemAccount(c, 'mm_wire_fees'), amountCents: fee, description: `${kind} wire fee`, postedOn: t }] });
  const row = (await c.query(`INSERT INTO transfers (id, user_id, rail, from_account_id, counterparty, counterparty_routing, counterparty_last4, counterparty_enc,
      amount_cents, fee_cents, memo, status, process_on, booked_on, idempotency_key, entry_id, created_at, updated_at)
    VALUES ($1,$2,'wire',$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',$11,$12,$13,$14,$15,$15) RETURNING *`,
    [w.id, w.requested_by, w.from_account_id, who, w.bank_identifier, w.account_last4, w.account_enc, amount, fee, w.purpose, valueDate, t, key, e.entryId, at])).rows[0];
  await useLimit(c, row);
  await c.query(`UPDATE wire_requests SET status = 'released', entry_id = $2, value_date = $3, released_at = $4, released_by = $5, updated_at = $4 WHERE id = $1`,
    [w.id, e.entryId, valueDate, at, actorId]);
  await audit(c, req, actorId, 'wire.released', { wire: w.id, entry: e.entryId, valueDate, amountCents: Number(amount), feeCents: Number(fee) });
  if (valueDate === t) await sendWire(c, req, { id: actorId }, row);        // before the cut-off it goes out now, exactly like a wire sent from Pay
}

async function closeCase(c, wireId, outcome, closedBy, reason) {
  await c.query(`UPDATE compliance_cases SET status = 'closed', outcome = $2, closed_at = $3, closed_by = $4, close_reason = $5 WHERE wire_id = $1 AND status = 'open'`,
    [wireId, outcome, now(), closedBy, reason]);
}

// ---------- routes ----------
export function register(r) {
  const h = fn => async ({ req, pool, params, body, query }) => tx(pool, async c => fn(c, req, await requireUser(c, req), body, params, query));

  // 1. request a wire
  r.add('POST', '/api/wire-requests', h(async (c, req, u, body) => {
    const key = `${u.id}:${FEATURE}:${requestKey(body)}`, fingerprint = fingerprintOf({}, body);
    await lock(c, `mm:${u.id}`);                           // one at a time per customer: the request id, the limit and (below) the account
    const prev = (await c.query('SELECT * FROM wire_requests WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) {
      if (prev.fingerprint !== fingerprint) throw conflict();
      return { wire: wireView(prev), replayed: true };
    }
    const x = readRequest(body);
    const a = await accountFor(c, u.id, x.fromId, AUTHORIZED);
    if (!SOURCE_KINDS.includes(a.kind)) throw new AppError(400, 'bad_account', 'Choose a checking, savings or money market account to send from.');
    if (a.status !== 'open') throw new AppError(409, 'account_not_open', `${a.name} ··${a.number_last4} isn't open for wires.`);
    requireStepUp(u);
    const { result, matches } = screen(x.name, x.country);
    const fee = FEES[x.type];
    if (result !== 'hit') {
      // the wire limit: what is left today and in 30 days must cover this wire and the caller's own wires still waiting
      const l = await limitsFor(c, u.id, 'wire');
      const waiting = BigInt((await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM wire_requests WHERE requested_by = $1 AND status = ANY($2)', [u.id, WAITING])).rows[0].s);
      const need = x.amount + waiting;
      if (l.perTxn != null && x.amount > l.perTxn) throw new AppError(422, 'over_limit', `Wires are limited to ${usd(l.perTxn)} each.`);
      if (need > l.leftDay) throw new AppError(422, 'over_limit', `That's over your daily wire limit. You can send up to ${usd(l.leftDay > waiting ? l.leftDay - waiting : 0n)} more today.`);
      if (need > l.leftMonth) throw new AppError(422, 'over_limit', `That's over your 30-day wire limit. You can send up to ${usd(l.leftMonth > waiting ? l.leftMonth - waiting : 0n)} more right now.`);
      await lockHolds(c, a.id);
      const { available } = await availableOf(c, a.id);
      if (x.amount + fee > available)
        throw new AppError(409, 'insufficient_funds', `${a.name} ··${a.number_last4} has ${usd(available)} available, which isn't enough for this wire and its fee (${usd(x.amount + fee)}).`);
    }
    const id = newId(), at = now();
    const status = result === 'hit' ? 'stopped' : result === 'potential_match' ? 'under_review' : 'awaiting_approval';
    await c.query(`INSERT INTO wire_requests (id, idempotency_key, fingerprint, requested_by, from_account_id, type, status, amount_cents, fee_cents,
        beneficiary_name, beneficiary_bank, bank_identifier, account_last4, account_enc, country, purpose, screening_result, screening_matches,
        second_approval_required, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)`,
      [id, key, fingerprint, u.id, a.id, x.type, status, x.amount, fee, x.name, x.bank, x.bankId, x.num.slice(-4), seal(x.num, `${u.id}:${id}`),
        x.country, x.purpose, result, JSON.stringify(matches), x.amount >= SECOND_APPROVAL_CENTS, at]);
    let caseId = null;
    if (result !== 'clear') {
      caseId = newId();
      await c.query('INSERT INTO compliance_cases (id, wire_id, kind, opened_at) VALUES ($1,$2,$3,$4)', [caseId, id, result, at]);
    }
    await audit(c, req, u.id, 'wire.requested', { wire: id, type: x.type, amountCents: Number(x.amount), feeCents: Number(fee), country: x.country });
    await audit(c, req, u.id, 'wire.screened', { wire: id, result, matches, case: caseId });
    if (result === 'clear' && x.amount < SECOND_APPROVAL_CENTS) await release(c, req, await wireById(c, id), u.id);
    return { wire: wireView(await wireById(c, id)), replayed: false };
  }));

  // 2. list, 3. one wire, 4. availability
  r.add('GET', '/api/wire-requests', h(async (c, req, u, body, params, query) => {
    if (query.status !== undefined && !STATUSES.includes(query.status)) throw new AppError(400, 'bad_status', `Status is one of: ${STATUSES.join(', ')}.`);
    const rows = (await c.query(`${WIRE_SQL} WHERE EXISTS (SELECT 1 FROM account_owners o WHERE o.account_id = w.from_account_id AND o.user_id = $1 AND o.role = ANY($2))
        AND ($3::text IS NULL OR w.status = $3) ORDER BY w.created_at DESC, w.seq DESC`, [u.id, AUTHORIZED, query.status ?? null])).rows;
    return { wires: rows.map(wireView) };
  }));
  r.add('GET', '/api/wire-requests/availability/:accountId', h(async (c, req, u, body, { accountId }) => {
    const a = await accountFor(c, u.id, accountId, AUTHORIZED);
    const { balance, held, available } = await availableOf(c, a.id);
    return { accountId: a.id, balanceCents: Number(balance), heldCents: Number(held), availableCents: Number(available) };
  }));
  r.add('GET', '/api/wire-requests/:id', h(async (c, req, u, body, { id }) => ({ wire: wireView(await visibleWire(c, u, id)) })));

  // 5. second approval
  r.add('POST', '/api/wire-requests/:id/approve', h(async (c, req, u, body, { id }) => {
    const w = await visibleWire(c, u, id, { forUpdate: true });
    requireStepUp(u);
    if (w.requested_by === u.id) throw new AppError(403, 'approver_must_differ', 'Someone other than the person who asked for this wire must approve it.');
    if (w.reviewed_by === u.id) {
      await audit(c, req, u.id, 'wire.review_refused', { wire: w.id, reviewer: u.id, attempted: 'approve', reason: 'conflict_of_interest' });
      throw refuse(403, 'conflict_of_interest', 'You reviewed this wire for compliance, so another owner of the account must approve it.');
    }
    if (w.approved_by === u.id) return { wire: wireView(w), replayed: true };
    if (!WAITING.includes(w.status) || w.approved_by) throw invalidState('approved');
    if (!w.second_approval_required) throw new AppError(409, 'approval_not_required', 'This wire is under $10,000.00, so it needs no second approval.');
    const at = now();
    await c.query('UPDATE wire_requests SET approved_by = $2, approved_at = $3, updated_at = $3 WHERE id = $1', [w.id, u.id, at]);
    await audit(c, req, u.id, 'wire.approved', { wire: w.id, approver: u.id });
    if (w.status === 'awaiting_approval') await release(c, req, await wireById(c, w.id), u.id);
    return { wire: wireView(await wireById(c, w.id)), replayed: false };
  }));

  // 6. cancel (the requester only, while it waits)
  r.add('POST', '/api/wire-requests/:id/cancel', h(async (c, req, u, body, { id }) => {
    const w = await visibleWire(c, u, id, { forUpdate: true });
    if (w.requested_by !== u.id) throw new AppError(403, 'forbidden', 'Only the person who asked for this wire can cancel it.');
    if (!WAITING.includes(w.status)) throw invalidState('canceled');
    const at = now();
    await c.query("UPDATE wire_requests SET status = 'canceled', canceled_at = $2, updated_at = $2 WHERE id = $1", [w.id, at]);
    await closeCase(c, w.id, 'canceled', u.id, null);
    await audit(c, req, u.id, 'wire.canceled', { wire: w.id });
    return { wire: wireView(await wireById(c, w.id)) };
  }));

  // 7. and 8. compliance cases
  r.add('GET', '/api/compliance/cases', h(async (c, req, u, body, params, query) => {
    await requireStaff(c, u);
    if (query.status !== undefined && !['open', 'closed'].includes(query.status)) throw new AppError(400, 'bad_status', 'Status is open or closed.');
    const cases = (await c.query('SELECT * FROM compliance_cases WHERE ($1::text IS NULL OR status = $1) ORDER BY opened_at DESC, seq DESC', [query.status ?? null])).rows;
    const wires = new Map((await c.query(`${WIRE_SQL} WHERE w.id = ANY($1)`, [cases.map(k => k.wire_id)])).rows.map(w => [w.id, w]));
    return { cases: cases.map(k => ({ ...caseView(k), wire: staffView(wires.get(k.wire_id)) })) };
  }));
  r.add('GET', '/api/compliance/cases/:id', h(async (c, req, u, body, { id }) => {
    await requireStaff(c, u);
    const k = isUuid(id) ? (await c.query('SELECT * FROM compliance_cases WHERE id = $1', [id])).rows[0] : null;
    if (!k) throw new AppError(404, 'not_found', 'Case not found.');
    const history = (await c.query("SELECT at, action, user_id, detail FROM audit_events WHERE detail ? 'wire' AND detail->>'wire' = $1 ORDER BY id", [k.wire_id])).rows
      .map(e => ({ at: e.at, action: e.action, actorId: e.user_id, detail: e.detail }));
    return { case: caseView(k), wire: staffView(await wireById(c, k.wire_id)), history };
  }));

  // 9. and 10. release or reject a wire held for review
  for (const [path, decision, verb] of [['release', 'released', 'released'], ['reject', 'rejected', 'rejected']]) {
    r.add('POST', `/api/compliance/wires/:id/${path}`, h(async (c, req, u, body, { id }) => {
      await requireStaff(c, u);
      const w = await staffWire(c, id);
      const reason = reasonOf(body);
      await fourEyes(c, req, u, w, path);
      if (w.reviewed_by === u.id && w.review_decision === decision) return { wire: staffView(w), replayed: true };
      if (w.status !== 'under_review') throw invalidState(verb);
      const at = now();
      await c.query(`UPDATE wire_requests SET reviewed_by = $2, review_decision = $3, review_reason = $4, reviewed_at = $5, updated_at = $5,
          status = CASE WHEN $3 = 'rejected' THEN 'rejected' ELSE 'awaiting_approval' END WHERE id = $1`, [w.id, u.id, decision, reason, at]);
      await closeCase(c, w.id, decision, u.id, reason);
      await audit(c, req, u.id, decision === 'released' ? 'wire.review_released' : 'wire.review_rejected', { wire: w.id, reviewer: u.id, reason });
      if (decision === 'released' && (!w.second_approval_required || w.approved_by)) await release(c, req, await wireById(c, w.id), u.id);
      return { wire: staffView(await wireById(c, w.id)), replayed: false };
    }));
  }

  // 11. close the case of a hit (the wire stays stopped)
  r.add('POST', '/api/compliance/cases/:id/close', h(async (c, req, u, body, { id }) => {
    await requireStaff(c, u);
    if (!isUuid(id) || !(await c.query('SELECT 1 FROM compliance_cases WHERE id = $1 FOR UPDATE', [id])).rowCount) throw new AppError(404, 'not_found', 'Case not found.');
    const k = (await c.query('SELECT * FROM compliance_cases WHERE id = $1', [id])).rows[0];
    const reason = reasonOf(body);
    await fourEyes(c, req, u, await wireById(c, k.wire_id), 'close');
    if (k.status === 'closed' && k.outcome === 'confirmed_hit' && k.closed_by === u.id) return { case: caseView(k), replayed: true };
    if (k.status !== 'open' || k.kind !== 'hit') throw new AppError(409, 'invalid_state', 'Only an open case of a screening hit can be closed here.');
    await closeCase(c, k.wire_id, 'confirmed_hit', u.id, reason);
    await audit(c, req, u.id, 'wire.case_closed', { wire: k.wire_id, case: k.id, reviewer: u.id, reason });
    return { case: caseView((await c.query('SELECT * FROM compliance_cases WHERE id = $1', [id])).rows[0]), replayed: false };
  }));
}
