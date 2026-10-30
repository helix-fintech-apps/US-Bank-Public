// Card disputes: a customer disputes a posted card purchase on an own account, bank staff acknowledge it, may issue a
// provisional credit and decide it. Independent of the older /api/cards/... dispute routes (their card_disputes table is
// never read or changed here). Tables: db/migrations/065_card_disputes.sql.
import { createHash } from 'node:crypto';
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { bankToday, addDays } from '../bank-date.mjs';
import { addBusinessDays } from '../money-movement/calendar.mjs';

const FEATURE = 'card-disputes';
const SYSTEM = 'card_disputes';                                      // system account …60 (065_card_disputes.sql)
const OWN = ['owner', 'joint_owner'];
const KINDS = ['checking', 'credit_card'];                            // accounts whose card purchases can be disputed
const REASONS = ['unauthorized', 'wrong_amount', 'duplicate', 'not_received', 'canceled_recurring'];
const STATUSES = ['submitted', 'investigating', 'provisional_credit_issued', 'resolved_in_favor', 'resolved_against', 'withdrawn'];
const OPEN = ['submitted', 'investigating', 'provisional_credit_issued'];
const OUTCOMES = { in_favor: 'resolved_in_favor', against: 'resolved_against' };
const AMOUNT_MAX = 10_000_000_000;                                    // cents; ok-number: an input bound, compared before BigInt()
const WINDOW_DAYS = 60;                                               // a purchase can be disputed up to 60 days after it posted
const DUE = { acknowledge: 1, provisionalCredit: 10, decisionCalendarDays: 45 };
const NOTE_MAX = 1000, DECISION_MAX = 500, NOTES_PER_DISPUTE = 20, LIST_MAX = 100;
// 13 to 19 digits, single spaces or hyphens allowed between them. Longer runs are refused too (they contain one).
const CARD_NUMBER = /\d(?:[ -]?\d){12}/;

const MESSAGES = {
  filed: 'We received your dispute and will acknowledge it within 1 bank day.',
  acknowledged: 'We are looking into your dispute.',
  provisional_credit_issued: 'We added a provisional credit to your account while we finish looking into your dispute.',
  resolved_in_favor: 'We decided your dispute in your favor. The credit to your account is final.',
  resolved_against: 'We looked into your dispute and decided the charge was correct.',
  withdrawn: 'You withdrew your dispute. We have closed it.',
  credit_reversed: 'We took back the provisional credit we added to your account for this dispute.'
};

const sha = s => createHash('sha256').update(s).digest('hex');
const cents = v => Number(v);                                         // ok-number: BigInt cents to a JSON integer, at most 10^10 (safe)
const notFound = () => new AppError(404, 'not_found', 'Dispute not found.');
const invalidState = () => new AppError(409, 'invalid_state', "This dispute can't be changed that way in its current status.");

// ---------- views ----------
function disputeView(d, today = bankToday()) {
  const open = OPEN.includes(d.status);
  return {
    id: d.id, customerId: d.customer_id, transactionId: String(d.line_id), accountId: d.account_id,
    transactionAmountCents: cents(d.transaction_amount_cents), amountCents: cents(d.amount_cents), reason: d.reason, status: d.status,
    filedOn: d.filed_on, acknowledgeDueOn: d.acknowledge_due_on, provisionalCreditDueOn: d.provisional_credit_due_on, decisionDueOn: d.decision_due_on,
    acknowledgedOn: d.acknowledged_on, creditedOn: d.credited_on, closedOn: d.closed_on, decisionReason: d.decision_reason,
    decidedBy: d.decided_by, creditEntryId: d.credit_entry_id, reversalEntryId: d.reversal_entry_id,
    overdue: {                                                         // 'YYYY-MM-DD' strings compare as dates; on the due date nothing is overdue
      acknowledge: d.status === 'submitted' && today > d.acknowledge_due_on,
      provisionalCredit: (d.status === 'submitted' || d.status === 'investigating') && today > d.provisional_credit_due_on,
      decision: open && today > d.decision_due_on
    },
    createdAt: new Date(d.created_at).toISOString()
  };
}
const noteView = n => ({ id: n.id, text: n.text, createdAt: new Date(n.created_at).toISOString() });
const notificationView = n => ({ id: n.id, kind: n.kind, message: n.message, createdAt: new Date(n.created_at).toISOString() });

