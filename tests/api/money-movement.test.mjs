import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('hex');      // test-only key, made fresh for each run
const { testEnv, signIn } = await import('../helpers.mjs');
const { clock, processingDay, addBusinessDays, addMonth, isBusinessDay, ct } = await import('../../lib/money-movement/calendar.mjs');
const { open } = await import('../../lib/money-movement/vault.mjs');

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const at = iso => { clock.now = () => new Date(iso); };

const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'], AVA = ['ava@usabanc.example', 'ava-demo-pass'];
let n = 0; const key = () => `test-${Date.now()}-${++n}`;
const acct = async last4 => (await env.q('SELECT id, balance_cents FROM accounts WHERE number_last4 = $1', [last4])).rows[0];
const id = async last4 => (await acct(last4)).id;
const bal = async last4 => (await acct(last4)).balance_cents;
async function stepped(user) {
  const c = await signIn(env.base, ...user);
  const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
  return c;
}
async function link(c, accountNumber, when) {
  if (when) at(when);
  const r = await c.post('/api/pay/external-accounts', { nickname: 'Test bank', routing: '123456780', accountNumber });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [amount1, amount2] = r.body.demoMicroDeposits;
  const v = await c.post(`/api/pay/external-accounts/${r.body.externalAccount.id}/verify`, { amount1, amount2 });
  assert.equal(v.body.externalAccount.status, 'verified');
  return r.body.externalAccount.id;
}

test('business days skip weekends and Fed holidays; cut-offs are Central Time', () => {
  assert.equal(isBusinessDay('2026-11-26'), false);                       // Thanksgiving
  assert.equal(isBusinessDay('2026-11-28'), false);                       // Saturday
  assert.equal(addBusinessDays('2026-11-25', 1), '2026-11-27');
  assert.equal(addBusinessDays('2026-12-24', 1), '2026-12-28');           // Christmas Friday, then the weekend
  assert.equal(processingDay('ach', new Date('2026-11-25T22:59:00Z')), '2026-11-25');   // 4:59 pm CST
  assert.equal(processingDay('ach', new Date('2026-11-25T23:00:00Z')), '2026-11-27');   // 5:00 pm CST: after the cut-off
  assert.deepEqual(ct(new Date('2026-07-01T21:30:00Z')), { date: '2026-07-01', minutes: 16 * 60 + 30 });   // CDT in summer
  assert.equal(addMonth('2027-01-31', 31), '2027-02-28');
  assert.equal(addMonth('2027-02-28', 31), '2027-03-31');
});

test('the hub shows accounts, limits with what is left, the seeded external account, payee and the USA Pay warning', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const r = await c.get('/api/pay');
  assert.equal(r.status, 200);
  const p2p = r.body.limits.find(l => l.rail === 'p2p');
  assert.equal(p2p.daily, '1000.00'); assert.equal(p2p.monthly, '5000.00');
  const ach = r.body.limits.find(l => l.rail === 'ach');
  assert.equal(ach.perTransfer, '2500.00'); assert.equal(ach.daily, '10000.00'); assert.equal(ach.monthly, '25000.00');
  assert.deepEqual(r.body.externalAccounts.map(e => [e.last4, e.status, e.onHold]), [['6789', 'verified', false]]);
  assert.deepEqual(r.body.payees.map(p => p.name), ['City Power & Light', 'Riverside Apartments']);
  assert.ok(r.body.p2p.requestsIn.some(q => q.from === 'Jordan' && q.amount === '24.50'));
  assert.deepEqual(r.body.activity.map(t => [t.rail, t.status]).sort(), [['billpay', 'paid'], ['internal', 'completed'], ['p2p', 'completed']]);
  assert.match(r.body.p2p.warning, /people you know/);
  assert.equal(r.body.wire.fee, '25.00');
  const teen = r.body.accounts.find(a => a.last4 === '5120');
  assert.equal(teen.canMove, true); assert.equal(teen.canSend, false);    // custodian: transfers only
  assert.ok(!JSON.stringify(r.body).includes('000123456789'));
});

test('a transfer between your own accounts moves money once, even when retried', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const [chk, sav] = [await bal('4471'), await bal('9302')];
  const body = { fromAccountId: await id('4471'), toAccountId: await id('9302'), amount: '25.50', idempotencyKey: key() };
  const a = await c.post('/api/pay/transfers', body), b = await c.post('/api/pay/transfers', body);
  assert.equal(a.status, 200); assert.equal(a.body.transfer.status, 'completed'); assert.equal(a.body.replayed, false);
  assert.equal(b.body.replayed, true); assert.equal(b.body.transfer.id, a.body.transfer.id);
  assert.equal(await bal('4471'), chk - 2550n); assert.equal(await bal('9302'), sav + 2550n);
  assert.equal((await env.q("SELECT count(*)::int n FROM transfers WHERE id = $1", [a.body.transfer.id])).rows[0].n, 1);
  assert.equal((await c.post('/api/pay/transfers', { ...body, idempotencyKey: undefined })).body.error, 'idempotency_key_required');
});

test('an overdraft is refused in plain words, moves nothing and is audited', async () => {
  const c = await stepped(NIZAM);                                    // $5,000 between your own accounts asks for a code first
  const sav = await bal('9302');
  const r = await c.post('/api/pay/transfers', { fromAccountId: await id('9302'), toAccountId: await id('4471'), amount: '5000.00', idempotencyKey: key() });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'insufficient_funds');
  const { usd } = await import('../../lib/money-movement/limits.mjs');
  assert.ok(r.body.message.includes(`has ${usd(sav)}, which isn't enough`), r.body.message);
  assert.equal(await bal('9302'), sav);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'transfer.refused' AND detail->>'reason' = 'insufficient_funds'")).rowCount >= 1);
});

