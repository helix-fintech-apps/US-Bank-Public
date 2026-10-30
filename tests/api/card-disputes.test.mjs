// Card disputes: filing on own posted card purchases, staff review (acknowledge, provisional credit, decide), withdrawal,
// deadlines, request ids, the ledger postings, the audit trail and the notification records.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { clock, bankToday, addDays } from '../../lib/bank-date.mjs';

let env, staffA, staffB;
before(async () => {
  env = await testEnv();
  staffA = await customer('StaffA', { staff: true }); staffB = await customer('StaffB', { staff: true });   // two staff members
});
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
/** Moves the bank's clock to noon Central Time on a date (the server runs in this process, so it moves the API's "today"). */
const setToday = d => { clock.now = () => new Date(`${d}T18:00:00Z`); };

let n = 0;
const key = () => `dispute-key-${++n}-${Date.now()}`;
const STATUSES = ['submitted', 'investigating', 'provisional_credit_issued', 'resolved_in_favor', 'resolved_against', 'withdrawn'];
const q = async (sql, args) => (await env.q(sql, args)).rows;
const bal = async id => (await q('SELECT balance_cents FROM accounts WHERE id = $1', [id]))[0].balance_cents;
const audits = async (action, dispute) => q(`SELECT * FROM audit_events WHERE action = $1 AND detail->>'dispute' = $2 ORDER BY id`, [action, dispute]);
const entriesFor = async disputeId => q(`SELECT e.*, (SELECT sum(amount_cents)::bigint FROM ledger_lines WHERE entry_id = e.id) total FROM journal_entries e
  WHERE e.idempotency_key LIKE $1 ORDER BY e.created_at`, [`%:card-disputes:${disputeId}:%`]);
const stepUp = async c => { const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); return c; };

let people = 0;
/** A fresh customer (mfa off) with a funded checking account; `staff` also makes them a staff member. */
async function customer(name, { staff = false, funds = 1_000_00n } = {}) {
  const username = `${name.toLowerCase()}-${++people}@disputes.test`, uid = newId(), chk = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,'55')`,
      [uid, username, name, await hashPassword('pw-' + name)]);
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Smart Checking','4321')`, [chk]);
    await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [chk, uid]);
    await post(c, { key: `test:fund:${username}`, kind: 'seed', lines: [{ accountId: chk, amountCents: funds, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -funds, description: 'Opening deposit' }] });
    if (staff) await c.query('INSERT INTO staff_members (user_id) VALUES ($1)', [uid]);
  });
  return { c: await signIn(env.base, username, 'pw-' + name), uid, chk };
}
/** Another account of `kind` for a user with `role` (a credit card gets a limit; the others may go negative, so test purchases always post). */
async function account(uid, { kind = 'checking', role = 'owner', last4 = '7777' } = {}) {
  const id = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, kind, `Test ${kind}`, last4, true, kind === 'credit_card' ? 5_000_00n : null]);
  await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, uid, role]);
  return id;
}
const share = (accountId, uid, role) => env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [accountId, uid, role]);
/** A card purchase of `cents` on an account, as POST /api/cards/card/:id/purchases posts it. Returns the line id as a string. */
async function purchase(accountId, cents, { postedOn = bankToday(), description = 'Corner Market', kind = 'card_purchase', sign = -1n } = {}) {
  return tx(env.pool, async c => {
    const amt = BigInt(cents);
    const { entryId } = await post(c, { key: `test:purchase:${newId()}`, kind, lines: [
      { accountId, amountCents: sign * amt, description, category: 'Shopping', postedOn },
      { accountId: await systemAccount(c, 'card_network_settlement'), amountCents: -sign * amt, description: `${description} ··4321`, postedOn }] });
    return String((await c.query('SELECT id FROM ledger_lines WHERE entry_id = $1 AND account_id = $2', [entryId, accountId])).rows[0].id);
  });
}
const file = (c, transactionId, b = {}) => c.post('/api/card-disputes', { idempotencyKey: key(), transactionId, amountCents: 1000, reason: 'unauthorized', ...b });

const ack = (id, s = staffA) => s.c.post(`/api/staff/card-disputes/${id}/acknowledge`, {});
const credit = (id, s = staffA) => s.c.post(`/api/staff/card-disputes/${id}/provisional-credit`, {});
const resolve = (id, outcome, s = staffA, decisionReason = 'Merchant could not show a signed receipt.') =>
  s.c.post(`/api/staff/card-disputes/${id}/resolve`, { outcome, decisionReason });
/** A filed dispute for a fresh customer, moved along to `to` by staff A. */
async function disputeIn(to, { amount = 2500, purchaseCents = 4599, funds } = {}) {
  const who = await customer('Cara', { funds });
  const tid = await purchase(who.chk, purchaseCents);
  const f = await file(who.c, tid, { amountCents: amount });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const id = f.body.dispute.id;
  if (to !== 'submitted') assert.equal((await ack(id)).status, 200);
  if (to === 'provisional_credit_issued') assert.equal((await credit(id)).status, 200);
  return { ...who, tid, id };
}

// ---------- access ----------
test('R1: every endpoint answers 401 signed_out without a session', async () => {
  const anon = client(env.base), id = newId();
  for (const [m, p] of [['GET', '/api/card-disputes/transactions'], ['POST', '/api/card-disputes'], ['GET', '/api/card-disputes'], ['GET', `/api/card-disputes/${id}`],
    ['POST', `/api/card-disputes/${id}/notes`], ['POST', `/api/card-disputes/${id}/withdraw`], ['GET', '/api/staff/card-disputes'], ['GET', `/api/staff/card-disputes/${id}`],
    ['POST', `/api/staff/card-disputes/${id}/acknowledge`], ['POST', `/api/staff/card-disputes/${id}/provisional-credit`], ['POST', `/api/staff/card-disputes/${id}/resolve`]]) {
    const r = await anon.call(m, p, {});
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out'); assert.ok(r.body.message);
  }
});

test('R2: staff endpoints are 403 staff_only for a customer, for an existing, unknown or malformed id, and change nothing', async () => {
  const { id, c } = await disputeIn('submitted');
  const other = await customer('Nonstaff');
  for (const who of [c, other.c]) {
    const l = await who.get('/api/staff/card-disputes');
    assert.equal(l.status, 403); assert.equal(l.body.error, 'staff_only');
    for (const x of [id, newId(), 'not-a-uuid']) {
      for (const [m, p, b] of [['GET', `/api/staff/card-disputes/${x}`], ['POST', `/api/staff/card-disputes/${x}/acknowledge`, {}],
        ['POST', `/api/staff/card-disputes/${x}/provisional-credit`, {}], ['POST', `/api/staff/card-disputes/${x}/resolve`, { outcome: 'in_favor', decisionReason: 'x' }]]) {
        const r = await who.call(m, p, b);
        assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.body.error, 'staff_only');
      }
    }
  }
  assert.equal((await c.get(`/api/card-disputes/${id}`)).body.dispute.status, 'submitted');
  assert.equal((await audits('disputes.acknowledge', id)).length, 0);
});

