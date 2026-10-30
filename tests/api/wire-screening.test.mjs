import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('hex');      // test-only key, made fresh for each run
const { testEnv, signIn, client } = await import('../helpers.mjs');
const { clock } = await import('../../lib/money-movement/calendar.mjs');
const { tx } = await import('../../lib/db.mjs');
const { hashPassword, newId } = await import('../../lib/auth.mjs');
const { post, systemAccount } = await import('../../lib/ledger.mjs');
const { screen, tokens, nameRule } = await import('../../lib/wire-screening/screening.mjs');

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const at = iso => { clock.now = () => new Date(iso); };
// Wednesday 4 November 2026 (CST, UTC-6): 9:00 am, before both cut-offs
const WED_9AM = '2026-11-04T15:00:00Z';

let n = 0;
const key = () => `ws-${Date.now()}-${++n}`;
const BEN = '000555123456';
/** A customer who signs straight in. */
async function person(name, { staff = false } = {}) {
  const id = newId(), username = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@example.test`;
  await env.q('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,$5)',
    [id, username, name, await hashPassword('pw-' + name), '11']);
  if (staff) await env.q("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'compliance')", [id]);
  return { id, username, password: 'pw-' + name };
}
/** An account with these owners, funded from bank equity. */
async function account(owners, { cents = 0n, kind = 'checking', status = 'open' } = {}) {
  const id = newId();
  await env.q(`INSERT INTO accounts (id, kind, name, number_last4, status) VALUES ($1,$2,'Test Account',$3,$4)`, [id, kind, String(1000 + (++n % 9000)), status]);
  for (const [who, role] of owners) await env.q('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, who.id, role]);
  if (cents) await fund(id, cents);
  return id;
}
const fund = (id, cents) => tx(env.pool, async c => post(c, { key: `test-fund:${newId()}`, kind: 'seed', lines: [
  { accountId: await systemAccount(c, 'equity'), amountCents: -cents, description: 'Test funding' },
  { accountId: id, amountCents: cents, description: 'Test funding' }] }));
const bal = async id => (await env.q('SELECT balance_cents b FROM accounts WHERE id = $1', [id])).rows[0].b;
const sys = async code => (await env.q('SELECT balance_cents b FROM accounts WHERE system_code = $1', [code])).rows[0].b;
const signedIn = p => signIn(env.base, p.username, p.password);
async function stepped(p) {
  const c = await signedIn(p);
  const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
  return c;
}
const body = (fromAccountId, extra = {}) => ({ idempotencyKey: key(), fromAccountId, type: 'domestic', amountCents: 250000, beneficiaryName: 'Pat Lee',
  beneficiaryBankName: 'Prairie National Bank', bankIdentifier: '111111118', accountNumber: BEN, country: 'US', purpose: 'Rent for March', ...extra });
const intl = (fromAccountId, extra = {}) => body(fromAccountId, { type: 'international', bankIdentifier: 'norbxn2l', accountNumber: 'XN12 3456 7890 1234', country: 'XN', ...extra });
const audits = async (wireId, action) => (await env.q("SELECT * FROM audit_events WHERE detail->>'wire' = $1 AND ($2::text IS NULL OR action = $2) ORDER BY id", [wireId, action ?? null])).rows;
const countWires = async acct => (await env.q('SELECT count(*)::int n FROM wire_requests WHERE from_account_id = $1', [acct])).rows[0].n;
const wireLimit = async c => (await c.get('/api/pay/limits')).body.limits.find(l => l.rail === 'wire');
/** An owner, a joint owner and a staff member, with a funded joint checking account. */
async function household(cents = 5_000_000n) {
  const owner = await person('Owner'), joint = await person('Joint'), staff = await person('Staff', { staff: true });
  const acct = await account([[owner, 'owner'], [joint, 'joint_owner']], { cents });
  return { owner, joint, staff, acct };
}

// ---------- screening rules (5.4, R13, R14) ----------
test('screening: tokens, exact and similar names, countries and the worst result', () => {
  assert.deepEqual(tokens('  The José-Álvaro  PENHALIGON, Ltd. '), ['jose', 'alvaro', 'penhaligon']);
  assert.equal(screen('penhaligon jose alvaro', 'US').result, 'hit');                       // any order, case or accents
  assert.equal(screen('Jose Alvaro Penhaligon', 'US').result, 'hit');
  assert.equal(screen('Kestrel Obsidian Shipping', 'GB').result, 'hit');                    // ignored words don't matter
  assert.equal(screen('The Bakhtiyar Soomrai Trading Company', 'US').result, 'clear');     // "company" is an extra word, and too far off
  assert.equal(screen('HMH Trading Inc', 'US').result, 'hit');                              // an alias
  assert.equal(screen('Viktor Dolenko', 'US').result, 'clear');                             // a missing word: not exact, and too far to be similar
  assert.equal(screen('Olwen Tarsk Smith', 'US').result, 'clear');                          // an extra word
  assert.deepEqual(screen('Olwen Tarsc', 'US'), { result: 'potential_match', matches: [{ kind: 'name', rule: 'similar', listId: 'SL-1004' }] });
  assert.equal(nameRule('Olwen Tarsk', 'Olwen Tarsk'), 'exact_tokens');
  assert.equal(nameRule('Olwen Tarskk', 'Olwen Tarsk'), 'similar');                         // L = 12... "olwen tarskk" 12 chars, d = 1
  assert.equal(nameRule('Olwen Tursc', 'Olwen Tarsk'), null);                               // L = 11 < 12: d = 2 is too far
  assert.equal(nameRule('Marisol Quentarul', 'Marisol Quenteral'), 'similar');              // L = 17: d = 2 is close enough
  assert.equal(nameRule('Marisol Quuntarul', 'Marisol Quenteral'), null);                   // d = 3
  assert.equal(nameRule('Ilyana Voss Marchetti', 'Ilyana Voss-Marchetti'), 'exact_tokens'); // punctuation separates
  assert.equal(nameRule('Inc Ltd', 'Olwen Tarsk'), null);                                   // nothing left after ignored words: never exact
  assert.deepEqual(screen('Pat Lee', 'XV'), { result: 'hit', matches: [{ kind: 'country', rule: 'sanctioned_country', listId: 'XV' }] });
  assert.deepEqual(screen('Pat Lee', 'XT'), { result: 'potential_match', matches: [{ kind: 'country', rule: 'watch_country', listId: 'XT' }] });
  assert.deepEqual(screen('Olwen Tarsc', 'XS'), { result: 'hit', matches: [{ kind: 'name', rule: 'similar', listId: 'SL-1004' },
    { kind: 'country', rule: 'sanctioned_country', listId: 'XS' }] });                     // names first, then the country; worst wins
  assert.equal(screen('Pat Lee', 'XN').result, 'clear');
});

// ---------- access ----------
test('R1: every endpoint needs a signed-in user', async () => {
  const c = client(env.base), id = newId();
  const calls = [['POST', '/api/wire-requests'], ['GET', '/api/wire-requests'], ['GET', `/api/wire-requests/${id}`], ['GET', `/api/wire-requests/availability/${id}`],
    ['POST', `/api/wire-requests/${id}/approve`], ['POST', `/api/wire-requests/${id}/cancel`], ['GET', '/api/compliance/cases'], ['GET', `/api/compliance/cases/${id}`],
    ['POST', `/api/compliance/wires/${id}/release`], ['POST', `/api/compliance/wires/${id}/reject`], ['POST', `/api/compliance/cases/${id}/close`]];
  for (const [m, p] of calls) {
    const r = await c.call(m, p, { idempotencyKey: key(), reason: 'some reason' });
    assert.deepEqual([r.status, r.body.error], [401, 'signed_out'], `${m} ${p}`);
  }
});

test('R2, R3: staff endpoints need the compliance role; customers see only wires on their own accounts', async () => {
  at(WED_9AM);
  const { owner, joint, staff, acct } = await household();
  const stranger = await person('Stranger'), viewer = await person('Viewer');
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'viewer')", [acct, viewer.id]);
  const o = await stepped(owner), j = await signedIn(joint), s = await signedIn(staff), x = await signedIn(stranger), v = await signedIn(viewer);
  const w = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_500_000 }))).body.wire;
  const hit = (await o.post('/api/wire-requests', body(acct, { beneficiaryName: 'Olwen Tarsk' }))).body.wire;
  const caseId = (await env.q('SELECT id FROM compliance_cases WHERE wire_id = $1', [hit.id])).rows[0].id;
  // not staff (even the owner of the wire's account): 403 on 7 to 11
  for (const [m, p] of [['GET', '/api/compliance/cases'], ['GET', `/api/compliance/cases/${caseId}`], ['POST', `/api/compliance/wires/${hit.id}/release`],
    ['POST', `/api/compliance/wires/${hit.id}/reject`], ['POST', `/api/compliance/cases/${caseId}/close`]]) {
    const r = await o.call(m, p, { reason: 'looks fine to me' });
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], `${m} ${p}`);
  }
  // staff: unknown or malformed ids are 404
  for (const [m, p] of [['GET', `/api/compliance/cases/${newId()}`], ['GET', '/api/compliance/cases/nope'], ['POST', `/api/compliance/wires/${newId()}/release`],
    ['POST', '/api/compliance/wires/nope/reject'], ['POST', `/api/compliance/cases/${newId()}/close`]]) {
    const r = await s.call(m, p, { reason: 'looks fine to me' });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${m} ${p}`);
  }
  // staff have no customer rights on wires of accounts they don't own
  assert.deepEqual((await s.get('/api/wire-requests')).body.wires, []);
  assert.equal((await s.get(`/api/wire-requests/${w.id}`)).status, 404);
  // a stranger, a viewer, unknown and malformed ids: 404 and nothing changes
  for (const c of [x, v]) {
    assert.equal((await c.get(`/api/wire-requests/${w.id}`)).status, 404);
    assert.equal((await c.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'not_found');
    assert.equal((await c.post(`/api/wire-requests/${w.id}/cancel`)).body.error, 'not_found');
    assert.equal((await c.get(`/api/wire-requests/availability/${acct}`)).status, 404);
    assert.deepEqual((await c.get('/api/wire-requests')).body.wires, []);
  }
  for (const id of [newId(), 'not-a-uuid']) {
    assert.equal((await o.get(`/api/wire-requests/${id}`)).status, 404);
    assert.equal((await o.post(`/api/wire-requests/${id}/cancel`)).status, 404);
    assert.equal((await o.get(`/api/wire-requests/availability/${id}`)).status, 404);
  }
  assert.equal((await env.q('SELECT status FROM wire_requests WHERE id = $1', [w.id])).rows[0].status, 'awaiting_approval');
  // the co-owner sees the wires the other owner requested, newest first, and can filter by status
  assert.deepEqual((await j.get('/api/wire-requests')).body.wires.map(x => x.id), [hit.id, w.id]);
  assert.deepEqual((await j.get('/api/wire-requests?status=stopped')).body.wires.map(x => x.id), [hit.id]);
  assert.equal((await j.get('/api/wire-requests?status=nope')).body.error, 'bad_status');
  assert.equal((await j.get(`/api/wire-requests/${w.id}`)).body.wire.id, w.id);
  assert.equal((await s.get('/api/compliance/cases?status=nope')).body.error, 'bad_status');
});

