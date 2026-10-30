import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testEnv, signIn } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { bornYearsAgo } from '../../lib/seed.mjs';
import { AppError } from '../../lib/http.mjs';
import { checkMinorSpend, runDueAllowances } from '../../lib/controls.mjs';
import { newLast4, DISCLOSURE_VERSION } from '../../lib/onboarding.mjs';
import { bankToday } from '../../lib/bank-date.mjs';
const T = () => `'${bankToday()}'::date`;                       // the bank date the server uses (Central Time)

let env;
after(async () => { await env.close(); });
const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'], AVA = ['ava@usabanc.example', 'ava-demo-pass'];
const acct = async last4 => (await env.q('SELECT * FROM accounts WHERE number_last4 = $1', [last4])).rows[0];
const bal = async last4 => (await acct(last4)).balance_cents;
const ME = { legalName: 'Nizam Ali', dob: '1988-04-12', line1: '100 Harbor St', city: 'Minneapolis', state: 'MN', zip: '55401', ssn: '512-34-7788' };
const ESIGN = { version: DISCLOSURE_VERSION, accepted: true };
const steppedUp = async cl => { const s = await cl.post('/api/stepup'); assert.equal((await cl.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); return cl; };
const apply = (cl, over = {}) => cl.post('/api/applications', { idempotencyKey: randomUUID(), product: 'smart_checking', ownership: 'solo', identity: ME,
  funding: { fromAccountId: over.from, amount: '50.00' }, disclosures: ESIGN, ...over });
let nizam, ava, jordan, chk, teen;
before(async () => {
  env = await testEnv();
  nizam = await signIn(env.base, ...NIZAM); ava = await signIn(env.base, ...AVA); jordan = await signIn(env.base, ...JORDAN);
  chk = (await acct('4471')).id; teen = (await acct('5120')).id;
});
const check = (...a) => tx(env.pool, c => checkMinorSpend(c, ...a));

// ---------- opening accounts ----------
test('the catalog comes from data: products, rates, CD terms and who can own each', async () => {
  const r = await nizam.get('/api/products');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.products.map(p => [p.code, p]));
  assert.deepEqual(Object.keys(by).length >= 9, true);
  assert.equal(by.cd_12.termMonths, 12); assert.equal(by.cd_12.apy, '4.30'); assert.deepEqual(by.cd_12.ownerships, ['solo']);
  assert.deepEqual(by.teen_checking.minorAges, [13, 17]); assert.deepEqual(by.custodial_savings.minorAges, [0, 17]);
  assert.equal(by.premier_mm.minOpen, '1000.00');
  const d = await nizam.get('/api/disclosures?product=cd_6&ownership=solo');
  assert.ok(d.body.documents.some(x => x.key === 'cd_terms')); assert.equal(d.body.version, DISCLOSURE_VERSION);
});

test('solo checking: approved, funded through the ledger once, e-sign recorded, only the last 4 of the SSN kept', async () => {
  const before4471 = await bal('4471');
  const body = { idempotencyKey: randomUUID(), product: 'smart_checking', ownership: 'solo', identity: ME, funding: { fromAccountId: chk, amount: '150.00' }, disclosures: ESIGN };
  const r = await nizam.post('/api/applications', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'approved'); assert.equal(r.body.ssnLast4, '7788');
  assert.match(r.body.account.last4, /^\d{4}$/); assert.equal(r.body.account.balance, '150.00');
  assert.equal(await bal('4471'), before4471 - 15000n);
  const again = await nizam.post('/api/applications', body);                      // a retry returns the first result
  assert.equal(again.body.replayed, true); assert.equal(again.body.id, r.body.id);
  assert.equal(await bal('4471'), before4471 - 15000n);
  const dup = await env.q('SELECT count(*)::int n FROM accounts WHERE number_last4 = $1', [r.body.account.last4]);
  assert.equal(dup.rows[0].n, 1);
  const owners = await env.q('SELECT role FROM account_owners WHERE account_id = $1', [r.body.account.id]);
  assert.deepEqual(owners.rows.map(x => x.role), ['owner']);
  const docs = await env.q('SELECT document_key, version, accepted_at FROM disclosure_acceptances WHERE application_id = $1', [r.body.id]);
  assert.ok(docs.rowCount >= 5); assert.ok(docs.rows.every(x => x.version === DISCLOSURE_VERSION && x.accepted_at));
  const e = await env.q("SELECT idempotency_key FROM journal_entries WHERE kind = 'account_opening'");
  assert.ok(e.rows.some(x => x.idempotency_key.endsWith(`:accounts-family:${body.idempotencyKey}`)));
  const me = await nizam.get('/api/me');
  assert.ok(me.body.accounts.some(a => a.id === r.body.account.id && a.role === 'owner'));
  for (const t of ['action', 'detail']) {
    const a = await env.q(`SELECT ${t}::text v FROM audit_events WHERE action LIKE 'account.%'`);
    assert.ok(a.rowCount >= 3);
  }
});

