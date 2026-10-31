import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('hex');      // test-only key, made fresh for each run
const { testEnv, signIn, client } = await import('../helpers.mjs');
const { clock } = await import('../../lib/bank-date.mjs');
const { tx } = await import('../../lib/db.mjs');
const { hashPassword, newId } = await import('../../lib/auth.mjs');
const { post } = await import('../../lib/ledger.mjs');
const { issueCard } = await import('../../lib/cards.mjs');

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const at = iso => { clock.now = () => new Date(iso); };
const DAY = '2026-11-10T16:00:00Z';                                      // a Tuesday, 10:00 am CT: before every cut-off

let n = 0; const key = () => `odp-${Date.now()}-${++n}`;
const SYS = { line: '00000000-0000-4000-8000-000000000060', fees: '00000000-0000-4000-8000-000000000061' };
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const q1 = async (sql, args) => (await env.q(sql, args)).rows[0];

// ---------- test customers, made directly in the database ----------
async function user(tag) {
  const id = newId(), username = `odp-${tag.toLowerCase()}-${randomBytes(4).toString("hex")}@usabanc.example`, password = `pw-${tag}-demo`;
  await env.q('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
    [id, username, tag, await hashPassword(password), '42']);
  return { id, login: [username, password] };
}
async function account(kind, name, owners, cents = 0n, status = 'open') {
  const id = newId(), last4 = String(1000 + Math.floor(Math.random() * 9000));
  await env.q('INSERT INTO accounts (id, kind, name, number_last4, status) VALUES ($1,$2,$3,$4,$5)', [id, kind, name, last4, status]);
  for (const [u, role] of owners) await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, u.id, role]);
  if (cents) await fund(id, cents);
  return { id, name, last4, label: `${name} ··${last4}` };
}
const fund = (id, cents) => tx(env.pool, c => post(c, { key: `test-fund:${newId()}`, kind: 'seed', lines: [
  { accountId: '00000000-0000-4000-8000-000000000001', amountCents: -cents, description: 'Test funding' },
  { accountId: id, amountCents: cents, description: 'Test deposit', category: 'Transfers' }] }));
const card = async (acct, holder) => (await tx(env.pool, c => issueCard(c, { accountId: acct.id, holderId: holder.id, type: 'debit' }))).id;
async function stepped(u) {
  const c = await signIn(env.base, ...u.login);
  const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
  return c;
}
/** A customer with checking, savings and a debit card, signed in with a recent step-up; `link` protects the checking account. */
async function setup({ checking = 5000n, savings = 100000n, limit, link = true } = {}) {
  const u = await user('Pat');
  const chk = await account('checking', 'Smart Checking', [[u, 'owner']], checking);
  const sav = await account('savings', 'Bright Savings', [[u, 'owner']], savings);
  const cardId = await card(chk, u);
  const c = await stepped(u);
  let protection = null;
  if (link) {
    const r = await c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id, courtesyLimitCents: limit });
    assert.equal(r.status, 200, JSON.stringify(r.body)); protection = r.body.protection;
  }
  return { u, c, chk, sav, cardId, protection };
}
const buy = (c, cardId, amount, extra = {}) => c.post(`/api/cards/card/${cardId}/purchases`, { idempotencyKey: key(), merchant: 'Corner Market', amount, ...extra });
const xfer = (c, from, to, amount, extra = {}) => c.post('/api/pay/transfers', { idempotencyKey: key(), fromAccountId: from.id, toAccountId: to.id, amount, ...extra });
const detail = async (c, acct) => (await c.get(`/api/overdraft-protection/${acct.id}`)).body;
const lines = async entryId => (await env.q('SELECT account_id, amount_cents, description, category, posted_on FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [entryId])).rows
  .map(l => [l.account_id, l.amount_cents, l.description, l.category, l.posted_on]);
const audits = async (action, accountId) => (await env.q(`SELECT user_id, detail FROM audit_events WHERE action = $1 AND detail->>'account' = $2 ORDER BY id`, [action, accountId])).rows;
const notes = async (userId) => (await env.q(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'overdraft_protection' ORDER BY id`, [userId])).rows;

/** R33: every entry balances, every balance is the sum of its lines, and each protection's figures match its events. */
async function integrity() {
  assert.equal((await env.q('SELECT entry_id FROM ledger_lines GROUP BY entry_id HAVING sum(amount_cents) <> 0')).rowCount, 0);
  assert.equal((await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY account_id) l ON l.account_id = a.id
    WHERE a.balance_cents <> coalesce(l.s, 0)`)).rowCount, 0);
  assert.equal((await env.q(`SELECT p.account_id FROM overdraft_protections p, LATERAL (SELECT
      coalesce(sum(amount_cents) FILTER (WHERE type = 'line_draw'), 0) - coalesce(sum(principal_repaid_cents), 0) used,
      coalesce(sum(fee_cents) FILTER (WHERE type = 'line_draw'), 0) - coalesce(sum(fees_repaid_cents), 0) owed
      FROM overdraft_protection_events e WHERE e.account_id = p.account_id) x WHERE x.used <> p.line_used_cents OR x.owed <> p.fees_owed_cents`)).rowCount, 0);
  const line = await q1(`SELECT coalesce(sum(l.amount_cents), 0)::bigint s FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id
    WHERE l.account_id = $1 AND j.kind NOT IN ('od_line_draw', 'od_repayment')`, [SYS.line]);
  assert.equal(line.s, 0n);                                               // only this feature moves the courtesy line account
  const ev = await q1(`SELECT coalesce(sum(amount_cents + fee_cents) FILTER (WHERE type = 'line_draw'), 0)::bigint draws,
    coalesce(sum(amount_cents) FILTER (WHERE type = 'repayment'), 0)::bigint repaid, coalesce(sum(fee_cents), 0)::bigint fees FROM overdraft_protection_events`);
  assert.equal(await bal(SYS.line), ev.repaid - ev.draws);
  assert.equal(await bal(SYS.fees), ev.fees);
}

// ---------- access ----------
test('R1: every endpoint needs a signed-in user', async () => {
  const c = client(env.base), id = newId();
  for (const [m, p] of [['POST', '/api/overdraft-protection'], ['GET', '/api/overdraft-protection'], ['GET', `/api/overdraft-protection/${id}`],
    ['PUT', `/api/overdraft-protection/${id}/line`], ['DELETE', `/api/overdraft-protection/${id}`], ['POST', `/api/overdraft-protection/${id}/repay`]]) {
    const r = await c.call(m, p, { idempotencyKey: key() });
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out');
  }
});