test('R3: another customer\'s dispute, an unknown id and a malformed id are 404 on detail, notes and withdraw (staff too)', async () => {
  const { id, c } = await disputeIn('investigating');
  const stranger = await stepUp((await customer('Stranger')).c);
  await stepUp(staffA.c);
  for (const who of [stranger, staffA.c]) {
    for (const x of [id, newId(), '12345']) {
      for (const [m, p, b] of [['GET', `/api/card-disputes/${x}`], ['POST', `/api/card-disputes/${x}/notes`, { text: 'hello' }], ['POST', `/api/card-disputes/${x}/withdraw`, {}]]) {
        const r = await who.call(m, p, b);
        assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.body.error, 'not_found');
      }
    }
    assert.deepEqual((await who.get('/api/card-disputes')).body.disputes.filter(d => d.id === id), []);
  }
  const d = (await c.get(`/api/card-disputes/${id}`)).body;
  assert.equal(d.dispute.status, 'investigating'); assert.deepEqual(d.notes, []);
});

// ---------- transactions ----------
test('R4: only own posted card purchases on checking and credit card accounts are listed, newest first, with the 5.1 fields', async () => {
  const me = await customer('Lister'), other = await customer('Otherone');
  const cc = await account(me.uid, { kind: 'credit_card', last4: '0088' });
  const sav = await account(me.uid, { kind: 'savings' });
  const custodial = await account(other.uid);  await share(custodial, me.uid, 'custodian');
  const viewed = await account(other.uid); await share(viewed, me.uid, 'viewer');
  const joint = await account(other.uid); await share(joint, me.uid, 'joint_owner');
  const today = bankToday();
  const old = await purchase(me.chk, 4599, { postedOn: addDays(today, -3), description: 'Corner Market' });
  const onCard = await purchase(cc, 1250, { postedOn: addDays(today, -1), description: 'Bookshop' });
  const onJoint = await purchase(joint, 300, { postedOn: addDays(today, -1), description: 'Joint coffee' });
  const sameDay = await purchase(me.chk, 99, { postedOn: today, description: 'Gum' });
  const hidden = [
    await purchase(sav, 100), await purchase(me.chk, 100, { kind: 'transfer' }), await purchase(me.chk, 100, { sign: 1n }),
    await purchase(me.chk, 100, { postedOn: addDays(today, 2) }), await purchase(custodial, 100), await purchase(viewed, 100), await purchase(other.chk, 100)];
  const r = await me.c.get('/api/card-disputes/transactions');
  assert.equal(r.status, 200);
  const ids = r.body.transactions.map(t => t.transactionId);
  assert.deepEqual(ids, [sameDay, onJoint, onCard, old]);                    // same day: higher transactionId first
  for (const h of hidden) assert.ok(!ids.includes(h));
  assert.deepEqual(r.body.transactions.at(-1), { transactionId: old, accountId: me.chk, description: 'Corner Market', amountCents: 4599,
    postedOn: addDays(today, -3), hasOpenDispute: false, creditedCents: 0 });
  // hasOpenDispute and creditedCents follow the transaction's disputes
  const f = await file(me.c, old, { amountCents: 1000 });
  assert.equal((await me.c.get('/api/card-disputes/transactions')).body.transactions.find(t => t.transactionId === old).hasOpenDispute, true);
  assert.equal((await ack(f.body.dispute.id)).status, 200);
  assert.equal((await resolve(f.body.dispute.id, 'in_favor')).status, 200);
  const t = (await me.c.get('/api/card-disputes/transactions')).body.transactions.find(x => x.transactionId === old);
  assert.equal(t.hasOpenDispute, false); assert.equal(t.creditedCents, 1000);
  // other customers never see my transactions
  assert.ok(!(await other.c.get('/api/card-disputes/transactions')).body.transactions.some(x => x.transactionId === old));
});

test('R4: at most the 100 newest are listed', async () => {
  const me = await customer('Many');
  await tx(env.pool, async c => {
    for (let i = 0; i < 105; i++) await post(c, { key: `test:many:${me.uid}:${i}`, kind: 'card_purchase', lines: [
      { accountId: me.chk, amountCents: -1n, description: `P${i}`, postedOn: addDays(bankToday(), -(i % 30)) },
      { accountId: await systemAccount(c, 'card_network_settlement'), amountCents: 1n, description: 'x' }] });
  });
  const list = (await me.c.get('/api/card-disputes/transactions')).body.transactions;
  assert.equal(list.length, 100);
  for (let i = 1; i < list.length; i++)
    assert.ok(list[i - 1].postedOn > list[i].postedOn || (list[i - 1].postedOn === list[i].postedOn && BigInt(list[i - 1].transactionId) > BigInt(list[i].transactionId)));
});

