// Round-up savings: enable, collect change on debit-card purchases, sweep to savings, refunds and reversals, state changes, access.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { issueCard } from '../../lib/cards.mjs';
import { changeFor } from '../../lib/round-ups.mjs';
import { clock, bankToday, addDays } from '../../lib/bank-date.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
/** Moves the bank's clock to noon Central Time on a bank date. */
const onDay = d => { clock.now = () => new Date(`${d}T17:00:00Z`); };

let n = 0;
const key = () => `ru-key-${++n}-${Date.now()}`;
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const audits = async (action, account) => (await env.q(`SELECT * FROM audit_events WHERE action = $1 AND ($2::text IS NULL OR detail->>'account' = $2) ORDER BY id`,
  [action, account ?? null])).rows;
const entries = async (kind, accountId) => (await env.q(`SELECT DISTINCT e.* FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
  WHERE e.kind = $1 AND l.account_id = $2`, [kind, accountId])).rows;
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}

/** A fresh customer (mfa off): a funded checking account with a debit card, and a savings account. */
let people = 0;
async function customer({ funds = 1_000_00n, stepped = true } = {}) {
  const name = `ru${++people}x${Date.now()}`;
  const username = `${name}@roundups.test`, uid = newId(), chk = newId(), sav = newId();
  let card;
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,'55')`,
      [uid, username, name, await hashPassword('pw-' + name)]);
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Smart Checking','1234'), ($2,'savings','Goal Savings','5678')`, [chk, sav]);
    await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$3,'owner'), ($2,$3,'owner')`, [chk, sav, uid]);
    if (funds > 0n) await post(c, { key: `test:fund:${username}`, kind: 'seed', lines: [{ accountId: chk, amountCents: funds, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -funds, description: 'Opening deposit' }] });
    card = (await issueCard(c, { accountId: chk, holderId: uid, type: 'debit' })).id;
  });
  const c = await signIn(env.base, username, 'pw-' + name);
  if (stepped) await stepUp(c);
  return { c, uid, chk, sav, card, username };
}
const enable = (p, extra = {}) => p.c.post('/api/round-ups', { idempotencyKey: key(), accountId: p.chk, destinationAccountId: p.sav, ...extra });
const buy = (p, amount, extra = {}) => p.c.post(`/api/cards/card/${p.card}/purchases`, { idempotencyKey: key(), merchant: 'Corner Store', amount, ...extra });
const detail = async p => (await p.c.get(`/api/round-ups/${p.chk}`)).body;
const sweep = p => p.c.post('/api/round-ups/sweep', {});
const refund = (p, authorizationId, amountCents, k = key()) => p.c.post('/api/round-ups/refunds', { idempotencyKey: k, authorizationId, ...(amountCents === undefined ? {} : { amountCents }) });
/** accrued - reversed = swept + pending, and every total matches its records (R26). */
async function conserved(p) {
  const d = await detail(p), r = d.roundUp;
  assert.equal(r.accruedCents - r.reversedCents, r.sweptCents + r.pendingCents);
  assert.equal(r.accruedCents, d.purchases.reduce((s, x) => s + x.changeCents, 0));
  assert.equal(r.reversedCents, d.purchases.reduce((s, x) => s + x.reversedCents, 0));
  assert.equal(r.sweptCents, d.sweeps.reduce((s, x) => s + x.amountCents, 0));
  for (const id of [p.chk, p.sav]) {
    const x = (await env.q('SELECT a.balance_cents, (SELECT coalesce(sum(amount_cents), 0)::bigint FROM ledger_lines WHERE account_id = a.id) s FROM accounts a WHERE id = $1', [id])).rows[0];
    assert.equal(x.balance_cents, x.s);
  }
  return d;
}

// ---------- rounding ----------
test('R8: rounding follows the formula for every step', () => {
  for (const [a, s, ch] of [[435n, 100n, 65n], [1000n, 100n, 0n], [1n, 100n, 99n], [435n, 500n, 65n], [1250n, 500n, 250n], [500n, 500n, 0n], [1999n, 200n, 1n], [2000n, 200n, 0n]])
    assert.equal(changeFor(a, s), ch, `${a} step ${s}`);
});

// ---------- access ----------
test('R1: every endpoint needs a signed-in customer', async () => {
  const anon = client(env.base), id = newId();
  for (const [m, p] of [['POST', '/api/round-ups'], ['GET', '/api/round-ups'], ['GET', `/api/round-ups/${id}`], ['POST', `/api/round-ups/${id}/pause`],
    ['POST', `/api/round-ups/${id}/resume`], ['POST', `/api/round-ups/${id}/disable`], ['POST', '/api/round-ups/sweep'], ['POST', '/api/round-ups/refunds']]) {
    const r = await anon.call(m, p, { idempotencyKey: key() });
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out');
  }
});

// ---------- enabling ----------
test('R2: enable creates an active round-up with defaults, moves no money, and shows in the list and detail', async () => {
  const p = await customer();
  const before = [await bal(p.chk), await bal(p.sav)], entriesBefore = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const r = await enable(p);
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, false);
  const ru = r.body.roundUp;
  assert.deepEqual({ ...ru, createdAt: undefined }, { accountId: p.chk, destinationAccountId: p.sav, stepCents: 100, thresholdCents: 500, monthlyCapCents: 50000,
    status: 'active', pendingCents: 0, pendingSince: null, accruedCents: 0, reversedCents: 0, sweptCents: 0, sweptThisMonthCents: 0, lastSweepDate: null, createdAt: undefined });
  assert.ok(!Number.isNaN(Date.parse(ru.createdAt)));
  assert.deepEqual([await bal(p.chk), await bal(p.sav)], before);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entriesBefore);
  assert.deepEqual((await p.c.get('/api/round-ups')).body.roundUps.map(x => x.accountId), [p.chk]);
  const d = await detail(p);
  assert.deepEqual(d.purchases, []); assert.deepEqual(d.sweeps, []); assert.equal(d.roundUp.accountId, p.chk);
  const a = await audits('roundup.enable', p.chk);
  assert.equal(a.length, 1); assert.equal(a[0].user_id, p.uid);
});

test('R2: given settings are echoed; null counts as absent', async () => {
  const p = await customer();
  const r = await enable(p, { stepCents: 500, thresholdCents: 100, monthlyCapCents: 1_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.roundUp.stepCents, 500); assert.equal(r.body.roundUp.thresholdCents, 100); assert.equal(r.body.roundUp.monthlyCapCents, 1_000_000);
  const q = await customer();
  const s = await enable(q, { stepCents: null, thresholdCents: null, monthlyCapCents: null });
  assert.equal(s.status, 200); assert.equal(s.body.roundUp.stepCents, 100); assert.equal(s.body.roundUp.monthlyCapCents, 50000);
});

test('R3: bad settings are refused and nothing is created', async () => {
  const p = await customer();
  for (const v of [150, '100', 100.5, 0, true, -100]) { const r = await enable(p, { stepCents: v }); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_step', String(v)); }
  for (const v of [99, 1_000_001, '500', 500.5]) { const r = await enable(p, { thresholdCents: v }); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_threshold', String(v)); }
  for (const v of [99, 1_000_001, '50000', 0]) { const r = await enable(p, { monthlyCapCents: v }); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_cap', String(v)); }
  assert.equal((await env.q('SELECT count(*)::int n FROM round_ups WHERE account_id = $1', [p.chk])).rows[0].n, 0);
});

test('R4: accounts must be own, of the right kind, and open', async () => {
  const p = await customer(), other = await customer();
  const e = async (b, status, code) => { const r = await p.c.post('/api/round-ups', { idempotencyKey: key(), accountId: p.chk, destinationAccountId: p.sav, ...b });
    assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.error, code); };
  await e({ accountId: undefined }, 400, 'bad_account');
  await e({ accountId: 123 }, 400, 'bad_account');
  await e({ destinationAccountId: null }, 400, 'bad_account');
  await e({ accountId: newId() }, 404, 'not_found');
  await e({ accountId: 'nope' }, 404, 'not_found');
  await e({ accountId: other.chk }, 404, 'not_found');
  await e({ destinationAccountId: other.sav }, 404, 'not_found');
  await e({ accountId: p.sav }, 400, 'bad_account');
  await e({ destinationAccountId: p.chk }, 400, 'bad_account');
  // an account the customer holds as joint_owner is not their own
  const joint = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'savings','Joint Savings','9999')`, [joint]);
  await env.q(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner'), ($1,$3,'joint_owner')`, [joint, other.uid, p.uid]);
  await e({ destinationAccountId: joint }, 404, 'not_found');
  await env.q(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [p.sav]);
  await e({}, 409, 'account_not_open');
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.sav]);
  await env.q(`UPDATE accounts SET status = 'closed' WHERE id = $1`, [p.chk]);
  await e({}, 409, 'account_not_open');
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.chk]);
  assert.equal((await env.q('SELECT count(*)::int n FROM round_ups WHERE account_id = $1', [p.chk])).rows[0].n, 0);
  assert.equal((await audits('roundup.enable', p.chk)).length, 0);
});

