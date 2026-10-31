// ACH debit returns and returned-item fees: staff record incoming debits and post returns; returns reverse the money, give
// the ACH limit back and (R01/R02 on outgoing debits) charge a capped returned-item fee; R01 returns may be presented again;
// money from pulls is held while it can still be returned. Each test makes its own customers and staff, so fees, caps and
// limits never leak between tests.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('hex');      // test-only key, made fresh for each run
const { testEnv, signIn, client } = await import('../helpers.mjs');
const { clock } = await import('../../lib/money-movement/calendar.mjs');
const { open, seal } = await import('../../lib/money-movement/vault.mjs');
const { hashPassword, newId } = await import('../../lib/auth.mjs');
const { post, systemAccount } = await import('../../lib/ledger.mjs');
const { tx } = await import('../../lib/db.mjs');
const { toStr } = await import('../../lib/money.mjs');
const { baseFee } = await import('../../lib/routes/ach-returns.mjs');

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const at = day => { clock.now = () => new Date(`${day}T16:00:00Z`); };       // 10 or 11 am Central Time

let n = 0; const key = () => `ach-ret-${Date.now()}-${++n}`;
const EXT_NUMBER = '000099991234', COMPANY_NUMBER = '000123456789';

// ---------- people and accounts ----------
async function account(ownerId, { deposit = 0n, kind = 'checking', role = 'owner' } = {}) {
  const id = newId(), last4 = String(1000 + (++n % 9000)).padStart(4, '0');
  await env.q("INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,$2,'Test account',$3)", [id, kind, last4]);
  await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, ownerId, role]);
  if (deposit) await fund(id, deposit);
  return { id, last4 };
}
const fund = (accountId, cents) => tx(env.pool, async c => post(c, { key: `test:fund:${newId()}`, kind: 'seed', lines: [
  { accountId, amountCents: cents, description: 'Test deposit', category: 'Transfers', postedOn: '2026-01-02' },
  { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Test deposit', postedOn: '2026-01-02' }] }));
/** A user with a checking account (and, for customers, a verified external account), signed in. */
async function person({ staff = false, deposit = 100000n } = {}) {
  const id = newId(), name = `u${++n}${randomBytes(3).toString('hex')}`, username = `${name}@test.example`, password = `pw-${name}`;
  await env.q('INSERT INTO users (id, username, display_name, password_hash, mfa_required) VALUES ($1,$2,$3,$4,false)', [id, username, name, await hashPassword(password)]);
  if (staff) await env.q("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'ach_operations')", [id]);
  const acct = await account(id, { deposit });
  const ext = newId();
  await env.q(`INSERT INTO external_accounts (id, user_id, nickname, kind, routing_number, number_last4, number_enc, status, tries_left, created_at, verified_at)
    VALUES ($1,$2,'Other bank','checking','123456780','1234',$3,'verified',0,'2026-01-01','2026-01-01')`, [ext, id, seal(EXT_NUMBER, `${id}:${ext}`)]);
  return { id, username, password, acct, ext, c: await signIn(env.base, username, password) };
}
const staffer = () => person({ staff: true, deposit: 0n });
async function stepUp(c) { const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); }
const bal = async accountId => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [accountId])).rows[0].balance_cents;
const sysBal = async code => (await env.q('SELECT balance_cents FROM accounts WHERE system_code = $1', [code])).rows[0].balance_cents;
const count = async (sql, args) => (await env.q(sql, args)).rows[0].n;

/** An ACH pull into the customer's account, settled (credited) at once. Returns its transfer id (the item id). */
async function pull(p, amountCents, accountId = p.acct.id) {
  if (amountCents >= 100000) await stepUp(p.c);
  const r = await p.c.post('/api/pay/ach', { accountId, externalAccountId: p.ext, direction: 'in', amount: toStr(BigInt(amountCents)), idempotencyKey: key() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await p.c.post('/api/pay/simulate-settlement', { transferId: r.body.transfer.id });
  assert.equal(s.body.settled[0].status, 'settled', JSON.stringify(s.body));
  return r.body.transfer.id;
}
const ret = (s, itemId, body = {}) => s.c.post(`/api/ach-ops/items/${itemId}/returns`, { idempotencyKey: key(), presentment: 1, reasonCode: 'R01', note: 'In today\'s ACH return file', ...body });
const debit = (s, accountId, body = {}) => s.c.post('/api/ach-ops/incoming-debits', { idempotencyKey: key(), accountId, amountCents: 4599, companyName: 'Prairie Power & Light',
  companyAccountNumber: COMPANY_NUMBER, ...body });
const avail = async (p, accountId = p.acct.id) => (await p.c.get(`/api/ach-returns/availability/${accountId}`)).body;
const limitUse = async p => (await p.c.get('/api/pay/limits')).body.limits.find(l => l.rail === 'ach');
const alerts = async p => (await p.c.get('/api/alerts')).body.items.filter(i => i.kind === 'ach_return');

test('R23: the base returned-item fee is 2.5% rounded half up, from $5 to $35', () => {
  for (const [amount, fee] of [[100, 500], [20019, 500], [20020, 501], [50000, 1250], [139999, 3500], [250000, 3500]])
    assert.equal(baseFee(BigInt(amount)), BigInt(fee), String(amount));
});

test('R1, R2, R3: sign-in and the staff role are required; customers only see their own accounts', async () => {
  at('2027-03-01');
  const cust = await person(), staff = await staffer(), other = await person();
  const item = await pull(cust, 5000);
  const anon = client(env.base), bogus = newId();
  const all = [['GET', '/api/ach-returns'], ['GET', `/api/ach-returns/items/${item}`], ['GET', `/api/ach-returns/availability/${cust.acct.id}`],
    ['POST', '/api/ach-ops/incoming-debits'], ['GET', `/api/ach-ops/items/${item}`], ['POST', `/api/ach-ops/items/${item}/returns`],
    ['POST', `/api/ach-ops/items/${item}/represent`], ['POST', `/api/ach-ops/returns/${bogus}/waive-fee`]];
  for (const [m, p] of all) {
    const r = await anon.call(m, p, {});
    assert.equal(r.status, 401, p); assert.equal(r.body.error, 'signed_out', p);
  }
  const entries = await count('SELECT count(*)::int n FROM journal_entries');
  // a customer who owns the account is still not staff
  for (const r of [await debit(cust, cust.acct.id), await cust.c.get(`/api/ach-ops/items/${item}`), await ret(cust, item),
    await cust.c.post(`/api/ach-ops/items/${item}/represent`, {}), await cust.c.post(`/api/ach-ops/returns/${bogus}/waive-fee`, { reason: 'Goodwill refund' })]) {
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden');
  }
  assert.equal(await count('SELECT count(*)::int n FROM journal_entries'), entries);
  // staff: unknown and malformed ids are 404
  for (const id of [bogus, 'not-a-uuid']) {
    assert.equal((await staff.c.get(`/api/ach-ops/items/${id}`)).body.error, 'not_found');
    assert.equal((await ret(staff, id)).body.error, 'not_found');
    assert.equal((await staff.c.post(`/api/ach-ops/items/${id}/represent`, {})).body.error, 'not_found');
    assert.equal((await staff.c.post(`/api/ach-ops/returns/${id}/waive-fee`, { reason: 'Goodwill refund' })).body.error, 'not_found');
  }
  // being staff gives no rights on the customer endpoints
  assert.equal((await staff.c.get(`/api/ach-returns/items/${item}`)).body.error, 'not_found');
  assert.equal((await staff.c.get(`/api/ach-returns/availability/${cust.acct.id}`)).status, 404);
  assert.equal((await staff.c.get(`/api/ach-returns/availability/${staff.acct.id}`)).status, 200);
  // another customer, an unknown id, a malformed id
  for (const id of [item, bogus, 'nope']) assert.equal((await other.c.get(`/api/ach-returns/items/${id}`)).status, 404);
  assert.equal((await other.c.get(`/api/ach-returns/availability/${cust.acct.id}`)).body.error, 'not_found');
  assert.equal((await other.c.get('/api/ach-returns/availability/nope')).status, 404);
  assert.equal((await ret(staff, item, { reasonCode: 'R10' })).status, 200);
  assert.deepEqual((await other.c.get('/api/ach-returns')).body.returns, []);
  assert.equal((await cust.c.get('/api/ach-returns')).body.returns.length, 1);
});

test('R3, R33: joint owners see the shared account’s items and get notified; custodians and viewers do not', async () => {
  at('2027-03-02');
  const a = await person(), b = await person(), viewer = await person(), cust = await person(), staff = await staffer();
  const shared = await account(a.id, { deposit: 50000n });
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner'), ($1,$3,'viewer'), ($1,$4,'custodian')", [shared.id, b.id, viewer.id, cust.id]);
  const item = await pull(a, 20000, shared.id);
  for (const p of [a, b]) assert.equal((await p.c.get(`/api/ach-returns/items/${item}`)).body.item.id, item);
  for (const p of [viewer, cust]) {
    assert.equal((await p.c.get(`/api/ach-returns/items/${item}`)).status, 404);
    assert.equal((await p.c.get(`/api/ach-returns/availability/${shared.id}`)).status, 404);
  }
  const r = await ret(staff, item, { reasonCode: 'R01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const p of [a, b]) {
    const list = (await p.c.get('/api/ach-returns')).body.returns;
    assert.deepEqual(list.map(x => [x.id, x.direction, x.accountId, x.counterparty]), [[r.body.return.id, 'outgoing', shared.id, 'Other bank ··1234']]);
    const notes = await alerts(p);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, 'ACH transfer returned');
    assert.ok(notes[0].body.includes('$200.00') && notes[0].body.includes('R01') && notes[0].body.includes('Insufficient funds') && notes[0].body.includes(`··${shared.last4}`), notes[0].body);
    assert.ok(notes[0].body.includes('fee of $5.00'), notes[0].body);
  }
  for (const p of [viewer, cust, staff]) assert.deepEqual(await alerts(p), []);
  assert.equal(await count("SELECT count(*)::int n FROM notifications WHERE ref = $1", [`ach-return:${r.body.return.id}`]), 2);
  assert.deepEqual((await viewer.c.get('/api/ach-returns')).body.returns, []);
});

test('R4: staff may not act on an account they own or jointly own', async () => {
  at('2027-03-03');
  const staff = await person({ staff: true }), staff2 = await staffer(), cust = await person();
  const mine = await pull(staff, 10000);
  const joint = await account(cust.id, { deposit: 20000n });
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')", [joint.id, staff.id]);
  const entries = await count('SELECT count(*)::int n FROM journal_entries');
  for (const r of [await debit(staff, staff.acct.id), await debit(staff, joint.id), await ret(staff, mine), await staff.c.post(`/api/ach-ops/items/${mine}/represent`, {})]) {
    assert.equal(r.status, 403); assert.equal(r.body.error, 'conflict_of_interest');
  }
  const r = await ret(staff2, mine);
  assert.equal(r.status, 200); assert.ok(r.body.return.feeCents > 0);
  const w = await staff.c.post(`/api/ach-ops/returns/${r.body.return.id}/waive-fee`, { reason: 'Goodwill refund' });
  assert.equal(w.status, 403); assert.equal(w.body.error, 'conflict_of_interest');
  assert.equal(await count('SELECT count(*)::int n FROM journal_entries'), entries + 2);   // only staff2's reversal and fee
  assert.equal((await staff.c.get(`/api/ach-ops/items/${mine}`)).status, 200);              // reading is fine
});

test('R5, R6, R8: a credited pull is an outgoing item; its money is held through its final date', async () => {
  at('2027-03-05');                                                                         // Friday
  const cust = await person({ deposit: 30000n }), staff = await staffer();
  await stepUp(cust.c);
  const pending = await cust.c.post('/api/pay/ach', { accountId: cust.acct.id, externalAccountId: cust.ext, direction: 'in', amount: '75.00', idempotencyKey: key() });
  assert.equal((await cust.c.get(`/api/ach-returns/items/${pending.body.transfer.id}`)).status, 404);   // not credited yet
  assert.equal((await staff.c.get(`/api/ach-ops/items/${pending.body.transfer.id}`)).status, 404);
  await cust.c.post('/api/pay/simulate-settlement', { transferId: pending.body.transfer.id });
  const item = pending.body.transfer.id;
  const v = (await cust.c.get(`/api/ach-returns/items/${item}`)).body.item;
  assert.deepEqual({ ...v, createdAt: undefined }, { id: item, direction: 'outgoing', accountId: cust.acct.id, amountCents: 7500, counterparty: 'Other bank ··1234',
    state: 'posted', presentment: 1, postedOn: '2027-03-05', finalOn: '2027-03-12', heldCents: 7500, rePresentment: null, returns: [], createdAt: undefined });
  assert.equal(typeof v.createdAt, 'string');
  const s = (await staff.c.get(`/api/ach-ops/items/${item}`)).body.item;
  assert.equal(s.customerId, cust.id); assert.deepEqual(s.history, []);
  assert.deepEqual(await avail(cust), { accountId: cust.acct.id, balanceCents: 37500, heldCents: 7500, availableCents: 30000 });

  // a pull returned by the simulated settlement (external account ending 0001) and other rails are not items
  const bad = newId();
  await env.q(`INSERT INTO external_accounts (id, user_id, nickname, kind, routing_number, number_last4, status, tries_left, created_at, verified_at)
    VALUES ($1,$2,'Bouncing bank','checking','123456780','0001','verified',0,'2026-01-01','2026-01-01')`, [bad, cust.id]);
  const bounced = await cust.c.post('/api/pay/ach', { accountId: cust.acct.id, externalAccountId: bad, direction: 'in', amount: '10.00', idempotencyKey: key() });
  await cust.c.post('/api/pay/simulate-settlement', { transferId: bounced.body.transfer.id });
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [bounced.body.transfer.id])).rows[0].status, 'returned');
  const sav = await account(cust.id);
  const internal = await cust.c.post('/api/pay/transfers', { fromAccountId: cust.acct.id, toAccountId: sav.id, amount: '1.00', idempotencyKey: key() });
  for (const id of [bounced.body.transfer.id, internal.body.transfer.id]) {
    assert.equal((await cust.c.get(`/api/ach-returns/items/${id}`)).status, 404);
    assert.equal((await staff.c.get(`/api/ach-ops/items/${id}`)).status, 404);
  }
  // held through its final date (Friday a week later), weekends counted out; settled the day after
  at('2027-03-12');
  assert.equal((await avail(cust)).heldCents, 7500);
  assert.equal((await cust.c.get(`/api/ach-returns/items/${item}`)).body.item.state, 'posted');
  at('2027-03-13');
  const settled = (await cust.c.get(`/api/ach-returns/items/${item}`)).body.item;
  assert.equal(settled.state, 'settled'); assert.equal(settled.heldCents, 0);
  assert.deepEqual(await avail(cust), { accountId: cust.acct.id, balanceCents: 37400, heldCents: 0, availableCents: 37400 });
  // R8, R17: every return of a settled item is late, and the refusal is kept in the audit trail
  at('2027-03-15');
  const before = await bal(cust.acct.id);
  const late = await ret(staff, item, { reasonCode: 'R10' });
  assert.equal(late.status, 422); assert.equal(late.body.error, 'return_window_closed');
  assert.equal(await bal(cust.acct.id), before);
  const hist = (await staff.c.get(`/api/ach-ops/items/${item}`)).body.item.history;
  assert.deepEqual(hist.map(h => [h.action, h.actorId, h.detail.presentment, h.detail.reasonCode, h.detail.deadline]), [['ach_return.late_refused', staff.id, 1, 'R10', '2027-03-12']]);
});

test('R7: held money can’t be spent through /api/pay until the hold is gone', async () => {
  at('2027-03-08');
  const cust = await person({ deposit: 20000n });
  const item = await pull(cust, 50000);
  const sav = await account(cust.id);
  const send = amount => cust.c.post('/api/pay/transfers', { fromAccountId: cust.acct.id, toAccountId: sav.id, amount, idempotencyKey: key() });
  const big = await send('200.01');
  assert.equal(big.status, 409); assert.equal(big.body.error, 'insufficient_funds'); assert.match(big.body.message, /held/);
  await stepUp(cust.c);
  const out = await cust.c.post('/api/pay/ach', { accountId: cust.acct.id, externalAccountId: cust.ext, direction: 'out', amount: '300.00', idempotencyKey: key() });
  assert.equal(out.status, 409); assert.equal(out.body.error, 'insufficient_funds');
  assert.equal((await send('200.00')).status, 200);                                      // exactly the available money
  assert.equal((await send('0.01')).body.error, 'insufficient_funds');
  assert.equal(await bal(cust.acct.id), 50000n);
  at('2027-03-16');                                                                       // the day after the final date
  assert.equal((await cust.c.get(`/api/ach-returns/items/${item}`)).body.item.state, 'settled');
  assert.equal((await send('200.01')).status, 200);
  await stepUp(cust.c);
  const out2 = await cust.c.post('/api/pay/ach', { accountId: cust.acct.id, externalAccountId: cust.ext, direction: 'out', amount: '200.00', idempotencyKey: key() });
  assert.equal(out2.status, 200, JSON.stringify(out2.body));
});

test('R9, R34, R35: recording an incoming debit posts it at once; the company account number is only stored encrypted', async () => {
  at('2027-03-09');
  const cust = await person({ deposit: 10000n }), staff = await staffer();
  const net = await sysBal('mm_network');
  const r = await debit(staff, cust.acct.id, { companyName: '  Prairie Power & Light  ', companyAccountNumber: '0001-2345 6789' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const it = r.body.item;
  assert.equal(r.body.replayed, false);
  assert.deepEqual([it.direction, it.state, it.presentment, it.postedOn, it.finalOn, it.heldCents, it.customerId, it.amountCents, it.counterparty, it.rePresentment],
    ['incoming', 'posted', 1, '2027-03-09', '2027-03-16', 0, null, 4599, 'Prairie Power & Light ··6789', null]);
  assert.deepEqual(it.history.map(h => [h.action, h.actorId, h.detail]), [['ach_return.debit_recorded', staff.id, { item: it.id, amountCents: 4599, account: cust.acct.last4 }]]);
  assert.equal(await bal(cust.acct.id), 10000n - 4599n);
  assert.equal(await sysBal('mm_network'), net + 4599n);
  const lines = (await env.q(`SELECT l.account_id, l.amount_cents, l.description, l.category, l.posted_on, e.kind FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.id`, [`ach-returns:${it.id}:p1:post`])).rows;
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.posted_on, l.kind]), [
    [cust.acct.id, -4599n, 'ACH debit: Prairie Power & Light ··6789', 'Transfers', '2027-03-09', 'ach_debit_in'],
    [await systemAccount(env.pool, 'mm_network'), 4599n, 'ACH debit: Prairie Power & Light ··6789', null, '2027-03-09', 'ach_debit_in']]);
  const row = (await env.q('SELECT * FROM ach_incoming_debits WHERE id = $1', [it.id])).rows[0];
  assert.equal(row.company_name, 'Prairie Power & Light');
  assert.ok(!row.company_account_enc.includes(COMPANY_NUMBER));
  assert.equal(open(row.company_account_enc, it.id), COMPANY_NUMBER);
  assert.deepEqual(await avail(cust), { accountId: cust.acct.id, balanceCents: 5401, heldCents: 0, availableCents: 5401 });   // incoming items hold nothing
  assert.ok(!JSON.stringify(r.body).includes(COMPANY_NUMBER));
  assert.equal((await cust.c.get(`/api/ach-returns/items/${it.id}`)).body.item.direction, 'incoming');
});