async function detail(c, d) {
  const notes = (await c.query('SELECT * FROM dispute_notes WHERE dispute_id = $1 ORDER BY created_at, seq', [d.id])).rows;
  const sent = (await c.query('SELECT * FROM dispute_notifications WHERE dispute_id = $1 ORDER BY created_at, seq', [d.id])).rows;
  return { dispute: disputeView(d), notes: notes.map(noteView), notifications: sent.map(notificationView) };
}

// ---------- input checks ----------
/**
 * Evidence text (R13): a string, trimmed, 1 to 1,000 characters, without a card number. Returns the trimmed text, or null when
 * it is blank and `blankOk` (a filing's optional note).
 */
function readNote(v, { blankOk = false } = {}) {
  if (typeof v !== 'string') throw new AppError(400, 'bad_note', 'The note must be text.');
  const t = v.trim();
  if (!t) { if (blankOk) return null; throw new AppError(400, 'bad_note', 'Write a note of 1 to 1,000 characters.'); }
  if ([...t].length > NOTE_MAX) throw new AppError(400, 'bad_note', 'Keep the note to 1,000 characters or fewer.');
  if (CARD_NUMBER.test(t)) throw new AppError(400, 'card_number_in_text', 'For your security, remove the card number from the note.');
  return t;
}
function readAmount(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > AMOUNT_MAX)
    throw new AppError(400, 'bad_amount', 'Enter the amount in dispute as whole cents, from 1 up to the purchase amount.');
  return BigInt(v);
}
function readStatus(query) {
  if (!('status' in query)) return null;
  if (!STATUSES.includes(query.status)) throw new AppError(400, 'bad_status', `Status must be one of: ${STATUSES.join(', ')}.`);
  return query.status;
}
/** What makes two filings "the same request" (R12): the four request fields, exactly as sent. */
const fingerprint = b => sha(JSON.stringify([b.transactionId ?? null, b.amountCents ?? null, b.reason ?? null, b.note ?? null]));