// ---------- filing ----------
test('R5: filing creates a submitted dispute, moves no money, and shows in the list and the detail with its note', async () => {
  const me = await customer('Filer');
  const tid = await purchase(me.chk, 4599);
  const before = await bal(me.chk), entries = (await q('SELECT count(*)::int n FROM journal_entries'))[0].n;
  const r = await file(me.c, tid, { amountCents: 4599, reason: 'wrong_amount', note: '  I was abroad on that day.  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.dispute;
  assert.equal(r.body.replayed, false);
  assert.equal(d.customerId, me.uid); assert.equal(d.transactionId, tid); assert.equal(d.accountId, me.chk);
  assert.equal(d.transactionAmountCents, 4599); assert.equal(d.amountCents, 4599); assert.equal(d.reason, 'wrong_amount');
  assert.equal(d.status, 'submitted'); assert.equal(d.filedOn, bankToday());
  for (const k of ['acknowledgedOn', 'creditedOn', 'closedOn', 'decisionReason', 'decidedBy', 'creditEntryId', 'reversalEntryId']) assert.equal(d[k], null, k);
  assert.deepEqual(d.overdue, { acknowledge: false, provisionalCredit: false, decision: false });
  assert.ok(!Number.isNaN(Date.parse(d.createdAt)));
  assert.equal(await bal(me.chk), before);
  assert.equal((await q('SELECT count(*)::int n FROM journal_entries'))[0].n, entries);
  assert.deepEqual((await me.c.get('/api/card-disputes')).body.disputes, [d]);
  const det = await me.c.get(`/api/card-disputes/${d.id}`);
  assert.deepEqual(det.body.dispute, d);
  assert.deepEqual(det.body.notes.map(x => x.text), ['I was abroad on that day.']);
  // a blank note means "no note"; frozen and closed accounts can still be disputed
  const t2 = await purchase(me.chk, 500), t3 = await purchase(me.chk, 600);
  await env.q(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [me.chk]);
  const blank = await file(me.c, t2, { amountCents: 500, note: '   ' });
  assert.equal(blank.status, 200);
  assert.deepEqual((await me.c.get(`/api/card-disputes/${blank.body.dispute.id}`)).body.notes, []);
  await env.q(`UPDATE accounts SET status = 'closed' WHERE id = $1`, [me.chk]);
  assert.equal((await file(me.c, t3, { amountCents: 600 })).status, 200);
});

test('R6, R7, R8: reason, amount and transaction checks', async () => {
  const me = await customer('Checker'), other = await customer('Somebody');
  const tid = await purchase(me.chk, 4599);
  const expect = async (b, status, error) => { const r = await file(me.c, tid, b); assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.error, error, JSON.stringify(b)); assert.ok(r.body.message); };
  for (const reason of [undefined, 'Unauthorized', 'fraud', 7, null, ['duplicate']]) await expect({ reason }, 400, 'bad_reason');
  for (const amountCents of [undefined, '1000', 10.5, 0, -1, 10_000_000_001, null, true]) await expect({ amountCents }, 400, 'bad_amount');
  for (const transactionId of [undefined, Number(tid), '', 'abc', '12a', '1234567890123456789', '-5', ' 1']) await expect({ transactionId }, 400, 'bad_transaction');
  assert.equal((await file(me.c, tid, { amountCents: 10_000_000_000 })).body.error, 'amount_exceeds_transaction');   // the maximum itself is a valid amount
  // lines that are not own card purchases: 404
  const sav = await account(me.uid, { kind: 'savings' }), loan = await account(me.uid, { kind: 'loan' });
  const custodial = await account(other.uid); await share(custodial, me.uid, 'custodian');
  const minor = await account(other.uid); await share(minor, me.uid, 'minor');
  const viewed = await account(other.uid); await share(viewed, me.uid, 'viewer');
  for (const t of ['999999999999', await purchase(other.chk, 100), await purchase(custodial, 100), await purchase(minor, 100), await purchase(viewed, 100),
    await purchase(sav, 100), await purchase(loan, 100), await purchase(me.chk, 100, { sign: 1n }), await purchase(me.chk, 100, { kind: 'transfer' })]) {
    const r = await file(me.c, t, { amountCents: 100 });
    assert.equal(r.status, 404, t); assert.equal(r.body.error, 'not_found');
  }
  assert.equal((await q('SELECT count(*)::int n FROM dispute_cases WHERE customer_id = $1', [me.uid]))[0].n, 0);
});

test('R9: not yet posted, outside the 60-day window, and exactly 60 days ago', async () => {
  const me = await customer('Window');
  const today = bankToday();
  const r1 = await file(me.c, await purchase(me.chk, 100, { postedOn: addDays(today, 1) }), { amountCents: 100 });
  assert.equal(r1.status, 422); assert.equal(r1.body.error, 'not_posted');
  const r2 = await file(me.c, await purchase(me.chk, 100, { postedOn: addDays(today, -61) }), { amountCents: 100 });
  assert.equal(r2.status, 422); assert.equal(r2.body.error, 'window_closed');
  const r3 = await file(me.c, await purchase(me.chk, 100, { postedOn: addDays(today, -60) }), { amountCents: 100 });
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
});

test('R10, R11: partial amounts, credited amounts, one open dispute per transaction (joint owners too)', async () => {
  const me = await customer('Joint1'), partner = await customer('Joint2');
  await share(me.chk, partner.uid, 'joint_owner');
  const tid = await purchase(me.chk, 5000);
  assert.equal((await file(me.c, tid, { amountCents: 5001 })).body.error, 'amount_exceeds_transaction');
  const first = await file(me.c, tid, { amountCents: 3000 });
  assert.equal(first.status, 200);
  for (const who of [me.c, partner.c]) {
    const dup = await file(who, tid, { amountCents: 100 });
    assert.equal(dup.status, 409); assert.equal(dup.body.error, 'dispute_exists');
  }
  assert.equal((await ack(first.body.dispute.id)).status, 200);
  assert.equal((await resolve(first.body.dispute.id, 'in_favor')).status, 200);
  // 2000 left: more is refused, the rest can be disputed by either owner
  assert.equal((await file(partner.c, tid, { amountCents: 2001 })).body.error, 'amount_exceeds_transaction');
  const second = await file(partner.c, tid, { amountCents: 2000 });
  assert.equal(second.status, 200); assert.equal(second.body.dispute.customerId, partner.uid);
  assert.equal((await ack(second.body.dispute.id)).status, 200);
  assert.equal((await resolve(second.body.dispute.id, 'in_favor')).status, 200);
  const full = await file(me.c, tid, { amountCents: 1 });
  assert.equal(full.status, 422); assert.equal(full.body.error, 'amount_exceeds_transaction');
  // a closed dispute that was not in favor does not use up the amount
  const t2 = await purchase(me.chk, 700);
  const w = await file(me.c, t2, { amountCents: 700 });
  await stepUp(me.c);
  assert.equal((await me.c.post(`/api/card-disputes/${w.body.dispute.id}/withdraw`, {})).status, 200);
  assert.equal((await file(me.c, t2, { amountCents: 700 })).status, 200);
});

test('R11: simultaneous filings on one transaction with different request ids: one succeeds, the others are 409', async () => {
  const me = await customer('Racer');
  const tid = await purchase(me.chk, 900);
  const rs = await Promise.all(Array.from({ length: 5 }, () => file(me.c, tid, { amountCents: 900 })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.ok(rs.filter(r => r.status !== 200).every(r => r.status === 409 && r.body.error === 'dispute_exists'));
  assert.equal((await q('SELECT count(*)::int n FROM dispute_cases WHERE line_id = $1', [tid]))[0].n, 1);
});

test('R12: request ids: replay returns the dispute as it is now, a different request is 422, keys belong to the customer', async () => {
  const me = await customer('Replayer'), other = await customer('Samekey');
  const tid = await purchase(me.chk, 4000);
  for (const idempotencyKey of [undefined, 'short', 'has space in it', 'x'.repeat(101), { a: 1 }]) {
    const r = await me.c.post('/api/card-disputes', { idempotencyKey, transactionId: tid, amountCents: 100, reason: 'duplicate' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'idempotency_key_required');
  }
  const k = key(), body = { idempotencyKey: k, transactionId: tid, amountCents: 1500, reason: 'duplicate', note: 'Charged twice.' };
  const first = await me.c.post('/api/card-disputes', body);
  assert.equal(first.status, 200);
  const count = async () => (await q(`SELECT (SELECT count(*)::int FROM dispute_cases WHERE customer_id = $1) d,
    (SELECT count(*)::int FROM dispute_notes n JOIN dispute_cases d ON d.id = n.dispute_id WHERE d.customer_id = $1) notes,
    (SELECT count(*)::int FROM dispute_notifications WHERE user_id = $1) sent, (SELECT count(*)::int FROM audit_events WHERE action LIKE 'disputes.%') audits,
    (SELECT count(*)::int FROM journal_entries) entries`, [me.uid]))[0];
  const was = await count();
  const again = await me.c.post('/api/card-disputes', body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.dispute, first.body.dispute);
  // from another session as well, and after the dispute changed status and closed
  const second = await signIn(env.base, (await q('SELECT username FROM users WHERE id = $1', [me.uid]))[0].username, 'pw-Replayer');
  assert.equal((await ack(first.body.dispute.id)).status, 200);
  assert.equal((await resolve(first.body.dispute.id, 'against')).status, 200);
  const otherTid = await purchase(me.chk, 100);
  const wasAfter = await count();
  const late = await second.post('/api/card-disputes', body);
  assert.equal(late.status, 200); assert.equal(late.body.replayed, true);
  assert.equal(late.body.dispute.id, first.body.dispute.id); assert.equal(late.body.dispute.status, 'resolved_against');
  assert.deepEqual(await count(), wasAfter);
  assert.equal(wasAfter.d, was.d);
  for (const change of [{ amountCents: 1501 }, { reason: 'wrong_amount' }, { note: 'Different.' }, { transactionId: otherTid }]) {
    for (const who of [me.c, second]) {
      const r = await who.post('/api/card-disputes', { ...body, ...change });
      assert.equal(r.status, 422, JSON.stringify(change)); assert.equal(r.body.error, 'idempotency_conflict');
    }
  }
  assert.deepEqual(await count(), wasAfter);
  // another customer with the same key string gets their own dispute
  const theirs = await other.c.post('/api/card-disputes', { ...body, transactionId: await purchase(other.chk, 4000) });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.dispute.id, first.body.dispute.id);
});

test('R12: simultaneous identical filings create exactly one dispute', async () => {
  const me = await customer('Twins');
  const body = { idempotencyKey: key(), transactionId: await purchase(me.chk, 800), amountCents: 800, reason: 'not_received' };
  const rs = await Promise.all(Array.from({ length: 4 }, () => me.c.post('/api/card-disputes', body)));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.body)));
  assert.equal(new Set(rs.map(r => r.body.dispute.id)).size, 1);
  assert.equal(rs.filter(r => r.body.replayed === false).length, 1);
  assert.equal((await q('SELECT count(*)::int n FROM dispute_cases WHERE customer_id = $1', [me.uid]))[0].n, 1);
  assert.equal((await audits('disputes.file', rs[0].body.dispute.id)).length, 1);
  assert.equal((await q('SELECT count(*)::int n FROM dispute_notifications WHERE dispute_id = $1', [rs[0].body.dispute.id]))[0].n, 1);
});