test('R9: incoming debit checks, in order, and nothing is recorded on any error', async () => {
  at('2027-03-10');
  const cust = await person({ deposit: 10000n }), staff = await staffer();
  const card = await account(cust.id, { kind: 'credit_card' }), frozen = await account(cust.id, { deposit: 10000n });
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [frozen.id]);
  const items = () => count('SELECT count(*)::int n FROM ach_incoming_debits');
  const before = await items();
  const cases = [
    [{ idempotencyKey: 'short' }, 400, 'idempotency_key_required'],
    [{ accountId: 12 }, 400, 'bad_account'],
    [{ accountId: undefined, amountCents: 0 }, 400, 'bad_account'],
    [{ amountCents: 0 }, 400, 'bad_amount'],
    [{ amountCents: 12.5 }, 400, 'bad_amount'],
    [{ amountCents: '4599' }, 400, 'bad_amount'],
    [{ amountCents: 100_000_001 }, 400, 'bad_amount'],
    [{ companyName: ' A ' }, 400, 'bad_company'],
    [{ companyName: 'x'.repeat(81) }, 400, 'bad_company'],
    [{ companyAccountNumber: '123' }, 400, 'bad_account_number'],
    [{ companyAccountNumber: 123456789 }, 400, 'bad_account_number'],
    [{ companyAccountNumber: '1'.repeat(18) }, 400, 'bad_account_number'],
    [{ accountId: newId() }, 404, 'not_found'],
    [{ accountId: 'nope' }, 404, 'not_found'],
    [{ accountId: await systemAccount(env.pool, 'mm_network') }, 404, 'not_found'],
    [{ accountId: card.id }, 400, 'bad_account'],
    [{ accountId: frozen.id }, 409, 'account_not_open'],
    [{ amountCents: 10001 }, 409, 'insufficient_funds']
  ];
  for (const [body, status, error] of cases) {
    const r = await debit(staff, cust.acct.id, body);
    assert.equal(r.status, status, JSON.stringify(body)); assert.equal(r.body.error, error, JSON.stringify(body));
  }
  at('2027-03-13');                                                                       // Saturday
  assert.equal((await debit(staff, cust.acct.id)).body.error, 'not_business_day');
  at('2027-03-10');
  await pull(cust, 2000);                                                                 // held money is not available to a debit either
  assert.equal((await debit(staff, cust.acct.id, { amountCents: 10001 })).body.error, 'insufficient_funds');
  assert.equal(await items(), before);
  assert.equal(await bal(cust.acct.id), 12000n);
  const exact = await debit(staff, cust.acct.id, { amountCents: 10000 });                  // exactly the available money
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.deepEqual(await avail(cust), { accountId: cust.acct.id, balanceCents: 2000, heldCents: 2000, availableCents: 0 });
});