test('R3, R5, R34: linking creates the protection with its figures, moves no money and is audited', async () => {
  at(DAY);
  const u = await user('Lee');
  const chk = await account('checking', 'Smart Checking', [[u, 'owner']], 5000n);
  const mm = await account('money_market', 'Money Market', [[u, 'owner']], 20000n);
  const c = await stepped(u);
  const entries = (await q1('SELECT count(*)::int n FROM journal_entries')).n;
  const r = await c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: mm.id, courtesyLimitCents: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  const p = r.body.protection;
  assert.deepEqual({ ...p, createdAt: undefined }, { accountId: chk.id, backupAccountId: mm.id, courtesyLimitCents: 0, lineUsedCents: 0, feesOwedCents: 0,
    lineAvailableCents: 0, transfersThisMonth: 0, freeTransfersLeft: 3, backupWithdrawalsThisMonth: 0, lineFeesToday: 0, lineFeesThisMonthCents: 0,
    linkedBy: u.id, createdAt: undefined });
  assert.equal(p.createdAt, new Date(DAY).toISOString());
  assert.equal((await q1('SELECT count(*)::int n FROM journal_entries')).n, entries);
  assert.equal(await bal(chk.id), 5000n); assert.equal(await bal(mm.id), 20000n);
  assert.deepEqual((await c.get('/api/overdraft-protection')).body.protections, [p]);
  assert.deepEqual(await detail(c, chk), { protection: p, events: [] });
  assert.deepEqual((await audits('overdraft_protection.link', chk.id)).map(a => [a.user_id, a.detail]), [[u.id, { account: chk.id, backup: mm.id, courtesyLimitCents: 0 }]]);
});

test('R4-R8, R11: link validation, in the order of checks, creates nothing', async () => {
  const u = await user('Val'), other = await user('Other');
  const chk = await account('checking', 'Smart Checking', [[u, 'owner']], 1000n);
  const sav = await account('savings', 'Bright Savings', [[u, 'owner']], 1000n);
  const closedChk = await account('checking', 'Old Checking', [[u, 'owner']], 0n, 'closed');
  const closedSav = await account('savings', 'Old Savings', [[u, 'owner']], 0n, 'closed');
  const teen = await account('teen_checking', 'Teen Checking', [[u, 'owner']]);
  const theirs = await account('checking', 'Smart Checking', [[other, 'owner']]);
  const viewed = await account('savings', 'Viewed Savings', [[other, 'owner'], [u, 'viewer']]);
  const custodial = await account('checking', 'Kid Checking', [[other, 'owner'], [u, 'custodian']]);
  const shared = await account('savings', 'Shared Savings', [[u, 'owner'], [other, 'joint_owner']]);
  const plain = await signIn(env.base, ...u.login), c = await stepped(u);
  const link = (b, cl = c) => cl.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id, ...b });
  const cases = [
    [{ idempotencyKey: undefined }, 400, 'idempotency_key_required'],
    [{ idempotencyKey: 'short' }, 400, 'idempotency_key_required'],
    [{ accountId: undefined, courtesyLimitCents: 'x' }, 400, 'bad_account'],
    [{ accountId: 12, backupAccountId: undefined }, 400, 'bad_account'],
    [{ backupAccountId: null }, 400, 'bad_account'],
    [{ backupAccountId: ['x'] }, 400, 'bad_account'],
    ...['1000', 1000.5, -1000, 101000, 1500, true, 100001].map(v => [{ courtesyLimitCents: v, accountId: theirs.id }, 400, 'bad_limit']),
    [{ accountId: theirs.id, backupAccountId: 'nope' }, 404, 'not_found'],
    [{ accountId: 'not-a-uuid' }, 404, 'not_found'],
    [{ accountId: newId() }, 404, 'not_found'],
    [{ accountId: custodial.id }, 404, 'not_found'],
    [{ accountId: sav.id, backupAccountId: newId() }, 400, 'bad_account'],
    [{ accountId: teen.id }, 400, 'bad_account'],
    [{ accountId: closedChk.id, backupAccountId: chk.id }, 409, 'account_not_open'],
    [{ backupAccountId: viewed.id }, 404, 'not_found'],
    [{ backupAccountId: newId() }, 404, 'not_found'],
    [{ backupAccountId: closedChk.id }, 400, 'bad_account'],
    [{ backupAccountId: closedSav.id }, 409, 'account_not_open'],
    [{ backupAccountId: shared.id, courtesyLimitCents: 100000 }, 422, 'backup_not_shared']
  ];
  for (const [b, status, error] of cases) {
    const r = await link(b);
    assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.error, error, JSON.stringify(b)); assert.ok(r.body.message);
  }
  const s = await link({}, plain);
  assert.equal(s.status, 403); assert.equal(s.body.error, 'stepup_required');
  assert.equal((await q1('SELECT count(*)::int n FROM overdraft_protections WHERE account_id = ANY($1)', [[chk.id, sav.id, closedChk.id, teen.id]])).n, 0);
  const ok = await link({ courtesyLimitCents: 100000 });
  assert.equal(ok.status, 200); assert.equal(ok.body.protection.courtesyLimitCents, 100000);
  const again = await link({ backupAccountId: sav.id });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_linked');
  // R5: one backup account may back several checking accounts
  const chk2 = await account('checking', 'Second Checking', [[u, 'owner']]);
  assert.equal((await link({ accountId: chk2.id })).status, 200);
});

test('R6: every owner of the backup account must own the checking account; the checking account may have more owners', async () => {
  const a = await user('Ana'), b = await user('Ben');
  const joint = await account('checking', 'Joint Checking', [[a, 'owner'], [b, 'joint_owner']]);
  const solo = await account('savings', 'Ana Savings', [[a, 'owner']]);
  const both = await account('savings', 'Both Savings', [[a, 'owner'], [b, 'joint_owner']]);
  const kid = await account('checking', 'Ana Checking', [[a, 'owner'], [b, 'custodian']]);
  const c = await stepped(a);
  const r1 = await c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: kid.id, backupAccountId: both.id });
  assert.equal(r1.status, 422); assert.equal(r1.body.error, 'backup_not_shared');      // Ben is only custodian on the checking account
  assert.equal((await c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: joint.id, backupAccountId: solo.id })).status, 200);
});