test('R5: enabling needs a step-up; pause, resume, disable, sweep and refund do not', async () => {
  const p = await customer({ stepped: false });
  const r = await enable(p);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
  assert.equal((await env.q('SELECT count(*)::int n FROM round_ups WHERE account_id = $1', [p.chk])).rows[0].n, 0);
  await stepUp(p.c);
  assert.equal((await enable(p)).status, 200);
  await env.q('UPDATE sessions SET stepup_at = NULL');                                 // the step-up is gone for everyone
  const b = await buy(p, '4.35');
  assert.equal(b.status, 200);
  assert.equal((await p.c.post(`/api/round-ups/${p.chk}/pause`, {})).status, 200);
  assert.equal((await p.c.post(`/api/round-ups/${p.chk}/resume`, {})).status, 200);
  assert.equal((await sweep(p)).status, 200);
  assert.equal((await refund(p, b.body.authorization.id, 100)).status, 200);
  assert.equal((await p.c.post(`/api/round-ups/${p.chk}/disable`, {})).status, 200);
  const again = await enable(p);                                                        // enabling again needs one
  assert.equal(again.status, 403); assert.equal(again.body.error, 'stepup_required');
  assert.equal((await detail(p)).roundUp.status, 'disabled');
});

test('R6: the same request id replays, a different request with it conflicts, and keys belong to the customer', async () => {
  const p = await customer(), q = await customer();
  const k = key(), body = { idempotencyKey: k, accountId: p.chk, destinationAccountId: p.sav, stepCents: 200 };
  const first = await p.c.post('/api/round-ups', body);
  assert.equal(first.status, 200); assert.equal(first.body.replayed, false);
  await buy(p, '4.35');
  await env.q('UPDATE sessions SET stepup_at = NULL');
  const again = await p.c.post('/api/round-ups', body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(again.body.roundUp.pendingCents, 165);                                  // the round-up as it is now (step 200: 435 -> 165)
  const other = await p.c.post('/api/round-ups', { ...body, stepCents: 500 });
  assert.equal(other.status, 422); assert.equal(other.body.error, 'idempotency_conflict');
  assert.equal((await detail(p)).roundUp.stepCents, 200);
  // a replay from a new session (same customer) still replays
  const p2 = await signIn(env.base, p.username, 'pw-' + p.username.split('@')[0]);
  const fromNew = await p2.post('/api/round-ups', body);
  assert.equal(fromNew.status, 200); assert.equal(fromNew.body.replayed, true);
  const conflictNew = await p2.post('/api/round-ups', { ...body, thresholdCents: 900 });
  assert.equal(conflictNew.status, 422); assert.equal(conflictNew.body.error, 'idempotency_conflict');
  // another customer using the same key string gets their own result
  await stepUp(q.c);
  const theirs = await q.c.post('/api/round-ups', { ...body, accountId: q.chk, destinationAccountId: q.sav });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.equal(theirs.body.roundUp.accountId, q.chk);
  assert.equal((await audits('roundup.enable', p.chk)).length, 1);
  for (const b of [{ ...body, idempotencyKey: undefined }, { ...body, idempotencyKey: 'short' }, { ...body, idempotencyKey: 'has spaces in it' }]) {
    const r = await p.c.post('/api/round-ups', b);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'idempotency_key_required');
  }
  // refund keys: same request replays, a different one conflicts
  const b = await buy(p, '10.00'), rk = key();
  const f1 = await refund(p, b.body.authorization.id, 100, rk);
  assert.equal(f1.status, 200); assert.equal(f1.body.replayed, false);
  const f2 = await refund(p, b.body.authorization.id, 100, rk);
  assert.equal(f2.status, 200); assert.equal(f2.body.replayed, true); assert.deepEqual(f2.body.refund, f1.body.refund);
  const f3 = await refund(p, b.body.authorization.id, 200, rk);
  assert.equal(f3.status, 422); assert.equal(f3.body.error, 'idempotency_conflict');
  assert.equal((await env.q('SELECT count(*)::int n FROM card_refunds WHERE authorization_id = $1', [b.body.authorization.id])).rows[0].n, 1);
  const f4 = await p.c.post('/api/round-ups/refunds', { authorizationId: b.body.authorization.id });
  assert.equal(f4.status, 400); assert.equal(f4.body.error, 'idempotency_key_required');
});