test('R13: note text: a string, trimmed, 1 to 1,000 characters, and never a card number', async () => {
  const me = await customer('Noter');
  const tid = await purchase(me.chk, 4599);
  const bad = async (note, error) => { const r = await file(me.c, tid, { amountCents: 100, note }); assert.equal(r.status, 400, JSON.stringify(note)); assert.equal(r.body.error, error, JSON.stringify(note)); };
  for (const v of [5, ['a'], { t: 'a' }, true]) await bad(v, 'bad_note');
  await bad('x'.repeat(1001), 'bad_note');
  for (const v of ['My card 4111111111111111 was used', '4111 1111 1111 1111', 'card: 4111-1111-1111-1111.', '4111-1111 1111-1', '1234567890123456789', 'x12345678901234567890y'])
    await bad(v, 'card_number_in_text');
  assert.equal((await q('SELECT count(*)::int n FROM dispute_cases WHERE customer_id = $1', [me.uid]))[0].n, 0);
  const ok = await file(me.c, tid, { amountCents: 100, note: `  ${'y'.repeat(1000)}  ` });
  assert.equal(ok.status, 200);
  const id = ok.body.dispute.id;
  for (const text of ['Receipt 123456789012 shows 45.99 on 2027-03-01, phone 555-123-4567.', '4111  1111  1111  1111', '4111 1111 1111 x111', '4111--11111111'])
    assert.equal((await me.c.post(`/api/card-disputes/${id}/notes`, { text })).status, 200, text);
  for (const [text, error] of [['   ', 'bad_note'], [undefined, 'bad_note'], [12, 'bad_note'], ['z'.repeat(1001), 'bad_note'], ['use 4111111111111111', 'card_number_in_text']]) {
    const r = await me.c.post(`/api/card-disputes/${id}/notes`, { text });
    assert.equal(r.status, 400, String(text)); assert.equal(r.body.error, error);
  }
  assert.equal((await me.c.get(`/api/card-disputes/${id}`)).body.notes.length, 5);
});

test('R14: notes on open disputes only, at most 20 (the filing note counts), and nothing else changes', async () => {
  const me = await customer('Notes20');
  const f = await file(me.c, await purchase(me.chk, 4599), { amountCents: 100, note: 'first' });
  const id = f.body.dispute.id;
  const r = await me.c.post(`/api/card-disputes/${id}/notes`, { text: '  The receipt shows 45.99, I was charged 54.99.  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.note).sort(), ['createdAt', 'id', 'text']);
  assert.equal(r.body.note.text, 'The receipt shows 45.99, I was charged 54.99.');
  assert.equal((await audits('disputes.note', id)).length, 1);
  assert.ok(!JSON.stringify((await audits('disputes.note', id))[0].detail).includes('receipt'), 'the note text is not audited');
  for (let i = 3; i <= 20; i++) assert.equal((await me.c.post(`/api/card-disputes/${id}/notes`, { text: `note ${i}` })).status, 200);
  const over = await me.c.post(`/api/card-disputes/${id}/notes`, { text: 'one too many' });
  assert.equal(over.status, 422); assert.equal(over.body.error, 'note_limit');
  const d = (await me.c.get(`/api/card-disputes/${id}`)).body;
  assert.equal(d.notes.length, 20); assert.deepEqual(d.notes.map(x => x.text).slice(0, 2), ['first', 'The receipt shows 45.99, I was charged 54.99.']);
  assert.deepEqual(d.notifications.map(x => x.kind), ['filed']);
  assert.deepEqual(d.dispute, f.body.dispute);
  // closed: 409
  const g = await file(me.c, await purchase(me.chk, 100), { amountCents: 100 });
  await stepUp(me.c);
  await me.c.post(`/api/card-disputes/${g.body.dispute.id}/withdraw`, {});
  const closed = await me.c.post(`/api/card-disputes/${g.body.dispute.id}/notes`, { text: 'late' });
  assert.equal(closed.status, 409); assert.equal(closed.body.error, 'invalid_state');
});

test('R15: the first applicable check wins when filing', async () => {
  const me = await customer('Orderly');
  const today = bankToday();
  const tid = await purchase(me.chk, 1000), future = await purchase(me.chk, 1000, { postedOn: addDays(today, 3) });
  const old = await purchase(me.chk, 1000, { postedOn: addDays(today, -90) });
  const err = async b => (await me.c.post('/api/card-disputes', b)).body.error;
  const k = key();
  assert.equal((await me.c.post('/api/card-disputes', { idempotencyKey: k, transactionId: tid, amountCents: 100, reason: 'duplicate' })).status, 200);
  assert.equal(await err({ reason: 'x', amountCents: 0, transactionId: 'x', note: 5 }), 'idempotency_key_required');
  assert.equal(await err({ idempotencyKey: k, transactionId: tid, amountCents: 100, reason: 'nope' }), 'idempotency_conflict');
  assert.equal(await err({ idempotencyKey: key(), reason: 'x', amountCents: 0, transactionId: 'x', note: 5 }), 'bad_reason');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 0, transactionId: 'x', note: 5 }), 'bad_amount');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: 'x', note: 5 }), 'bad_transaction');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: '999999999999', note: 5 }), 'bad_note');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: '999999999999', note: '4111111111111111' }), 'card_number_in_text');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: '999999999999' }), 'not_found');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: future }), 'not_posted');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: old }), 'window_closed');
  assert.equal(await err({ idempotencyKey: key(), reason: 'duplicate', amountCents: 999999, transactionId: tid }), 'dispute_exists');
});