test('R9: a request id replays the first result across sessions, conflicts with another request, and belongs to its user', async () => {
  const s = await setup({ link: false });
  const k = key(), body = { idempotencyKey: k, accountId: s.chk.id, backupAccountId: s.sav.id, courtesyLimitCents: 20000 };
  const first = await s.c.post('/api/overdraft-protection', body);
  assert.equal(first.status, 200);
  const other = await signIn(env.base, ...s.u.login);                     // another session, no step-up: a replay doesn't need one
  const again = await other.post('/api/overdraft-protection', body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.protection, first.body.protection);
  const diff = await other.post('/api/overdraft-protection', { ...body, courtesyLimitCents: 30000 });
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
  assert.equal((await audits('overdraft_protection.link', s.chk.id)).length, 1);
  // another user with the same key string gets their own result
  const t = await setup({ link: false });
  const theirs = await t.c.post('/api/overdraft-protection', { idempotencyKey: k, accountId: t.chk.id, backupAccountId: t.sav.id });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.equal(theirs.body.protection.accountId, t.chk.id);
  // after an unlink the replay shows protection: null
  assert.equal((await s.c.del(`/api/overdraft-protection/${s.chk.id}`)).status, 200);
  const gone = await other.post('/api/overdraft-protection', body);
  assert.equal(gone.status, 200); assert.equal(gone.body.protection, null); assert.equal(gone.body.replayed, true);
  // simultaneous identical requests: one link, every response 200
  const u = await setup({ link: false });
  const same = { idempotencyKey: key(), accountId: u.chk.id, backupAccountId: u.sav.id };
  const rs = await Promise.all([1, 2, 3, 4].map(() => u.c.post('/api/overdraft-protection', same)));
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200]);
  assert.equal(rs.filter(r => !r.body.replayed).length, 1);
  assert.equal((await audits('overdraft_protection.link', u.chk.id)).length, 1);
});

test('R10: two owners linking one checking account at the same moment: one link, one already_linked', async () => {
  const a = await user('Cy'), b = await user('Dee');
  const chk = await account('checking', 'Joint Checking', [[a, 'owner'], [b, 'joint_owner']]);
  const sav = await account('savings', 'Joint Savings', [[a, 'owner'], [b, 'joint_owner']]);
  const [ca, cb] = [await stepped(a), await stepped(b)];
  const rs = await Promise.all([ca, cb].map(c => c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(rs.find(r => r.status === 409).body.error, 'already_linked');
});

test('R2: owners and joint owners manage it, whoever linked it; others get 404 and the list shows only their own', async () => {
  const a = await user('Eve'), b = await user('Fin'), v = await user('Gus'), x = await user('Hal');
  const chk = await account('checking', 'Joint Checking', [[a, 'owner'], [b, 'joint_owner'], [v, 'viewer'], [x, 'custodian']], 1000n);
  const sav = await account('savings', 'Joint Savings', [[a, 'owner'], [b, 'joint_owner']], 1000n);
  const mine = await account('checking', 'Own Checking', [[a, 'owner']]);
  const ca = await stepped(a), cb = await stepped(b), cv = await stepped(v), cx = await stepped(x);
  assert.equal((await ca.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id, courtesyLimitCents: 5000 })).status, 200);
  for (const cl of [cv, cx]) {
    assert.deepEqual((await cl.get('/api/overdraft-protection')).body.protections, []);
    for (const [m, p, b] of [['GET', `/api/overdraft-protection/${chk.id}`], ['PUT', `/api/overdraft-protection/${chk.id}/line`, { courtesyLimitCents: 0 }],
      ['DELETE', `/api/overdraft-protection/${chk.id}`], ['POST', `/api/overdraft-protection/${chk.id}/repay`, { idempotencyKey: key() }],
      ['GET', `/api/overdraft-protection/${mine.id}`], ['GET', '/api/overdraft-protection/not-a-uuid'], ['GET', `/api/overdraft-protection/${newId()}`]]) {
      const r = await cl.call(m, p, b ?? {});
      assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.body.error, 'not_found');
    }
  }
  assert.equal((await ca.get(`/api/overdraft-protection/${mine.id}`)).status, 404);   // own checking account without a protection
  assert.equal((await q1('SELECT courtesy_limit_cents FROM overdraft_protections WHERE account_id = $1', [chk.id])).courtesy_limit_cents, 5000n);
  assert.equal((await cb.get('/api/overdraft-protection')).body.protections.length, 1);
  const line = await cb.call('PUT', `/api/overdraft-protection/${chk.id}/line`, { courtesyLimitCents: 10000 });
  assert.equal(line.status, 200); assert.equal(line.body.protection.lineAvailableCents, 10000); assert.equal(line.body.protection.linkedBy, a.id);
  assert.equal((await cb.del(`/api/overdraft-protection/${chk.id}`)).status, 200);
});