test('step-up is required to send to someone else or out of the bank, add a payee or external account, or raise a limit', async () => {
  const c = await signIn(env.base, ...NIZAM);                       // signs in without a code, so no recent step-up
  const chk = await id('4471'), ext = (await c.get('/api/pay')).body.externalAccounts[0].id;
  const tries = [
    ['/api/pay/p2p/send', { fromAccountId: chk, to: 'jordan@usabanc.example', amount: '1.00', idempotencyKey: key() }],
    ['/api/pay/ach', { accountId: chk, externalAccountId: ext, direction: 'out', amount: '1.00', idempotencyKey: key() }],
    ['/api/pay/wires', { fromAccountId: chk, amount: '1.00', recipientName: 'A', bankName: 'B', routing: '123456780', accountNumber: '12345678', confirmIrrevocable: true, idempotencyKey: key() }],
    ['/api/pay/bills', { fromAccountId: chk, payeeId: (await c.get('/api/pay')).body.payees[0].id, amount: '1.00', idempotencyKey: key() }],
    ['/api/pay/payees', { name: 'Water Co', address: '1 Main St' }],
    ['/api/pay/external-accounts', { routing: '123456780', accountNumber: '55554444' }],
    ['/api/pay/p2p/enroll', { token: '2025550199', accountId: chk }]
  ];
  for (const [path, body] of tries) {
    const r = await c.post(path, body);
    assert.equal(r.status, 403, path); assert.equal(r.body.error, 'stepup_required', path);
  }
  assert.equal((await c.call('PUT', '/api/pay/limits/p2p', { daily: '500.00', monthly: '5000.00' })).status, 200);   // lowering is fine
  const up = await c.call('PUT', '/api/pay/limits/p2p', { daily: '1000.00', monthly: '5000.00' });                   // raising is not
  assert.equal(up.body.error, 'stepup_required');
  const ok = await c.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: await id('9302'), amount: '1.00', idempotencyKey: key() });
  assert.equal(ok.status, 200);                                                                                     // your own accounts: no code
  const s = await stepped(NIZAM);
  assert.equal((await s.call('PUT', '/api/pay/limits/p2p', { daily: '1000.00', monthly: '5000.00' })).status, 200);
  const over = await s.call('PUT', '/api/pay/limits/p2p', { daily: '1000.01', monthly: '5000.00' });
  assert.equal(over.status, 422); assert.equal(over.body.error, 'above_bank_limit');
  const audits = (await env.q("SELECT detail->>'decision' d FROM audit_events WHERE action = 'limit.change' ORDER BY id")).rows.map(r => r.d);
  assert.deepEqual(audits, ['ok', 'ok', 'refused']);
});