test('R7: one round-up per account; enabling a disabled one keeps its history with the new settings', async () => {
  const p = await customer();
  assert.equal((await enable(p)).status, 200);
  const dup = await enable(p);
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'already_enabled');
  await buy(p, '4.35');
  await p.c.post(`/api/round-ups/${p.chk}/pause`, {});
  assert.equal((await enable(p)).body.error, 'already_enabled');
  const before = (await detail(p)).roundUp;
  assert.equal((await p.c.post(`/api/round-ups/${p.chk}/disable`, {})).status, 200);
  // a second savings account as the new destination
  const sav2 = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'savings','Rainy Day','4321')`, [sav2]);
  await env.q(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [sav2, p.uid]);
  const r = await enable(p, { destinationAccountId: sav2, stepCents: 500, thresholdCents: 1000, monthlyCapCents: 2000 });
  assert.equal(r.status, 200); assert.equal(r.body.replayed, false);
  const ru = r.body.roundUp;
  assert.equal(ru.status, 'active'); assert.equal(ru.destinationAccountId, sav2);
  assert.equal(ru.stepCents, 500); assert.equal(ru.thresholdCents, 1000); assert.equal(ru.monthlyCapCents, 2000);
  for (const f of ['pendingCents', 'pendingSince', 'accruedCents', 'reversedCents', 'sweptCents', 'lastSweepDate', 'createdAt']) assert.equal(ru[f], before[f], f);
  assert.equal((await detail(p)).purchases.length, 1);
  assert.equal((await audits('roundup.enable', p.chk)).length, 2);
});

test('R7: when an enable has several problems, the documented order decides', async () => {
  const p = await customer({ stepped: false }), other = await customer();
  const e = (b) => p.c.post('/api/round-ups', { idempotencyKey: key(), accountId: p.chk, destinationAccountId: p.sav, ...b });
  assert.equal((await p.c.post('/api/round-ups', { accountId: 5, stepCents: 7 })).body.error, 'idempotency_key_required');
  assert.equal((await e({ accountId: undefined, destinationAccountId: undefined, stepCents: 7 })).body.error, 'bad_account');
  assert.equal((await e({ stepCents: 7, thresholdCents: 1, monthlyCapCents: 1 })).body.error, 'bad_step');
  assert.equal((await e({ thresholdCents: 1, monthlyCapCents: 1 })).body.error, 'bad_threshold');
  assert.equal((await e({ monthlyCapCents: 1, accountId: other.chk })).body.error, 'bad_cap');
  assert.equal((await e({ accountId: other.chk, destinationAccountId: p.chk })).status, 404);      // the checking account is checked first
  assert.equal((await e({ accountId: p.sav, destinationAccountId: other.sav })).body.error, 'bad_account');
  assert.equal((await e({ destinationAccountId: other.sav })).body.error, 'not_found');           // account checks come before step-up
  assert.equal((await e({})).body.error, 'stepup_required');
});

// ---------- collecting change ----------
test('R9/R10: an approved debit purchase is rounded up; pending change grows, no ledger entry, balance as the purchase left it', async () => {
  const p = await customer();
  await enable(p);
  const before = await bal(p.chk);
  const b = await buy(p, '4.35');
  assert.equal(b.status, 200);
  assert.deepEqual(Object.keys(b.body).sort(), ['authorization', 'rewardsEarned']);       // the purchase response is unchanged
  assert.equal(await bal(p.chk), before - 435n);
  assert.equal((await entries('round_up_sweep', p.chk)).length, 0);
  await buy(p, '10.00');
  await buy(p, '0.01', { channel: 'online' });
  await buy(p, '2.50', { channel: 'contactless' });
  const d = await detail(p);
  assert.deepEqual(d.purchases.map(x => [x.purchaseCents, x.changeCents, x.refundedCents, x.reversedCents]), [[435, 65, 0, 0], [1000, 0, 0, 0], [1, 99, 0, 0], [250, 50, 0, 0]]);
  assert.equal(d.purchases[0].authorizationId, b.body.authorization.id);
  assert.ok(d.purchases.every(x => x.accruedOn === bankToday()));
  assert.equal(d.roundUp.pendingCents, 214); assert.equal(d.roundUp.accruedCents, 214); assert.equal(d.roundUp.pendingSince, bankToday());
  const a = await audits('roundup.accrue', p.chk);
  assert.equal(a.length, 4); assert.deepEqual(a.map(x => x.detail.changeCents), [65, 0, 99, 50]);
  assert.equal(a[0].detail.authorizationId, b.body.authorization.id); assert.equal(a[0].user_id, p.uid);
  await conserved(p);
});

test('R9: no change for declined, ATM, replayed, paused, disabled, before-enable, no-round-up and credit-card purchases', async () => {
  const p = await customer({ funds: 50_00n });
  const early = await buy(p, '1.25');                                              // before the round-up
  await enable(p);
  assert.equal((await buy(p, '20.00', { channel: 'atm' })).status, 200);         // ATM
  const k = key();
  assert.equal((await p.c.post(`/api/cards/card/${p.card}/purchases`, { idempotencyKey: k, merchant: 'Cafe', amount: '3.10' })).status, 200);
  const replay = await p.c.post(`/api/cards/card/${p.card}/purchases`, { idempotencyKey: k, merchant: 'Cafe', amount: '3.10' });
  assert.equal(replay.body.replayed, true);
  const declined = await buy(p, '999.99');                                          // more than the balance
  assert.equal(declined.status, 422); assert.equal(declined.body.error, 'insufficient_funds');
  await p.c.post(`/api/round-ups/${p.chk}/pause`, {});
  await buy(p, '1.01');
  await p.c.post(`/api/round-ups/${p.chk}/resume`, {});
  let d = await detail(p);
  assert.deepEqual(d.purchases.map(x => x.purchaseCents), [310]);                // only the café purchase, once
  assert.equal(d.roundUp.pendingCents, 90);
  assert.ok(!d.purchases.some(x => x.authorizationId === early.body.authorization.id));
  await p.c.post(`/api/round-ups/${p.chk}/disable`, {});
  await buy(p, '1.01');
  d = await detail(p);
  assert.equal(d.purchases.length, 1); assert.equal(d.roundUp.pendingCents, 90);
  // a customer with no round-up, and a credit card: nothing is created anywhere
  const q = await customer();
  const cc = newId(), ccCard = await tx(env.pool, async c => {
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents) VALUES ($1,'credit_card','Cash+','0101',true,100000)`, [cc]);
    await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [cc, q.uid]);
    return (await issueCard(c, { accountId: cc, holderId: q.uid, type: 'credit' })).id;
  });
  const before = (await env.q('SELECT count(*)::int n FROM round_up_purchases')).rows[0].n;
  assert.equal((await buy(q, '4.35')).status, 200);
  assert.equal((await q.c.post(`/api/cards/card/${ccCard}/purchases`, { idempotencyKey: key(), merchant: 'Shop', amount: '4.35' })).status, 200);
  assert.equal((await env.q('SELECT count(*)::int n FROM round_up_purchases')).rows[0].n, before);
  await conserved(p);
});