// ---------- covering a debit ----------
test('R12-R14, R21, R34-R36: a card purchase over the balance is covered by a protection transfer from savings', async () => {
  at(DAY);
  const s = await setup({ checking: 5000n, savings: 100000n });
  const r = await buy(s.c, s.cardId, '55.01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.authorization.result, 'approved'); assert.equal(r.body.authorization.amount, '55.01');
  assert.deepEqual(Object.keys(r.body).sort(), ['authorization', 'rewardsEarned']);
  assert.equal(await bal(s.chk.id), 5000n + 1000n - 5501n);
  assert.equal(await bal(s.sav.id), 100000n - 1000n);
  const d = await detail(s.c, s.chk);
  assert.equal(d.events.length, 1);
  const e = d.events[0];
  assert.deepEqual({ ...e, id: undefined, entryId: undefined, createdAt: undefined }, { id: undefined, type: 'sweep', accountId: s.chk.id, date: '2026-11-10',
    createdAt: undefined, actorId: s.u.id, rail: 'card', shortfallCents: 501, amountCents: 1000, feeCents: 0, feesRepaidCents: 0, principalRepaidCents: 0,
    backupAccountId: s.sav.id, entryId: undefined });
  const j = await q1('SELECT kind, memo, idempotency_key FROM journal_entries WHERE id = $1', [e.entryId]);
  assert.deepEqual(j, { kind: 'od_sweep', memo: 'Overdraft protection', idempotency_key: `${s.chk.id}:overdraft-protection:${e.id}` });
  assert.deepEqual(await lines(e.entryId), [
    [s.sav.id, -1000n, `Overdraft protection transfer to ${s.chk.label}`, 'Transfers', '2026-11-10'],
    [s.chk.id, 1000n, `Overdraft protection transfer from ${s.sav.label}`, 'Transfers', '2026-11-10']]);
  // posted before the purchase
  assert.ok((await q1('SELECT min(l.id) FILTER (WHERE j.kind = $2) a, min(l.id) FILTER (WHERE j.kind = $3) b FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id WHERE l.account_id = $1',
    [s.chk.id, 'od_sweep', 'card_purchase'])).a < (await q1('SELECT min(l.id) b FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id WHERE l.account_id = $1 AND j.kind = $2', [s.chk.id, 'card_purchase'])).b);
  assert.deepEqual(d.protection.transfersThisMonth, 1); assert.equal(d.protection.freeTransfersLeft, 2);
  assert.equal(d.protection.backupWithdrawalsThisMonth, 1);
  assert.deepEqual((await audits('overdraft_protection.sweep', s.chk.id)).map(a => [a.user_id, a.detail]), [[s.u.id, { account: s.chk.id, event: e.id,
    backup: s.sav.id, rail: 'card', shortfallCents: 501, amountCents: 1000, feeCents: 0, entry: e.entryId }]]);
  const alerts = (await s.c.get('/api/alerts')).body.items.filter(i => i.kind === 'overdraft_protection');
  assert.deepEqual(alerts.map(a => a.title), [`Overdraft protection transfer: $10.00 from ${s.sav.label}`]);
  assert.match(alerts[0].body, new RegExp(s.chk.label));
  // within the balance: no protection activity at all
  assert.equal((await buy(s.c, s.cardId, '4.99')).status, 200);
  assert.equal((await detail(s.c, s.chk)).events.length, 1);
  await integrity();
});

test('R13: the transfer is up(S) as far as the backup can pay; otherwise the debit is refused as today (R20)', async () => {
  at(DAY);
  const a = await setup({ checking: 0n, savings: 1500n });
  assert.equal((await buy(a.c, a.cardId, '10.01')).status, 200);         // S = 1,001, B = 1,500: A = 1,500
  assert.equal(await bal(a.sav.id), 0n); assert.equal(await bal(a.chk.id), 1500n - 1001n);
  for (const [S, A] of [[1n, 1000n], [1000n, 1000n], [1001n, 2000n]]) {
    const s = await setup({ checking: 0n, savings: 100000n });
    assert.equal((await buy(s.c, s.cardId, (Number(S) / 100).toFixed(2))).status, 200);
    assert.equal((await detail(s.c, s.chk)).events[0].amountCents, Number(A));
  }
  const b = await setup({ checking: 0n, savings: 1000n });
  const before = (await q1('SELECT count(*)::int n FROM journal_entries')).n, alerts = (await notes(b.u.id)).length;
  const r = await buy(b.c, b.cardId, '10.01');                             // S = 1,001, B = 1,000: not covered, no courtesy line
  assert.equal(r.status, 422); assert.equal(r.body.error, 'insufficient_funds'); assert.equal(r.body.authorization.result, 'declined');
  assert.equal((await q1('SELECT count(*)::int n FROM journal_entries')).n, before);
  assert.equal(await bal(b.sav.id), 1000n); assert.equal((await detail(b.c, b.chk)).events.length, 0);
  assert.equal((await notes(b.u.id)).length, alerts);
  assert.equal((await env.q("SELECT 1 FROM audit_events WHERE action LIKE 'overdraft_protection.%' AND user_id = $1 AND action <> 'overdraft_protection.link'", [b.u.id])).rowCount, 0);
  const t = await xfer(b.c, b.chk, b.sav, '10.01');
  assert.equal(t.status, 409); assert.equal(t.body.error, 'insufficient_funds');
});

test('R15, R29: three free transfers a month, then a $12 fee from the backup account; the count restarts each month and survives unlinking', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 100000n });
  for (let i = 0; i < 2; i++) assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);
  assert.equal((await s.c.del(`/api/overdraft-protection/${s.chk.id}`)).status, 200);
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 422);         // unprotected: refused as today
  const re = await s.c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: s.chk.id, backupAccountId: s.sav.id });
  assert.equal(re.body.protection.transfersThisMonth, 2); assert.equal(re.body.protection.freeTransfersLeft, 1);
  assert.notEqual(re.body.protection.createdAt, undefined);
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);         // 3rd: free
  const sav0 = await bal(s.sav.id);
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);         // 4th: fee
  assert.equal(await bal(s.sav.id), sav0 - 1000n - 1200n);
  const d = await detail(s.c, s.chk);
  assert.equal(d.events.length, 4);                                       // events from before the unlink are kept
  const e = d.events[3];
  assert.equal(e.feeCents, 1200);
  assert.deepEqual(await lines(e.entryId), [
    [s.sav.id, -1000n, `Overdraft protection transfer to ${s.chk.label}`, 'Transfers', '2026-11-10'],
    [s.chk.id, 1000n, `Overdraft protection transfer from ${s.sav.label}`, 'Transfers', '2026-11-10'],
    [s.sav.id, -1200n, 'Overdraft protection transfer fee', 'Fees & Charges', '2026-11-10'],
    [SYS.fees, 1200n, 'Overdraft protection transfer fee', null, '2026-11-10']]);
  assert.match((await notes(s.u.id)).at(-1).body, /\$12\.00/);
  assert.equal(d.protection.transfersThisMonth, 4); assert.equal(d.protection.freeTransfersLeft, 0);
  at('2026-12-01T16:00:00Z');
  assert.equal((await detail(s.c, s.chk)).protection.transfersThisMonth, 0);
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);
  assert.equal((await detail(s.c, s.chk)).events.at(-1).feeCents, 0);
  await integrity();
});

test('R16, R17, R18: a backup account with 6 withdrawals, closed or no longer shared is skipped for the courtesy line', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 100000n, limit: 50000 });
  const other = await account('savings', 'Other Savings', [[s.u, 'owner']]);
  for (let i = 0; i < 6; i++) assert.equal((await xfer(s.c, s.sav, other, '1.00')).status, 200);   // any debit counts
  assert.equal((await detail(s.c, s.chk)).protection.backupWithdrawalsThisMonth, 6);
  const sav0 = await bal(s.sav.id);
  assert.equal((await buy(s.c, s.cardId, '7.25')).status, 200);
  assert.equal(await bal(s.sav.id), sav0);
  const d = await detail(s.c, s.chk);
  assert.equal(d.events[0].type, 'line_draw'); assert.equal(d.events[0].amountCents, 725);
  assert.equal(d.protection.lineUsedCents, 725); assert.equal(d.protection.feesOwedCents, 1500); assert.equal(d.protection.lineAvailableCents, 50000 - 725);
  assert.equal(await bal(s.chk.id), 0n);
  // the next month the backup account is used again
  at('2026-12-02T16:00:00Z');
  assert.equal((await buy(s.c, s.cardId, '1.00')).status, 200);
  assert.equal((await detail(s.c, s.chk)).events.at(-1).type, 'sweep');
  // a backup account whose owner is no longer on the checking account is skipped; the protection stays
  const t = await setup({ checking: 0n, savings: 100000n, limit: 10000 });
  const stranger = await user('Ivy');
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')", [t.sav.id, stranger.id]);
  assert.equal((await buy(t.c, t.cardId, '2.00')).status, 200);
  assert.equal((await detail(t.c, t.chk)).events[0].type, 'line_draw');
  await env.q('DELETE FROM account_owners WHERE account_id = $1 AND user_id = $2', [t.sav.id, stranger.id]);
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [t.sav.id]);
  assert.equal((await buy(t.c, t.cardId, '2.00')).status, 200);
  assert.equal((await detail(t.c, t.chk)).events[1].type, 'line_draw');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [t.sav.id]);
  assert.equal((await buy(t.c, t.cardId, '2.00')).status, 200);
  assert.equal((await detail(t.c, t.chk)).events[2].type, 'sweep');
  await integrity();
});