// ---------- requesting ----------
test('R5-R10, R12: validation in order, then the account, then step-up; nothing is created on any refusal', async () => {
  at(WED_9AM);
  const { owner, joint, acct } = await household();
  const o = await stepped(owner), plain = await signedIn(owner);
  const other = await account([[joint, 'owner']], { cents: 100000n });
  const minor = await person('Kid'), custodial = await account([[owner, 'custodian'], [minor, 'minor']], { cents: 100000n, kind: 'checking' });
  const card = await account([[owner, 'owner']], { kind: 'credit_card' });
  await env.q('UPDATE accounts SET allow_negative = true WHERE id = $1', [card]);
  const frozen = await account([[owner, 'owner']], { cents: 100000n, status: 'frozen' });
  const cases = [
    [{ idempotencyKey: undefined }, 400, 'idempotency_key_required'], [{ idempotencyKey: 'short' }, 400, 'idempotency_key_required'],
    [{ type: 'Domestic' }, 400, 'bad_type'], [{ type: undefined, amountCents: 'x' }, 400, 'bad_type'],
    ...[undefined, '2500', 25.5, 0, -1, 10_000_000_001, true, [1]].map(a => [{ amountCents: a, beneficiaryName: '' }, 400, 'bad_amount']),
    [{ beneficiaryName: ' a ' }, 400, 'bad_beneficiary'], [{ beneficiaryName: '-- !!' }, 400, 'bad_beneficiary'], [{ beneficiaryName: 'x'.repeat(101) }, 400, 'bad_beneficiary'],
    [{ beneficiaryName: 7, beneficiaryBankName: '' }, 400, 'bad_beneficiary'],
    [{ beneficiaryBankName: 'B', bankIdentifier: 'nope' }, 400, 'bad_bank'], [{ beneficiaryBankName: 'x'.repeat(81) }, 400, 'bad_bank'],
    [{ bankIdentifier: '111111119', accountNumber: '1' }, 400, 'bad_bank_identifier'], [{ bankIdentifier: 111111118 }, 400, 'bad_bank_identifier'],
    [{ type: 'international', bankIdentifier: '111111118' }, 400, 'bad_bank_identifier'], [{ type: 'international', bankIdentifier: 'NORBXN2LX' }, 400, 'bad_bank_identifier'],
    [{ accountNumber: '1234567', country: 'ZZ' }, 400, 'bad_account_number'], [{ accountNumber: '12345678901234567X' }, 400, 'bad_account_number'],
    [{ accountNumber: 12345678 }, 400, 'bad_account_number'],
    [{ type: 'international', bankIdentifier: 'NORBXN2L', accountNumber: 'X'.repeat(35) }, 400, 'bad_account_number'],
    [{ country: 'us' }, 400, 'bad_country'], [{ country: 'XN' }, 400, 'bad_country'], [{ type: 'international', bankIdentifier: 'NORBXN2L', country: 'US' }, 400, 'bad_country'],
    [{ country: 'ZZ', purpose: '' }, 400, 'bad_country'],
    [{ purpose: ' ab ', fromAccountId: undefined }, 400, 'bad_purpose'], [{ purpose: 'x'.repeat(141) }, 400, 'bad_purpose'],
    [{ fromAccountId: undefined }, 400, 'bad_account'], [{ fromAccountId: 12 }, 400, 'bad_account'],
    [{ fromAccountId: newId() }, 404, 'not_found'], [{ fromAccountId: 'nope' }, 404, 'not_found'], [{ fromAccountId: other }, 404, 'not_found'],
    [{ fromAccountId: custodial }, 404, 'not_found'], [{ fromAccountId: card }, 400, 'bad_account'], [{ fromAccountId: frozen }, 409, 'account_not_open']
  ];
  for (const [extra, status, code] of cases) {
    const r = await o.post('/api/wire-requests', body(acct, extra));
    assert.deepEqual([r.status, r.body.error], [status, code], JSON.stringify(extra));
    assert.ok(r.body.message, 'every error says what to do');
  }
  const noStep = await plain.post('/api/wire-requests', body(acct, { amountCents: 100 }));
  assert.deepEqual([noStep.status, noStep.body.error], [403, 'stepup_required']);
  assert.equal(await countWires(acct), 0);
  assert.equal((await env.q("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'wire.%' AND user_id = $1", [owner.id])).rows[0].n, 0);
});