test('USA Pay daily limit: exactly at the limit is allowed, a cent more is refused; the next day it resets', async () => {
  const c = await stepped(NIZAM), chk = await id('4471');
  at('2027-03-01T16:00:00Z');
  const send = amount => c.post('/api/pay/p2p/send', { fromAccountId: chk, to: '(202) 555-0117', amount, idempotencyKey: key() });
  const jordan = await bal('3388'), clearing = (await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'mm_p2p'")).rows[0].b;
  const a = await send('1000.00');
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.transfer.status, 'completed'); assert.equal(a.body.transfer.counterparty, 'Jordan');
  assert.equal(await bal('3388'), jordan + 100000n);                                  // instant between demo users
  assert.equal((await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'mm_p2p'")).rows[0].b, clearing);   // nets to zero in p2p_clearing
  const b = await send('0.01');
  assert.equal(b.status, 422); assert.equal(b.body.error, 'over_limit'); assert.equal(b.body.limit, 'daily'); assert.equal(b.body.remaining, '0.00');
  assert.equal((await c.get('/api/pay')).body.limits.find(l => l.rail === 'p2p').leftToday, '0.00');
  at('2027-03-02T16:00:00Z');
  assert.equal((await send('0.01')).status, 200);
  const decisions = (await env.q("SELECT detail->>'decision' d FROM audit_events WHERE action = 'limit.check' AND detail->>'rail' = 'p2p' ORDER BY id")).rows.map(r => r.d);
  assert.deepEqual(decisions.slice(-3), ['ok', 'refused', 'ok']);
});

test('a 30-day limit set by the customer is enforced at the boundary', async () => {
  const c = await stepped(JORDAN), from = await id('3388');
  assert.equal((await c.call('PUT', '/api/pay/limits/p2p', { daily: '100.00', monthly: '150.00' })).status, 200);
  const send = amount => c.post('/api/pay/p2p/send', { fromAccountId: from, to: 'nizam@helixbots.ai', amount, idempotencyKey: key() });
  at('2027-05-03T16:00:00Z'); assert.equal((await send('100.00')).status, 200);
  at('2027-05-10T16:00:00Z'); assert.equal((await send('50.00')).status, 200);
  const r = await send('0.01'); assert.equal(r.body.error, 'over_limit'); assert.equal(r.body.limit, 'monthly');
  at('2027-06-03T16:00:00Z'); assert.equal((await send('50.00')).status, 200);      // the first send has rolled out of the 30 days
});

test('ACH: per-transfer limit is checked to the cent', async () => {
  const c = await stepped(NIZAM), ext = (await c.get('/api/pay')).body.externalAccounts[0].id;
  const id9302 = await id('9302');
  const send = amount => c.post('/api/pay/ach', { accountId: id9302, externalAccountId: ext, direction: 'in', amount, idempotencyKey: key() });
  assert.equal((await send('2500.01')).body.limit, 'per_transfer');
  const ok = await send('2500.00');
  assert.equal(ok.status, 200); assert.equal(ok.body.transfer.status, 'pending');
});

test('micro-deposits: two amounts, three tries, and the link goes away after 15 days', async () => {
  const c = await stepped(JORDAN);
  const r = await c.post('/api/pay/external-accounts', { nickname: 'Credit union', routing: '123456780', accountNumber: '9876543210', kind: 'savings' });
  assert.equal(r.status, 200); assert.equal(r.body.externalAccount.status, 'pending'); assert.equal(r.body.externalAccount.last4, '3210');
  assert.equal(r.body.demoMicroDeposits.length, 2);
  const row = (await env.q('SELECT * FROM external_accounts WHERE id = $1', [r.body.externalAccount.id])).rows[0];
  assert.ok(!row.number_enc.includes('9876543210'));
  assert.equal(open(row.number_enc, `${row.user_id}:${row.id}`), '9876543210');       // AES-256-GCM round trip with the test key
  const v = `/api/pay/external-accounts/${row.id}/verify`;
  const w1 = await c.post(v, { amount1: '0.00', amount2: '1.00' });
  assert.equal(w1.status, 400);                                                           // not a micro-deposit amount at all
  const md = r.body.demoMicroDeposits, bad = await c.post(v, { amount1: md[0], amount2: md[1] === '0.99' ? '0.98' : '0.99' });
  assert.equal(bad.body.error, 'bad_amounts'); assert.match(bad.body.message, /2 tries left/);
  const good = await c.post(v, { amount1: r.body.demoMicroDeposits[1], amount2: r.body.demoMicroDeposits[0] });   // either order
  assert.equal(good.body.externalAccount.status, 'verified');

  const r2 = await c.post('/api/pay/external-accounts', { routing: '123456780', accountNumber: '11112222' });
  const v2 = `/api/pay/external-accounts/${r2.body.externalAccount.id}/verify`;
  const wrong = r2.body.demoMicroDeposits[0] === '0.50' ? '0.51' : '0.50';
  for (let i = 0; i < 2; i++) assert.equal((await c.post(v2, { amount1: wrong, amount2: wrong })).body.error, 'bad_amounts');
  const third = await c.post(v2, { amount1: wrong, amount2: wrong });
  assert.equal(third.status, 429); assert.equal(third.body.error, 'too_many_tries');
  assert.equal((await env.q('SELECT status FROM external_accounts WHERE id = $1', [r2.body.externalAccount.id])).rows[0].status, 'removed');

  at('2027-09-01T15:00:00Z');
  const r3 = await c.post('/api/pay/external-accounts', { routing: '123456780', accountNumber: '33334444' });
  at('2027-09-15T15:00:00Z');
  assert.ok((await c.get('/api/pay')).body.externalAccounts.some(e => e.id === r3.body.externalAccount.id));   // day 14: still there
  at('2027-09-16T15:00:00Z');
  const list = (await c.get('/api/pay')).body.externalAccounts.map(e => e.id);
  assert.ok(!list.includes(r3.body.externalAccount.id));
  assert.equal((await env.q('SELECT removed_reason FROM external_accounts WHERE id = $1', [r3.body.externalAccount.id])).rows[0].removed_reason, 'not verified in time');
  assert.ok(!(await env.q('SELECT detail::text d FROM audit_events')).rows.some(x => /9876543210|11112222|33334444/.test(x.d ?? '')));
});

test('a new external account has a 3-day hold on outgoing ACH; money can come in right away', async () => {
  const c = await stepped(JORDAN), from = await id('3388');
  const ext = await link(c, '44440000', '2027-04-05T15:00:00Z');                     // Monday 10 am CDT
  const out = await c.post('/api/pay/ach', { accountId: from, externalAccountId: ext, direction: 'out', amount: '10.00', idempotencyKey: key() });
  assert.equal(out.status, 409); assert.equal(out.body.error, 'new_account_hold'); assert.match(out.body.message, /3-day hold.*2027-04-08/);
  const inn = await c.post('/api/pay/ach', { accountId: from, externalAccountId: ext, direction: 'in', amount: '10.00', idempotencyKey: key() });
  assert.equal(inn.status, 200); assert.equal(inn.body.transfer.settlesOn, '2027-04-08');   // 3 business days
  at('2027-04-08T15:00:01Z');
  const later = await c.post('/api/pay/ach', { accountId: from, externalAccountId: ext, direction: 'out', amount: '10.00', idempotencyKey: key() });
  assert.equal(later.status, 200); assert.equal(later.body.transfer.processOn, '2027-04-08'); assert.equal(later.body.transfer.settlesOn, '2027-04-09');
});

test('an R01 return reverses the money with a new ledger entry; R03 on a pull never credits', async () => {
  const c = await stepped(NIZAM), chk = await id('4471');
  const ext = await link(c, '7770001', '2027-04-12T15:00:00Z');
  at('2027-04-15T21:30:00Z');                                                        // Thursday 4:30 pm CDT, before the ACH cut-off
  const before = await bal('4471');
  const r = await c.post('/api/pay/ach', { accountId: chk, externalAccountId: ext, direction: 'out', amount: '100.00', idempotencyKey: key() });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.transfer.settlesOn, '2027-04-16');
  assert.equal(await bal('4471'), before - 10000n);
  const firstEntry = (await env.q('SELECT entry_id FROM transfers WHERE id = $1', [r.body.transfer.id])).rows[0].entry_id;
  const linesBefore = (await env.q('SELECT id, amount_cents FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [firstEntry])).rows;
  at('2027-04-15T23:00:00Z'); await c.get('/api/pay');                              // past the cut-off: processing, not settled yet
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [r.body.transfer.id])).rows[0].status, 'processing');
  at('2027-04-16T15:00:00Z');
  const t = (await c.get('/api/pay')).body.activity.find(x => x.id === r.body.transfer.id);
  assert.equal(t.status, 'returned'); assert.equal(t.returnCode, 'R01'); assert.match(t.note, /insufficient funds/);
  assert.equal(await bal('4471'), before);
  assert.deepEqual((await env.q('SELECT id, amount_cents FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [firstEntry])).rows, linesBefore);
  const rev = (await env.q('SELECT reversal_entry_id FROM transfers WHERE id = $1', [r.body.transfer.id])).rows[0].reversal_entry_id;
  assert.ok(rev && rev !== firstEntry);
  assert.equal((await env.q("SELECT 1 FROM audit_events WHERE action = 'ach.returned' AND detail->>'return_code' = 'R01'")).rowCount, 1);

  const ext3 = await link(c, '8880003', '2027-04-19T15:00:00Z');
  const pull = await c.post('/api/pay/ach', { accountId: chk, externalAccountId: ext3, direction: 'in', amount: '40.00', idempotencyKey: key() });
  const b2 = await bal('4471');
  at('2027-04-22T15:00:00Z'); await c.get('/api/pay');
  const t3 = (await env.q('SELECT status, return_code FROM transfers WHERE id = $1', [pull.body.transfer.id])).rows[0];
  assert.deepEqual(t3, { status: 'returned', return_code: 'R03' });
  assert.equal(await bal('4471'), b2);
});

test('an ACH pull from a good account credits on its settlement day', async () => {
  const c = await stepped(NIZAM), sav = await id('9302'), ext = (await c.get('/api/pay')).body.externalAccounts.find(e => e.last4 === '6789').id;
  at('2027-07-02T22:30:00Z');                                                        // Friday 5:30 pm CDT: after the cut-off
  const r = await c.post('/api/pay/ach', { accountId: sav, externalAccountId: ext, direction: 'in', amount: '12.34', idempotencyKey: key() });
  assert.equal(r.body.transfer.processOn, '2027-07-06');                            // Monday Jul 5 is the July 4 holiday
  assert.equal(r.body.transfer.settlesOn, '2027-07-09');
  const b = await bal('9302');
  at('2027-07-09T15:00:00Z'); await c.post('/api/pay/run-due');
  assert.equal(await bal('9302'), b + 1234n);
});

test('wires: $25 fee, irrevocable confirmation, and after 4:30 pm CT they go the next business day', async () => {
  const c = await stepped(NIZAM), sav = await id('9302');
  const feeBefore = (await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'mm_wire_fees'")).rows[0].b;
  const wire = (extra = {}) => c.post('/api/pay/wires', { fromAccountId: sav, amount: '100.00', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780',
    accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key(), ...extra });
  const unconfirmed = await wire({ confirmIrrevocable: false });
  assert.equal(unconfirmed.body.error, 'confirm_required'); assert.match(unconfirmed.body.message, /irrevocable/);
  at('2026-11-25T22:29:00Z');                                                        // Wednesday 4:29 pm CST
  const q = await c.post('/api/pay/wires/quote', { fromAccountId: sav, amount: '100.00' });
  assert.deepEqual([q.body.quote.fee, q.body.quote.total, q.body.quote.sendsOn, q.body.quote.afterCutoff], ['25.00', '125.00', '2026-11-25', false]);
  const b = await bal('9302');
  const early = await wire();
  assert.equal(early.body.transfer.status, 'sent'); assert.equal(early.body.transfer.processOn, '2026-11-25');
  assert.equal(await bal('9302'), b - 12500n);
  assert.equal((await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'mm_wire_fees'")).rows[0].b, feeBefore + 2500n);
  at('2026-11-25T22:31:00Z');                                                        // 4:31 pm CST: Thanksgiving is next, so Friday
  const late = await wire();
  assert.equal(late.body.transfer.status, 'scheduled'); assert.equal(late.body.transfer.processOn, '2026-11-27'); assert.equal(late.body.quote.afterCutoff, true);
  at('2026-11-27T22:45:00Z');
  assert.equal((await c.post('/api/pay/wires/quote', { fromAccountId: sav, amount: '1.00' })).body.quote.sendsOn, '2026-11-30');
  await c.get('/api/pay');
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [late.body.transfer.id])).rows[0].status, 'sent');
  const row = (await env.q('SELECT * FROM transfers WHERE id = $1', [late.body.transfer.id])).rows[0];
  assert.equal(row.counterparty_last4, '5123'); assert.equal(open(row.counterparty_enc, `${row.user_id}:${row.id}`), '000555123');
});

test('joint owners can move money; a custodian puts money into a minor’s account but can’t take it out to their own; the minor is refused', async () => {
  const j = await signIn(env.base, ...JORDAN), joint = await id('7781'), jchk = await id('3388');
  const a = await j.post('/api/pay/transfers', { fromAccountId: joint, toAccountId: jchk, amount: '20.00', idempotencyKey: key() });
  assert.equal(a.status, 200); assert.equal(a.body.transfer.status, 'completed');
  const nz = await signIn(env.base, ...NIZAM), teen = await id('5120'), chk = await id('4471');
  const t0 = await bal('5120');
  assert.equal((await nz.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: teen, amount: '10.00', idempotencyKey: key() })).status, 200);
  const out = await nz.post('/api/pay/transfers', { fromAccountId: teen, toAccountId: chk, amount: '4.00', idempotencyKey: key() });
  assert.equal(out.status, 403); assert.equal(out.body.error, 'childs_money');      // the child's money stays the child's (R1)
  assert.equal(await bal('5120'), t0 + 1000n);
  const s = await stepped(NIZAM);
  const p = await s.post('/api/pay/p2p/send', { fromAccountId: teen, to: 'jordan@usabanc.example', amount: '1.00', idempotencyKey: key() });
  assert.equal(p.status, 403); assert.equal(p.body.error, 'not_allowed');           // a minor's money doesn't leave the bank
  const ava = await signIn(env.base, ...AVA);
  const m = await ava.post('/api/pay/transfers', { fromAccountId: teen, toAccountId: chk, amount: '1.00', idempotencyKey: key() });
  assert.equal(m.status, 403); assert.equal(m.body.error, 'minor_not_allowed'); assert.match(m.body.message, /parent or guardian/);
  assert.equal((await ava.get('/api/pay')).body.accounts.find(x => x.last4 === '5120').canMove, false);
});

test("someone else's account, external account, payee or schedule is a 404", async () => {
  const j = await stepped(JORDAN), nz = await stepped(NIZAM);
  const chk = await id('4471'), jchk = await id('3388');
  const ov = (await nz.get('/api/pay')).body;
  at('2027-02-01T16:00:00Z');
  const sched = await nz.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: await id('9302'), amount: '5.00', when: 'date', date: '2027-02-20', idempotencyKey: key() });
  const checks = [
    await j.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: jchk, amount: '1.00', idempotencyKey: key() }),
    await j.post('/api/pay/transfers', { fromAccountId: jchk, toAccountId: chk, amount: '1.00', idempotencyKey: key() }),
    await j.post('/api/pay/p2p/send', { fromAccountId: chk, to: '2025550142', amount: '1.00', idempotencyKey: key() }),
    await j.post('/api/pay/ach', { accountId: jchk, externalAccountId: ov.externalAccounts[0].id, direction: 'in', amount: '1.00', idempotencyKey: key() }),
    await j.post('/api/pay/bills', { fromAccountId: jchk, payeeId: ov.payees[0].id, amount: '1.00', idempotencyKey: key() }),
    await j.post('/api/pay/wires/quote', { fromAccountId: chk, amount: '1.00' }),
    await j.del(`/api/pay/external-accounts/${ov.externalAccounts[0].id}`),
    await j.post('/api/pay/transfers', { fromAccountId: 'not-a-uuid', toAccountId: jchk, amount: '1.00', idempotencyKey: key() })
  ];
  checks.push(await j.del(`/api/pay/schedules/${sched.body.schedule.id}`));
  for (const r of checks) { assert.equal(r.status, 404, JSON.stringify(r.body)); assert.equal(r.body.error, 'not_found'); }
  assert.equal((await nz.del(`/api/pay/schedules/${sched.body.schedule.id}`)).status, 200);
});