test('R18, R19, R36: a courtesy line use advances the exact shortfall; fees are capped per day and per month', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 0n, limit: 100000 });
  const r = await buy(s.c, s.cardId, '3.33');
  assert.equal(r.status, 200);
  const e = (await detail(s.c, s.chk)).events[0];
  assert.deepEqual([e.type, e.shortfallCents, e.amountCents, e.feeCents, e.backupAccountId, e.rail], ['line_draw', 333, 333, 1500, null, 'card']);
  assert.deepEqual(await q1('SELECT kind, memo, idempotency_key FROM journal_entries WHERE id = $1', [e.entryId]),
    { kind: 'od_line_draw', memo: 'Courtesy overdraft line', idempotency_key: `${s.chk.id}:overdraft-protection:${e.id}` });
  assert.deepEqual(await lines(e.entryId), [
    [SYS.line, -333n, 'Courtesy overdraft line advance', null, '2026-11-10'],
    [s.chk.id, 333n, 'Courtesy overdraft line advance', 'Transfers', '2026-11-10'],
    [SYS.line, -1500n, 'Courtesy overdraft fee', null, '2026-11-10'],
    [SYS.fees, 1500n, 'Courtesy overdraft fee', null, '2026-11-10']]);
  assert.deepEqual((await audits('overdraft_protection.line_draw', s.chk.id)).map(a => a.detail), [{ account: s.chk.id, event: e.id, rail: 'card',
    shortfallCents: 333, amountCents: 333, feeCents: 1500, entry: e.entryId }]);
  const n0 = await notes(s.u.id);
  assert.equal(n0.at(-1).title, 'Courtesy overdraft line used: $3.33'); assert.match(n0.at(-1).body, /\$15\.00/);
  const fees = [];
  for (const d of ['2026-11-10', '2026-11-10', '2026-11-10', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-12', '2026-11-12']) {
    at(`${d}T16:00:00Z`);
    assert.equal((await buy(s.c, s.cardId, '1.00')).status, 200);
    fees.push((await detail(s.c, s.chk)).events.at(-1).feeCents);
  }
  assert.deepEqual(fees, [1500, 1500, 0, 1500, 1500, 1500, 1000, 0]);   // 4th of a day free; 9,000 charged, then 1,000, then 0
  const p = (await detail(s.c, s.chk)).protection;
  assert.equal(p.lineFeesThisMonthCents, 10000); assert.equal(p.lineFeesToday, 1); assert.equal(p.feesOwedCents, 10000);
  assert.equal(p.lineUsedCents, 333 + 800);
  at('2026-12-01T16:00:00Z');
  assert.equal((await buy(s.c, s.cardId, '1.00')).status, 200);
  assert.equal((await detail(s.c, s.chk)).events.at(-1).feeCents, 1500);
  // not enough line left for the whole shortfall: refused, the line is never used for part of it
  const t = await setup({ checking: 100n, savings: 0n, limit: 1000 });
  const no = await buy(t.c, t.cardId, '11.01');
  assert.equal(no.status, 422); assert.equal(no.body.error, 'insufficient_funds');
  assert.equal((await detail(t.c, t.chk)).events.length, 0); assert.equal(await bal(t.chk.id), 100n);
  assert.equal((await buy(t.c, t.cardId, '11.00')).status, 200);
  await integrity();
});

test('R12, R21, R37: transfers, bill pay, ACH and wires are covered with the same responses; USA Pay and a transfer to the backup are not', async () => {
  at('2026-11-02T16:00:00Z');
  const s = await setup({ checking: 0n, savings: 500000n });
  const other = await account('savings', 'Other Savings', [[s.u, 'owner']]);
  const ext = await s.c.post('/api/pay/external-accounts', { nickname: 'Test bank', routing: '123456780', accountNumber: '000555123456' });
  const [amount1, amount2] = ext.body.demoMicroDeposits;
  await s.c.post(`/api/pay/external-accounts/${ext.body.externalAccount.id}/verify`, { amount1, amount2 });
  const payee = (await s.c.post('/api/pay/payees', { name: 'Power Co', address: '1 Main St' })).body.payee;
  at(DAY);
  const c = await stepped(s.u);
  const tr = await xfer(c, s.chk, other, '12.00');
  assert.equal(tr.status, 200); assert.equal(tr.body.transfer.amount, '12.00'); assert.equal(tr.body.transfer.status, 'completed');
  const bill = await c.post('/api/pay/bills', { idempotencyKey: key(), fromAccountId: s.chk.id, payeeId: payee.id, amount: '20.50' });
  assert.equal(bill.status, 200, JSON.stringify(bill.body)); assert.equal(bill.body.transfer.amount, '20.50');
  const ach = await c.post('/api/pay/ach', { idempotencyKey: key(), direction: 'out', accountId: s.chk.id, externalAccountId: ext.body.externalAccount.id, amount: '30.00' });
  assert.equal(ach.status, 200, JSON.stringify(ach.body)); assert.equal(ach.body.transfer.status, 'pending');
  const wire = await c.post('/api/pay/wires', { idempotencyKey: key(), fromAccountId: s.chk.id, amount: '40.00', recipientName: 'Sam Lee', bankName: 'Far Bank',
    routing: '123456780', accountNumber: '99887766', confirmIrrevocable: true });
  assert.equal(wire.status, 200, JSON.stringify(wire.body)); assert.equal(wire.body.transfer.fee, '25.00');
  const d = await detail(c, s.chk);
  assert.deepEqual(d.events.map(e => [e.rail, e.shortfallCents, e.amountCents, e.feeCents]),
    [['internal', 1200, 2000, 0], ['billpay', 1250, 2000, 0], ['ach', 2250, 3000, 0], ['wire', 5750, 6000, 1200]]);
  assert.equal(await bal(s.chk.id), 2000n - 1200n + 2000n - 2050n + 3000n - 3000n + 6000n - 6500n);
  // R37: limits count the debits only
  const lim = (await c.get('/api/pay/limits')).body.limits;
  assert.equal(lim.find(l => l.rail === 'internal').usedToday, '12.00'); assert.equal(lim.find(l => l.rail === 'wire').usedToday, '40.00');
  // not covered: USA Pay and a transfer to the backup account itself
  const p2p = await c.post('/api/pay/p2p/send', { idempotencyKey: key(), fromAccountId: s.chk.id, to: 'someone@example.com', amount: '50.00' });
  assert.equal(p2p.status, 409); assert.equal(p2p.body.error, 'insufficient_funds');
  const toBackup = await xfer(c, s.chk, s.sav, '50.00');
  assert.equal(toBackup.status, 409); assert.equal(toBackup.body.error, 'insufficient_funds');
  assert.equal((await detail(c, s.chk)).events.length, 4);
  // R22: refused for another reason first: no protection activity
  const big = await c.post('/api/pay/ach', { idempotencyKey: key(), direction: 'out', accountId: s.chk.id, externalAccountId: ext.body.externalAccount.id, amount: '2600.00' });
  assert.equal(big.body.error, 'over_limit');
  const noConfirm = await c.post('/api/pay/wires', { idempotencyKey: key(), fromAccountId: s.chk.id, amount: '40.00', recipientName: 'Sam Lee', bankName: 'Far Bank',
    routing: '123456780', accountNumber: '99887766' });
  assert.equal(noConfirm.body.error, 'confirm_required');
  await env.q("UPDATE cards SET status = 'locked' WHERE id = $1", [s.cardId]);
  assert.equal((await buy(c, s.cardId, '5.00')).body.error, 'card_locked');
  assert.equal((await detail(c, s.chk)).events.length, 4);
  await integrity();
});