test('R11: a purchase that fails leaves no purchase record and collects no change', async () => {
  const p = await customer({ funds: 5_00n });
  await enable(p);
  await env.q(`UPDATE cards SET status = 'locked' WHERE id = $1`, [p.card]);
  const locked = await buy(p, '1.10');
  assert.equal(locked.status, 422);
  await env.q(`UPDATE cards SET status = 'active' WHERE id = $1`, [p.card]);
  const broke = await buy(p, '6.00');
  assert.equal(broke.status, 422);
  const bad = await buy(p, 'abc');
  assert.equal(bad.status, 400);
  const d = await detail(p);
  assert.equal(d.purchases.length, 0); assert.equal(d.roundUp.pendingCents, 0); assert.equal(d.roundUp.pendingSince, null);
  // every approved authorization on the account has a purchase record and vice versa
  assert.equal((await buy(p, '1.10')).status, 200);
  const x = (await env.q(`SELECT (SELECT count(*)::int FROM card_authorizations WHERE card_id = $1 AND result = 'approved') a,
    (SELECT count(*)::int FROM round_up_purchases WHERE account_id = $2) p`, [p.card, p.chk])).rows[0];
  assert.deepEqual(x, { a: 1, p: 1 });
});

// ---------- sweeping ----------
test('R13/R14: a sweep is due at the threshold and posts one two-line entry to savings', async () => {
  const p = await customer();
  await enable(p, { thresholdCents: 100 });
  await buy(p, '4.35');
  assert.deepEqual((await sweep(p)).body, { sweeps: [], posted: 0, deferred: 0 });   // 65 < 100 and still the same day
  assert.equal((await audits('roundup.sweep_posted', p.chk)).length + (await audits('roundup.sweep_deferred', p.chk)).length, 0);
  await buy(p, '1.50');                                                            // 65 + 50 = 115
  const [c0, s0] = [await bal(p.chk), await bal(p.sav)];
  const r = await sweep(p);
  assert.equal(r.status, 200); assert.equal(r.body.posted, 1); assert.equal(r.body.deferred, 0);
  const s = r.body.sweeps[0], today = bankToday();
  assert.equal(s.status, 'posted'); assert.equal(s.amountCents, 115); assert.equal(s.sweepDate, today); assert.equal(s.reason, null);
  assert.equal(s.accountId, p.chk); assert.equal(s.destinationAccountId, p.sav); assert.ok(s.id);
  assert.equal(await bal(p.chk), c0 - 115n); assert.equal(await bal(p.sav), s0 + 115n);
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [s.entryId])).rows[0];
  assert.equal(e.kind, 'round_up_sweep'); assert.equal(e.memo, 'Round-up savings'); assert.equal(e.idempotency_key, `${p.uid}:round-ups:sweep:${p.chk}:${today}`);
  const lines = (await env.q('SELECT * FROM ledger_lines WHERE entry_id = $1 ORDER BY amount_cents', [s.entryId])).rows;
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.posted_on]), [
    [p.chk, -115n, 'Round-up savings to Goal Savings ··5678', 'Transfers', today],
    [p.sav, 115n, 'Round-up savings from Smart Checking ··1234', 'Transfers', today]]);
  const d = await conserved(p);
  assert.equal(d.roundUp.pendingCents, 0); assert.equal(d.roundUp.pendingSince, null); assert.equal(d.roundUp.sweptCents, 115);
  assert.equal(d.roundUp.sweptThisMonthCents, 115); assert.equal(d.roundUp.lastSweepDate, today);
  assert.deepEqual(d.sweeps, [s]);
  const a = await audits('roundup.sweep_posted', p.chk);
  assert.equal(a.length, 1); assert.deepEqual(a[0].detail, { account: p.chk, sweepDate: today, amountCents: 115, entryId: s.entryId });
});