test('scheduled transfers run when due and can be canceled before; recurring ones keep going', async () => {
  const c = await signIn(env.base, ...NIZAM), chk = await id('4471'), sav = await id('9302');
  at('2027-08-10T15:00:00Z');
  const b = await bal('4471');
  const once = await c.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: sav, amount: '7.00', when: 'date', date: '2027-08-12', idempotencyKey: key() });
  assert.equal(once.status, 200, JSON.stringify(once.body)); assert.equal(once.body.schedule.nextRun, '2027-08-12');
  const cancel = await c.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: sav, amount: '8.00', when: 'date', date: '2027-08-12', idempotencyKey: key() });
  assert.equal((await c.del(`/api/pay/schedules/${cancel.body.schedule.id}`)).status, 200);
  const monthly = await c.post('/api/pay/transfers', { fromAccountId: chk, toAccountId: sav, amount: '3.00', when: 'monthly', date: '2027-08-31', idempotencyKey: key() });
  assert.equal(await bal('4471'), b);                                                 // nothing moves until it's due
  at('2027-08-12T15:00:00Z'); await c.get('/api/pay');
  assert.equal(await bal('4471'), b - 700n);
  assert.equal((await c.del(`/api/pay/schedules/${once.body.schedule.id}`)).body.error, 'already_done');
  at('2027-10-01T15:00:00Z');
  const ov = (await c.get('/api/pay')).body;
  assert.equal(await bal('4471'), b - 700n - 600n);                                  // Aug 31 and Sep 30
  assert.equal(ov.schedules.find(s => s.id === monthly.body.schedule.id).nextRun, '2027-10-31');
  const runs = await env.q("SELECT count(*)::int n FROM transfers WHERE schedule_id = $1 AND status = 'completed'", [monthly.body.schedule.id]);
  assert.equal(runs.rows[0].n, 2);
  assert.equal((await c.post('/api/pay/run-due')).body.ran, 0);                     // running again does nothing twice
  assert.equal((await c.del(`/api/pay/schedules/${monthly.body.schedule.id}`)).status, 200);
});