test('R10: an incoming debit request id replays, refuses a different request, is per staff member and safe under concurrency', async () => {
  at('2027-03-11');
  const cust = await person({ deposit: 50000n }), staff = await staffer(), staff2 = await staffer();
  const k = key(), body = { idempotencyKey: k, amountCents: 1000 };
  const all = await Promise.all(Array.from({ length: 6 }, () => debit(staff, cust.acct.id, body)));
  assert.ok(all.every(r => r.status === 200), JSON.stringify(all.map(r => r.body)));
  assert.equal(new Set(all.map(r => r.body.item.id)).size, 1);
  assert.equal(all.filter(r => !r.body.replayed).length, 1);
  const id = all[0].body.item.id;
  const audits = () => count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.debit_recorded' AND detail->>'item' = $1", [id]);
  assert.equal(await audits(), 1);
  const again = await signIn(env.base, staff.username, staff.password);                   // another session of the same staff member
  const replay = await debit({ c: again }, cust.acct.id, body);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.item.id, id);
  const diff = await debit(staff, cust.acct.id, { ...body, amountCents: 1001 });
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
  const theirs = await debit(staff2, cust.acct.id, body);                                // the same key string is staff2's own
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.item.id, id);
  assert.equal(await bal(cust.acct.id), 50000n - 2000n);
  assert.equal(await audits(), 1);
});