// ---------- deadlines ----------
test('R16, R17: due dates in bank days from a Friday before a holiday week, and the overdue flags move with the bank clock', async () => {
  const me = await customer('Deadline');
  setToday('2026-11-06');                                          // a Friday; Wed 2026-11-11 is a Federal Reserve holiday
  const tid = await purchase(me.chk, 2000, { postedOn: '2026-11-02' });
  const f = await file(me.c, tid, { amountCents: 2000 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const d = f.body.dispute;
  assert.equal(d.filedOn, '2026-11-06');
  assert.equal(d.acknowledgeDueOn, '2026-11-09');
  assert.equal(d.provisionalCreditDueOn, '2026-11-23');            // 9,10,12,13,16,17,18,19,20,23 (the 11th is skipped)
  assert.equal(d.decisionDueOn, '2026-12-21');
  const flags = async () => (await me.c.get(`/api/card-disputes/${d.id}`)).body.dispute.overdue;
  setToday('2026-11-09'); assert.deepEqual(await flags(), { acknowledge: false, provisionalCredit: false, decision: false });
  setToday('2026-11-10'); assert.deepEqual(await flags(), { acknowledge: true, provisionalCredit: false, decision: false });
  setToday('2026-11-24'); assert.deepEqual(await flags(), { acknowledge: true, provisionalCredit: true, decision: false });
  assert.equal((await ack(d.id)).body.dispute.acknowledgedOn, '2026-11-24');      // late is still allowed
  assert.deepEqual(await flags(), { acknowledge: false, provisionalCredit: true, decision: false });
  setToday('2026-12-21'); assert.deepEqual(await flags(), { acknowledge: false, provisionalCredit: true, decision: false });
  setToday('2026-12-22'); assert.deepEqual(await flags(), { acknowledge: false, provisionalCredit: true, decision: true });
  const credited = await credit(d.id);
  assert.equal(credited.body.dispute.creditedOn, '2026-12-22');
  assert.deepEqual(credited.body.dispute.overdue, { acknowledge: false, provisionalCredit: false, decision: true });
  const closed = await resolve(d.id, 'in_favor');
  assert.deepEqual(closed.body.dispute.overdue, { acknowledge: false, provisionalCredit: false, decision: false });
  // the due dates never change
  for (const k of ['filedOn', 'acknowledgeDueOn', 'provisionalCreditDueOn', 'decisionDueOn']) assert.equal(closed.body.dispute[k], d[k]);
  // filed on a weekend: one bank day later is Monday
  setToday('2026-11-07');
  const sat = await file(me.c, await purchase(me.chk, 100, { postedOn: '2026-11-02' }), { amountCents: 100 });
  assert.equal(sat.body.dispute.filedOn, '2026-11-07'); assert.equal(sat.body.dispute.acknowledgeDueOn, '2026-11-09');
});

// ---------- status changes ----------
test('R18: transitions outside the table are 409 invalid_state and change nothing', async () => {
  const sub = await disputeIn('submitted');
  for (const r of [await credit(sub.id), await resolve(sub.id, 'in_favor'), await resolve(sub.id, 'against')]) {
    assert.equal(r.status, 409); assert.equal(r.body.error, 'invalid_state');
  }
  const inv = await disputeIn('investigating');
  assert.equal((await ack(inv.id)).body.error, 'invalid_state');
  const pci = await disputeIn('provisional_credit_issued');
  assert.equal((await ack(pci.id)).body.error, 'invalid_state');
  assert.equal((await credit(pci.id)).body.error, 'invalid_state');
  const closed = await disputeIn('investigating');
  assert.equal((await resolve(closed.id, 'against')).status, 200);
  await stepUp(closed.c);
  const before = (await closed.c.get(`/api/card-disputes/${closed.id}`)).body, entries = await entriesFor(closed.id);
  for (const r of [await ack(closed.id), await credit(closed.id), await resolve(closed.id, 'in_favor'), await closed.c.post(`/api/card-disputes/${closed.id}/withdraw`, {})]) {
    assert.equal(r.status, 409); assert.equal(r.body.error, 'invalid_state');
  }
  assert.deepEqual((await closed.c.get(`/api/card-disputes/${closed.id}`)).body, before);
  assert.deepEqual(await entriesFor(closed.id), entries);
  assert.equal((await audits('disputes.credit', sub.id)).length, 0);
  assert.equal((await audits('disputes.resolve', sub.id)).length, 0);
});

test('R19, R20: acknowledge, then a provisional credit posted once through the ledger with the exact shape', async () => {
  const { id, c, chk, uid, tid } = await disputeIn('submitted', { amount: 2500 });
  const a = await ack(id);
  assert.equal(a.status, 200); assert.equal(a.body.dispute.status, 'investigating'); assert.equal(a.body.dispute.acknowledgedOn, bankToday());
  const before = await bal(chk), sys = (await q(`SELECT id, balance_cents FROM accounts WHERE system_code = 'card_disputes'`))[0];
  const r = await credit(id);
  assert.equal(r.status, 200);
  const d = r.body.dispute;
  assert.equal(d.status, 'provisional_credit_issued'); assert.equal(d.creditedOn, bankToday()); assert.ok(d.creditEntryId);
  assert.equal(await bal(chk), before + 2500n);
  const e = (await q('SELECT * FROM journal_entries WHERE id = $1', [d.creditEntryId]))[0];
  assert.equal(e.kind, 'dispute_credit'); assert.equal(e.idempotency_key, `${uid}:card-disputes:${id}:credit`);
  const lines = await q('SELECT * FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents DESC', [e.id]);
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].account_id, lines[0].amount_cents, lines[0].category, lines[0].description, lines[0].posted_on],
    [chk, 2500n, 'Disputes', 'Dispute credit: Corner Market', bankToday()]);
  assert.deepEqual([lines[1].account_id, lines[1].amount_cents, lines[1].description, lines[1].posted_on],
    [sys.id, -2500n, 'Dispute credit ··4321', bankToday()]);
  assert.equal((await audits('disputes.credit', id)).length, 1);
  assert.equal((await audits('disputes.credit', id))[0].user_id, staffA.uid);
  assert.equal((await c.get('/api/card-disputes/transactions')).body.transactions.find(t => t.transactionId === tid).hasOpenDispute, true);
});