test('R23, R24: a scheduled transfer is covered when it runs; replays make no second protection transfer', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 100000n });
  const other = await account('savings', 'Other Savings', [[s.u, 'owner']]);
  const body = { idempotencyKey: key(), fromAccountId: s.chk.id, toAccountId: other.id, amount: '5.00' };
  const a = await s.c.post('/api/pay/transfers', body), b = await s.c.post('/api/pay/transfers', body);
  assert.equal(a.status, 200); assert.equal(b.body.replayed, true);
  const pk = key(), purchase = { idempotencyKey: pk, merchant: 'Corner Market', amount: '9.00' };
  const p1 = await s.c.post(`/api/cards/card/${s.cardId}/purchases`, purchase), p2 = await s.c.post(`/api/cards/card/${s.cardId}/purchases`, purchase);
  assert.equal(p1.status, 200); assert.equal(p2.body.replayed, true);
  assert.equal((await detail(s.c, s.chk)).events.length, 2);
  assert.equal((await audits('overdraft_protection.sweep', s.chk.id)).length, 2); assert.equal((await notes(s.u.id)).length, 2);
  const sch = await s.c.post('/api/pay/transfers', { idempotencyKey: key(), fromAccountId: s.chk.id, toAccountId: other.id, amount: '15.00', when: 'date', date: '2026-11-11' });
  assert.equal(sch.status, 200, JSON.stringify(sch.body));
  at('2026-11-11T16:00:00Z');
  const runner = await signIn(env.base, ...s.u.login);
  assert.equal((await runner.post('/api/pay/run-due', {})).status, 200);
  const e = (await detail(runner, s.chk)).events.at(-1);
  assert.deepEqual([e.rail, e.shortfallCents, e.amountCents, e.actorId, e.date], ['internal', 1500 - (1000 - 500 + 1000 - 900), 1000, s.u.id, '2026-11-11']);
  assert.equal((await env.q("SELECT status FROM transfers WHERE schedule_id = $1", [sch.body.schedule.id])).rows[0].status, 'completed');
  await integrity();
});

// ---------- repaying ----------
test('R25: an internal transfer in and a settled ACH pull repay the line, fees first; other credits do not', async () => {
  at('2026-11-02T16:00:00Z');
  const s = await setup({ checking: 0n, savings: 0n, limit: 100000 });
  const ext = await s.c.post('/api/pay/external-accounts', { nickname: 'Test bank', routing: '123456780', accountNumber: '000555123456' });
  const [amount1, amount2] = ext.body.demoMicroDeposits;
  await s.c.post(`/api/pay/external-accounts/${ext.body.externalAccount.id}/verify`, { amount1, amount2 });
  at(DAY);
  assert.equal((await buy(s.c, s.cardId, '40.00')).status, 200);         // line 4,000, fee 1,500
  await fund(s.sav.id, 100000n);                                          // a credit from elsewhere repays nothing
  assert.equal((await detail(s.c, s.chk)).protection.feesOwedCents, 1500);
  const tr = await xfer(s.c, s.sav, s.chk, '20.00');
  assert.equal(tr.status, 200); assert.equal(tr.body.transfer.amount, '20.00');
  let d = await detail(s.c, s.chk);
  const e = d.events.at(-1);
  assert.deepEqual([e.type, e.rail, e.amountCents, e.feesRepaidCents, e.principalRepaidCents, e.shortfallCents, e.feeCents, e.backupAccountId],
    ['repayment', 'internal', 2000, 1500, 500, null, 0, null]);
  assert.deepEqual(await q1('SELECT kind, memo, idempotency_key FROM journal_entries WHERE id = $1', [e.entryId]),
    { kind: 'od_repayment', memo: 'Courtesy overdraft line repayment', idempotency_key: `${s.chk.id}:overdraft-protection:${e.id}` });
  assert.deepEqual(await lines(e.entryId), [
    [s.chk.id, -2000n, 'Courtesy overdraft line repayment', 'Transfers', '2026-11-10'],
    [SYS.line, 2000n, 'Courtesy overdraft line repayment', null, '2026-11-10']]);
  assert.equal(d.protection.feesOwedCents, 0); assert.equal(d.protection.lineUsedCents, 3500);
  assert.equal(await bal(s.chk.id), 0n);
  assert.deepEqual((await audits('overdraft_protection.repayment', s.chk.id)).map(a => a.detail), [{ account: s.chk.id, event: e.id, rail: 'internal',
    amountCents: 2000, feesRepaidCents: 1500, principalRepaidCents: 500, entry: e.entryId }]);
  assert.equal((await notes(s.u.id)).length, 1);                          // repayments write no notification
  const pull = await s.c.post('/api/pay/ach', { idempotencyKey: key(), direction: 'in', accountId: s.chk.id, externalAccountId: ext.body.externalAccount.id, amount: '50.00' });
  assert.equal(pull.status, 200, JSON.stringify(pull.body));
  assert.equal((await s.c.post('/api/pay/simulate-settlement', { transferId: pull.body.transfer.id })).status, 200);
  d = await detail(s.c, s.chk);
  assert.deepEqual([d.events.at(-1).rail, d.events.at(-1).amountCents, d.events.at(-1).principalRepaidCents], ['ach', 3500, 3500]);
  assert.equal(d.protection.lineUsedCents, 0); assert.equal(await bal(s.chk.id), 1500n);
  await integrity();
});