test('R11, R36: return request checks come in the documented order and change nothing', async () => {
  at('2027-03-15');
  const cust = await person(), staff = await staffer();
  const item = await pull(cust, 10000);
  const inc = (await debit(staff, cust.acct.id)).body.item.id;
  const before = [await bal(cust.acct.id), await count('SELECT count(*)::int n FROM ach_returns')];
  const cases = [
    [item, { idempotencyKey: undefined, presentment: 9 }, 400, 'idempotency_key_required'],
    [item, { presentment: 0 }, 400, 'bad_presentment'],
    [item, { presentment: '1' }, 400, 'bad_presentment'],
    [item, { presentment: 1.5, reasonCode: 'R99' }, 400, 'bad_presentment'],
    [item, { reasonCode: 'r01' }, 400, 'bad_reason_code'],
    [item, { reasonCode: 'R03', note: '' }, 400, 'bad_reason_code'],
    [item, { note: '  abc  ' }, 400, 'note_required'],
    [item, { note: 'x'.repeat(501) }, 400, 'note_required'],
    [item, { note: 42 }, 400, 'note_required'],
    [inc, { reasonCode: 'R01', presentment: 2 }, 422, 'reason_not_allowed'],
    [inc, { reasonCode: 'R02' }, 422, 'reason_not_allowed'],
    [item, { presentment: 2 }, 409, 'invalid_state'],
    [inc, { presentment: 2, reasonCode: 'R08' }, 409, 'invalid_state']
  ];
  for (const [id, body, status, error] of cases) {
    const r = await ret(staff, id, body);
    assert.equal(r.status, status, JSON.stringify(body)); assert.equal(r.body.error, error, JSON.stringify(body));
  }
  at('2027-03-20');                                                                       // Saturday: refused before the window check
  assert.equal((await ret(staff, item, { reasonCode: 'R10', presentment: 2 })).body.error, 'not_business_day');
  assert.deepEqual([await bal(cust.acct.id), await count('SELECT count(*)::int n FROM ach_returns')], before);
});