test('R4, R29, R32, R35, R36: a clear wire under $10,000 is released at once: one entry of four lines, a transfers row, the limit, sent before the cut-off', async () => {
  at(WED_9AM);
  const owner = await person('Solo'), acct = await account([[owner, 'owner']], { cents: 1_000_000n });
  const o = await stepped(owner);
  const before = { acct: await bal(acct), out: await sys('mm_wire_out'), fees: await sys('mm_wire_fees'), net: await sys('mm_network') };
  const limitBefore = await wireLimit(o);
  const r = await o.post('/api/wire-requests', body(acct, { beneficiaryName: '  Pat Lee  ', accountNumber: '0005-5512 3456' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = r.body.wire;
  assert.equal(r.body.replayed, false);
  assert.deepEqual({ ...w, id: undefined, entryId: undefined, createdAt: undefined, releasedAt: undefined }, {
    id: undefined, status: 'released', type: 'domestic', fromAccountId: acct, amountCents: 250000, feeCents: 2500,
    beneficiary: { name: 'Pat Lee', bankName: 'Prairie National Bank', bankIdentifier: '111111118', accountMasked: '****3456', country: 'US' },
    purpose: 'Rent for March', screening: { result: 'clear' }, secondApprovalRequired: false, requestedBy: owner.id, approvedBy: null, approvedAt: null,
    holdCents: 0, valueDate: '2026-11-04', entryId: undefined, createdAt: undefined, releasedAt: undefined });
  assert.ok(w.entryId && w.releasedAt && w.createdAt);
  // the ledger entry
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [w.entryId])).rows[0];
  assert.deepEqual([e.kind, e.memo, e.idempotency_key], ['wire', 'Rent for March', `${owner.id}:wire-screening:${w.id}:release`]);
  const lines = (await env.q('SELECT account_id, amount_cents, category, description, posted_on FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [w.entryId])).rows;
  assert.deepEqual(lines.map(l => [l.account_id, l.amount_cents, l.category, l.posted_on]), [
    [acct, -250000n, 'Transfers', '2026-11-04'], [acct, -2500n, 'Fees & Charges', '2026-11-04'],
    [await env.q("SELECT id FROM accounts WHERE system_code = 'mm_wire_out'").then(x => x.rows[0].id), 250000n, null, '2026-11-04'],
    [await env.q("SELECT id FROM accounts WHERE system_code = 'mm_wire_fees'").then(x => x.rows[0].id), 2500n, null, '2026-11-04']]);
  assert.equal(lines[0].description, 'Domestic wire to Pat Lee at Prairie National Bank ··3456');
  assert.equal(lines[1].description, 'Outgoing domestic wire fee');
  // the transfers row, the limit and the send (before 4:30 pm CT: at once, from mm_wire_out to mm_network)
  const t = (await env.q('SELECT * FROM transfers WHERE id = $1', [w.id])).rows[0];
  assert.deepEqual([t.rail, t.user_id, t.process_on, t.idempotency_key, t.status, t.entry_id], ['wire', owner.id, '2026-11-04', e.idempotency_key, 'sent', w.entryId]);
  assert.equal((await env.q("SELECT count(*)::int n FROM journal_entries WHERE idempotency_key = $1 AND kind = 'wire_send'", [`${e.idempotency_key}:send`])).rows[0].n, 1);
  const limitAfter = await wireLimit(o);
  assert.equal(Number(limitAfter.usedToday) - Number(limitBefore.usedToday), 2500);
  assert.equal(Number(limitAfter.usedMonth) - Number(limitBefore.usedMonth), 2500);
  // exact money: the customer pays amount + fee, the fee goes to fee income, the amount reaches the network
  assert.equal(await bal(acct), before.acct - 252500n);
  assert.equal(await sys('mm_wire_fees'), before.fees + 2500n);
  assert.equal(await sys('mm_wire_out'), before.out);
  assert.equal(await sys('mm_network'), before.net + 250000n);
  assert.equal((await env.q('SELECT sum(amount_cents)::bigint s FROM ledger_lines WHERE account_id = $1', [acct])).rows[0].s, await bal(acct));
  // audit: requested, screened, released, each once, by the requester
  const ev = await audits(w.id);
  assert.deepEqual(ev.map(x => [x.action, x.user_id]), [['wire.requested', owner.id], ['wire.screened', owner.id], ['wire.released', owner.id]]);
  assert.deepEqual(ev[0].detail, { wire: w.id, type: 'domestic', amountCents: 250000, feeCents: 2500, country: 'US' });
  assert.deepEqual(ev[1].detail, { wire: w.id, result: 'clear', matches: [], case: null });
  assert.deepEqual(ev[2].detail, { wire: w.id, entry: w.entryId, valueDate: '2026-11-04', amountCents: 250000, feeCents: 2500 });
  // R37: the full account number is nowhere but encrypted
  const stored = (await env.q('SELECT account_enc FROM wire_requests WHERE id = $1', [w.id])).rows[0].account_enc;
  assert.ok(stored.startsWith('v1.') && !stored.includes(BEN));
  for (const sql of ["SELECT detail::text s FROM audit_events WHERE detail::text LIKE '%000555123456%'", "SELECT description s FROM ledger_lines WHERE description LIKE '%000555123456%'",
    "SELECT counterparty s FROM transfers WHERE counterparty LIKE '%000555123456%'"])
    assert.equal((await env.q(sql)).rowCount, 0, sql);
  assert.ok(!JSON.stringify(r.body).includes(BEN) && !JSON.stringify((await o.get('/api/wire-requests')).body).includes(BEN));
  assert.ok(!JSON.stringify((await o.get('/api/pay')).body).includes(BEN));
  // in the list and detail
  assert.deepEqual((await o.get(`/api/wire-requests/${w.id}`)).body.wire, w);
  assert.deepEqual((await o.get('/api/wire-requests')).body.wires, [w]);
});

test('R11: the same request id replays; a different request with it is refused; keys belong to the customer; simultaneous requests make one wire', async () => {
  at(WED_9AM);
  const { owner, joint, acct } = await household();
  const other = await account([[joint, 'owner']], { cents: 1_000_000n });
  const o = await stepped(owner), o2 = await stepped(owner), j = await stepped(joint);
  const b = body(acct, { amountCents: 2_000_000 });
  const first = await o.post('/api/wire-requests', b);
  assert.equal(first.body.wire.status, 'awaiting_approval');
  const again = await o2.post('/api/wire-requests', b);                     // another session
  assert.deepEqual([again.status, again.body.replayed, again.body.wire.id], [200, true, first.body.wire.id]);
  const diff = await o2.post('/api/wire-requests', { ...b, amountCents: 2_000_001 });
  assert.deepEqual([diff.status, diff.body.error], [422, 'idempotency_conflict']);
  const diffSame = await o.post('/api/wire-requests', { ...b, purpose: 'Something else' });
  assert.deepEqual([diffSame.status, diffSame.body.error], [422, 'idempotency_conflict']);
  assert.equal(await countWires(acct), 1);
  assert.equal((await audits(first.body.wire.id)).length, 2);
  assert.equal((await env.q('SELECT count(*)::int n FROM compliance_cases WHERE wire_id = $1', [first.body.wire.id])).rows[0].n, 0);
  // another customer with the same key string gets their own wire
  const theirs = await j.post('/api/wire-requests', { ...b, fromAccountId: other, amountCents: 1000 });
  assert.equal(theirs.status, 200); assert.notEqual(theirs.body.wire.id, first.body.wire.id); assert.equal(theirs.body.replayed, false);
  // simultaneous identical requests
  const same = body(acct, { amountCents: 400_000 });
  const rs = await Promise.all(Array.from({ length: 6 }, () => o.post('/api/wire-requests', same)));
  assert.ok(rs.every(x => x.status === 200), JSON.stringify(rs.map(x => x.body)));
  assert.equal(new Set(rs.map(x => x.body.wire.id)).size, 1);
  assert.equal(rs.filter(x => !x.body.replayed).length, 1);
  assert.equal(await countWires(acct), 2);
  // a refused request records nothing, so the same key can be used again once it is fixed
  const k = key();
  assert.equal((await o.post('/api/wire-requests', body(acct, { idempotencyKey: k, amountCents: 1_000_000_000 }))).body.error, 'over_limit');
  assert.equal((await o.post('/api/wire-requests', body(acct, { idempotencyKey: k, amountCents: 1000 }))).body.wire.status, 'released');
});

// ---------- holds, approvals ----------
test('R17-R23: a wire from $10,000 holds its money and waits for the other owner; held money cannot be spent elsewhere', async () => {
  at(WED_9AM);
  const { owner, joint, acct } = await household(2_300_000n);
  const third = await person('Third');
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner')", [acct, third.id]);
  const mine = await account([[owner, 'owner']]);
  const o = await stepped(owner), j = await stepped(joint), jPlain = await signedIn(joint), t3 = await stepped(third);
  const limit0 = await wireLimit(o);
  const r = await o.post('/api/wire-requests', body(acct, { amountCents: 1_000_000 }));    // exactly $10,000: needs a second approval
  const w = r.body.wire;
  assert.deepEqual([w.status, w.secondApprovalRequired, w.holdCents, w.valueDate, w.entryId, w.approvedBy], ['awaiting_approval', true, 1_002_500, null, null, null]);
  assert.equal(await bal(acct), 2_300_000n);                                                // a hold doesn't touch the ledger
  assert.equal((await env.q('SELECT count(*)::int n FROM transfers WHERE id = $1', [w.id])).rows[0].n, 0);
  assert.deepEqual((await o.get(`/api/wire-requests/availability/${acct}`)).body, { accountId: acct, balanceCents: 2_300_000, heldCents: 1_002_500, availableCents: 1_297_500 });
  assert.deepEqual(await wireLimit(o), limit0);                                             // limit used only once released
  // held money can't be spent by Pay: a transfer or a wire over the available money is refused
  const t1 = await o.post('/api/pay/transfers', { fromAccountId: acct, toAccountId: mine, amount: '12975.01', idempotencyKey: key() });
  assert.deepEqual([t1.status, t1.body.error], [409, 'insufficient_funds']);
  assert.match(t1.body.message, /held/);
  const pw = () => o.post('/api/pay/wires', { fromAccountId: acct, amount: '12950.01', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780',
    accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key() });
  assert.equal((await pw()).body.error, 'insufficient_funds');                            // $12,950.01 + $25 fee > $12,975.00
  // nor by another wire request
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 1_295_001 }))).body.error, 'insufficient_funds');
  // R22: who may approve, in order
  assert.equal((await o.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'approver_must_differ');
  assert.equal((await jPlain.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'stepup_required');
  const small = (await o.post('/api/wire-requests', body(acct, { amountCents: 999_999 }))).body.wire;
  assert.equal(small.status, 'released'); assert.equal(small.secondApprovalRequired, false);
  assert.equal((await j.post(`/api/wire-requests/${small.id}/approve`)).body.error, 'invalid_state');
  // the joint owner approves: released in the same request
  const a = await j.post(`/api/wire-requests/${w.id}/approve`);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.replayed, a.body.wire.status, a.body.wire.approvedBy, a.body.wire.holdCents, a.body.wire.valueDate], [false, 'released', joint.id, 0, '2026-11-04']);
  assert.ok(a.body.wire.approvedAt && a.body.wire.entryId);
  const again = await j.post(`/api/wire-requests/${w.id}/approve`);
  assert.deepEqual([again.status, again.body.replayed, again.body.wire.entryId], [200, true, a.body.wire.entryId]);
  assert.equal((await t3.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'invalid_state');   // already approved by someone else
  assert.equal(await bal(acct), 2_300_000n - 1_002_500n - 1_002_499n);
  assert.equal(limit0.usedToday, '0.00');
  assert.equal((await wireLimit(o)).usedToday, '19999.99');
  const ev = await audits(w.id);
  assert.deepEqual(ev.map(x => [x.action, x.user_id]), [['wire.requested', owner.id], ['wire.screened', owner.id], ['wire.approved', joint.id], ['wire.released', joint.id]]);
  assert.deepEqual(ev[2].detail, { wire: w.id, approver: joint.id });
  // once the hold is gone the money can be spent
  assert.equal((await o.post('/api/pay/transfers', { fromAccountId: acct, toAccountId: mine, amount: '10.00', idempotencyKey: key() })).status, 200);
});