// ---------- lookups ----------
const isStaff = async (c, userId) => (await c.query('SELECT 1 FROM staff_members WHERE user_id = $1', [userId])).rowCount > 0;
async function requireStaff(c, req) {
  const u = await requireUser(c, req);
  if (!(await isStaff(c, u.id))) throw new AppError(403, 'staff_only', 'Only bank staff can do this.');
  return u;
}
/** A dispute, locked for a change when `lock`. `customerId` limits it to that customer's own disputes (a 404 otherwise). */
async function disputeFor(c, id, { customerId = null, lock = false } = {}) {
  if (!isUuid(id)) throw notFound();
  const d = (await c.query(`SELECT * FROM dispute_cases WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!d || (customerId && d.customer_id !== customerId)) throw notFound();
  return d;
}
/** A card purchase line (section 4.1) on an account the user owns or jointly owns, or null. */
async function cardLine(c, userId, lineId) {
  return (await c.query(`SELECT l.id, l.account_id, l.amount_cents, l.description, l.posted_on, a.number_last4
      FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      JOIN account_owners o ON o.account_id = a.id AND o.user_id = $2 AND o.role = ANY($3)
     WHERE l.id = $1 AND l.amount_cents < 0 AND a.kind = ANY($4) AND e.kind = 'card_purchase'`, [lineId, userId, OWN, KINDS])).rows[0] ?? null;
}
const creditedOn = async (c, lineId) => BigInt((await c.query(
  `SELECT coalesce(sum(amount_cents), 0)::bigint s FROM dispute_cases WHERE line_id = $1 AND status = 'resolved_in_favor'`, [lineId])).rows[0].s);

// ---------- writes ----------
async function notify(c, d, kind) {
  await c.query('INSERT INTO dispute_notifications (id, dispute_id, user_id, kind, message) VALUES ($1,$2,$3,$4,$5)',
    [newId(), d.id, d.customer_id, kind, MESSAGES[kind]]);
}
async function update(c, id, fields) {
  const keys = Object.keys(fields);
  return (await c.query(`UPDATE dispute_cases SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...keys.map(k => fields[k])])).rows[0];
}
async function ledgerContext(c, d) {
  const l = (await c.query(`SELECT l.description, a.number_last4 FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE l.id = $1`, [d.line_id])).rows[0];
  return { description: l.description, last4: l.number_last4 ?? '' };
}
/** The credit (R20): amountCents into the transaction's account from the card_disputes system account. */
async function postCredit(c, req, d, actorId) {
  const { description, last4 } = await ledgerContext(c, d);
  const amount = BigInt(d.amount_cents);
  const { entryId } = await post(c, { key: `${d.customer_id}:${FEATURE}:${d.id}:credit`, kind: 'dispute_credit', createdBy: actorId, lines: [
    { accountId: d.account_id, amountCents: amount, description: `Dispute credit: ${description}`, category: 'Disputes' },
    { accountId: await systemAccount(c, SYSTEM), amountCents: -amount, description: `Dispute credit ··${last4}` }] });
  await audit(c, req, actorId, 'disputes.credit', { dispute: d.id, entryId, amountCents: cents(amount) });
  return { credited_on: bankToday(), credit_entry_id: entryId };
}
/** The reversal (R22, R24): the credit taken back. A refusal by the ledger is 409 insufficient_funds and the caller's tx rolls back. */
async function postReversal(c, req, d, actorId) {
  const { description, last4 } = await ledgerContext(c, d);
  const amount = BigInt(d.amount_cents);
  let entryId;
  try {
    ({ entryId } = await post(c, { key: `${d.customer_id}:${FEATURE}:${d.id}:reversal`, kind: 'dispute_credit_reversal', createdBy: actorId, lines: [
      { accountId: d.account_id, amountCents: -amount, description: `Dispute credit reversed: ${description}`, category: 'Disputes' },
      { accountId: await systemAccount(c, SYSTEM), amountCents: amount, description: `Dispute credit reversed ··${last4}` }] }));
  } catch (e) {
    // a deposit account below zero (insufficient_funds) or a card past its limit (over_limit): the money isn't there to take back yet
    if (e.code === 'insufficient_funds' || e.code === 'over_limit')
      throw new AppError(409, 'insufficient_funds', "The account doesn't have enough money to take back the provisional credit. Try again later.");
    throw e;
  }
  await audit(c, req, actorId, 'disputes.credit_reversed', { dispute: d.id, entryId, amountCents: cents(amount) });
  return { reversal_entry_id: entryId };
}