test('R12/R13/R18: a day after change starts, it is due; at most one sweep per day', async () => {
  const p = await customer();
  const d0 = '2031-03-10';
  onDay(d0);
  await enable(p);
  await buy(p, '4.35');
  await buy(p, '1.90');                                                           // same day: pendingSince stays
  assert.equal((await detail(p)).roundUp.pendingSince, d0);
  assert.equal((await sweep(p)).body.posted, 0);
  onDay(addDays(d0, 1));
  await buy(p, '2.80');                                                           // a later day does not move pendingSince
  assert.equal((await detail(p)).roundUp.pendingSince, d0);
  const r = await sweep(p);
  assert.equal(r.body.posted, 1); assert.equal(r.body.sweeps[0].amountCents, 65 + 10 + 20);
  assert.equal((await detail(p)).roundUp.pendingSince, null);
  await buy(p, '0.01');                                                           // 99: grows from zero again today
  assert.equal((await detail(p)).roundUp.pendingSince, addDays(d0, 1));
  await buy(p, '0.01');                                                           // 198, below the 500 threshold
  await env.q('UPDATE round_ups SET threshold_cents = 100 WHERE account_id = $1', [p.chk]);  // now due by threshold, but already swept today
  assert.deepEqual((await sweep(p)).body, { sweeps: [], posted: 0, deferred: 0 });
  assert.equal((await entries('round_up_sweep', p.chk)).length, 1);
  onDay(addDays(d0, 2));
  const next = await sweep(p);
  assert.equal(next.body.posted, 1); assert.equal(next.body.sweeps[0].amountCents, 198);
  const d = await conserved(p);
  assert.deepEqual(d.sweeps.map(s => s.sweepDate), [addDays(d0, 1), addDays(d0, 2)]);
});

test('R18: two simultaneous sweep calls post exactly one entry, reported once', async () => {
  const p = await customer();
  await enable(p, { thresholdCents: 100 });
  await buy(p, '1.01'); await buy(p, '1.01');                                     // 198
  const p2 = await signIn(env.base, p.username, 'pw-' + p.username.split('@')[0]);
  const rs = await Promise.all([sweep(p), p2.post('/api/round-ups/sweep', {}), sweep(p)]);
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(rs.reduce((s, r) => s + r.body.posted, 0), 1);
  assert.equal((await entries('round_up_sweep', p.chk)).length, 1);
  assert.equal((await detail(p)).roundUp.sweptCents, 198);
  await conserved(p);
});

test('R15: a sweep never overdraws; it is deferred and posts later; an exact balance is enough', async () => {
  const p = await customer({ funds: 10_00n });
  await enable(p, { thresholdCents: 100 });
  await buy(p, '8.01');                                                           // change 99, balance 199
  await buy(p, '1.99');                                                           // change 1, balance 0, pending 100
  assert.equal(await bal(p.chk), 0n);
  const before = (await detail(p)).roundUp, sav0 = await bal(p.sav);
  const r = await sweep(p);
  assert.deepEqual(r.body, { sweeps: [{ id: null, accountId: p.chk, destinationAccountId: p.sav, sweepDate: bankToday(), status: 'deferred',
    amountCents: 100, entryId: null, reason: 'insufficient_funds' }], posted: 0, deferred: 1 });
  assert.deepEqual((await detail(p)).roundUp, before);
  assert.equal(await bal(p.sav), sav0); assert.equal((await entries('round_up_sweep', p.chk)).length, 0);
  const a = await audits('roundup.sweep_deferred', p.chk);
  assert.equal(a.length, 1); assert.deepEqual(a[0].detail, { account: p.chk, sweepDate: bankToday(), reason: 'insufficient_funds', amountCents: 100 });
  // deposit exactly the amount: the next call posts it
  await tx(env.pool, async c => post(c, { key: `test:topup:${p.chk}`, kind: 'seed', lines: [{ accountId: p.chk, amountCents: 100n, description: 'Deposit' },
    { accountId: await systemAccount(c, 'equity'), amountCents: -100n, description: 'Deposit' }] }));
  const ok = await sweep(p);
  assert.equal(ok.body.posted, 1); assert.equal(ok.body.sweeps[0].amountCents, 100);
  assert.equal(await bal(p.chk), 0n); assert.equal(await bal(p.sav), sav0 + 100n);
  await conserved(p);
});

test('R16: the monthly cap limits a sweep, the rest stays pending, and a new month starts again', async () => {
  const p = await customer();
  const d0 = '2031-05-30';
  onDay(d0);
  await enable(p, { thresholdCents: 100, monthlyCapCents: 150 });
  await buy(p, '0.01'); await buy(p, '0.01');                                     // 198
  let r = await sweep(p);
  assert.equal(r.body.sweeps[0].status, 'posted'); assert.equal(r.body.sweeps[0].amountCents, 150);
  let d = await detail(p);
  assert.equal(d.roundUp.pendingCents, 48); assert.equal(d.roundUp.pendingSince, d0); assert.equal(d.roundUp.sweptThisMonthCents, 150);
  await buy(p, '0.01'); await buy(p, '0.01');                                     // 48 + 198 = 246
  onDay(addDays(d0, 1));                                                          // May 31: cap used up
  r = await sweep(p);
  assert.deepEqual(r.body.sweeps.map(s => [s.status, s.reason, s.amountCents]), [['deferred', 'monthly_cap', 0]]);
  assert.equal((await detail(p)).roundUp.pendingCents, 246);
  onDay('2031-06-01');                                                            // a new month
  d = await detail(p);
  assert.equal(d.roundUp.sweptThisMonthCents, 0);
  r = await sweep(p);
  assert.equal(r.body.sweeps[0].amountCents, 150);
  d = await conserved(p);
  assert.equal(d.roundUp.pendingCents, 96); assert.equal(d.roundUp.sweptCents, 300); assert.equal(d.roundUp.sweptThisMonthCents, 150);
});