test('R12, R14, R15, R23, R35: returning an outgoing item reverses it, gives the limit back and charges the fee', async () => {
  at('2027-03-16');
  const cust = await person({ deposit: 10000n }), staff = await staffer();
  const item = await pull(cust, 50000);
  const used = await limitUse(cust);
  assert.equal(used.usedToday, '500.00');
  const a0 = await avail(cust), inSys = await sysBal('mm_ach_in'), fees = await sysBal('ach_return_fees');
  at('2027-03-17');
  const r = await ret(staff, item, { reasonCode: 'R01', note: '  Returned in today\'s ACH file  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.return;
  assert.deepEqual([x.itemId, x.presentment, x.reasonCode, x.reasonText, x.amountCents, x.feeCents, x.feeWaived, x.returnedOn, x.postedBy, x.note, x.feeWaivedBy, x.feeWaiverReason, x.feeWaiverEntryId],
    [item, 1, 'R01', 'Insufficient funds', 50000, 1250, false, '2027-03-17', staff.id, 'Returned in today\'s ACH file', null, null, null]);
  assert.equal(r.body.item.state, 'returned'); assert.equal(r.body.item.heldCents, 0); assert.equal(r.body.replayed, false);
  const lines = async k => (await env.q(`SELECT l.account_id, l.amount_cents, l.description, l.category, l.posted_on, e.kind, e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.id`, [k])).rows;
  const rev = await lines(`ach-returns:${item}:p1:return`);
  assert.equal(rev[0].id, x.entryId);
  assert.deepEqual(rev.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.posted_on, l.kind]), [
    [cust.acct.id, -50000n, 'ACH return R01: Other bank ··1234', 'Transfers', '2027-03-17', 'ach_return'],
    [await systemAccount(env.pool, 'mm_ach_in'), 50000n, 'ACH return R01: Other bank ··1234', null, '2027-03-17', 'ach_return']]);
  const fee = await lines(`ach-returns:${item}:p1:fee`);
  assert.equal(fee[0].id, x.feeEntryId);
  assert.deepEqual(fee.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.kind]), [
    [cust.acct.id, -1250n, 'Returned item fee (R01)', 'Fees & Charges', 'ach_return_fee'],
    [await systemAccount(env.pool, 'ach_return_fees'), 1250n, 'Returned item fee (R01)', null, 'ach_return_fee']]);
  assert.equal(await sysBal('mm_ach_in'), inSys + 50000n);
  assert.equal(await sysBal('ach_return_fees'), fees + 1250n);
  const t = (await env.q('SELECT * FROM transfers WHERE id = $1', [item])).rows[0];
  assert.deepEqual([t.status, t.return_code, t.reversal_entry_id, t.note], ['returned', 'R01', x.entryId, 'Returned: Insufficient funds (R01).']);
  const shown = (await cust.c.get('/api/pay')).body.activity.find(a => a.id === item);
  assert.equal(shown.status, 'returned'); assert.equal(shown.returnCode, 'R01');
  // R14: the limit comes back once, dated to the pull's day
  at('2027-03-16');
  assert.equal((await limitUse(cust)).usedToday, '0.00');
  assert.equal((await limitUse(cust)).usedMonth, toStr(BigInt(Math.round(Number(used.usedMonth) * 100)) - 50000n));
  assert.deepEqual((await env.q('SELECT amount_cents, booked_on, reason FROM limit_usage WHERE transfer_id = $1 ORDER BY id', [item])).rows,
    [{ amount_cents: 50000n, booked_on: '2027-03-16', reason: 'used' }, { amount_cents: -50000n, booked_on: '2027-03-16', reason: 'returned' }]);
  // R15: balance lower by amount + fee, held by the amount, available by the fee
  at('2027-03-17');
  const a1 = await avail(cust);
  assert.equal(a1.balanceCents, a0.balanceCents - 51250); assert.equal(a1.heldCents, a0.heldCents - 50000); assert.equal(a1.availableCents, a0.availableCents - 1250);
  // R34: customers see the return form only
  const mine = (await cust.c.get('/api/ach-returns')).body.returns[0];
  assert.deepEqual(Object.keys(mine).sort(), ['accountId', 'amountCents', 'counterparty', 'createdAt', 'direction', 'feeCents', 'feeWaived', 'id', 'itemId', 'presentment',
    'reasonCode', 'reasonText', 'returnedOn'].sort());
  const custItem = JSON.stringify((await cust.c.get(`/api/ach-returns/items/${item}`)).body);
  assert.ok(!custItem.includes(staff.id) && !custItem.includes('ACH file') && !custItem.includes('customerId') && !custItem.includes('history'));
  // R35: the audit event
  const ev = (await env.q("SELECT user_id, detail FROM audit_events WHERE action = 'ach_return.posted' AND detail->>'item' = $1", [item])).rows;
  assert.deepEqual(ev, [{ user_id: staff.id, detail: { item, return: x.id, presentment: 1, reasonCode: 'R01', amountCents: 50000, feeCents: 1250 } }]);
});

test('R13, R33: returning an incoming item puts the money back, with no fee, even on an account that is no longer open', async () => {
  at('2027-03-18');
  const cust = await person({ deposit: 10000n }), staff = await staffer();
  const it = (await debit(staff, cust.acct.id, { amountCents: 2500 })).body.item;
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cust.acct.id]);
  const limits = await limitUse(cust), net = await sysBal('mm_network');
  at('2027-03-25');                                                                       // R10: 5 business days, the deadline day itself
  const r = await ret(staff, it.id, { reasonCode: 'R10' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.return.feeCents, r.body.return.feeEntryId, r.body.item.state], [0, null, 'returned']);
  assert.equal(await bal(cust.acct.id), 10000n);
  assert.equal(await sysBal('mm_network'), net - 2500n);
  const lines = (await env.q(`SELECT l.account_id, l.amount_cents, l.description, l.category FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.id`, [`ach-returns:${it.id}:p1:return`])).rows;
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.description, l.category]), [
    [await systemAccount(env.pool, 'mm_network'), -2500n, 'ACH debit returned R10: Prairie Power & Light ··6789', null],
    [cust.acct.id, 2500n, 'ACH debit returned R10: Prairie Power & Light ··6789', 'Transfers']]);
  assert.deepEqual(await limitUse(cust), limits);
  const [note] = await alerts(cust);
  assert.equal(note.title, 'ACH debit returned');
  assert.ok(note.body.includes('$25.00') && note.body.includes('R10') && note.body.includes('Customer advises not authorized') && note.body.includes(`··${cust.acct.last4}`), note.body);
  assert.ok(!note.body.includes('fee of'));
});

test('R16, R17, R18: return windows count business days; the deadline day is on time; non-business days refuse', async () => {
  at('2027-01-14');                                                                       // Thursday; Monday Jan 18 is MLK Day
  const cust = await person(), staff = await staffer();
  const [a, b, c, d] = [await pull(cust, 1000), await pull(cust, 1100), await pull(cust, 1200), await pull(cust, 1300)];
  at('2027-01-18');
  assert.equal((await ret(staff, a)).body.error, 'not_business_day');
  at('2027-01-19');                                                                       // R01 deadline: Fri 15, Tue 19
  const ok = await ret(staff, a);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  at('2027-01-20');
  const late = await ret(staff, b, { reasonCode: 'R02' });
  assert.equal(late.status, 422); assert.equal(late.body.error, 'return_window_closed');
  assert.equal((await cust.c.get(`/api/ach-returns/items/${b}`)).body.item.state, 'posted');
  assert.equal((await ret(staff, c, { reasonCode: 'R08' })).status, 200);                 // R08: 3 business days, Jan 20
  at('2027-01-21');
  assert.equal((await ret(staff, d, { reasonCode: 'R08' })).body.error, 'return_window_closed');
  const refusals = (await env.q("SELECT detail FROM audit_events WHERE action = 'ach_return.late_refused' AND detail->>'item' = ANY($1) ORDER BY id", [[b, d]])).rows.map(r => r.detail);
  assert.deepEqual(refusals, [{ item: b, presentment: 1, reasonCode: 'R02', deadline: '2027-01-19' }, { item: d, presentment: 1, reasonCode: 'R08', deadline: '2027-01-20' }]);
  at('2027-01-22');
  assert.equal((await ret(staff, d, { reasonCode: 'R10' })).status, 200);                 // R10: 5 business days, Jan 22
});