test('R18, R33: a canceled wire gives its hold back; only the requester can cancel, and only while it waits', async () => {
  at(WED_9AM);
  const { owner, joint, acct } = await household(1_100_000n);
  const mine = await account([[owner, 'owner']]);
  const o = await stepped(owner), j = await stepped(joint);
  const w = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_050_000 }))).body.wire;
  const send = () => o.post('/api/pay/wires', { fromAccountId: acct, amount: '500.00', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780',
    accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key() });
  assert.equal((await send()).body.error, 'insufficient_funds');
  assert.equal((await o.post('/api/pay/transfers', { fromAccountId: acct, toAccountId: mine, amount: '475.01', idempotencyKey: key() })).body.error, 'insufficient_funds');
  assert.deepEqual([(await j.post(`/api/wire-requests/${w.id}/cancel`)).status, (await j.post(`/api/wire-requests/${w.id}/cancel`)).body.error], [403, 'forbidden']);
  const c = await o.post(`/api/wire-requests/${w.id}/cancel`, {});
  assert.deepEqual([c.status, c.body.wire.status, c.body.wire.holdCents], [200, 'canceled', 0]);
  assert.equal(c.body.replayed, undefined);
  assert.equal((await o.post(`/api/wire-requests/${w.id}/cancel`)).body.error, 'invalid_state');
  assert.equal((await j.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'invalid_state');
  assert.equal((await o.get(`/api/wire-requests/availability/${acct}`)).body.heldCents, 0);
  assert.equal((await send()).status, 200);                                                // the same payment now goes
  assert.deepEqual((await audits(w.id)).map(x => x.action), ['wire.requested', 'wire.screened', 'wire.canceled']);
  assert.equal((await env.q("SELECT count(*)::int n FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.idempotency_key LIKE $1", [`%${w.id}%`])).rows[0].n, 0);
});