export function register(r) {
  // ---------- customer ----------
  r.add('GET', '/api/card-disputes/transactions', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT l.id, l.account_id, l.description, l.amount_cents, l.posted_on,
        EXISTS (SELECT 1 FROM dispute_cases d WHERE d.line_id = l.id AND d.status = ANY($4)) has_open,
        (SELECT coalesce(sum(d.amount_cents), 0)::bigint FROM dispute_cases d WHERE d.line_id = l.id AND d.status = 'resolved_in_favor') credited
      FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      JOIN account_owners o ON o.account_id = a.id AND o.user_id = $1 AND o.role = ANY($2)
      WHERE l.amount_cents < 0 AND a.kind = ANY($3) AND e.kind = 'card_purchase' AND l.posted_on <= $5::date
      ORDER BY l.posted_on DESC, l.id DESC LIMIT $6`, [u.id, OWN, KINDS, OPEN, bankToday(), LIST_MAX])).rows;
    return { transactions: rows.map(l => ({ transactionId: String(l.id), accountId: l.account_id, description: l.description,
      amountCents: cents(-BigInt(l.amount_cents)), postedOn: l.posted_on, hasOpenDispute: l.has_open, creditedCents: cents(l.credited) })) };
  }));

  r.add('POST', '/api/card-disputes', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = requestKey(body);
    // the same request id is handled one at a time, so simultaneous identical requests make one dispute
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:key:${u.id}:${key}`]);
    const fp = fingerprint(body);
    const prev = (await c.query('SELECT * FROM dispute_cases WHERE customer_id = $1 AND idempotency_key = $2', [u.id, key])).rows[0];
    if (prev) { if (prev.fingerprint !== fp) throw conflict(); return { dispute: disputeView(prev), replayed: true }; }

    if (typeof body.reason !== 'string' || !REASONS.includes(body.reason))
      throw new AppError(400, 'bad_reason', `Choose a reason: ${REASONS.join(', ')}.`);
    const amount = readAmount(body.amountCents);
    if (typeof body.transactionId !== 'string' || !/^\d{1,18}$/.test(body.transactionId))
      throw new AppError(400, 'bad_transaction', 'Choose the card transaction to dispute.');
    const note = body.note === undefined || body.note === null ? null : readNote(body.note, { blankOk: true });

    const line = await cardLine(c, u.id, body.transactionId);
    if (!line) throw new AppError(404, 'not_found', 'Transaction not found.');
    const today = bankToday();
    if (line.posted_on > today) throw new AppError(422, 'not_posted', "This purchase hasn't posted yet. You can dispute it once it posts.");
    if (line.posted_on < addDays(today, -WINDOW_DAYS))
      throw new AppError(422, 'window_closed', `Purchases can be disputed up to ${WINDOW_DAYS} days after they post.`);

    // filings for one transaction are handled one at a time (one open dispute per transaction; the credited total is current)
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:line:${line.id}`]);
    if ((await c.query('SELECT 1 FROM dispute_cases WHERE line_id = $1 AND status = ANY($2)', [line.id, OPEN])).rowCount)
      throw new AppError(409, 'dispute_exists', 'This transaction already has an open dispute.');
    const txAmount = -BigInt(line.amount_cents);
    if (amount > txAmount - await creditedOn(c, line.id))
      throw new AppError(422, 'amount_exceeds_transaction', 'The amount in dispute is more than what is left of this purchase to dispute.');

    const id = newId();
    const d = (await c.query(`INSERT INTO dispute_cases (id, customer_id, line_id, account_id, transaction_amount_cents, amount_cents, reason, filed_on,
        acknowledge_due_on, provisional_credit_due_on, decision_due_on, idempotency_key, fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, u.id, line.id, line.account_id, txAmount, amount, body.reason, today, addBusinessDays(today, DUE.acknowledge),
        addBusinessDays(today, DUE.provisionalCredit), addDays(today, DUE.decisionCalendarDays), key, fp])).rows[0];
    if (note) await c.query('INSERT INTO dispute_notes (id, dispute_id, text) VALUES ($1,$2,$3)', [newId(), id, note]);
    await notify(c, d, 'filed');
    await audit(c, req, u.id, 'disputes.file', { dispute: id, transactionId: String(line.id), amountCents: cents(amount), reason: body.reason });
    return { dispute: disputeView(d), replayed: false };
  }));

  r.add('GET', '/api/card-disputes', async ({ req, pool, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const status = readStatus(query);
    const rows = (await c.query(`SELECT * FROM dispute_cases WHERE customer_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, seq DESC`, [u.id, status])).rows;
    const today = bankToday();
    return { disputes: rows.map(d => disputeView(d, today)) };
  }));

  r.add('GET', '/api/card-disputes/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    return detail(c, await disputeFor(c, params.id, { customerId: u.id }));
  }));

  r.add('POST', '/api/card-disputes/:id/notes', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const d = await disputeFor(c, params.id, { customerId: u.id, lock: true });
    const text = readNote(body.text);
    if (!OPEN.includes(d.status)) throw invalidState();
    const n = (await c.query('SELECT count(*)::int n FROM dispute_notes WHERE dispute_id = $1', [d.id])).rows[0].n;
    if (n >= NOTES_PER_DISPUTE) throw new AppError(422, 'note_limit', `A dispute can hold up to ${NOTES_PER_DISPUTE} notes.`);
    const note = (await c.query('INSERT INTO dispute_notes (id, dispute_id, text) VALUES ($1,$2,$3) RETURNING *', [newId(), d.id, text])).rows[0];
    await audit(c, req, u.id, 'disputes.note', { dispute: d.id, noteId: note.id });
    return { note: noteView(note) };
  }));

  r.add('POST', '/api/card-disputes/:id/withdraw', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const d = await disputeFor(c, params.id, { customerId: u.id, lock: true });
    requireStepUp(u);
    if (!OPEN.includes(d.status)) throw invalidState();
    const reversal = d.status === 'provisional_credit_issued' ? await postReversal(c, req, d, u.id) : {};
    const out = await update(c, d.id, { status: 'withdrawn', closed_on: bankToday(), ...reversal });
    await audit(c, req, u.id, 'disputes.withdraw', { dispute: d.id });
    await notify(c, out, 'withdrawn');
    if (reversal.reversal_entry_id) await notify(c, out, 'credit_reversed');
    return { dispute: disputeView(out) };
  }));

  // ---------- staff ----------
  r.add('GET', '/api/staff/card-disputes', async ({ req, pool, query }) => tx(pool, async c => {
    await requireStaff(c, req);
    const status = readStatus(query);
    const rows = (await c.query(`SELECT * FROM dispute_cases WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, seq DESC`, [status])).rows;
    const today = bankToday();
    return { disputes: rows.map(d => disputeView(d, today)) };
  }));

  r.add('GET', '/api/staff/card-disputes/:id', async ({ req, pool, params }) => tx(pool, async c => {
    await requireStaff(c, req);
    return detail(c, await disputeFor(c, params.id));
  }));

  /** Checks shared by the staff actions (R21 order): staff, the dispute, not their own; returns both, the dispute locked. */
  async function staffAction(c, req, id) {
    const u = await requireStaff(c, req);
    const d = await disputeFor(c, id, { lock: true });
    if (d.customer_id === u.id) throw new AppError(403, 'own_dispute', "You can't act on a dispute you filed. Ask another staff member.");
    return { u, d };
  }

  r.add('POST', '/api/staff/card-disputes/:id/acknowledge', async ({ req, pool, params }) => tx(pool, async c => {
    const { u, d } = await staffAction(c, req, params.id);
    if (d.status !== 'submitted') throw invalidState();
    const out = await update(c, d.id, { status: 'investigating', acknowledged_on: bankToday() });
    await audit(c, req, u.id, 'disputes.acknowledge', { dispute: d.id });
    await notify(c, out, 'acknowledged');
    return { dispute: disputeView(out) };
  }));

  r.add('POST', '/api/staff/card-disputes/:id/provisional-credit', async ({ req, pool, params }) => tx(pool, async c => {
    const { u, d } = await staffAction(c, req, params.id);
    if (d.status !== 'investigating') throw invalidState();
    const credit = await postCredit(c, req, d, u.id);
    const out = await update(c, d.id, { status: 'provisional_credit_issued', ...credit });
    await notify(c, out, 'provisional_credit_issued');
    return { dispute: disputeView(out) };
  }));

  r.add('POST', '/api/staff/card-disputes/:id/resolve', async ({ req, pool, params, body }) => tx(pool, async c => {
    const { u, d } = await staffAction(c, req, params.id);
    const status = Object.hasOwn(OUTCOMES, body.outcome) ? OUTCOMES[body.outcome] : null;
    if (!status) throw new AppError(400, 'bad_outcome', 'Choose an outcome: in_favor or against.');
    const reason = typeof body.decisionReason === 'string' ? body.decisionReason.trim() : '';
    if (!reason || [...reason].length > DECISION_MAX) throw new AppError(400, 'reason_required', 'Write the reason for the decision (1 to 500 characters).');
    if (d.status !== 'investigating' && d.status !== 'provisional_credit_issued') throw invalidState();
    let money = {};
    if (body.outcome === 'in_favor' && d.status === 'investigating') money = await postCredit(c, req, d, u.id);
    if (body.outcome === 'against' && d.status === 'provisional_credit_issued') money = await postReversal(c, req, d, u.id);
    const out = await update(c, d.id, { status, decision_reason: reason, decided_by: u.id, closed_on: bankToday(), ...money });
    await audit(c, req, u.id, 'disputes.resolve', { dispute: d.id, outcome: body.outcome });
    await notify(c, out, status);
    if (money.reversal_entry_id) await notify(c, out, 'credit_reversed');
    return { dispute: disputeView(out) };
  }));
}