test('R19, R20, R21: one return per presentment, request ids per staff member, and exactly one winner at once', async () => {
  at('2027-04-01');
  const cust = await person({ deposit: 20000n }), staff = await staffer(), staff2 = await staffer(), staff3 = await staffer();
  const item = await pull(cust, 40000);
  const k = key(), body = { idempotencyKey: k, reasonCode: 'R02', note: 'Account closed per file' };
  const first = await ret(staff, item, body);
  assert.equal(first.status, 200);
  at('2027-04-05');                                                                       // a later day, another session
  const again = await signIn(env.base, staff.username, staff.password);
  const replay = await ret({ c: again }, item, body);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.return, first.body.return);
  assert.equal((await ret(staff, item, { ...body, note: 'Something else here' })).body.error, 'idempotency_conflict');
  const theirs = await ret(staff2, item, body);
  assert.equal(theirs.status, 409); assert.equal(theirs.body.error, 'already_returned');
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.posted' AND detail->>'item' = $1", [item]), 1);
  assert.equal(await count('SELECT count(*)::int n FROM notifications WHERE ref = $1', [`ach-return:${first.body.return.id}`]), 1);

  // a refused request does not use up its key
  at('2027-04-06');
  const item2 = await pull(cust, 30000);
  const k2 = key();
  assert.equal((await ret(staff, item2, { idempotencyKey: k2, note: 'abc' })).body.error, 'note_required');
  assert.equal((await ret(staff, item2, { idempotencyKey: k2 })).status, 200);

  // many returns at the same moment, from different staff, keys and codes
  const item3 = await pull(cust, 25000);
  const fees0 = await sysBal('ach_return_fees');
  const codes = ['R01', 'R02', 'R08', 'R10', 'R01', 'R02', 'R08', 'R10'];
  const all = await Promise.all(codes.map((code, i) => ret([staff, staff2, staff3][i % 3], item3, { reasonCode: code })));
  assert.equal(all.filter(r => r.status === 200).length, 1, JSON.stringify(all.map(r => r.body)));
  assert.ok(all.filter(r => r.status !== 200).every(r => r.status === 409 && r.body.error === 'already_returned'));
  const win = all.find(r => r.status === 200).body.return;
  assert.equal(await count("SELECT count(*)::int n FROM journal_entries WHERE idempotency_key LIKE $1", [`ach-returns:${item3}:%`]), win.feeCents ? 2 : 1);
  assert.equal(await sysBal('ach_return_fees'), fees0 + BigInt(win.feeCents));
  assert.equal(await count("SELECT count(*)::int n FROM limit_usage WHERE transfer_id = $1 AND amount_cents < 0", [item3]), 1);
  assert.equal(await count("SELECT count(*)::int n FROM notifications WHERE ref LIKE 'ach-return:%' AND ref = $1", [`ach-return:${win.id}`]), 1);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.posted' AND detail->>'item' = $1", [item3]), 1);
});

test('R22: a return the account can no longer cover is refused until it is funded', async () => {
  at('2027-04-07');
  const cust = await person({ deposit: 0n }), staff = await staffer();
  const item = await pull(cust, 30000);
  // the money left another way (a card settlement, outside /api/pay)
  await tx(env.pool, async c => post(c, { key: `test:drain:${item}`, kind: 'seed', lines: [
    { accountId: cust.acct.id, amountCents: -20000n, description: 'Card purchase', category: 'Shopping' },
    { accountId: await systemAccount(c, 'card_settlement'), amountCents: 20000n, description: 'Card purchase' }] }));
  const r = await ret(staff, item);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'insufficient_funds');
  assert.equal((await cust.c.get(`/api/ach-returns/items/${item}`)).body.item.state, 'posted');
  assert.equal(await count('SELECT count(*)::int n FROM ach_returns WHERE item_id = $1', [item]), 0);
  await fund(cust.acct.id, 25000n);
  const ok = await ret(staff, item);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await bal(cust.acct.id), 35000n - 30000n - BigInt(ok.body.return.feeCents));
});