test('R20, R29: two simultaneous credits give one success and one 409, with one entry', async () => {
  const { id, chk } = await disputeIn('investigating', { amount: 1200 });
  const before = await bal(chk);
  const rs = await Promise.all([credit(id, staffA), credit(id, staffB)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(rs.find(r => r.status === 409).body.error, 'invalid_state');
  assert.equal((await entriesFor(id)).length, 1);
  assert.equal(await bal(chk), before + 1200n);
});

test('R21, R22: resolving: checks, outcomes and what each does to the ledger', async () => {
  // order: bad_outcome before reason_required before invalid_state
  const sub = await disputeIn('submitted');
  assert.equal((await staffA.c.post(`/api/staff/card-disputes/${sub.id}/resolve`, { outcome: 'maybe', decisionReason: '' })).body.error, 'bad_outcome');
  assert.equal((await staffA.c.post(`/api/staff/card-disputes/${sub.id}/resolve`, { outcome: 'in_favor', decisionReason: '' })).body.error, 'reason_required');
  assert.equal((await staffA.c.post(`/api/staff/card-disputes/${sub.id}/resolve`, { outcome: 'in_favor', decisionReason: 'ok' })).body.error, 'invalid_state');
  const inv = await disputeIn('investigating');
  for (const outcome of [undefined, 'IN_FAVOR', 'favor', 1, 'resolved_in_favor']) {
    const r = await staffA.c.post(`/api/staff/card-disputes/${inv.id}/resolve`, { outcome, decisionReason: 'x' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_outcome');
  }
  for (const decisionReason of [undefined, '   ', 5, 'r'.repeat(501)]) {
    const r = await staffA.c.post(`/api/staff/card-disputes/${inv.id}/resolve`, { outcome: 'against', decisionReason });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'reason_required');
  }
  assert.equal((await entriesFor(inv.id)).length, 0);

  // in_favor on investigating: the credit is posted now
  const b1 = await bal(inv.chk);
  const r1 = await resolve(inv.id, 'in_favor', staffA, `  ${'r'.repeat(500)}  `);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.dispute.status, 'resolved_in_favor'); assert.equal(r1.body.dispute.decisionReason, 'r'.repeat(500));
  assert.equal(r1.body.dispute.decidedBy, staffA.uid); assert.equal(r1.body.dispute.closedOn, bankToday());
  assert.equal(r1.body.dispute.creditedOn, bankToday()); assert.ok(r1.body.dispute.creditEntryId); assert.equal(r1.body.dispute.reversalEntryId, null);
  const e1 = await entriesFor(inv.id);
  assert.deepEqual(e1.map(e => [e.kind, e.idempotency_key, e.total]), [['dispute_credit', `${inv.uid}:card-disputes:${inv.id}:credit`, 0n]]);
  assert.equal(await bal(inv.chk), b1 + 2500n);
  assert.equal((await audits('disputes.credit', inv.id)).length, 1);
  assert.deepEqual((await audits('disputes.resolve', inv.id)).map(a => [a.user_id, a.detail.outcome]), [[staffA.uid, 'in_favor']]);

  // in_favor on provisional_credit_issued: keeps the credit, no new entry
  const pci = await disputeIn('provisional_credit_issued');
  const b2 = await bal(pci.chk);
  const r2 = await resolve(pci.id, 'in_favor', staffB);
  assert.equal(r2.body.dispute.status, 'resolved_in_favor'); assert.equal(r2.body.dispute.decidedBy, staffB.uid);
  assert.equal((await entriesFor(pci.id)).length, 1); assert.equal(await bal(pci.chk), b2);

  // against on investigating: nothing posted
  const inv2 = await disputeIn('investigating');
  const b3 = await bal(inv2.chk);
  const r3 = await resolve(inv2.id, 'against');
  assert.equal(r3.body.dispute.status, 'resolved_against'); assert.equal(r3.body.dispute.creditEntryId, null);
  assert.equal((await entriesFor(inv2.id)).length, 0); assert.equal(await bal(inv2.chk), b3);

  // against on provisional_credit_issued: the credit is taken back with the exact reversal shape
  const pci2 = await disputeIn('provisional_credit_issued', { amount: 1999 });
  const credited = await bal(pci2.chk);
  const r4 = await resolve(pci2.id, 'against');
  assert.equal(r4.status, 200);
  assert.equal(r4.body.dispute.status, 'resolved_against'); assert.ok(r4.body.dispute.reversalEntryId);
  assert.equal(await bal(pci2.chk), credited - 1999n);
  const rev = (await q('SELECT * FROM journal_entries WHERE id = $1', [r4.body.dispute.reversalEntryId]))[0];
  assert.equal(rev.kind, 'dispute_credit_reversal'); assert.equal(rev.idempotency_key, `${pci2.uid}:card-disputes:${pci2.id}:reversal`);
  const lines = await q('SELECT l.*, a.system_code FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = $1 ORDER BY amount_cents', [rev.id]);
  assert.deepEqual([lines[0].account_id, lines[0].amount_cents, lines[0].category, lines[0].description, lines[0].posted_on],
    [pci2.chk, -1999n, 'Disputes', 'Dispute credit reversed: Corner Market', bankToday()]);
  assert.deepEqual([lines[1].system_code, lines[1].amount_cents, lines[1].description], ['card_disputes', 1999n, 'Dispute credit reversed ··4321']);
  assert.equal((await audits('disputes.credit_reversed', pci2.id)).length, 1);
  assert.deepEqual((await pci2.c.get(`/api/card-disputes/${pci2.id}`)).body.notifications.map(x => x.kind),
    ['filed', 'acknowledged', 'provisional_credit_issued', 'resolved_against', 'credit_reversed']);
});

test('R23: a reversal the account cannot cover is 409 insufficient_funds and changes nothing; it works after a deposit', async () => {
  const d = await disputeIn('provisional_credit_issued', { amount: 3000 });
  // spend all but 10.00, so the account holds less than the 30.00 credit
  const spend = await bal(d.chk) - 1000n;
  await tx(env.pool, c => post(c, { key: `test:spend:${d.id}`, kind: 'transfer', lines: [
    { accountId: d.chk, amountCents: -spend, description: 'Spent' }, { accountId: '00000000-0000-4000-8000-000000000001', amountCents: spend, description: 'Spent' }] }));
  const state = async () => ({ d: (await d.c.get(`/api/card-disputes/${d.id}`)).body, e: await entriesFor(d.id), bal: await bal(d.chk),
    a: (await q(`SELECT count(*)::int n FROM audit_events WHERE detail->>'dispute' = $1`, [d.id]))[0].n });
  const before = await state();
  const r = await resolve(d.id, 'against');
  assert.equal(r.status, 409); assert.equal(r.body.error, 'insufficient_funds');
  await stepUp(d.c);
  const w = await d.c.post(`/api/card-disputes/${d.id}/withdraw`, {});
  assert.equal(w.status, 409); assert.equal(w.body.error, 'insufficient_funds');
  assert.deepEqual(await state(), before);
  await tx(env.pool, c => post(c, { key: `test:refill:${d.id}`, kind: 'seed', lines: [
    { accountId: d.chk, amountCents: 5000n, description: 'Deposit' }, { accountId: '00000000-0000-4000-8000-000000000001', amountCents: -5000n, description: 'Deposit' }] }));
  assert.equal((await resolve(d.id, 'against')).status, 200);
});

test('R23: on a credit card, a reversal past the credit limit is also 409 insufficient_funds', async () => {
  const me = await customer('Carder');
  const cc = await account(me.uid, { kind: 'credit_card', last4: '0088' });
  const tid = await purchase(cc, 5_000_00);                         // the whole limit
  const f = await file(me.c, tid, { amountCents: 1_000_00 });
  await ack(f.body.dispute.id); await credit(f.body.dispute.id);
  await purchase(cc, 1_000_00);                                     // the credit is spent: at the limit again
  const r = await resolve(f.body.dispute.id, 'against');
  assert.equal(r.status, 409); assert.equal(r.body.error, 'insufficient_funds');
  assert.equal((await me.c.get(`/api/card-disputes/${f.body.dispute.id}`)).body.dispute.status, 'provisional_credit_issued');
});

test('R24: withdraw needs step-up; it closes the dispute and takes back a credit', async () => {
  const sub = await disputeIn('submitted');
  const unknown = await sub.c.post(`/api/card-disputes/${newId()}/withdraw`, {});
  assert.equal(unknown.status, 404);                                              // 404 before step-up
  const r0 = await sub.c.post(`/api/card-disputes/${sub.id}/withdraw`, {});
  assert.equal(r0.status, 403); assert.equal(r0.body.error, 'stepup_required');
  assert.equal((await sub.c.get(`/api/card-disputes/${sub.id}`)).body.dispute.status, 'submitted');
  await stepUp(sub.c);
  const r1 = await sub.c.post(`/api/card-disputes/${sub.id}/withdraw`, {});
  assert.equal(r1.status, 200); assert.equal(r1.body.dispute.status, 'withdrawn'); assert.equal(r1.body.dispute.closedOn, bankToday());
  assert.equal((await entriesFor(sub.id)).length, 0);
  assert.equal((await audits('disputes.withdraw', sub.id))[0].user_id, sub.uid);

  const pci = await disputeIn('provisional_credit_issued', { amount: 777 });
  await stepUp(pci.c);
  const credited = await bal(pci.chk);
  const r2 = await pci.c.post(`/api/card-disputes/${pci.id}/withdraw`, {});
  assert.equal(r2.status, 200); assert.equal(r2.body.dispute.status, 'withdrawn'); assert.ok(r2.body.dispute.reversalEntryId);
  assert.equal(await bal(pci.chk), credited - 777n);
  assert.deepEqual((await entriesFor(pci.id)).map(e => [e.kind, e.idempotency_key]),
    [['dispute_credit', `${pci.uid}:card-disputes:${pci.id}:credit`], ['dispute_credit_reversal', `${pci.uid}:card-disputes:${pci.id}:reversal`]]);
  assert.deepEqual((await pci.c.get(`/api/card-disputes/${pci.id}`)).body.notifications.map(x => x.kind),
    ['filed', 'acknowledged', 'provisional_credit_issued', 'withdrawn', 'credit_reversed']);
  assert.equal((await audits('disputes.credit_reversed', pci.id))[0].user_id, pci.uid);
});

test('R25: staff cannot act on their own disputes; another staff member can, and staff can read their own', async () => {
  const tid = await purchase(staffA.chk, 3000);
  const f = await file(staffA.c, tid, { amountCents: 3000 });            // staff file like any customer
  assert.equal(f.status, 200);
  const id = f.body.dispute.id;
  for (const r of [await ack(id, staffA), await credit(id, staffA), await resolve(id, 'in_favor', staffA)]) {
    assert.equal(r.status, 403); assert.equal(r.body.error, 'own_dispute');
  }
  // own_dispute comes before the resolve body checks and the state check
  assert.equal((await staffA.c.post(`/api/staff/card-disputes/${id}/resolve`, { outcome: 'bad' })).body.error, 'own_dispute');
  assert.equal((await staffA.c.get(`/api/staff/card-disputes/${id}`)).status, 200);
  assert.ok((await staffA.c.get('/api/staff/card-disputes')).body.disputes.some(d => d.id === id));
  assert.equal((await staffA.c.get(`/api/card-disputes/${id}`)).body.dispute.status, 'submitted');
  assert.equal((await ack(id, staffB)).status, 200);
  assert.equal((await credit(id, staffB)).status, 200);
  const r = await resolve(id, 'in_favor', staffB);
  assert.equal(r.body.dispute.decidedBy, staffB.uid);
  assert.deepEqual((await staffA.c.get(`/api/card-disputes/${id}`)).body.notifications.map(x => x.kind), ['filed', 'acknowledged', 'provisional_credit_issued', 'resolved_in_favor']);
});

// ---------- reading ----------
test('R26, R27, R28: lists newest first with status filters; detail with notes and notifications oldest first', async () => {
  const me = await customer('Reader'), other = await customer('Readerother');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await file(me.c, await purchase(me.chk, 100 + i), { amountCents: 100 })).body.dispute.id);
  const theirs = (await file(other.c, await purchase(other.chk, 100), { amountCents: 100 })).body.dispute.id;
  await ack(ids[1]);
  const mine = (await me.c.get('/api/card-disputes')).body.disputes;
  assert.deepEqual(mine.map(d => d.id), [...ids].reverse());
  assert.deepEqual((await me.c.get('/api/card-disputes?status=investigating')).body.disputes.map(d => d.id), [ids[1]]);
  assert.deepEqual((await me.c.get('/api/card-disputes?status=withdrawn')).body.disputes, []);
  for (const s of ['Submitted', '', 'open', 'SUBMITTED']) {
    const r = await me.c.get(`/api/card-disputes?status=${s}`);
    assert.equal(r.status, 400, s); assert.equal(r.body.error, 'bad_status');
    const st = await staffA.c.get(`/api/staff/card-disputes?status=${s}`);
    assert.equal(st.status, 400, s); assert.equal(st.body.error, 'bad_status');
  }
  const all = (await staffA.c.get('/api/staff/card-disputes')).body.disputes;
  assert.deepEqual(all.slice(0, 4).map(d => d.id), [theirs, ids[2], ids[1], ids[0]]);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt);
  for (const s of STATUSES) assert.ok((await staffA.c.get(`/api/staff/card-disputes?status=${s}`)).body.disputes.every(d => d.status === s));
  assert.ok((await staffA.c.get('/api/staff/card-disputes?status=investigating')).body.disputes.some(d => d.id === ids[1]));
  for (const x of [newId(), 'nope']) {
    const r = await staffA.c.get(`/api/staff/card-disputes/${x}`);
    assert.equal(r.status, 404); assert.equal(r.body.error, 'not_found');
  }
  const det = await staffA.c.get(`/api/staff/card-disputes/${theirs}`);
  assert.equal(det.status, 200); assert.equal(det.body.dispute.customerId, other.uid);
  assert.deepEqual(det.body.notes, []);
  assert.deepEqual(det.body.notifications.map(x => x.kind), ['filed']);
  assert.ok(det.body.notifications.every(x => x.message.length > 0 && x.id && !Number.isNaN(Date.parse(x.createdAt))));
  await me.c.post(`/api/card-disputes/${ids[0]}/notes`, { text: 'one' });
  await me.c.post(`/api/card-disputes/${ids[0]}/notes`, { text: 'two' });
  assert.deepEqual((await staffA.c.get(`/api/staff/card-disputes/${ids[0]}`)).body.notes.map(x => x.text), ['one', 'two']);
});