test('a scheduled transfer the account can no longer cover fails in plain words instead of overdrawing', async () => {
  const c = await stepped(NIZAM);
  at('2027-11-01T15:00:00Z');
  const r = await c.post('/api/pay/transfers', { fromAccountId: await id('9302'), toAccountId: await id('4471'), amount: '9000.00', when: 'date', date: '2027-11-03', idempotencyKey: key() });
  at('2027-11-03T15:00:00Z');
  const t = (await c.get('/api/pay')).body.activity.find(x => x.status === 'failed');
  assert.ok(t); assert.match(t.note, /isn't enough/);
  assert.equal((await env.q('SELECT status FROM scheduled_transfers WHERE id = $1', [r.body.schedule.id])).rows[0].status, 'done');
});

test('USA Pay to someone not enrolled waits for them; enrolling delivers it; unclaimed money comes back after 14 days', async () => {
  const nz = await stepped(NIZAM), chk = await id('4471');
  at('2027-12-01T16:00:00Z');
  const b = await bal('4471');
  const p = await nz.post('/api/pay/p2p/send', { fromAccountId: chk, to: '202-555-0199', amount: '15.00', memo: 'Lunch', idempotencyKey: key() });
  assert.equal(p.body.transfer.status, 'pending'); assert.equal(p.body.transfer.settlesOn, '2027-12-15');
  assert.equal(await bal('4471'), b - 1500n);
  const j = await stepped(JORDAN), jb = await bal('3388');
  const e = await j.post('/api/pay/p2p/enroll', { token: '2025550199', accountId: await id('3388') });   // a code goes to the phone first (R2)
  assert.equal(e.status, 200); assert.equal(e.body.enrolled, false); assert.equal(await bal('3388'), jb);
  const v = await j.post('/api/pay/p2p/enroll/verify', { verificationId: e.body.verificationId, code: e.body.demoCode });
  assert.equal(v.status, 200); assert.equal(v.body.released, 1);
  assert.equal(await bal('3388'), jb + 1500n);
  // asking for a code answers the same for a taken email (R2: no oracle); only the right code learns it is taken
  const taken = await j.post('/api/pay/p2p/enroll', { token: 'nizam@helixbots.ai', accountId: await id('3388') });
  assert.equal(taken.status, 200); assert.equal(taken.body.enrolled, false);
  assert.equal((await j.post('/api/pay/p2p/enroll/verify', { verificationId: taken.body.verificationId, code: taken.body.demoCode })).body.error, 'token_taken');

  const q = await nz.post('/api/pay/p2p/send', { fromAccountId: chk, to: 'ava@usabanc.example', amount: '5.00', idempotencyKey: key() });
  assert.equal(q.body.transfer.status, 'pending');
  const ava = await signIn(env.base, ...AVA);
  assert.equal((await ava.post('/api/pay/p2p/enroll', { token: 'ava@usabanc.example', accountId: await id('5120') })).body.error, 'minor_not_allowed');
  const b2 = await bal('4471');
  at('2027-12-15T16:00:00Z'); await nz.get('/api/pay');
  assert.equal(await bal('4471'), b2 + 500n);
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [q.body.transfer.id])).rows[0].status, 'expired');
  const unclaimed = await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'p2p_unclaimed'");
  assert.equal(unclaimed.rows[0].b, 0n);
  assert.equal((await nz.post('/api/pay/p2p/send', { fromAccountId: chk, to: 'nizam@helixbots.ai', amount: '1.00', idempotencyKey: key() })).body.error, 'self');
});