test('R24, R28: the daily fee cap is per customer and per day, and a refunded fee frees room under it', async () => {
  at('2027-04-12');
  const cust = await person({ deposit: 100000n }), other = await person(), staff = await staffer();
  const shared = await account(cust.id, { deposit: 50000n });
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')", [shared.id, other.id]);
  const items = [];
  for (let i = 0; i < 4; i++) items.push(await pull(cust, 150000));
  const theirs = await pull(other, 150000, shared.id);
  const [a, b, c, d] = items;
  const ra = await ret(staff, a), rb = await ret(staff, b, { reasonCode: 'R02' });
  assert.deepEqual([ra.body.return.feeCents, rb.body.return.feeCents], [3500, 3500]);
  const rc = await ret(staff, c);
  assert.equal(rc.body.return.feeCents, 0); assert.equal(rc.body.return.feeEntryId, null);
  assert.equal(await count('SELECT count(*)::int n FROM journal_entries WHERE idempotency_key = $1', [`ach-returns:${c}:p1:fee`]), 0);
  assert.ok(!(await alerts(cust)).find(x => x.body.includes('$1,500.00') && x.body.includes('fee of $0.00')));
  const rt = await ret(staff, theirs);                                                    // another customer's pull on a shared account: their own cap
  assert.equal(rt.body.return.feeCents, 3500);
  // a refund frees room under the cap of that day
  const w = await staff.c.post(`/api/ach-ops/returns/${ra.body.return.id}/waive-fee`, { reason: '  First return, goodwill  ' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.deepEqual([w.body.return.feeWaived, w.body.return.feeWaivedBy, w.body.return.feeWaiverReason, w.body.replayed], [true, staff.id, 'First return, goodwill', false]);
  const refund = (await env.q(`SELECT l.account_id, l.amount_cents, l.description, l.category, e.kind, e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.id`, [`ach-returns:${a}:p1:fee-waiver`])).rows;
  assert.equal(refund[0].id, w.body.return.feeWaiverEntryId);
  assert.deepEqual(refund.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.kind]), [
    [await systemAccount(env.pool, 'ach_return_fees'), -3500n, 'Returned item fee refunded (R01)', null, 'ach_return_fee_waiver'],
    [cust.acct.id, 3500n, 'Returned item fee refunded (R01)', 'Fees & Charges', 'ach_return_fee_waiver']]);
  const notes = (await alerts(cust)).filter(x => x.title === 'Returned item fee refunded');
  assert.equal(notes.length, 1); assert.ok(notes[0].body.includes('$35.00'));
  assert.equal((await alerts(other)).filter(x => x.title === 'Returned item fee refunded').length, 0);   // not an owner of that account
  assert.equal((await cust.c.get(`/api/ach-returns/items/${a}`)).body.item.returns[0].feeWaived, true);
  const rd = await ret(staff, d);
  assert.equal(rd.body.return.feeCents, 3500);
  // the next day starts again at 0
  const e = await pull(cust, 150000);
  at('2027-04-13');
  assert.equal((await ret(staff, e)).body.return.feeCents, 3500);
  // R28: refunding again is a replay; a return with no fee is refused; checks come in order
  const again = await staff.c.post(`/api/ach-ops/returns/${ra.body.return.id}/waive-fee`, { reason: 'Second try at it' });
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.equal(again.body.return.feeWaiverReason, 'First return, goodwill');
  assert.equal((await staff.c.post(`/api/ach-ops/returns/${ra.body.return.id}/waive-fee`, { reason: 'abc' })).body.error, 'reason_required');
  assert.equal((await staff.c.post(`/api/ach-ops/returns/${rc.body.return.id}/waive-fee`, { reason: 'Goodwill refund' })).body.error, 'no_fee');
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.fee_waived' AND detail->>'return' = $1", [ra.body.return.id]), 1);
  const ev = (await env.q("SELECT detail FROM audit_events WHERE action = 'ach_return.fee_waived' AND detail->>'return' = $1", [ra.body.return.id])).rows[0].detail;
  assert.deepEqual(ev, { item: a, return: ra.body.return.id, feeCents: 3500, reason: 'First return, goodwill' });
  // customers never see who refunded it or why
  const custView = JSON.stringify((await cust.c.get('/api/ach-returns')).body);
  assert.ok(!custView.includes('goodwill') && !custView.includes(staff.id));
});

test('R25, R26: the fee never exceeds the available money, and concurrent returns never pass the cap', async () => {
  at('2027-04-14');
  const cust = await person({ deposit: 300n }), staff = await staffer();
  const a = await pull(cust, 10000), b = await pull(cust, 5000);
  const ra = await ret(staff, a);                                                         // after the reversal: 5,300 balance, 5,000 held by b
  assert.equal(ra.body.return.feeCents, 300);
  assert.deepEqual(await avail(cust), { accountId: cust.acct.id, balanceCents: 5000, heldCents: 5000, availableCents: 0 });
  const rb = await ret(staff, b);
  assert.equal(rb.body.return.feeCents, 0);                                               // nothing left at all
  assert.equal(await bal(cust.acct.id), 0n);

  const rich = await person({ deposit: 500000n });
  const items = [];
  for (let i = 0; i < 5; i++) items.push(await pull(rich, 140000));
  const all = await Promise.all(items.map(id => ret(staff, id)));
  assert.ok(all.every(r => r.status === 200), JSON.stringify(all.map(r => r.body)));
  const fees = all.map(r => r.body.return.feeCents);
  assert.equal(fees.reduce((x, y) => x + y, 0), 7000);
  assert.deepEqual([...fees].sort((x, y) => x - y), [0, 0, 0, 3500, 3500]);
  for (const r of all) {
    const posted = (await env.q(`SELECT coalesce(sum(-l.amount_cents), 0)::bigint s FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
       WHERE e.idempotency_key = $1 AND l.account_id = $2`, [`ach-returns:${r.body.return.itemId}:p1:fee`, rich.acct.id])).rows[0].s;
    assert.equal(posted, BigInt(r.body.return.feeCents));
  }
});