test('R19, R20: exactly enough money and exactly the limit are allowed; held wires count against the limit', async () => {
  at(WED_9AM);
  const owner = await person('Limits'), joint = await person('Limits2');
  const acct = await account([[owner, 'owner'], [joint, 'joint_owner']], { cents: 10_000_000n });
  const poor = await account([[owner, 'owner']], { cents: 102_500n });
  const o = await stepped(owner), j = await stepped(joint);
  assert.equal((await o.post('/api/wire-requests', body(poor, { amountCents: 100_001 }))).body.error, 'insufficient_funds');
  assert.equal((await o.post('/api/wire-requests', body(poor, { amountCents: 100_000 }))).body.wire.status, 'released');
  assert.equal(await bal(poor), 0n);
  // the daily wire limit is $25,000.00 (bank default); $1,000 was used above
  const held = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_500_000 }))).body.wire;      // waits, and counts
  const over = await o.post('/api/wire-requests', body(acct, { amountCents: 900_001 }));
  assert.deepEqual([over.status, over.body.error], [422, 'over_limit']);
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 900_000 }))).body.wire.status, 'released');   // exactly at the limit
  // a hit uses none of the limit and isn't refused by it
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 2_000_000, beneficiaryName: 'Olwen Tarsk' }))).body.wire.status, 'stopped');
  // a customer's own lower limit
  const other = await person('LowLimit'), acct2 = await account([[other, 'owner']], { cents: 1_000_000n });
  const x = await stepped(other);
  assert.equal((await x.call('PUT', '/api/pay/limits/wire', { daily: '500.00', monthly: '1000.00' })).status, 200);
  assert.equal((await x.post('/api/wire-requests', body(acct2, { amountCents: 50_001 }))).body.error, 'over_limit');
  assert.equal((await x.post('/api/wire-requests', body(acct2, { amountCents: 50_000 }))).body.wire.status, 'released');
  // the approval of the held wire still goes (the limit is checked when it is requested)
  assert.equal((await j.post(`/api/wire-requests/${held.id}/approve`)).body.wire.status, 'released');
  assert.equal((await wireLimit(o)).usedToday, '25000.00');
});