test('R17: closed or frozen accounts defer the sweep; precedence is account_not_open, monthly_cap, insufficient_funds', async () => {
  const p = await customer({ funds: 10_00n });
  const d0 = '2031-09-15';
  onDay(d0);
  await enable(p, { thresholdCents: 100, monthlyCapCents: 100 });
  await buy(p, '0.01'); await buy(p, '0.01');                                     // pending 198
  await env.q(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [p.sav]);
  let r = await sweep(p);
  assert.deepEqual(r.body.sweeps.map(s => [s.status, s.reason, s.amountCents]), [['deferred', 'account_not_open', 100]]);
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.sav]);
  await env.q(`UPDATE accounts SET status = 'closed' WHERE id = $1`, [p.chk]);
  assert.equal((await sweep(p)).body.sweeps[0].reason, 'account_not_open');
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.chk]);
  assert.equal((await detail(p)).roundUp.pendingCents, 198);                     // deferrals change nothing
  assert.equal((await sweep(p)).body.sweeps[0].amountCents, 100);                // posts the capped amount
  await buy(p, '8.98');                                                           // change 2, balance 0, pending 100
  assert.equal(await bal(p.chk), 0n);
  onDay(addDays(d0, 1));
  r = await sweep(p);                                                             // cap used up and no money: the cap wins
  assert.deepEqual(r.body.sweeps.map(s => [s.reason, s.amountCents]), [['monthly_cap', 0]]);
  await env.q(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [p.chk]);
  assert.deepEqual((await sweep(p)).body.sweeps.map(s => [s.reason, s.amountCents]), [['account_not_open', 0]]);
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.chk]);
  const d = await conserved(p);
  assert.equal(d.roundUp.pendingCents, 100); assert.equal(d.roundUp.sweptCents, 100);
  assert.equal((await audits('roundup.sweep_deferred', p.chk)).length, 4);
});

test('R13/R23/R25: paused and disabled round-ups are not swept', async () => {
  const p = await customer();
  await enable(p, { thresholdCents: 100 });
  await buy(p, '0.01'); await buy(p, '0.01');
  await p.c.post(`/api/round-ups/${p.chk}/pause`, {});
  assert.deepEqual((await sweep(p)).body, { sweeps: [], posted: 0, deferred: 0 });
  await p.c.post(`/api/round-ups/${p.chk}/disable`, {});
  assert.deepEqual((await sweep(p)).body, { sweeps: [], posted: 0, deferred: 0 });
  assert.equal((await detail(p)).roundUp.pendingCents, 198);
});

test('R19: sweeps do not count toward the transfer limits', async () => {
  const p = await customer();
  await enable(p, { thresholdCents: 100 });
  const before = (await p.c.get('/api/pay/limits')).body;
  await buy(p, '0.01'); await buy(p, '0.01');
  assert.equal((await sweep(p)).body.posted, 1);
  assert.deepEqual((await p.c.get('/api/pay/limits')).body, before);
});

test('sweep order: several round-ups are swept in the order they were created', async () => {
  const p = await customer();
  const chk2 = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Bills Checking','2222')`, [chk2]);
  await env.q(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [chk2, p.uid]);
  const card2 = await tx(env.pool, async c => {
    await post(c, { key: `test:fund:${chk2}`, kind: 'seed', lines: [{ accountId: chk2, amountCents: 50_00n, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -50_00n, description: 'Opening deposit' }] });
    return (await issueCard(c, { accountId: chk2, holderId: p.uid, type: 'debit' })).id;
  });
  await enable(p, { thresholdCents: 100 });
  assert.equal((await p.c.post('/api/round-ups', { idempotencyKey: key(), accountId: chk2, destinationAccountId: p.sav, thresholdCents: 100 })).status, 200);
  await buy(p, '0.01'); await buy(p, '0.01');
  await p.c.post(`/api/cards/card/${card2}/purchases`, { idempotencyKey: key(), merchant: 'Shop', amount: '0.01' });
  await p.c.post(`/api/cards/card/${card2}/purchases`, { idempotencyKey: key(), merchant: 'Shop', amount: '0.01' });
  const list = (await p.c.get('/api/round-ups')).body.roundUps.map(x => x.accountId);
  assert.deepEqual(list, [chk2, p.chk]);                                          // newest first
  const r = (await sweep(p)).body;
  assert.deepEqual(r.sweeps.map(s => s.accountId), [p.chk, chk2]);              // oldest round-up first
  assert.equal(r.posted, 2);
});

// ---------- refunds ----------
test('R20/R22: a full refund returns the money through card settlement and reverses all of its change', async () => {
  const p = await customer();
  await enable(p);
  const b = await buy(p, '4.35'), id = b.body.authorization.id;
  const c0 = await bal(p.chk);
  const r = await refund(p, id);
  assert.equal(r.status, 200); assert.equal(r.body.replayed, false);
  const f = r.body.refund;
  assert.equal(f.authorizationId, id); assert.equal(f.amountCents, 435); assert.equal(f.reversedCents, 65); assert.ok(f.id); assert.ok(Date.parse(f.createdAt));
  assert.equal(await bal(p.chk), c0 + 435n);
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [f.entryId])).rows[0];
  assert.equal(e.kind, 'card_refund'); assert.match(e.idempotency_key, new RegExp(`^${p.uid}:round-ups:refund:ru-key-`));
  const lines = (await env.q('SELECT l.*, a.system_code FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = $1 ORDER BY amount_cents', [f.entryId])).rows;
  assert.deepEqual(lines.map(l => [l.system_code ?? l.account_id, l.amount_cents, l.posted_on]), [['card_network_settlement', -435n, bankToday()], [p.chk, 435n, bankToday()]]);
  const d = await conserved(p);
  assert.equal(d.roundUp.pendingCents, 0); assert.equal(d.roundUp.pendingSince, null); assert.equal(d.roundUp.reversedCents, 65);
  assert.deepEqual(d.purchases[0], { authorizationId: id, purchaseCents: 435, changeCents: 65, refundedCents: 435, reversedCents: 65, accruedOn: bankToday() });
  assert.equal((await refund(p, id, 1)).body.error, 'refund_exceeds_purchase');
  assert.equal((await refund(p, id)).body.error, 'refund_exceeds_purchase');
  const ar = await audits('roundup.refund');
  assert.deepEqual(ar.filter(x => x.detail.authorizationId === id).map(x => [x.user_id, x.detail.amountCents, x.detail.entryId]), [[p.uid, 435, f.entryId]]);
  const av = (await audits('roundup.reverse', p.chk));
  assert.deepEqual(av.map(x => x.detail), [{ account: p.chk, authorizationId: id, reversedCents: 65 }]);
});