test('R27, R29, R30, R31: an R01 return is presented again once, in its window, and can be returned again', async () => {
  at('2027-05-03');                                                                       // Monday
  const cust = await person({ deposit: 10000n }), staff = await staffer();
  const item = await pull(cust, 20000), r08 = await pull(cust, 3000), open0 = await pull(cust, 4000);
  const inc = (await debit(staff, cust.acct.id, { amountCents: 1000 })).body.item.id;
  at('2027-05-04');
  const ret1 = await ret(staff, item);
  assert.equal(ret1.status, 200);
  await ret(staff, r08, { reasonCode: 'R08' });
  await ret(staff, inc, { reasonCode: 'R08' });
  const rep = id => staff.c.post(`/api/ach-ops/items/${id}/represent`, {});
  for (const id of [r08, open0, inc]) assert.equal((await rep(id)).body.error, 'not_representable');
  at('2027-05-05');
  assert.equal((await rep(item)).body.error, 'too_early');                                // from May 6 (2 business days after May 4)
  at('2027-05-08');
  assert.equal((await rep(item)).body.error, 'not_business_day');
  at('2027-05-06');
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cust.acct.id]);
  assert.equal((await rep(item)).body.error, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cust.acct.id]);
  const b0 = await bal(cust.acct.id), lim0 = await limitUse(cust);
  // many at once: credited exactly once
  const all = await Promise.all(Array.from({ length: 5 }, () => rep(item)));
  assert.ok(all.every(r => r.status === 200), JSON.stringify(all.map(r => r.body)));
  assert.equal(all.filter(r => r.body.replayed === false).length, 1);
  const it = all[0].body.item;
  assert.deepEqual([it.presentment, it.state, it.postedOn, it.finalOn, it.heldCents, it.rePresentment.presentedOn], [2, 're_presented', '2027-05-06', '2027-05-13', 20000, '2027-05-06']);
  const p2 = it.rePresentment.transferId;
  assert.equal(await bal(cust.acct.id), b0 + 20000n);
  const t = (await env.q('SELECT * FROM transfers WHERE id = $1', [p2])).rows[0];
  const orig = (await env.q('SELECT * FROM transfers WHERE id = $1', [item])).rows[0];
  assert.deepEqual([t.rail, t.direction, t.status, t.user_id, t.to_account_id, t.external_account_id, t.counterparty, t.amount_cents, t.memo, t.process_on, t.settles_on, t.booked_on, t.idempotency_key],
    ['ach', 'in', 'settled', orig.user_id, orig.to_account_id, orig.external_account_id, orig.counterparty, orig.amount_cents, orig.memo, '2027-05-06', '2027-05-06', '2027-05-06', `ach-returns:${item}:p2`]);
  const lines = (await env.q(`SELECT l.account_id, l.amount_cents, l.description, l.category, e.kind, e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.idempotency_key = $1 ORDER BY l.id`, [`ach-returns:${item}:p2:post`])).rows;
  assert.equal(lines[0].id, t.entry_id);
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.description, l.category, l.kind]), [
    [await systemAccount(env.pool, 'mm_ach_in'), -20000n, 'ACH in: Other bank ··1234 (presented again)', null, 'ach_in'],
    [cust.acct.id, 20000n, 'ACH transfer from Other bank ··1234 (presented again)', 'Transfers', 'ach_in']]);
  assert.equal(await count('SELECT count(*)::int n FROM transfers WHERE idempotency_key = $1', [`ach-returns:${item}:p2`]), 1);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.represented' AND detail->>'item' = $1", [item]), 1);
  assert.equal((await limitUse(cust)).usedToday, toStr(BigInt(Math.round(Number(lim0.usedToday) * 100)) + 20000n));
  assert.equal((await avail(cust)).heldCents, 20000 + 4000);                             // presentment 2, and open0 (still within its final date)
  // the re-presentment transfer is not an item; presentment 1 can't be returned again
  assert.equal((await staff.c.get(`/api/ach-ops/items/${p2}`)).status, 404);
  assert.equal((await cust.c.get(`/api/ach-returns/items/${p2}`)).status, 404);
  assert.equal((await ret(staff, item, { presentment: 1, reasonCode: 'R10' })).body.error, 'already_returned');
  // R31: presentment 2 is returned on its own deadlines, with its own reversal, fee and limit release
  at('2027-05-10');                                                                       // R01 deadline for May 6: May 10
  const ret2 = await ret(staff, item, { presentment: 2, reasonCode: 'R01' });
  assert.equal(ret2.status, 200, JSON.stringify(ret2.body));
  assert.equal(ret2.body.return.presentment, 2); assert.equal(ret2.body.return.feeCents, 500);
  assert.equal(ret2.body.item.state, 'returned'); assert.equal(ret2.body.item.returns.length, 2);
  const t2 = (await env.q('SELECT status, return_code, reversal_entry_id FROM transfers WHERE id = $1', [p2])).rows[0];
  assert.deepEqual([t2.status, t2.return_code, t2.reversal_entry_id], ['returned', 'R01', ret2.body.return.entryId]);
  assert.deepEqual((await env.q('SELECT amount_cents, booked_on FROM limit_usage WHERE transfer_id = $1 ORDER BY id', [p2])).rows,
    [{ amount_cents: 20000n, booked_on: '2027-05-06' }, { amount_cents: -20000n, booked_on: '2027-05-06' }]);
  const third = await rep(item);
  assert.equal(third.status, 200); assert.equal(third.body.replayed, true);
  assert.equal(await count('SELECT count(*)::int n FROM transfers WHERE idempotency_key LIKE $1', [`ach-returns:${item}:%`]), 1);
  const hist = (await staff.c.get(`/api/ach-ops/items/${item}`)).body.item.history.map(h => h.action);
  assert.deepEqual(hist, ['ach_return.posted', 'ach_return.represented', 'ach_return.posted']);
  // too late: more than 10 business days after the return
  const late = await pull(cust, 2000);
  at('2027-05-11');
  await ret(staff, late);
  at('2027-05-26');                                                                       // May 25 is the 10th business day after May 11
  assert.equal((await rep(late)).body.error, 'too_late');
  at('2027-05-25');
  assert.equal((await rep(late)).status, 200);
});

test('R31: presentment 2 not returned by its final date settles', async () => {
  at('2027-06-01');
  const cust = await person(), staff = await staffer();
  const item = await pull(cust, 6000);
  await ret(staff, item);
  at('2027-06-03');
  assert.equal((await staff.c.post(`/api/ach-ops/items/${item}/represent`, {})).status, 200);
  at('2027-06-10');
  assert.equal((await cust.c.get(`/api/ach-returns/items/${item}`)).body.item.state, 're_presented');
  at('2027-06-11');
  const it = (await cust.c.get(`/api/ach-returns/items/${item}`)).body.item;
  assert.deepEqual([it.state, it.heldCents], ['settled', 0]);
  assert.equal((await ret(staff, item, { presentment: 2, reasonCode: 'R10' })).body.error, 'return_window_closed');
});

test('R32: simultaneous fee refunds of one return refund once', async () => {
  at('2027-06-14');
  const cust = await person(), staff = await staffer(), staff2 = await staffer();
  const item = await pull(cust, 80000);
  const r = (await ret(staff, item)).body.return;
  assert.equal(r.feeCents, 2000);
  const b0 = await bal(cust.acct.id);
  const all = await Promise.all(Array.from({ length: 6 }, (_, i) => [staff, staff2][i % 2].c.post(`/api/ach-ops/returns/${r.id}/waive-fee`, { reason: 'Customer called in' })));
  assert.ok(all.every(x => x.status === 200), JSON.stringify(all.map(x => x.body)));
  assert.equal(all.filter(x => !x.body.replayed).length, 1);
  assert.equal(await bal(cust.acct.id), b0 + 2000n);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action = 'ach_return.fee_waived' AND detail->>'return' = $1", [r.id]), 1);
  assert.equal(await count('SELECT count(*)::int n FROM notifications WHERE ref = $1', [`ach-fee-waiver:${r.id}`]), 1);
});

test('R34, R37: the books balance, entries sum to zero, and no full account number is stored or shown anywhere', async () => {
  const off = (await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY account_id) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`)).rows;
  assert.deepEqual(off, []);
  const unbalanced = (await env.q(`SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.idempotency_key LIKE 'ach-returns:%'
     GROUP BY e.id HAVING sum(l.amount_cents) <> 0`)).rows;
  assert.deepEqual(unbalanced, []);
  // only the item's account and the named system accounts are touched by this feature's entries
  const touched = (await env.q(`SELECT DISTINCT a.system_code FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.idempotency_key LIKE 'ach-returns:%' AND a.kind = 'system' ORDER BY 1`)).rows.map(r => r.system_code);
  assert.ok(touched.every(c => ['ach_return_fees', 'mm_ach_in', 'mm_network'].includes(c)), touched.join());
  const texts = [
    ...(await env.q('SELECT detail::text t FROM audit_events')).rows,
    ...(await env.q('SELECT title || body t FROM notifications')).rows,
    ...(await env.q('SELECT description t FROM ledger_lines')).rows,
    ...(await env.q('SELECT row_to_json(t)::text t FROM transfers t')).rows,
    ...(await env.q('SELECT row_to_json(r)::text t FROM ach_returns r')).rows
  ].map(r => r.t ?? '');
  for (const num of [EXT_NUMBER, COMPANY_NUMBER, '0001-2345 6789']) assert.ok(!texts.some(t => t.includes(num)), num);
});