test('a CD gets its term and maturity date; a CD cannot be joint', async () => {
  const r = await apply(nizam, { product: 'cd_12', from: chk, funding: { fromAccountId: chk, amount: '500.00' } });
  assert.equal(r.body.state, 'approved', JSON.stringify(r.body));
  const t = (await env.q(`SELECT term_months, maturity_date, (${T()} + interval '12 months')::date::text AS want FROM account_terms WHERE account_id = $1`, [r.body.account.id])).rows[0];
  assert.equal(t.term_months, 12); assert.equal(t.maturity_date, t.want); assert.equal(r.body.account.maturityDate, t.want);
  assert.equal((await acct(r.body.account.last4)).apy_bp, 430);
  const j = await apply(nizam, { product: 'cd_12', ownership: 'joint', coOwner: JORDAN[0], funding: { fromAccountId: chk, amount: '500.00' } });
  assert.equal(j.status, 400); assert.match(j.body.message, /can't be opened as a joint account/);
});

test('simulated OFAC hit goes to review: no account, no money moved, plain reason', async () => {
  const b = await bal('4471');
  const r = await apply(nizam, { identity: { ...ME, legalName: 'Nizam TEST OFAC Ali' }, funding: { fromAccountId: chk, amount: '50.00' } });
  assert.equal(r.status, 200); assert.equal(r.body.state, 'review'); assert.equal(r.body.account, null);
  assert.match(r.body.reasons[0], /sanctions list/);
  assert.equal(await bal('4471'), b);
  assert.equal((await env.q('SELECT ofac_hit FROM applications WHERE id = $1', [r.body.id])).rows[0].ofac_hit, true);
  const a = await env.q("SELECT detail FROM audit_events WHERE action = 'account.application' AND detail->>'applicationId' = $1", [r.body.id]);
  assert.equal(a.rows[0].detail.state, 'review');
});

test('declines: failed identity check, and an SSN already on file for another customer', async () => {
  const r = await apply(nizam, { identity: { ...ME, legalName: 'Pat TEST DECLINE' }, funding: { fromAccountId: chk, amount: '50.00' } });
  assert.equal(r.body.state, 'declined'); assert.match(r.body.reasons[0], /couldn't confirm your identity/);
  const jchk = (await acct('3388')).id;
  const j = await jordan.post('/api/applications', { idempotencyKey: randomUUID(), product: 'bright_savings', ownership: 'solo',
    identity: { ...ME, legalName: 'Jordan Lee', dob: '1990-01-01' }, funding: { fromAccountId: jchk, amount: '25.00' }, disclosures: ESIGN });
  assert.equal(j.body.state, 'declined'); assert.match(j.body.reasons[0], /on file for another customer/);
  const dob = await apply(nizam, { identity: { ...ME, dob: '1970-01-01' }, funding: { fromAccountId: chk, amount: '50.00' } });
  assert.equal(dob.body.state, 'review'); assert.match(dob.body.reasons.join(' '), /date of birth doesn't match/);
});

test('plain-words refusals: PO box, bad SSN, small deposit, not enough money, disclosures', async () => {
  const cases = [
    [{ identity: { ...ME, line1: 'PO Box 12' } }, 400, /PO box/],
    [{ identity: { ...ME, ssn: '000-12-3456' } }, 400, /valid Social Security number/],
    [{ funding: { fromAccountId: chk, amount: '5.00' } }, 400, /at least \$25\.00/],
    [{ funding: { fromAccountId: chk, amount: '90000.00' } }, 409, /available/],
    [{ disclosures: { version: '2020-01-01', accepted: true } }, 409, /disclosures were updated/],
    [{ disclosures: { version: DISCLOSURE_VERSION } }, 400, /accept the disclosures/],
    [{ funding: { fromAccountId: (await acct('0088')).id, amount: '50.00' } }, 400, /open checking, savings or money market/],
    [{ funding: { fromAccountId: (await acct('3388')).id, amount: '50.00' } }, 404, /not found/i]
  ];
  for (const [over, status, msg] of cases) {
    const r = await apply(nizam, { funding: { fromAccountId: chk, amount: '50.00' }, ...over });
    assert.equal(r.status, status, JSON.stringify(r.body)); assert.match(r.body.message, msg);
  }
});

test("money in a child's account can't fund the parent's own account", async () => {
  const r = await apply(nizam, { funding: { fromAccountId: teen, amount: '25.00' } });
  assert.equal(r.status, 400); assert.match(r.body.message, /belongs to that child/);
});

test('a minor cannot open an account', async () => {
  const g = await ava.get('/api/applications');
  assert.equal(g.body.isMinor, true); assert.deepEqual(g.body.fundingAccounts, []);
  const r = await ava.post('/api/applications', { idempotencyKey: randomUUID(), product: 'smart_checking', ownership: 'solo', identity: ME, funding: { fromAccountId: teen, amount: '25.00' }, disclosures: ESIGN });
  assert.equal(r.status, 403); assert.match(r.body.message, /18 or older/);
});

test('joint: needs a fresh code, invites the co-owner, who accepts with their own identity check', async () => {
  const fresh = await signIn(env.base, ...NIZAM);
  const body = { idempotencyKey: randomUUID(), product: 'bright_savings', ownership: 'joint', coOwner: JORDAN[0], identity: ME, funding: { fromAccountId: chk, amount: '100.00' }, disclosures: ESIGN };
  const first = await fresh.post('/api/applications', body);
  assert.equal(first.status, 403); assert.equal(first.body.error, 'stepup_required');
  await steppedUp(fresh);
  const nobody = await fresh.post('/api/applications', { ...body, idempotencyKey: randomUUID(), coOwner: 'nobody@usabanc.example' });
  assert.equal(nobody.status, 404); assert.match(nobody.body.message, /couldn't find an adult USA Banc customer/);
  const kid = await fresh.post('/api/applications', { ...body, idempotencyKey: randomUUID(), coOwner: AVA[0] });
  assert.equal(kid.status, 404); assert.match(kid.body.message, /18 or older/);       // same answer as an unknown username (R3)
  assert.equal(kid.body.message, nobody.body.message); assert.equal(kid.body.error, nobody.body.error);
  const r = await fresh.post('/api/applications', body);
  assert.equal(r.body.state, 'approved'); assert.deepEqual(r.body.coOwner, { username: JORDAN[0], status: 'pending' });
  const inv = await jordan.get('/api/applications');
  const i = inv.body.invites.find(x => x.account.last4 === r.body.account.last4);
  assert.ok(i); assert.equal(i.inviter, 'Nizam');
  assert.equal((await nizam.post(`/api/invites/${i.id}/accept`, { identity: ME, disclosures: ESIGN })).status, 404);   // only the invitee
  const acc = await jordan.post(`/api/invites/${i.id}/accept`, { identity: { ...ME, legalName: 'Jordan Lee', dob: '1990-01-01', ssn: '521-11-2233' }, disclosures: ESIGN });
  assert.equal(acc.status, 200, JSON.stringify(acc.body)); assert.equal(acc.body.state, 'approved');
  const me = await jordan.get('/api/me');
  assert.equal(me.body.accounts.find(a => a.id === r.body.account.id).role, 'joint_owner');
  assert.equal((await jordan.post(`/api/invites/${i.id}/accept`, { identity: ME, disclosures: ESIGN })).status, 404);  // answered once
  const dis = await env.q('SELECT count(*)::int n FROM disclosure_acceptances WHERE invite_id = $1', [i.id]);
  assert.ok(dis.rows[0].n >= 6);
});

const AVA_DOB = bornYearsAgo(14);   // matches the seed (computed the same day)
test('teen checking for an existing minor (username + date of birth); custodial savings for a new profile with no login', async () => {
  const wrong = await apply(nizam, { product: 'teen_checking', ownership: 'minor', minor: { username: AVA[0], dob: '2000-01-01' }, funding: { fromAccountId: chk, amount: '20.00' } });
  assert.equal(wrong.status, 404); assert.match(wrong.body.message, /don't match a young customer/);
  const teenNew = await apply(nizam, { product: 'teen_checking', ownership: 'minor', minor: { name: 'Leo Ali', dob: '2012-01-01' }, funding: { fromAccountId: chk, amount: '20.00' } });
  assert.equal(teenNew.status, 400); assert.match(teenNew.body.message, /own USA Banc username/);
  const r = await apply(nizam, { product: 'teen_checking', ownership: 'minor', minor: { username: AVA[0], dob: AVA_DOB }, funding: { fromAccountId: chk, amount: '20.00' } });
  assert.equal(r.body.state, 'approved', JSON.stringify(r.body)); assert.equal(r.body.minorName, 'Ava');
  const roles = (await env.q('SELECT o.role, u.username FROM account_owners o JOIN users u ON u.id = o.user_id WHERE account_id = $1 ORDER BY role', [r.body.account.id])).rows;
  assert.deepEqual(roles.map(x => x.role), ['custodian', 'minor']);
  assert.ok((await env.q('SELECT 1 FROM family_controls WHERE account_id = $1', [r.body.account.id])).rowCount);
  const old = await apply(nizam, { product: 'custodial_savings', ownership: 'minor', minor: { name: 'Sam Ali', dob: '2000-01-01' }, funding: { fromAccountId: chk, amount: '25.00' } });
  assert.equal(old.status, 400); assert.match(old.body.message, /under 18/);
  const u = await apply(nizam, { product: 'custodial_savings', ownership: 'minor', minor: { name: 'Leo Ali', dob: '2019-06-01' }, funding: { fromAccountId: chk, amount: '25.00' } });
  assert.equal(u.body.state, 'approved', JSON.stringify(u.body));
  const leo = (await env.q("SELECT u.* FROM account_owners o JOIN users u ON u.id = o.user_id WHERE o.account_id = $1 AND o.role = 'minor'", [u.body.account.id])).rows[0];
  assert.equal(leo.display_name, 'Leo Ali'); assert.equal(leo.password_hash, '!');
  const g = await nizam.get('/api/applications');
  assert.ok(g.body.minors.some(m => m.name === 'Leo Ali' && m.hasLogin === false));
  // funding a second account for the same child from the child's own account is allowed
  const again = await apply(nizam, { product: 'custodial_savings', ownership: 'minor', minor: { id: leo.id }, funding: { fromAccountId: u.body.account.id, amount: '25.00' } });
  assert.equal(again.body.state, 'approved', JSON.stringify(again.body));
});

test('the full SSN is never stored or written to the audit trail', async () => {
  const dump = (await env.q(`SELECT (SELECT coalesce(json_agg(a), '[]') FROM applications a)::text || (SELECT coalesce(json_agg(e), '[]') FROM audit_events e)::text
     || (SELECT coalesce(json_agg(i), '[]') FROM customer_identities i)::text AS t`)).rows[0].t;
  for (const s of ['512347788', '512-34-7788', '521112233']) assert.ok(!dump.includes(s), s);
  assert.ok(dump.includes('7788'));
});

test('account numbers: the generator finds the one free last-4 when all others are taken', async () => {
  const c = await env.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4) SELECT gen_random_uuid(), 'checking', 'filler', lpad(g::text, 4, '0') FROM generate_series(0, 9999) g
      WHERE lpad(g::text, 4, '0') <> '4242' AND lpad(g::text, 4, '0') NOT IN (SELECT number_last4 FROM accounts WHERE number_last4 IS NOT NULL)`);
    assert.equal(await newLast4(c), '4242');
    await c.query("INSERT INTO accounts (id, kind, name, number_last4) VALUES (gen_random_uuid(), 'checking', 'filler', '4242')");
    await assert.rejects(newLast4(c), e => e instanceof AppError && e.code === 'no_numbers');
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('too many applications in a day are refused', async () => {
  const p = await signIn(env.base, ...JORDAN), jchk = (await acct('3388')).id;
  const n = (await env.q("SELECT count(*)::int n FROM applications a JOIN users u ON u.id = a.applicant_id WHERE u.username = $1", [JORDAN[0]])).rows[0].n;
  let last;
  for (let i = n; i <= 10; i++) last = await p.post('/api/applications', { idempotencyKey: randomUUID(), product: 'bright_savings', ownership: 'solo', disclosures: ESIGN,
    identity: { ...ME, legalName: 'Jordan Lee', dob: '1990-01-01', ssn: '521-11-2233' }, funding: { fromAccountId: jchk, amount: '25.00' } });
  assert.equal(last.status, 429); assert.match(last.body.message, /try again tomorrow/);
});

// ---------- checkMinorSpend ----------
test('checkMinorSpend: adult accounts pass; small spends pass and are audited', async () => {
  assert.equal(await check(chk, 100000n, 'Gaming'), undefined);
  assert.equal(await check(teen, 500n, 'Food & Dining', { userId: null }), undefined);
  const a = await env.q("SELECT detail FROM audit_events WHERE action = 'family.spend.allowed' AND detail->>'accountId' = $1", [teen]);
  assert.ok(a.rowCount >= 1); assert.equal(a.rows.at(-1).detail.amount, '5.00');
  await assert.rejects(check(teen, 5, 'Food & Dining'), e => e instanceof AppError && e.status === 400);
  await assert.rejects(check(teen, 0n, 'Food & Dining'), e => e instanceof AppError && e.status === 400);
});

test('checkMinorSpend: a category turned off says no, in plain words, and the decision is kept in the audit trail', async () => {
  await assert.rejects(check(teen, 100n, 'gaming'), e => e instanceof AppError && e.status === 422 && e.code === 'category_off' && /Gaming are turned off/.test(e.message));
  const a = await env.q("SELECT detail FROM audit_events WHERE action = 'family.spend.declined' AND detail->>'reason' = 'category_off'");
  assert.ok(a.rowCount >= 1);
});

test('checkMinorSpend: daily and 7-day limits count what was already spent', async () => {
  // seeded: $25/day, $75/7 days, $6.00 spent 2 days ago
  await assert.rejects(check(teen, 2501n, 'Groceries'), e => e.code === 'daily_limit' && /\$25\.00/.test(e.message));
  await env.q("UPDATE family_controls SET daily_limit_cents = 7500 WHERE account_id = $1", [teen]);
  await check(teen, 6900n, 'Groceries');
  await assert.rejects(check(teen, 6901n, 'Groceries'), e => e.code === 'weekly_limit' && /\$69\.00 left this week/.test(e.message));
  await env.q("UPDATE family_controls SET daily_limit_cents = 2500 WHERE account_id = $1", [teen]);
});

test('checkMinorSpend: a frozen card stops card spending only; a frozen account stops everything', async () => {
  await env.q('UPDATE family_controls SET card_frozen = true WHERE account_id = $1', [teen]);
  await assert.rejects(check(teen, 100n, 'Groceries'), e => e.code === 'card_frozen');
  assert.equal(await check(teen, 100n, null, { channel: 'p2p' }), undefined);
  await env.q('UPDATE family_controls SET card_frozen = false WHERE account_id = $1', [teen]);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [teen]);
  await assert.rejects(check(teen, 100n, null, { channel: 'p2p' }), e => e.code === 'account_frozen');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [teen]);
  await assert.rejects(check('00000000-0000-4000-8000-00000000ffff', 100n, null), e => e.status === 404);
});

// ---------- family controls over the API ----------
test('the parent sees the minor account with controls, allowance, chore and goal; the minor sees only their own; others see none', async () => {
  const p = await nizam.get('/api/family');
  assert.equal(p.body.role, 'parent');
  const f = p.body.accounts.find(x => x.account.last4 === '5120');
  assert.equal(f.role, 'custodian'); assert.equal(f.canManage, true);
  assert.equal(f.controls.dailyLimit, '25.00'); assert.deepEqual(f.controls.heldCategories, ['Gaming']);
  assert.equal(f.allowances[0].amount, '10.00'); assert.equal(f.allowances[0].cadence, 'weekly');
  assert.ok(f.goals.some(g => g.name === 'New bike' && g.pct === '16')); assert.ok(f.chores.some(c => c.status === 'open'));
  const a = await ava.get('/api/family');
  assert.equal(a.body.role, 'minor');
  assert.deepEqual(a.body.accounts.map(x => [x.account.last4, x.role, x.canManage]).filter(x => x[0] === '5120'), [['5120', 'minor', false]]);
  assert.ok(a.body.accounts.every(x => x.role === 'minor')); assert.deepEqual(a.body.payFrom, []);
  assert.equal(a.body.accounts[0].allowances[0].from, 'a parent');
  assert.equal((await jordan.get('/api/family')).body.role, 'none');
});

test('team demo data: Asim manages Mia, Zak watches Leo in view-only mode, and Zak invited Asim to a joint account', async () => {
  const asim = await signIn(env.base, 'asim@helixbots.ai', 'asim'), zak = await signIn(env.base, 'zak@helixbots.ai', 'zak');
  const a = await asim.get('/api/family');
  assert.equal(a.body.role, 'parent');
  const mia = a.body.accounts.find(x => x.account.last4 === '6125');
  assert.equal(mia.minor.name, 'Mia'); assert.equal(mia.minor.hasLogin, false); assert.equal(mia.canManage, true);
  assert.equal(mia.account.balance, '150.00'); assert.equal(mia.allowances[0].cadence, 'monthly'); assert.ok(mia.goals.some(g => g.name === 'College fund'));
  const z = await zak.get('/api/family');
  const leo = z.body.accounts.find(x => x.account.last4 === '7135');
  assert.equal(leo.controls.mode, 'view_only'); assert.equal(leo.canManage, false);
  assert.equal((await zak.post(`/api/family/${leo.account.id}/controls`, { dailyLimit: '1.00', weeklyLimit: '2.00', heldCategories: [] })).body.error, 'view_only');
  assert.deepEqual(z.body.shared.invites.map(i => [i.account.last4, i.invitee]), [['7133', 'Asim']]);
  // Asim sees the invitation, can choose Mia for another custodial account, and accepts the joint account
  const apps = await asim.get('/api/applications');
  const inv = apps.body.invites.find(i => i.account.last4 === '7133');
  assert.equal(inv.inviter, 'Zak'); assert.ok(apps.body.minors.some(m => m.name === 'Mia' && !m.hasLogin));
  const ok = await asim.post(`/api/invites/${inv.id}/accept`, { identity: { ...ME, legalName: 'Asim Khan', dob: '1991-02-03', ssn: '533-22-1144' }, disclosures: ESIGN });
  assert.equal(ok.body.state, 'approved', JSON.stringify(ok.body));
  const shared = (await asim.get('/api/family')).body.shared.accounts.find(x => x.last4 === '7133');
  assert.deepEqual(shared.coOwners, ['Zak']); assert.equal(shared.balance, '400.00');
  assert.deepEqual((await nizam.get('/api/family')).body.shared.accounts.find(x => x.last4 === '7781').coOwners, ['Jordan']);
});

test('controls: lowering needs no code, loosening does, the minor and strangers get a 404, and it is audited', async () => {
  const fresh = await signIn(env.base, ...NIZAM);
  const lower = await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '20.00', weeklyLimit: '60.00', heldCategories: ['Gaming', 'ATM cash'] });
  assert.equal(lower.status, 200, JSON.stringify(lower.body));
  const raise = await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '25.00', weeklyLimit: '75.00', heldCategories: ['Gaming', 'ATM cash'] });
  assert.equal(raise.body.error, 'stepup_required');
  const unhold = await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '20.00', weeklyLimit: '60.00', heldCategories: ['Gaming'] });
  assert.equal(unhold.body.error, 'stepup_required');
  await steppedUp(fresh);
  assert.equal((await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '25.00', weeklyLimit: '75.00', heldCategories: ['Gaming'] })).status, 200);
  const bad = await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '80.00', weeklyLimit: '75.00', heldCategories: [] });
  assert.equal(bad.status, 400); assert.match(bad.body.message, /daily limit can't be more/);
  const tooHigh = await fresh.post(`/api/family/${teen}/controls`, { dailyLimit: '600.00', weeklyLimit: '1000.00', heldCategories: [] });
  assert.equal(tooHigh.status, 400); assert.match(tooHigh.body.message, /\$500\.00/);
  assert.equal((await ava.post(`/api/family/${teen}/controls`, { dailyLimit: '500.00', weeklyLimit: '1500.00', heldCategories: [] })).status, 404);
  assert.equal((await jordan.post(`/api/family/${teen}/controls`, { dailyLimit: '1.00', weeklyLimit: '1.00', heldCategories: [] })).status, 404);
  const a = await env.q("SELECT detail FROM audit_events WHERE action = 'family.controls.update' AND detail->>'accountId' = $1 ORDER BY id", [teen]);
  assert.equal(a.rowCount, 2); assert.equal(a.rows[0].detail.before.daily, '25.00'); assert.equal(a.rows[0].detail.after.daily, '20.00');
});

test('view-only mode: the parent can watch and freeze, but not change controls', async () => {
  assert.equal((await nizam.post(`/api/family/${teen}/mode`, { mode: 'view_only' })).status, 200);
  const f = (await nizam.get('/api/family')).body.accounts.find(x => x.account.id === teen);
  assert.equal(f.canManage, false); assert.equal(f.controls.mode, 'view_only');
  const r = await nizam.post(`/api/family/${teen}/controls`, { dailyLimit: '10.00', weeklyLimit: '20.00', heldCategories: [] });
  assert.equal(r.status, 409); assert.match(r.body.message, /view-only mode/);
  assert.equal((await nizam.post(`/api/family/${teen}/chores`, { title: 'Dishes', reward: '2.00' })).status, 409);
  assert.equal((await nizam.post(`/api/family/${teen}/freeze`, { target: 'card', frozen: true })).status, 200);
  assert.equal((await ava.post(`/api/family/${teen}/mode`, { mode: 'managed' })).status, 404);
  assert.equal((await nizam.post(`/api/family/${teen}/mode`, { mode: 'managed' })).body.error, 'stepup_required');   // loosening: a fresh code (R10)
  assert.equal((await (await steppedUp(await signIn(env.base, ...NIZAM))).post(`/api/family/${teen}/mode`, { mode: 'managed' })).status, 200);
  const modes = await env.q("SELECT count(*)::int n FROM audit_events WHERE action = 'family.mode' AND detail->>'accountId' = $1", [teen]);
  assert.equal(modes.rows[0].n, 2);
});

test('freeze: the minor can only spend what the controls allow; unfreezing needs a fresh code', async () => {
  const buy = (amount, category = 'Groceries', key = randomUUID()) => ava.post(`/api/family/${teen}/purchase`, { idempotencyKey: key, amount, category, merchant: 'Corner Market' });
  let r = await buy('3.00');
  assert.equal(r.status, 422); assert.equal(r.body.error, 'card_frozen');                 // frozen in the test above
  const fresh = await signIn(env.base, ...NIZAM);
  assert.equal((await fresh.post(`/api/family/${teen}/freeze`, { target: 'card', frozen: false })).body.error, 'stepup_required');
  await steppedUp(fresh);
  assert.equal((await fresh.post(`/api/family/${teen}/freeze`, { target: 'card', frozen: false })).status, 200);
  const b = await bal('5120'), key = randomUUID();
  r = await buy('3.00', 'Groceries', key);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(await bal('5120'), b - 300n);
  assert.equal((await buy('3.00', 'Groceries', key)).body.replayed, true); assert.equal(await bal('5120'), b - 300n);
  r = await buy('3.00', 'Gaming');
  assert.equal(r.status, 422); assert.match(r.body.message, /turned off by a parent/);
  r = await buy('30.00');
  assert.equal(r.status, 422); assert.equal(r.body.error, 'daily_limit');
  assert.equal((await nizam.post(`/api/family/${teen}/freeze`, { target: 'account', frozen: true })).status, 200);
  assert.equal((await acct('5120')).status, 'frozen');
  r = await buy('1.00');
  assert.equal(r.body.error, 'account_frozen');
  assert.equal((await fresh.post(`/api/family/${teen}/freeze`, { target: 'account', frozen: false })).status, 200);
  assert.equal((await nizam.post(`/api/family/${teen}/purchase`, { idempotencyKey: randomUUID(), amount: '1.00', category: 'Groceries', merchant: 'X Store' })).status, 404);
  const ev = await env.q("SELECT action FROM audit_events WHERE action IN ('family.freeze', 'family.unfreeze') AND detail->>'accountId' = $1", [teen]);
  assert.ok(ev.rowCount >= 4);
});

test('allowance: pays on read through the ledger, once per date, catches up missed weeks, and skips when money is short', async () => {
  const seeded = (await env.q(`SELECT next_run_on > ${T()} AS future FROM allowances WHERE account_id = $1 AND active`, [teen])).rows[0];
  assert.equal(seeded.future, true);                                                    // seeding never moves money
  const dup = await nizam.post(`/api/family/${teen}/allowances`, { amount: '5.00', cadence: 'weekly', fromAccountId: chk });
  assert.equal(dup.status, 409);
  const old = (await nizam.get('/api/family')).body.accounts.find(x => x.account.id === teen).allowances[0];
  assert.equal((await nizam.del(`/api/family/${teen}/allowances/${old.id}`, {})).status, 200);
  assert.equal((await nizam.post(`/api/family/${teen}/allowances`, { amount: '500.00', cadence: 'weekly', fromAccountId: chk })).status, 400);
  assert.equal((await nizam.post(`/api/family/${teen}/allowances`, { amount: '5.00', cadence: 'weekly', fromAccountId: teen })).status, 404);
  const mk = await nizam.post(`/api/family/${teen}/allowances`, { amount: '7.50', cadence: 'weekly', fromAccountId: chk });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const b5120 = await bal('5120'), b4471 = await bal('4471');
  await nizam.get('/api/family'); await nizam.get('/api/family');
  assert.equal(await bal('5120'), b5120 + 750n); assert.equal(await bal('4471'), b4471 - 750n);
  await env.q(`UPDATE allowances SET next_run_on = ${T()} - 14 WHERE id = $1`, [mk.body.id]);
  const run = await nizam.post('/api/family/allowances/run');
  assert.deepEqual(run.body.runs.map(x => x.status), ['paid', 'paid']);                   // 14 and 7 days ago; today was already paid
  assert.equal(await bal('5120'), b5120 + 2250n);
  const next = (await env.q(`SELECT next_run_on, ${T()} + 7 AS want FROM allowances WHERE id = $1`, [mk.body.id])).rows[0];
  assert.equal(next.next_run_on, next.want);
  // short of money: skipped and recorded, nothing moves
  await env.q(`UPDATE allowances SET amount_cents = 1000000, next_run_on = ${T()} - 1 WHERE id = $1`, [mk.body.id]);
  const b = await bal('4471');
  const r = await tx(env.pool, c => runDueAllowances(c, [teen]));
  assert.equal(r[0].status, 'skipped'); assert.match(r[0].reason, /Not enough money in Smart Checking/);
  assert.equal(await bal('4471'), b);
  const a = await env.q("SELECT action FROM audit_events WHERE action LIKE 'family.allowance.%' AND detail->>'accountId' = $1", [teen]);
  assert.ok(a.rows.some(x => x.action === 'family.allowance.skipped') && a.rows.some(x => x.action === 'family.allowance.paid'));
  await env.q('UPDATE allowances SET active = false WHERE id = $1', [mk.body.id]);
});

test('chores: the minor marks one done, the parent approves and it pays once', async () => {
  const mk = await nizam.post(`/api/family/${teen}/chores`, { title: 'Clean your room', reward: '4.00' });
  assert.equal(mk.status, 200);
  assert.equal((await nizam.post(`/api/family/${teen}/chores`, { title: 'Big job', reward: '500.00' })).status, 400);
  assert.equal((await ava.post(`/api/chores/${mk.body.id}/submit`)).status, 200);
  assert.equal((await ava.post(`/api/chores/${mk.body.id}/submit`)).status, 409);
  assert.equal((await ava.post(`/api/chores/${mk.body.id}/approve`, { fromAccountId: teen, idempotencyKey: randomUUID() })).status, 404);
  assert.equal((await jordan.post(`/api/chores/${mk.body.id}/approve`, { fromAccountId: chk, idempotencyKey: randomUUID() })).status, 404);
  const b = await bal('5120'), key = randomUUID();
  const ok = await nizam.post(`/api/chores/${mk.body.id}/approve`, { fromAccountId: chk, idempotencyKey: key });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(await bal('5120'), b + 400n);
  const again = await nizam.post(`/api/chores/${mk.body.id}/approve`, { fromAccountId: chk, idempotencyKey: randomUUID() });
  assert.equal(again.body.replayed, true); assert.equal(await bal('5120'), b + 400n);
  assert.equal((await nizam.post(`/api/chores/${mk.body.id}/cancel`)).status, 409);
  const a = await env.q("SELECT action FROM audit_events WHERE detail->>'choreId' = $1 ORDER BY id", [mk.body.id]);
  assert.deepEqual(a.rows.map(x => x.action), ['family.chore.create', 'family.chore.submit', 'family.chore.paid']);
});

test('savings goals: the minor adds one and sets money aside, never more than the balance', async () => {
  const g = await ava.post(`/api/family/${teen}/goals`, { name: 'Concert tickets', target: '80.00', targetDate: '2030-01-01' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal((await ava.post(`/api/goals/${g.body.id}/set-aside`, { amount: '5.00' })).status, 200);
  const big = await ava.post(`/api/goals/${g.body.id}/set-aside`, { amount: '5000.00' });
  assert.equal(big.status, 409); assert.match(big.body.message, /set aside up to/);
  assert.equal((await ava.post(`/api/goals/${g.body.id}/set-aside`, { amount: '9.00', release: true })).status, 400);
  assert.equal((await ava.post(`/api/goals/${g.body.id}/set-aside`, { amount: '2.00', release: true })).status, 200);
  assert.equal((await jordan.post(`/api/goals/${g.body.id}/set-aside`, { amount: '1.00' })).status, 404);
  const f = (await ava.get('/api/family')).body.accounts.find(x => x.account.id === teen);
  assert.equal(f.goals.find(x => x.name === 'Concert tickets').saved, '3.00');
  assert.ok(f.activity.some(x => /set aside/.test(x.text)));
});

test('every balance still equals its ledger lines', async () => {
  const bad = await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY 1) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`);
  assert.equal(bad.rowCount, 0);
});