test('R22: partial refunds reverse in proportion, limited by what is still pending, in any status', async () => {
  const p = await customer();
  await enable(p);
  const b = await buy(p, '4.35'), id = b.body.authorization.id;
  await buy(p, '0.50');                                                           // 50 more pending (other purchase)
  await p.c.post(`/api/round-ups/${p.chk}/pause`, {});
  const r1 = await refund(p, id, 200);
  assert.equal(r1.body.refund.reversedCents, 29);                                 // floor(65*200/435)
  await p.c.post(`/api/round-ups/${p.chk}/disable`, {});
  const r2 = await refund(p, id, 235);
  assert.equal(r2.body.refund.reversedCents, 36);                                 // 65 - 29
  const d = await conserved(p);
  assert.equal(d.roundUp.pendingCents, 50); assert.equal(d.roundUp.reversedCents, 65);
  assert.equal(d.purchases[0].refundedCents, 435);

  // swept change is not taken back from savings
  const q = await customer();
  await enable(q, { thresholdCents: 100 });
  const qb = await buy(q, '0.01'), qid = qb.body.authorization.id;               // 99
  await buy(q, '0.99');                                                           // 1 -> 100 pending
  assert.equal((await sweep(q)).body.posted, 1);
  const sav = await bal(q.sav);
  const x = await refund(q, qid);
  assert.equal(x.status, 200); assert.equal(x.body.refund.reversedCents, 0);
  assert.equal(await bal(q.sav), sav);
  assert.equal((await audits('roundup.reverse', q.chk)).length, 0);
  // pending limits a later reversal; the next refund counts what was actually reversed
  const z = await customer();
  await enable(z, { thresholdCents: 100, monthlyCapCents: 100 });
  const zb = await buy(z, '0.10'), zid = zb.body.authorization.id;               // change 90
  await buy(z, '0.80');                                                           // change 20 -> 110 pending
  assert.equal((await sweep(z)).body.sweeps[0].amountCents, 100);                // 10 left pending
  const z1 = await refund(z, zid, 5);
  assert.equal(z1.body.refund.reversedCents, 10);                                 // floor(90*5/10)=45, limited by pending 10
  await buy(z, '0.70');                                                           // 30 more pending
  const z2 = await refund(z, zid, 5);
  assert.equal(z2.body.refund.reversedCents, 30);                                 // 90 - 10 = 80, limited by pending 30
  const zd = await conserved(z);
  assert.equal(zd.purchases[0].reversedCents, 40); assert.equal(zd.roundUp.pendingCents, 0); assert.equal(zd.roundUp.pendingSince, null);
});

test('R20: a refund of a purchase with no round-up returns the money and reverses nothing', async () => {
  const p = await customer();
  const b = await buy(p, '4.35');
  const r = await refund(p, b.body.authorization.id, 100);
  assert.equal(r.status, 200); assert.equal(r.body.refund.reversedCents, 0);
  assert.equal((await refund(p, b.body.authorization.id)).body.refund.amountCents, 335);  // the rest
});

test('R20: refund checks, in order', async () => {
  const p = await customer({ funds: 100_00n }), other = await customer();
  await enable(p);
  const ok = (await buy(p, '4.35')).body.authorization.id;
  const atm = (await buy(p, '20.00', { channel: 'atm' })).body.authorization.id;
  const declined = (await buy(p, '999.00')).body.authorization.id;
  const e = async (b, status, code) => { const r = await p.c.post('/api/round-ups/refunds', { idempotencyKey: key(), ...b }); assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.error, code); };
  await e({}, 400, 'bad_authorization');
  await e({ authorizationId: 42, amountCents: 'x' }, 400, 'bad_authorization');
  await e({ authorizationId: 'nope', amountCents: 'x' }, 404, 'not_found');
  await e({ authorizationId: newId() }, 404, 'not_found');
  const theirs = (await buy(other, '4.35')).body.authorization.id;
  await e({ authorizationId: theirs, amountCents: 0 }, 404, 'not_found');
  for (const v of [0, -1, 1.5, '100']) await e({ authorizationId: ok, amountCents: v }, 400, 'bad_amount');
  await e({ authorizationId: atm, amountCents: 1 }, 422, 'not_refundable');
  await e({ authorizationId: declined }, 422, 'not_refundable');
  await e({ authorizationId: ok, amountCents: 436 }, 409, 'refund_exceeds_purchase');
  await env.q(`UPDATE accounts SET status = 'frozen' WHERE id = $1`, [p.chk]);
  await e({ authorizationId: ok, amountCents: 436 }, 409, 'account_not_open');
  await env.q(`UPDATE accounts SET status = 'open' WHERE id = $1`, [p.chk]);
  assert.equal((await env.q('SELECT count(*)::int n FROM card_refunds WHERE authorization_id = ANY($1)', [[ok, atm, declined, theirs]])).rows[0].n, 0);
  assert.equal((await detail(p)).roundUp.pendingCents, 65);
  // a joint owner may refund a purchase on the joint account
  await env.q(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')`, [other.chk, p.uid]);
  const j = await refund(p, theirs, 100);
  assert.equal(j.status, 200);
  assert.equal((await audits('roundup.refund')).find(x => x.detail.entryId === j.body.refund.entryId).user_id, p.uid);
});