// ---------- integrity and records ----------
test('R29: resolve and withdraw at the same moment: one wins, at most one entry of each kind, the balance ends where it started', async () => {
  for (let round = 0; round < 3; round++) {
    const d = await disputeIn('provisional_credit_issued', { amount: 1500 });
    await stepUp(d.c);
    const credited = await bal(d.chk);
    const rs = await Promise.all([resolve(d.id, 'against'), d.c.post(`/api/card-disputes/${d.id}/withdraw`, {}), resolve(d.id, 'in_favor', staffB)]);
    assert.equal(rs.filter(r => r.status === 200).length, 1);
    assert.ok(rs.filter(r => r.status !== 200).every(r => r.status === 409 && r.body.error === 'invalid_state'));
    const e = await entriesFor(d.id);
    assert.ok(e.filter(x => x.kind === 'dispute_credit').length === 1 && e.filter(x => x.kind === 'dispute_credit_reversal').length <= 1);
    const status = (await d.c.get(`/api/card-disputes/${d.id}`)).body.dispute.status;
    assert.equal(await bal(d.chk), status === 'resolved_in_favor' ? credited : credited - 1500n);
  }
});

test('R29: after a full life every balance equals the sum of its lines and only the customer and card_disputes accounts are touched', async () => {
  const d = await disputeIn('provisional_credit_issued', { amount: 4599, purchaseCents: 4599 });
  const start = await bal(d.chk) - 4599n;
  assert.equal((await resolve(d.id, 'against')).status, 200);
  assert.equal(await bal(d.chk), start);
  const touched = await q(`SELECT DISTINCT coalesce(a.system_code, a.id::text) a FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id WHERE e.idempotency_key LIKE $1`, [`%:card-disputes:${d.id}:%`]);
  assert.deepEqual(touched.map(x => x.a).sort(), [d.chk, 'card_disputes'].sort());
  for (const e of await entriesFor(d.id)) assert.equal(e.total, 0n);
  const off = await q(`SELECT a.id FROM accounts a WHERE a.balance_cents <> (SELECT coalesce(sum(amount_cents), 0) FROM ledger_lines WHERE account_id = a.id)`);
  assert.deepEqual(off, []);
  const r = (await d.c.get(`/api/card-disputes/${d.id}`)).body.dispute;
  assert.ok(Number.isInteger(r.amountCents) && Number.isInteger(r.transactionAmountCents));
});