test('USA Pay requests and split bills: whole cents, paid through the ledger', async () => {
  const nz = await stepped(NIZAM), j = await stepped(JORDAN);
  const split = await nz.post('/api/pay/p2p/split', { total: '100.00', people: ['jordan@usabanc.example', '2025550188'], toAccountId: await id('4471'), memo: 'Dinner' });
  assert.equal(split.status, 200);
  assert.deepEqual(split.body.requests.map(r => r.amount), ['33.34', '33.33']); assert.equal(split.body.yourShare, '33.33');
  const req1 = (await j.get('/api/pay')).body.p2p.requestsIn.find(r => r.id === split.body.requests[0].id);
  assert.equal(req1.from, 'Nizam'); assert.equal(req1.amount, '33.34');
  const nb = await bal('4471');
  const body = { fromAccountId: await id('3388'), idempotencyKey: key() };
  const pay = await j.post(`/api/pay/p2p/requests/${req1.id}/pay`, body), again = await j.post(`/api/pay/p2p/requests/${req1.id}/pay`, body);
  assert.equal(pay.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(await bal('4471'), nb + 3334n);
  assert.equal((await nz.post(`/api/pay/p2p/requests/${req1.id}/pay`, { fromAccountId: await id('4471'), idempotencyKey: key() })).status, 404);
  const r2 = await nz.post('/api/pay/p2p/request', { from: 'jordan@usabanc.example', toAccountId: await id('4471'), amount: '9.99' });
  assert.equal((await j.post(`/api/pay/p2p/requests/${r2.body.request.id}/decline`)).body.status, 'declined');
});

test('bill pay: payees, a payment now with a delivery estimate, and a recurring one', async () => {
  const c = await stepped(NIZAM), chk = await id('4471');
  const p = await c.post('/api/pay/payees', { name: 'Metro Water', accountNumber: '4455667788' });
  assert.equal(p.status, 200); assert.equal(p.body.payee.accountLast4, '7788');
  assert.equal((await c.post('/api/pay/payees', { name: 'Nobody' })).body.error, 'missing');
  at('2027-03-05T16:00:00Z');                                                        // Friday morning
  const b = await bal('4471');
  const pay = await c.post('/api/pay/bills', { fromAccountId: chk, payeeId: p.body.payee.id, amount: '42.10', idempotencyKey: key() });
  assert.equal(pay.status, 200); assert.equal(pay.body.transfer.status, 'sent'); assert.equal(pay.body.transfer.settlesOn, '2027-03-09');
  assert.equal(await bal('4471'), b - 4210n);
  const rec = await c.post('/api/pay/bills', { fromAccountId: chk, payeeId: p.body.payee.id, amount: '10.00', when: 'weekly', date: '2027-03-08', idempotencyKey: key() });
  assert.equal(rec.body.schedule.cadence, 'weekly'); assert.equal(rec.body.schedule.deliverBy, '2027-03-10');
  at('2027-03-16T16:00:00Z'); await c.get('/api/pay');
  assert.equal(await bal('4471'), b - 4210n - 2000n);
  const row = (await env.q('SELECT * FROM payees WHERE id = $1', [p.body.payee.id])).rows[0];
  assert.equal(open(row.account_enc, `${row.user_id}:${row.id}`), '4455667788');
  assert.equal((await c.post('/api/pay/bills/estimate', { date: '2027-03-19' })).body.deliverBy, '2027-03-23');
  assert.equal((await c.del(`/api/pay/schedules/${rec.body.schedule.id}`)).status, 200);
});

test('step-up by amount: your own accounts from $5,000, ACH pulls from $1,000; the rules are data', async () => {
  const c = await signIn(env.base, ...NIZAM);                      // no recent code
  const joint = await id('7781'), chk = await id('4471'), ext = (await c.get('/api/pay')).body.externalAccounts.find(e => e.last4 === '6789').id;
  const rules = (await env.q('SELECT rail, step_up_cents FROM limit_profiles WHERE user_id IS NULL ORDER BY rail')).rows.map(r => [r.rail, r.step_up_cents]);
  assert.deepEqual(rules, [['ach', 100000n], ['billpay', 0n], ['internal', 500000n], ['p2p', 0n], ['wire', 0n]]);
  const move = (from, to, amount) => c.post('/api/pay/transfers', { fromAccountId: from, toAccountId: to, amount, idempotencyKey: key() });
  assert.equal((await move(joint, chk, '5000.00')).body.error, 'stepup_required');
  assert.equal((await move(joint, chk, '4999.99')).status, 200);
  assert.equal((await move(chk, joint, '4999.99')).status, 200);
  const pull = amount => c.post('/api/pay/ach', { accountId: chk, externalAccountId: ext, direction: 'in', amount, idempotencyKey: key() });
  assert.equal((await pull('1000.00')).body.error, 'stepup_required');
  const small = await pull('999.99');
  assert.equal(small.status, 200); assert.equal(small.body.transfer.status, 'pending');
  assert.equal((await c.call('DELETE', `/api/pay/transfers/${small.body.transfer.id}`)).status, 200);
});

test('instant verification (simulated): a wrong sign-in is refused; the demo sign-in links a verified account with the hold', async () => {
  const c = await stepped(JORDAN), from = await id('3388');
  const bad = await c.post('/api/pay/external-accounts/instant', { bank: 'prairie', username: 'user_good', password: 'nope' });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'instant_failed'); assert.match(bad.body.message, /Simulated/);
  assert.equal((await c.post('/api/pay/external-accounts/instant', { bank: 'nowhere', username: 'user_good', password: 'pass_good' })).body.error, 'bad_bank');
  at('2027-06-01T15:00:00Z');
  const ok = await c.post('/api/pay/external-accounts/instant', { bank: 'prairie', username: 'user_good', password: 'pass_good' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.externalAccount.status, ok.body.externalAccount.method, ok.body.externalAccount.institution], ['verified', 'instant', 'Prairie National Bank']);
  assert.equal((await c.post('/api/pay/external-accounts/instant', { bank: 'prairie', username: 'user_good', password: 'pass_good' })).body.error, 'already_linked');
  const out = await c.post('/api/pay/ach', { accountId: from, externalAccountId: ok.body.externalAccount.id, direction: 'out', amount: '5.00', idempotencyKey: key() });
  assert.equal(out.body.error, 'new_account_hold');
  const row = (await env.q('SELECT * FROM external_accounts WHERE id = $1', [ok.body.externalAccount.id])).rows[0];
  assert.equal(open(row.number_enc, `${row.user_id}:${row.id}`).slice(-4), row.number_last4);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'ach.link' AND detail->>'method' = 'instant'")).rowCount >= 1);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'ach.link_instant_failed'")).rowCount >= 1);
  const unl = await stepped(NIZAM);
  assert.equal((await unl.post('/api/pay/external-accounts/instant', { bank: 'prairie', username: 'user_good', password: 'pass_good' })).status, 200);   // per person
});