// ---------- state changes ----------
test('R23/R24/R25: pause, resume and disable move between states; anything else is invalid_state', async () => {
  const p = await customer();
  await enable(p);
  const s = async (what, status, code) => { const r = await p.c.post(`/api/round-ups/${p.chk}/${what}`, {}); assert.equal(r.status, status, what);
    if (code) assert.equal(r.body.error, code); else return r.body.roundUp; };
  await s('resume', 409, 'invalid_state');
  assert.equal((await s('pause', 200)).status, 'paused');
  await s('pause', 409, 'invalid_state');
  await buy(p, '4.35');                                                           // while paused: not rounded up, not afterwards either
  assert.equal((await s('resume', 200)).status, 'active');
  assert.equal((await detail(p)).purchases.length, 0);
  await buy(p, '4.35');
  assert.equal((await s('disable', 200)).status, 'disabled');
  await s('disable', 409, 'invalid_state'); await s('pause', 409, 'invalid_state'); await s('resume', 409, 'invalid_state');
  const d = await detail(p);
  assert.equal(d.roundUp.pendingCents, 65); assert.equal(d.purchases.length, 1);
  assert.equal((await p.c.get('/api/round-ups')).body.roundUps[0].status, 'disabled');
  for (const a of ['roundup.pause', 'roundup.resume', 'roundup.disable']) {
    const rows = await audits(a, p.chk);
    assert.equal(rows.length, 1, a); assert.equal(rows[0].user_id, p.uid);
  }
});

test('R21: another customer\'s round-up is a 404 and stays unchanged; list and sweep are per customer', async () => {
  const p = await customer(), q = await customer();
  await enable(p, { thresholdCents: 100 });
  await buy(p, '0.01'); await buy(p, '0.01');
  const before = (await detail(p)).roundUp;
  for (const id of [p.chk, newId(), 'not-a-uuid', p.sav]) {
    assert.equal((await q.c.get(`/api/round-ups/${id}`)).status, 404);
    for (const what of ['pause', 'resume', 'disable']) {
      const r = await q.c.post(`/api/round-ups/${id}/${what}`, {});
      assert.equal(r.status, 404); assert.equal(r.body.error, 'not_found');
    }
  }
  assert.deepEqual((await q.c.get('/api/round-ups')).body.roundUps, []);
  assert.deepEqual((await q.c.post('/api/round-ups/sweep', {})).body, { sweeps: [], posted: 0, deferred: 0 });
  assert.deepEqual((await detail(p)).roundUp, before);
  // a joint owner, custodian or viewer of the account does not see it as theirs
  for (const role of ['joint_owner', 'viewer']) {
    const w = await customer();
    await env.q(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)`, [p.chk, w.uid, role]);
    assert.equal((await w.c.get(`/api/round-ups/${p.chk}`)).status, 404, role);
    assert.equal((await w.c.post(`/api/round-ups/${p.chk}/pause`, {})).status, 404, role);
    assert.deepEqual((await w.c.post('/api/round-ups/sweep', {})).body.sweeps, [], role);
    assert.ok(!(await w.c.get('/api/round-ups')).body.roundUps.some(x => x.accountId === p.chk), role);
  }
  // a purchase on q's card never changes p's round-up
  await buy(q, '4.35');
  assert.deepEqual((await detail(p)).roundUp, before);
});

// ---------- integrity and records ----------
test('R26/R27: a mixed run conserves money, entries balance, and audit rows carry no account numbers', async () => {
  const p = await customer();
  const d0 = '2031-08-12';
  onDay(d0);
  await enable(p);
  const auths = [];
  for (const a of ['4.35', '12.99', '7.01', '0.10', '3.33']) auths.push((await buy(p, a)).body.authorization.id);
  await refund(p, auths[1], 500);
  onDay(addDays(d0, 1));
  assert.equal((await sweep(p)).body.posted, 1);
  await refund(p, auths[0]);
  await buy(p, '1.11');
  await refund(p, auths[4], 100);
  onDay(addDays(d0, 2));
  assert.equal((await sweep(p)).body.posted, 1);
  const d = await conserved(p);
  assert.ok(Object.values(d.roundUp).filter(v => typeof v === 'number').every(Number.isInteger));
  const out = (await env.q(`SELECT coalesce(sum(-l.amount_cents), 0)::bigint s FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.kind = 'round_up_sweep' AND l.account_id = $1`, [p.chk])).rows[0].s;
  const inn = (await env.q(`SELECT coalesce(sum(l.amount_cents), 0)::bigint s FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.kind = 'round_up_sweep' AND l.account_id = $1`, [p.sav])).rows[0].s;
  assert.equal(out, inn); assert.equal(Number(out), d.roundUp.sweptCents);
  const sums = (await env.q(`SELECT e.id, sum(l.amount_cents)::bigint s, count(*)::int n FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
    WHERE e.kind IN ('round_up_sweep', 'card_refund') GROUP BY e.id`)).rows;
  assert.ok(sums.every(x => x.s === 0n && x.n === 2));
  const rows = (await env.q(`SELECT detail::text t FROM audit_events WHERE action LIKE 'roundup.%'`)).rows;
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => !/account_number|accountNumber|"number"|pan/i.test(r.t)));
  // a refused request writes no audit row
  const count = (await env.q(`SELECT count(*)::int n FROM audit_events WHERE action LIKE 'roundup.%'`)).rows[0].n;
  await enable(p);
  await p.c.post(`/api/round-ups/${p.chk}/resume`, {});
  await refund(p, auths[0]);
  assert.equal((await env.q(`SELECT count(*)::int n FROM audit_events WHERE action LIKE 'roundup.%'`)).rows[0].n, count);
});