// ---------- compliance ----------
test('R13-R16, R24-R27: a potential match is held for review; customers see only the result; staff release it with a reason', async () => {
  at(WED_9AM);
  const { owner, joint, staff, acct } = await household();
  const staff2 = await person('Staff2', { staff: true });
  const o = await stepped(owner), s = await signedIn(staff), s2 = await signedIn(staff2);
  const r = await o.post('/api/wire-requests', intl(acct, { beneficiaryName: 'Olwen Tarsc', amountCents: 300_000 }));
  const w = r.body.wire;
  assert.deepEqual([w.status, w.screening, w.feeCents, w.holdCents, w.beneficiary.bankIdentifier, w.beneficiary.accountMasked],
    ['under_review', { result: 'potential_match' }, 4500, 304_500, 'NORBXN2L', '****1234']);
  for (const res of [r, await o.get(`/api/wire-requests/${w.id}`), await o.get('/api/wire-requests')]) {
    const text = JSON.stringify(res.body);
    assert.ok(!/SL-10|similar|caseId|matches|reviewedBy|"review"/.test(text), text);
  }
  assert.equal((await o.get(`/api/wire-requests/availability/${acct}`)).body.heldCents, 304_500);
  // staff see the case, the matches and the history
  const list = await s.get('/api/compliance/cases?status=open');
  const k = list.body.cases.find(x => x.wireId === w.id);
  assert.deepEqual([k.kind, k.status, k.outcome, k.closedAt, k.closedBy, k.closeReason], ['potential_match', 'open', null, null, null, null]);
  assert.deepEqual(k.wire.screening, { result: 'potential_match', matches: [{ kind: 'name', rule: 'similar', listId: 'SL-1004' }] });
  assert.deepEqual([k.wire.caseId, k.wire.review], [k.id, null]);
  assert.ok(!(await s.get('/api/compliance/cases?status=closed')).body.cases.some(x => x.id === k.id));
  // checks in order: reason, then (for the requester or approver) conflict of interest, then state
  for (const reason of [undefined, '', '   abc   ', 'x'.repeat(501), 42])
    assert.equal((await s.post(`/api/compliance/wires/${w.id}/release`, { reason })).body.error, 'reason_required');
  await env.q("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'compliance')", [owner.id]);
  const own = await o.post(`/api/compliance/wires/${w.id}/release`, { reason: 'my own wire' });
  assert.deepEqual([own.status, own.body.error], [403, 'conflict_of_interest']);
  const refused = await audits(w.id, 'wire.review_refused');
  assert.deepEqual(refused.map(x => [x.user_id, x.detail]), [[owner.id, { wire: w.id, reviewer: owner.id, attempted: 'release', reason: 'conflict_of_interest' }]]);
  // release: no second approval needed, so it is paid now
  const rel = await s.post(`/api/compliance/wires/${w.id}/release`, { reason: '  Different person: date of birth differs  ' });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.deepEqual([rel.body.replayed, rel.body.wire.status, rel.body.wire.review.reviewedBy, rel.body.wire.review.decision, rel.body.wire.review.reason],
    [false, 'released', staff.id, 'released', 'Different person: date of birth differs']);
  assert.equal((await s.post(`/api/compliance/wires/${w.id}/release`, { reason: 'Different person again' })).body.replayed, true);
  assert.deepEqual([(await s2.post(`/api/compliance/wires/${w.id}/release`, { reason: 'I agree with that' })).status], [409]);
  assert.equal((await s.post(`/api/compliance/wires/${w.id}/reject`, { reason: 'changed my mind' })).body.error, 'invalid_state');
  const detail = await s.get(`/api/compliance/cases/${k.id}`);
  assert.deepEqual([detail.body.case.status, detail.body.case.outcome, detail.body.case.closedBy, detail.body.case.closeReason],
    ['closed', 'released', staff.id, 'Different person: date of birth differs']);
  assert.deepEqual(detail.body.history.map(x => [x.action, x.actorId]), [['wire.requested', owner.id], ['wire.screened', owner.id],
    ['wire.review_refused', owner.id], ['wire.review_released', staff.id], ['wire.released', staff.id]]);
  assert.deepEqual(detail.body.history[1].detail.matches, [{ kind: 'name', rule: 'similar', listId: 'SL-1004' }]);
  assert.equal(detail.body.history[1].detail.case, k.id);
  // international: $45 fee, upper-case SWIFT, the account number as typed without spaces
  const lines = (await env.q('SELECT amount_cents, description FROM ledger_lines WHERE entry_id = $1 ORDER BY id', [rel.body.wire.entryId])).rows;
  assert.deepEqual(lines.map(l => [l.amount_cents, l.description]).slice(0, 2), [[-300000n, 'International wire to Olwen Tarsc at Prairie National Bank ··1234'], [-4500n, 'Outgoing international wire fee']]);
  // R16: the customer still sees only the result, the status and who approved
  const seen = (await o.get(`/api/wire-requests/${w.id}`)).body.wire;
  assert.deepEqual(Object.keys(seen.screening), ['result']);
  assert.ok(!JSON.stringify(seen).includes(staff.id));
});

test('R25-R27: a reviewed wire from $10,000 still needs its second approver; reviewers and approvers are different people; reject gives the hold back', async () => {
  at(WED_9AM);
  const { owner, joint, staff, acct } = await household();
  await env.q("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'compliance')", [joint.id]);    // the joint owner is also staff
  const o = await stepped(owner), j = await stepped(joint), s = await signedIn(staff);
  // approved first, reviewed second
  const a = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_100_000, country: 'US', beneficiaryName: 'Marisol Quentaral' }))).body.wire;
  assert.equal(a.status, 'under_review');
  const ap = await j.post(`/api/wire-requests/${a.id}/approve`);
  assert.deepEqual([ap.body.wire.status, ap.body.wire.approvedBy], ['under_review', joint.id]);
  const coi = await j.post(`/api/compliance/wires/${a.id}/release`, { reason: 'I approved it myself' });
  assert.deepEqual([coi.status, coi.body.error], [403, 'conflict_of_interest']);
  const rel = await s.post(`/api/compliance/wires/${a.id}/release`, { reason: 'Not the listed person' });
  assert.deepEqual([rel.body.wire.status, rel.body.wire.approvedBy], ['released', joint.id]);
  // reviewed first, approved second
  const b = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_200_000, beneficiaryName: 'Marisol Quentaral' }))).body.wire;
  const relB = await j.post(`/api/compliance/wires/${b.id}/release`, { reason: 'Not the listed person' });
  assert.deepEqual([relB.body.wire.status, relB.body.wire.holdCents], ['awaiting_approval', 1_202_500]);
  const coi2 = await j.post(`/api/wire-requests/${b.id}/approve`);
  assert.deepEqual([coi2.status, coi2.body.error], [403, 'conflict_of_interest']);
  assert.deepEqual((await audits(b.id, 'wire.review_refused')).map(x => x.detail.attempted), ['approve']);
  assert.equal((await env.q('SELECT status FROM wire_requests WHERE id = $1', [b.id])).rows[0].status, 'awaiting_approval');
  assert.equal((await o.post(`/api/wire-requests/${b.id}/cancel`)).body.wire.status, 'canceled');
  const caseB = (await env.q('SELECT * FROM compliance_cases WHERE wire_id = $1', [b.id])).rows[0];
  assert.equal(caseB.outcome, 'released');                                                     // its case was already closed by the review
  // reject: nothing posted, no fee, no limit, the hold comes back
  const limit0 = await wireLimit(o), fees0 = await sys('mm_wire_fees'), bal0 = await bal(acct);
  const c = (await o.post('/api/wire-requests', body(acct, { amountCents: 50_000, country: 'US', beneficiaryName: 'Olwen Tarsc' }))).body.wire;
  assert.equal((await s.post(`/api/compliance/wires/${c.id}/reject`, { reason: 'Matches the listed person' })).body.error, undefined);
  const again = await s.post(`/api/compliance/wires/${c.id}/reject`, { reason: 'still the same' });
  assert.deepEqual([again.status, again.body.replayed, again.body.wire.status, again.body.wire.review.decision], [200, true, 'rejected', 'rejected']);
  assert.equal((await s.post(`/api/compliance/wires/${c.id}/release`, { reason: 'release it now' })).body.error, 'invalid_state');
  assert.equal((await o.post(`/api/wire-requests/${c.id}/cancel`)).body.error, 'invalid_state');
  assert.deepEqual([await sys('mm_wire_fees'), await bal(acct), (await o.get(`/api/wire-requests/availability/${acct}`)).body.heldCents], [fees0, bal0, 0]);
  assert.deepEqual(await wireLimit(o), limit0);
  const caseC = (await env.q('SELECT * FROM compliance_cases WHERE wire_id = $1', [c.id])).rows[0];
  assert.deepEqual([caseC.status, caseC.outcome, caseC.closed_by, caseC.close_reason], ['closed', 'rejected', staff.id, 'Matches the listed person']);
  assert.deepEqual((await audits(c.id)).map(x => x.action), ['wire.requested', 'wire.screened', 'wire.review_rejected']);
  // a canceled potential match closes its case as canceled by the requester
  const d = (await o.post('/api/wire-requests', body(acct, { amountCents: 50_000, beneficiaryName: 'Olwen Tarsc' }))).body.wire;
  await o.post(`/api/wire-requests/${d.id}/cancel`);
  const caseD = (await env.q('SELECT * FROM compliance_cases WHERE wire_id = $1', [d.id])).rows[0];
  assert.deepEqual([caseD.status, caseD.outcome, caseD.closed_by], ['closed', 'canceled', owner.id]);
});