test('cancel: ACH before its cut-off and a wire not yet sent come back in full; once processing or sent they cannot', async () => {
  const c = await stepped(NIZAM), chk = await id('4471'), sav = await id('9302');
  const ext = (await c.get('/api/pay')).body.externalAccounts.find(e => e.last4 === '6789').id;
  const ach = amount => c.post('/api/pay/ach', { accountId: chk, externalAccountId: ext, direction: 'out', amount, idempotencyKey: key() });
  const leftToday = async () => (await c.get('/api/pay')).body.limits.find(l => l.rail === 'ach').leftToday;
  at('2027-06-09T15:00:00Z');                                                        // Wednesday 10 am CDT
  const b = await bal('4471'), left = await leftToday();
  const a = await ach('50.00');
  assert.equal(a.body.transfer.canCancel, true);
  assert.equal(await bal('4471'), b - 5000n);
  const x = await c.del(`/api/pay/transfers/${a.body.transfer.id}`);
  assert.equal(x.status, 200); assert.equal(x.body.transfer.status, 'canceled');
  assert.equal(await bal('4471'), b); assert.equal(await leftToday(), left);       // the money and the limit both come back
  const usage = (await env.q('SELECT reason, amount_cents FROM limit_usage WHERE transfer_id = $1 ORDER BY id', [a.body.transfer.id])).rows;
  assert.deepEqual(usage.map(u => [u.reason, u.amount_cents]), [['used', 5000n], ['canceled', -5000n]]);
  await assert.rejects(env.q('UPDATE limit_usage SET amount_cents = 1 WHERE transfer_id = $1', [a.body.transfer.id]), /append-only/);
  await assert.rejects(env.q('DELETE FROM limit_usage WHERE transfer_id = $1', [a.body.transfer.id]), /append-only/);
  assert.equal((await c.del(`/api/pay/transfers/${a.body.transfer.id}`)).body.error, 'cannot_cancel');

  const late = await ach('60.00');
  at('2027-06-09T23:00:00Z');                                                        // 6 pm CDT: past the 5 pm cut-off
  const y = await c.del(`/api/pay/transfers/${late.body.transfer.id}`);
  assert.equal(y.status, 409); assert.match(y.body.message, /already being processed/);

  const wire = () => c.post('/api/pay/wires', { fromAccountId: sav, amount: '200.00', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780',
    accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key() });
  const fees = async () => (await env.q("SELECT balance_cents b FROM accounts WHERE system_code = 'mm_wire_fees'")).rows[0].b;
  const sb = await bal('9302'), fb = await fees();
  const w = await wire();
  assert.equal(w.body.transfer.status, 'scheduled'); assert.equal(w.body.transfer.canCancel, true);
  assert.equal(await bal('9302'), sb - 22500n);
  assert.equal((await c.del(`/api/pay/transfers/${w.body.transfer.id}`)).body.transfer.status, 'canceled');
  assert.equal(await bal('9302'), sb); assert.equal(await fees(), fb);             // the fee is refunded too
  at('2027-06-10T15:00:00Z');
  const sent = await wire();
  assert.equal(sent.body.transfer.status, 'sent'); assert.equal(sent.body.transfer.canCancel, false);
  const z = await c.del(`/api/pay/transfers/${sent.body.transfer.id}`);
  assert.equal(z.status, 409); assert.match(z.body.message, /irrevocable/);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'transfer.cancel_refused'")).rowCount >= 2);
  const j = await stepped(JORDAN);
  assert.equal((await j.del(`/api/pay/transfers/${late.body.transfer.id}`)).status, 404);
});