test('R30, R31: each step writes its audit event and notification; refusals and replays write none; details hold no note text', async () => {
  const me = await customer('Audited');
  const body = { idempotencyKey: key(), transactionId: await purchase(me.chk, 4599), amountCents: 4599, reason: 'not_received', note: 'secret evidence words' };
  const f = await me.c.post('/api/card-disputes', body);
  const id = f.body.dispute.id;
  await me.c.post('/api/card-disputes', body);                                       // replay
  await me.c.post('/api/card-disputes', { ...body, amountCents: 1 });                  // conflict
  await credit(id);                                                                    // refused: invalid_state
  await me.c.post(`/api/card-disputes/${id}/notes`, { text: 'more evidence words' });
  await ack(id); await credit(id); await resolve(id, 'in_favor');
  const rows = await q(`SELECT action, user_id, detail FROM audit_events WHERE detail->>'dispute' = $1 ORDER BY id`, [id]);
  assert.deepEqual(rows.map(r => r.action), ['disputes.file', 'disputes.note', 'disputes.acknowledge', 'disputes.credit', 'disputes.resolve']);
  assert.deepEqual(rows.map(r => r.user_id), [me.uid, me.uid, staffA.uid, staffA.uid, staffA.uid]);
  assert.deepEqual(rows[0].detail, { dispute: id, transactionId: body.transactionId, amountCents: 4599, reason: 'not_received' });
  assert.equal(rows[4].detail.outcome, 'in_favor');
  assert.ok(rows.every(r => !/evidence/.test(JSON.stringify(r.detail))));
  const det = (await me.c.get(`/api/card-disputes/${id}`)).body;
  assert.deepEqual(det.notifications.map(x => x.kind), ['filed', 'acknowledged', 'provisional_credit_issued', 'resolved_in_favor']);
  assert.deepEqual((await staffB.c.get(`/api/staff/card-disputes/${id}`)).body.notifications, det.notifications);
  assert.ok((await q('SELECT user_id FROM dispute_notifications WHERE dispute_id = $1', [id])).every(x => x.user_id === me.uid));
});