test('R26: repay on request, its checks in order, and its request id', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 0n, limit: 20000 });
  const repay = (b, cl = s.c) => cl.post(`/api/overdraft-protection/${s.chk.id}/repay`, b);
  assert.equal((await repay({ idempotencyKey: key() })).body.error, 'nothing_owed');
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);          // owes 1,000 + 1,500
  for (const [b, status, error] of [[{}, 400, 'idempotency_key_required'], [{ idempotencyKey: key(), amountCents: 0 }, 400, 'bad_amount'],
    [{ idempotencyKey: key(), amountCents: '5' }, 400, 'bad_amount'], [{ idempotencyKey: key(), amountCents: 1.5 }, 400, 'bad_amount'],
    [{ idempotencyKey: key(), amountCents: 2501 }, 422, 'more_than_owed'], [{ idempotencyKey: key() }, 409, 'insufficient_funds']]) {
    const r = await repay(b);
    assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.error, error);
  }
  await fund(s.chk.id, 5000n);
  const k = key(), first = await repay({ idempotencyKey: k, amountCents: 1600 });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.replayed, false);
  assert.deepEqual([first.body.repayment.rail, first.body.repayment.feesRepaidCents, first.body.repayment.principalRepaidCents], ['manual', 1500, 100]);
  assert.equal(first.body.protection.lineUsedCents, 900); assert.equal(first.body.protection.feesOwedCents, 0);
  const again = await repay({ idempotencyKey: k, amountCents: 1600 }, await signIn(env.base, ...s.u.login));
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.repayment, first.body.repayment);
  assert.equal((await repay({ idempotencyKey: k, amountCents: 1 })).body.error, 'idempotency_conflict');
  const all = await repay({ idempotencyKey: key(), amountCents: null });
  assert.equal(all.body.repayment.amountCents, 900); assert.equal(all.body.protection.lineUsedCents, 0);
  assert.equal(await bal(s.chk.id), 5000n - 2500n);
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [s.chk.id]);
  assert.equal((await repay({ idempotencyKey: key() })).body.error, 'account_not_open');
  await integrity();
});

// ---------- managing ----------
test('R27: changing the courtesy line: raising needs a step-up, not below what is used, audited only when it changes', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 0n, limit: 5000 });
  const plain = await signIn(env.base, ...s.u.login);
  const put = (b, cl = s.c) => cl.call('PUT', `/api/overdraft-protection/${s.chk.id}/line`, b);
  for (const v of [undefined, null, '1000', 999, -1000, 101000, true]) assert.equal((await put({ courtesyLimitCents: v })).body.error, 'bad_limit');
  assert.equal((await put({ courtesyLimitCents: 6000 }, plain)).body.error, 'stepup_required');
  assert.equal((await put({ courtesyLimitCents: 5000 }, plain)).status, 200);
  assert.equal((await audits('overdraft_protection.line_change', s.chk.id)).length, 0);
  assert.equal((await buy(s.c, s.cardId, '30.00')).status, 200);
  const used = await put({ courtesyLimitCents: 2000 }, plain);
  assert.equal(used.status, 409); assert.equal(used.body.error, 'line_in_use');
  const ok = await put({ courtesyLimitCents: 3000 }, plain);
  assert.equal(ok.status, 200); assert.equal(ok.body.protection.courtesyLimitCents, 3000); assert.equal(ok.body.protection.lineAvailableCents, 0);
  assert.deepEqual((await audits('overdraft_protection.line_change', s.chk.id)).map(a => a.detail), [{ account: s.chk.id, from: 5000, to: 3000 }]);
});

test('R28, R29: unlink only when nothing is owed; afterwards debits are refused as today and the account can be linked again', async () => {
  at(DAY);
  const s = await setup({ checking: 0n, savings: 0n, limit: 5000 });
  assert.equal((await buy(s.c, s.cardId, '10.00')).status, 200);
  const owed = await s.c.del(`/api/overdraft-protection/${s.chk.id}`);
  assert.equal(owed.status, 409); assert.equal(owed.body.error, 'balance_owed');
  await fund(s.chk.id, 3000n);
  assert.equal((await s.c.post(`/api/overdraft-protection/${s.chk.id}/repay`, { idempotencyKey: key() })).status, 200);
  const created = (await detail(s.c, s.chk)).protection.createdAt;
  const del = await s.c.del(`/api/overdraft-protection/${s.chk.id}`);
  assert.deepEqual(del.body, { accountId: s.chk.id, removed: true });
  assert.deepEqual((await audits('overdraft_protection.unlink', s.chk.id)).map(a => a.detail), [{ account: s.chk.id, backup: s.sav.id }]);
  assert.deepEqual((await s.c.get('/api/overdraft-protection')).body.protections, []);
  assert.equal((await s.c.get(`/api/overdraft-protection/${s.chk.id}`)).status, 404);
  assert.equal((await s.c.call('PUT', `/api/overdraft-protection/${s.chk.id}/line`, { courtesyLimitCents: 0 })).status, 404);
  assert.equal((await s.c.post(`/api/overdraft-protection/${s.chk.id}/repay`, { idempotencyKey: key() })).status, 404);
  assert.equal((await s.c.del(`/api/overdraft-protection/${s.chk.id}`)).status, 404);
  assert.equal((await buy(s.c, s.cardId, '10.01')).status, 422);
  at('2026-11-10T17:00:00Z');
  const re = await s.c.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: s.chk.id, backupAccountId: s.sav.id, courtesyLimitCents: 5000 });
  assert.equal(re.status, 200); assert.notEqual(re.body.protection.createdAt, created);
  assert.equal(re.body.protection.lineFeesToday, 1); assert.equal(re.body.protection.lineFeesThisMonthCents, 1500);
  assert.equal((await detail(s.c, s.chk)).events.length, 2);
});