test('Simulate settlement finishes ACH, wires and bill payments now, through the in-transit and network accounts', async () => {
  const c = await stepped(NIZAM), chk = await id('4471'), sav = await id('9302');
  const ov = (await c.get('/api/pay')).body, ext = ov.externalAccounts.find(e => e.last4 === '6789').id;
  const sys = async code => (await env.q('SELECT balance_cents b FROM accounts WHERE system_code = $1', [code])).rows[0].b;
  at('2027-06-14T23:30:00Z');                                                        // Monday 6:30 pm CDT: after every cut-off
  const before = { chk: await bal('4471'), sav: await bal('9302'), net: await sys('mm_network'), achOut: await sys('mm_ach_out'), bill: await sys('mm_billpay'), wire: await sys('mm_wire_out') };
  const pull = await c.post('/api/pay/ach', { accountId: sav, externalAccountId: ext, direction: 'in', amount: '20.00', idempotencyKey: key() });
  const push = await c.post('/api/pay/ach', { accountId: chk, externalAccountId: ext, direction: 'out', amount: '30.00', idempotencyKey: key() });
  const w = await c.post('/api/pay/wires', { fromAccountId: sav, amount: '40.00', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780', accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key() });
  const bill = await c.post('/api/pay/bills', { fromAccountId: chk, payeeId: ov.payees[0].id, amount: '10.00', idempotencyKey: key() });
  for (const r of [pull, push, w, bill]) { assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.transfer.canSimulate, true); }
  assert.equal(await sys('mm_ach_out'), before.achOut + 3000n);                      // waiting in transit
  const one = await c.post('/api/pay/simulate-settlement', { transferId: pull.body.transfer.id });
  assert.deepEqual(one.body.settled.map(t => [t.status, t.simulated]), [['settled', true]]);
  assert.equal(await bal('9302'), before.sav + 2000n - 4000n - 2500n);
  const all = await c.post('/api/pay/simulate-settlement', {});
  assert.deepEqual(all.body.settled.map(t => [t.rail, t.status]).sort(), [['ach', 'settled'], ['billpay', 'paid'], ['wire', 'sent']]);   // the clock is frozen, so no order
  assert.ok(all.body.settled.every(t => t.simulated && t.settledAt && !t.canCancel && !t.canSimulate));
  assert.equal(await sys('mm_ach_out'), before.achOut); assert.equal(await sys('mm_billpay'), before.bill); assert.equal(await sys('mm_wire_out'), before.wire);
  assert.equal(await sys('mm_network'), before.net + 3000n + 4000n + 1000n);
  assert.deepEqual((await c.post('/api/pay/simulate-settlement', {})).body.settled, []);
  assert.equal((await c.post('/api/pay/simulate-settlement', { transferId: pull.body.transfer.id })).body.error, 'nothing_to_settle');
  const j = await stepped(JORDAN);
  assert.equal((await j.post('/api/pay/simulate-settlement', { transferId: push.body.transfer.id })).status, 404);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'settlement.simulated' AND (detail->>'count')::int = 3")).rowCount);
});

test('every money movement is audited and the ledger still balances', async () => {
  const acts = new Set((await env.q('SELECT DISTINCT action FROM audit_events')).rows.map(r => r.action));
  for (const a of ['transfer.internal', 'transfer.scheduled', 'transfer.canceled', 'transfer.failed', 'p2p.send', 'p2p.pending', 'p2p.released', 'p2p.expired', 'ach.send',
    'ach.returned', 'ach.settled', 'ach.processing', 'wire.send', 'wire.sent', 'billpay.send', 'billpay.paid', 'payee.add', 'ach.link', 'ach.verify_ok', 'limit.check',
    'limit.change', 'settlement.simulated', 'transfer.cancel_refused']) assert.ok(acts.has(a), a);
  const bad = await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY 1) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`);
  assert.equal(bad.rowCount, 0);
  // money movement only goes through its own system accounts (UUID ...20-...29) and customer accounts
  const sys = (await env.q(`SELECT DISTINCT a.id FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.kind = 'system' AND j.idempotency_key LIKE '%:money-movement:%'`)).rows.map(r => r.id);
  assert.ok(sys.length >= 6);
  for (const s of sys) assert.match(s, /^00000000-0000-4000-8000-00000000002\d$/);
});