test('R15, R28: a hit is stopped with a case and nothing moves; staff close the case as a confirmed hit', async () => {
  at(WED_9AM);
  const { owner, joint, staff, acct } = await household();
  const staff2 = await person('Staff3', { staff: true });
  const o = await stepped(owner), j = await stepped(joint), s = await signedIn(staff), s2 = await signedIn(staff2);
  const bal0 = await bal(acct), limit0 = await wireLimit(o);
  const r = await o.post('/api/wire-requests', intl(acct, { beneficiaryName: 'Pat Lee', country: 'XS', amountCents: 2_000_000 }));
  const w = r.body.wire;
  assert.deepEqual([r.status, w.status, w.screening, w.holdCents, w.entryId], [200, 'stopped', { result: 'hit' }, 0, null]);
  assert.deepEqual([await bal(acct), (await o.get(`/api/wire-requests/availability/${acct}`)).body.heldCents], [bal0, 0]);
  assert.deepEqual(await wireLimit(o), limit0);
  assert.equal((await j.post(`/api/wire-requests/${w.id}/approve`)).body.error, 'invalid_state');
  assert.equal((await o.post(`/api/wire-requests/${w.id}/cancel`)).body.error, 'invalid_state');
  assert.equal((await s.post(`/api/compliance/wires/${w.id}/release`, { reason: 'looks fine to me' })).body.error, 'invalid_state');
  assert.equal((await s.post(`/api/compliance/wires/${w.id}/reject`, { reason: 'looks bad to me' })).body.error, 'invalid_state');
  const k = (await s.get('/api/compliance/cases')).body.cases.find(x => x.wireId === w.id);
  assert.deepEqual([k.kind, k.status, k.wire.caseId, k.wire.screening.matches], ['hit', 'open', k.id, [{ kind: 'country', rule: 'sanctioned_country', listId: 'XS' }]]);
  assert.equal((await s.post(`/api/compliance/cases/${k.id}/close`, { reason: 'no' })).body.error, 'reason_required');
  await env.q("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'compliance')", [owner.id]);
  assert.equal((await o.post(`/api/compliance/cases/${k.id}/close`, { reason: 'my own wire, fine' })).body.error, 'conflict_of_interest');
  const closed = await s.post(`/api/compliance/cases/${k.id}/close`, { reason: 'Sanctioned country confirmed' });
  assert.deepEqual([closed.status, closed.body.replayed, closed.body.case.status, closed.body.case.outcome, closed.body.case.closedBy, closed.body.case.closeReason],
    [200, false, 'closed', 'confirmed_hit', staff.id, 'Sanctioned country confirmed']);
  assert.equal((await s.post(`/api/compliance/cases/${k.id}/close`, { reason: 'Sanctioned country confirmed' })).body.replayed, true);
  assert.equal((await s2.post(`/api/compliance/cases/${k.id}/close`, { reason: 'Sanctioned country confirmed' })).body.error, 'invalid_state');
  assert.equal((await o.get(`/api/wire-requests/${w.id}`)).body.wire.status, 'stopped');
  assert.deepEqual((await audits(w.id)).map(x => x.action), ['wire.requested', 'wire.screened', 'wire.review_refused', 'wire.case_closed']);
  assert.deepEqual((await audits(w.id, 'wire.case_closed'))[0].detail, { wire: w.id, case: k.id, reviewer: staff.id, reason: 'Sanctioned country confirmed' });
  // a potential-match case can't be closed here
  const pm = (await o.post('/api/wire-requests', body(acct, { beneficiaryName: 'Olwen Tarsc' }))).body.wire;
  const pmCase = (await env.q('SELECT id FROM compliance_cases WHERE wire_id = $1', [pm.id])).rows[0].id;
  assert.equal((await s.post(`/api/compliance/cases/${pmCase}/close`, { reason: 'close this one' })).body.error, 'invalid_state');
  // every hit and potential match has exactly one case; clear wires none
  const counts = (await env.q(`SELECT w.screening_result r, count(k.id)::int n, count(*)::int w FROM wire_requests w LEFT JOIN compliance_cases k ON k.wire_id = w.id GROUP BY 1`)).rows;
  for (const x of counts) assert.equal(x.n, x.r === 'clear' ? 0 : x.w, x.r);
});