// ---------- at the same moment ----------
test('R30: simultaneous debits by two owners through several routes on one checking account act one after another', async () => {
  at(DAY);
  const a = await user('Joy'), b = await user('Kai');
  const chk = await account('checking', 'Joint Checking', [[a, 'owner'], [b, 'joint_owner']], 1000n);
  const sav = await account('savings', 'Joint Savings', [[a, 'owner'], [b, 'joint_owner']], 4000n);
  const other = await account('savings', 'Other', [[a, 'owner'], [b, 'joint_owner']]);
  const cardA = await card(chk, a), cardB = await card(chk, b);
  const ca = await stepped(a), cb = await stepped(b);
  assert.equal((await ca.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id, courtesyLimitCents: 3000 })).status, 200);
  const rs = await Promise.all([buy(ca, cardA, '7.00'), buy(cb, cardB, '7.00'), xfer(ca, chk, other, '7.00'), xfer(cb, chk, other, '7.00'),
    buy(ca, cardA, '7.00'), buy(cb, cardB, '7.00'), xfer(cb, chk, other, '7.00'), xfer(ca, chk, other, '7.00')]);
  // Every debit is $7.00, so any order gives the same outcome: 3 free protection transfers of $10.00 while the 4th would need
  // a fee the backup can't pay, then 3 courtesy line uses of $2.00, $7.00 and $7.00, each with a $15.00 fee.
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200, 200, 200, 200, 200], JSON.stringify(rs.map(r => r.body.error)));
  const d = await detail(ca, chk);
  assert.deepEqual(d.events.map(e => [e.type, e.shortfallCents, e.amountCents, e.feeCents]), [['sweep', 400, 1000, 0], ['sweep', 100, 1000, 0], ['sweep', 500, 1000, 0],
    ['line_draw', 200, 200, 1500], ['line_draw', 700, 700, 1500], ['line_draw', 700, 700, 1500]]);
  assert.equal(await bal(chk.id), 0n); assert.equal(await bal(sav.id), 1000n); assert.equal(await bal(other.id), 2800n);
  assert.equal(d.protection.lineUsedCents, 1600); assert.equal(d.protection.feesOwedCents, 4500);
  assert.equal((await notes(a.id)).length, 6); assert.equal((await notes(b.id)).length, 6);
  await integrity();
});

test('R31: two checking accounts with one backup account at the same moment share its balance and withdrawal limit exactly', async () => {
  at(DAY);
  const a = await user('Lou'), b = await user('Max');
  const sav = await account('savings', 'Shared Savings', [[a, 'owner'], [b, 'joint_owner']], 5000n);
  const c1 = await account('checking', 'Lou Checking', [[a, 'owner'], [b, 'joint_owner']]);
  const c2 = await account('checking', 'Max Checking', [[b, 'owner'], [a, 'joint_owner']]);
  const other = await account('savings', 'Lou Other', [[a, 'owner'], [b, 'joint_owner']]);
  const k1 = await card(c1, a), k2 = await card(c2, b);
  const ca = await stepped(a), cb = await stepped(b);
  for (const [cl, chk] of [[ca, c1], [cb, c2]])
    assert.equal((await cl.post('/api/overdraft-protection', { idempotencyKey: key(), accountId: chk.id, backupAccountId: sav.id, courtesyLimitCents: 5000 })).status, 200);
  // each checking account: 4 debits of $5.00 need 2 transfers of $10.00; with the $9.00 withdrawal the backup can pay all of it in any order
  const rs = await Promise.all([buy(ca, k1, '5.00'), buy(cb, k2, '5.00'), buy(ca, k1, '5.00'), buy(cb, k2, '5.00'), xfer(cb, c2, other, '5.00'),
    xfer(ca, sav, other, '9.00'), buy(ca, k1, '5.00'), buy(cb, k2, '5.00'), xfer(ca, c1, other, '5.00')]);
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200, 200, 200, 200, 200, 200], JSON.stringify(rs.map(r => r.body.error)));
  assert.equal(await bal(sav.id), 100n); assert.equal(await bal(c1.id), 0n); assert.equal(await bal(c2.id), 0n);
  assert.equal((await detail(ca, c1)).protection.backupWithdrawalsThisMonth, 5);
  // the 6th withdrawal of the month is the last one: of 4 debits on the two accounts now, exactly 1 is a protection transfer
  await fund(sav.id, 100000n);
  const more = await Promise.all([buy(ca, k1, '1.00'), buy(cb, k2, '1.00'), buy(ca, k1, '9.50'), buy(cb, k2, '9.50')]);
  assert.deepEqual(more.map(r => r.status), [200, 200, 200, 200]);
  const ev = (await env.q('SELECT type FROM overdraft_protection_events WHERE account_id = ANY($1) ORDER BY seq', [[c1.id, c2.id]])).rows.map(r => r.type);
  assert.equal(ev.filter(t => t === 'sweep').length, 5); assert.equal(ev.filter(t => t === 'line_draw').length, 3);
  assert.equal((await detail(cb, c2)).protection.backupWithdrawalsThisMonth, 6);
  await integrity();
});

test('R32: a debit racing a deposit into the same checking account, or a transfer out of the backup account', async () => {
  at(DAY);
  // (a) owes $5.00 + $15.00; a $10.00 debit and a $30.00 deposit: either order ends at $0.00, owing $15.00 or nothing
  const s = await setup({ checking: 0n, savings: 0n, limit: 5000 });
  const other = await account('savings', 'Other', [[s.u, 'owner']], 100000n);
  assert.equal((await buy(s.c, s.cardId, '5.00')).status, 200);
  const second = await signIn(env.base, ...s.u.login);
  const ra = await Promise.all([buy(s.c, s.cardId, '10.00'), xfer(second, other, s.chk, '30.00')]);
  assert.deepEqual(ra.map(r => r.status), [200, 200]);
  assert.equal(await bal(s.chk.id), 0n);
  const p = (await detail(s.c, s.chk)).protection;
  assert.ok([0, 1500].includes(p.lineUsedCents + p.feesOwedCents), JSON.stringify(p));
  // (b) backup $15.00: a $5.00 debit (a $10.00 transfer) and a $10.00 transfer out of the backup account
  const t = await setup({ checking: 0n, savings: 1500n });
  const out = await account('savings', 'Out', [[t.u, 'owner']]);
  const second2 = await signIn(env.base, ...t.u.login);
  const rb = await Promise.all([buy(t.c, t.cardId, '5.00'), xfer(second2, t.sav, out, '10.00')]);
  const ev = (await detail(t.c, t.chk)).events;
  if (rb[1].status === 200) {                                             // the withdrawal first: $5.00 left covers exactly
    assert.equal(rb[0].status, 200); assert.equal(ev[0].amountCents, 500); assert.equal(await bal(t.sav.id), 0n);
  } else {                                                                // the debit first: the withdrawal is refused
    assert.equal(rb[1].status, 409); assert.equal(rb[0].status, 200); assert.equal(ev[0].amountCents, 1000); assert.equal(await bal(t.sav.id), 500n);
  }
  // (c) a debit and a deposit from the backup account itself: no deadlock, no server error
  const u = await setup({ checking: 0n, savings: 100000n });
  const third = await signIn(env.base, ...u.u.login);
  const rc = await Promise.all([buy(u.c, u.cardId, '5.00'), xfer(third, u.sav, u.chk, '2.00'), buy(u.c, u.cardId, '4.00'), xfer(third, u.sav, u.chk, '3.00')]);
  assert.deepEqual(rc.map(r => r.status), [200, 200, 200, 200]);
  await integrity();
});