// ---------- timing ----------
test('R31: cut-offs are 4:30 pm CT domestic and 3:00 pm CT international; a waiting wire takes the value date of its release; run-due sends it', async () => {
  const { owner, joint, acct } = await household();
  const o = await stepped(owner), j = await stepped(joint);
  at('2026-11-04T22:29:00Z');                                                                // 4:29 pm CST
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 1000 }))).body.wire.valueDate, '2026-11-04');
  at('2026-11-04T22:30:00Z');                                                                // 4:30 pm: after the cut-off
  const late = (await o.post('/api/wire-requests', body(acct, { amountCents: 1000 }))).body.wire;
  assert.equal(late.valueDate, '2026-11-05');
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [late.id])).rows[0].status, 'scheduled');
  at('2026-11-04T20:59:00Z');                                                                // 2:59 pm
  assert.equal((await o.post('/api/wire-requests', intl(acct, { amountCents: 1000 }))).body.wire.valueDate, '2026-11-04');
  at('2026-11-04T21:00:00Z');                                                                // 3:00 pm: international cut-off
  assert.equal((await o.post('/api/wire-requests', intl(acct, { amountCents: 1000 }))).body.wire.valueDate, '2026-11-05');
  at('2026-11-10T21:00:00Z');                                                                // Tuesday before Veterans Day (a Fed holiday)
  assert.equal((await o.post('/api/wire-requests', intl(acct, { amountCents: 1000 }))).body.wire.valueDate, '2026-11-12');
  at('2026-11-07T15:00:00Z');                                                                // Saturday
  const big = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_000_000 }))).body.wire;
  at('2026-11-09T15:00:00Z');                                                                // approved on Monday morning
  const a = (await j.post(`/api/wire-requests/${big.id}/approve`)).body.wire;
  assert.deepEqual([a.status, a.valueDate], ['released', '2026-11-09']);
  assert.equal((await env.q('SELECT booked_on FROM transfers WHERE id = $1', [big.id])).rows[0].booked_on, '2026-11-09');
  // the late wire goes out on its value date when the requester runs due items
  at('2026-11-05T15:00:00Z');
  const net = await sys('mm_network');
  assert.equal((await o.post('/api/pay/run-due')).status, 200);
  assert.equal((await env.q('SELECT status FROM transfers WHERE id = $1', [late.id])).rows[0].status, 'sent');
  assert.ok(await sys('mm_network') >= net + 1000n);
});

// ---------- money no longer there, exactly once ----------
test('R34: if the money left while the wire waited, the approval is refused and nothing changes; after funding it goes', async () => {
  at(WED_9AM);
  const owner = await person('Drain'), joint = await person('Drain2');
  const acct = await account([[owner, 'owner'], [joint, 'joint_owner']], { cents: 1_002_500n });
  const o = await stepped(owner), j = await stepped(joint);
  const w = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_000_000 }))).body.wire;
  // money leaves by another route that doesn't know about holds (a card-style debit straight through the ledger)
  await tx(env.pool, async c => post(c, { key: `drain:${w.id}`, kind: 'seed', lines: [
    { accountId: acct, amountCents: -1n, description: 'Debit' }, { accountId: await systemAccount(c, 'equity'), amountCents: 1n, description: 'Debit' }] }));
  const r = await j.post(`/api/wire-requests/${w.id}/approve`);
  assert.deepEqual([r.status, r.body.error], [409, 'insufficient_funds']);
  const row = (await env.q('SELECT status, approved_by FROM wire_requests WHERE id = $1', [w.id])).rows[0];
  assert.deepEqual([row.status, row.approved_by], ['awaiting_approval', null]);
  assert.deepEqual((await audits(w.id)).map(x => x.action), ['wire.requested', 'wire.screened']);
  await fund(acct, 1n);
  const ok = await j.post(`/api/wire-requests/${w.id}/approve`);
  assert.deepEqual([ok.status, ok.body.wire.status], [200, 'released']);
  assert.equal(await bal(acct), 0n);
});

test('R23, R25, R30: simultaneous approvals and simultaneous compliance releases post the wire exactly once', async () => {
  at(WED_9AM);
  const { owner, joint, staff, acct } = await household();
  const staff2 = await person('Staff4', { staff: true });
  const o = await stepped(owner), j = await stepped(joint), j2 = await stepped(joint), s = await signedIn(staff), s2 = await signedIn(staff2);
  const w = (await o.post('/api/wire-requests', body(acct, { amountCents: 1_300_000 }))).body.wire;
  const rs = await Promise.all([...Array(4)].map((_, i) => (i % 2 ? j : j2).post(`/api/wire-requests/${w.id}/approve`)));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.body)));
  assert.equal(rs.filter(r => !r.body.replayed).length, 1);
  const p = (await o.post('/api/wire-requests', body(acct, { amountCents: 70_000, beneficiaryName: 'Olwen Tarsc' }))).body.wire;
  const rel = await Promise.all([s, s2, s, s2].map(c => c.post(`/api/compliance/wires/${p.id}/release`, { reason: 'Not the same person' })));
  const winner = rel.find(r => r.status === 200 && !r.body.replayed);
  assert.ok(winner, JSON.stringify(rel.map(r => r.body)));
  const loser = winner.body.wire.review.reviewedBy === staff.id ? staff2 : staff;
  rel.forEach((r, i) => {
    const who = i % 2 ? staff2 : staff;
    if (who === loser) assert.deepEqual([r.status, r.body.error], [409, 'invalid_state']);
    else assert.equal(r.status, 200);
  });
  for (const id of [w.id, p.id]) {
    const k = `${owner.id}:wire-screening:${id}:release`;
    assert.equal((await env.q("SELECT count(*)::int n FROM journal_entries WHERE idempotency_key = $1 AND kind = 'wire'", [k])).rows[0].n, 1);
    assert.equal((await env.q('SELECT count(*)::int n FROM transfers WHERE idempotency_key = $1', [k])).rows[0].n, 1);
    assert.equal((await env.q("SELECT count(*)::int n FROM limit_usage WHERE transfer_id = $1 AND reason = 'used'", [id])).rows[0].n, 1);
    assert.equal((await audits(id, 'wire.released')).length, 1);
  }
  // every entry this feature made balances, and every customer balance equals its lines
  assert.equal((await env.q(`SELECT count(*)::int n FROM (SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
    WHERE e.idempotency_key LIKE '%:wire-screening:%' GROUP BY e.id HAVING sum(l.amount_cents) <> 0) x`)).rows[0].n, 0);
  assert.equal((await env.q(`SELECT count(*)::int n FROM accounts a WHERE a.kind <> 'system' AND a.balance_cents <> coalesce((SELECT sum(amount_cents) FROM ledger_lines WHERE account_id = a.id), 0)`)).rows[0].n, 0);
});

test('R38: Pay wires work as before and share the wire limit with released wires', async () => {
  at(WED_9AM);
  const owner = await person('PayWire'), acct = await account([[owner, 'owner']], { cents: 5_000_000n });
  const o = await stepped(owner);
  const fees = await sys('mm_wire_fees');
  const pw = await o.post('/api/pay/wires', { fromAccountId: acct, amount: '20000.00', recipientName: 'Pat Lee', bankName: 'Prairie Bank', routing: '123456780',
    accountNumber: '000555123', confirmIrrevocable: true, idempotencyKey: key() });
  assert.deepEqual([pw.status, pw.body.transfer.status, pw.body.transfer.fee], [200, 'sent', '25.00']);
  assert.equal(await sys('mm_wire_fees'), fees + 2500n);
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 500_001 }))).body.error, 'over_limit');
  assert.equal((await o.post('/api/wire-requests', body(acct, { amountCents: 500_000 }))).body.wire.status, 'released');
  assert.equal((await wireLimit(o)).usedToday, '25000.00');
});
