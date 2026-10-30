import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { toStr } from '../../lib/money.mjs';
import { bankToday, addDays, clock } from '../../lib/bank-date.mjs';
import { bornYearsAgo } from '../../lib/seed.mjs';

let env, officer, officer2;
before(async () => {
  env = await testEnv();
  officer = await customer('Olivia', { staff: true }); officer2 = await customer('Omar', { staff: true });
});
after(async () => { await env.close(); });
const realNow = clock.now;
afterEach(() => { clock.now = realNow; });
const daysLater = n => { clock.now = () => new Date(realNow().getTime() + n * 86_400_000); };

let n = 0;
const key = () => `auto-key-${++n}-${Date.now()}`;
const vin = () => `1HGCM8${String(++n).padStart(6, '0')}${String(Date.now() % 100000).padStart(5, '0')}`;
const one = async (sql, args) => (await env.q(sql, args)).rows[0];
const bal = async id => (await one('SELECT balance_cents FROM accounts WHERE id = $1', [id])).balance_cents;
const audits = async (action, userId) => (await env.q('SELECT * FROM audit_events WHERE action = $1 AND user_id = $2 ORDER BY id', [action, userId])).rows;
const apps = async uid => (await one('SELECT count(*)::int n FROM auto_loan_applications WHERE user_id = $1', [uid])).n;
const pulls = async uid => (await one("SELECT count(*)::int n FROM credit_pulls WHERE user_id = $1 AND kind = 'hard'", [uid])).n;
async function stepUp(who) {
  const c = who.c ?? who, s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}

/** A fresh customer (mfa off) with a simulated score, a funded checking and an empty savings account. */
async function customer(name, { score = 780, dob = null, staff = false, displayName = name } = {}) {
  const username = `${name.toLowerCase()}+score${score}@auto.test`, uid = newId(), chk = newId(), sav = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2, date_of_birth, staff_role) VALUES ($1,$2,$3,$4,false,'55',$5,$6)`,
      [uid, username, displayName, await hashPassword('pw-' + name), dob, staff ? 'loan_officer' : null]);
    for (const [id, kind, nm] of [[chk, 'checking', 'Smart Checking'], [sav, 'savings', 'Bright Savings']]) {
      await c.query('INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,$2,$3,$4)', [id, kind, nm, '1234']);
      await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')", [id, uid]);
    }
    await post(c, { key: `test:fund:${username}`, kind: 'seed', lines: [{ accountId: chk, amountCents: 100_000n, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -100_000n, description: 'Opening deposit' }] });
  });
  return { c: await signIn(env.base, username, 'pw-' + name), uid, chk, sav, username };
}
const form = (who, o = {}) => ({ idempotencyKey: key(), product: 'auto_new', vehicle: { year: 2024, make: 'Honda', model: 'Civic', vehicleId: vin() },
  priceCents: 3_000_000, downPaymentCents: 500_000, amountCents: 2_500_000, termMonths: 60, annualIncomeCents: 9_000_000, housingCostCents: 150_000,
  employment: 'employed', disbursementAccountId: who.chk, creditConsent: true, ...o });
const apply = (who, o) => who.c.post('/api/auto-loans/applications', form(who, o));
// Engine counteroffer: $25,000 over 60 months is just over 45% DTI on $52,000 a year with $1,500 housing; 72 months fits.
const COUNTER = { annualIncomeCents: 5_200_000 };
const LARGE = { priceCents: 9_000_000, downPaymentCents: 500_000, amountCents: 8_000_000, annualIncomeCents: 30_000_000 };

// ---------- access ----------
test('R1: every endpoint needs a signed-in session', async () => {
  const c = client(env.base), id = newId();
  for (const [m, p] of [['POST', '/api/auto-loans/applications'], ['GET', '/api/auto-loans/applications'], ['GET', `/api/auto-loans/applications/${id}`],
    ['GET', `/api/auto-loans/applications/${id}/notice`], ['POST', `/api/auto-loans/applications/${id}/accept`], ['GET', '/api/staff/auto-loans/queue'],
    ['GET', `/api/staff/auto-loans/applications/${id}`], ['POST', `/api/staff/auto-loans/applications/${id}/approve`],
    ['POST', `/api/staff/auto-loans/applications/${id}/decline`], ['POST', `/api/staff/auto-loans/applications/${id}/counter`]]) {
    const r = await c.call(m, p, {});
    assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error, 'signed_out');
  }
});

test('R2: staff endpoints are staff only, whatever the id; customer endpoints work for staff', async () => {
  const cust = await customer('Sasha');
  const mine = (await apply(cust, COUNTER)).body.application.id;
  for (const id of [mine, newId(), 'nope']) {
    for (const [m, p] of [['GET', '/api/staff/auto-loans/queue'], ['GET', `/api/staff/auto-loans/applications/${id}`],
      ['POST', `/api/staff/auto-loans/applications/${id}/approve`], ['POST', `/api/staff/auto-loans/applications/${id}/decline`],
      ['POST', `/api/staff/auto-loans/applications/${id}/counter`]]) {
      const r = await cust.c.call(m, p, { reason: 'x', reasonCodes: ['other_policy'] });
      assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.body.error, 'staff_only');
    }
  }
  assert.equal((await one('SELECT status FROM auto_loan_applications WHERE id = $1', [mine])).status, 'referred');
  const r = await apply(officer);
  assert.equal(r.status, 200); assert.equal(r.body.application.status, 'approved');
  assert.equal((await officer.c.get('/api/auto-loans/applications')).body.applications[0].id, r.body.application.id);
});

test('R3: customers reach only their own applications; staff get the same 404 on customer endpoints', async () => {
  const a = await customer('Avery'), b = await customer('Blake');
  const id = (await apply(a)).body.application.id;
  await stepUp(b); await stepUp(officer);
  for (const who of [b, officer]) {
    for (const x of [id, newId(), 'not-a-uuid']) {
      assert.equal((await who.c.get(`/api/auto-loans/applications/${x}`)).body.error, 'not_found');
      assert.equal((await who.c.get(`/api/auto-loans/applications/${x}/notice`)).status, 404);
      const acc = await who.c.post(`/api/auto-loans/applications/${x}/accept`, { idempotencyKey: key() });
      assert.equal(acc.status, 404); assert.equal(acc.body.error, 'not_found');
    }
  }
  assert.equal((await b.c.get('/api/auto-loans/applications')).body.applications.length, 0);
  const row = await one('SELECT status, loan_id FROM auto_loan_applications WHERE id = $1', [id]);
  assert.equal(row.status, 'approved'); assert.equal(row.loan_id, null);
});

// ---------- applying ----------
test('R4, R14, R15, R27, R36: an approved application echoes the request, carries a disclosed 7-day offer, pulls credit once and moves no money', async () => {
  const cu = await customer('Casey');
  const before = await bal(cu.chk), entries = (await one('SELECT count(*)::int n FROM journal_entries')).n;
  const f = form(cu, { vehicle: { year: 2024, make: '  Honda ', model: ' Civic', vehicleId: vin() } });
  const r = await cu.c.post('/api/auto-loans/applications', f);
  assert.equal(r.status, 200); assert.equal(r.body.replayed, false);
  const a = r.body.application, today = bankToday();
  assert.equal(a.status, 'approved'); assert.equal(a.decision, 'approved'); assert.equal(a.product, 'auto_new');
  assert.deepEqual(a.vehicle, { year: 2024, make: 'Honda', model: 'Civic', vehicleId: f.vehicle.vehicleId });
  for (const k of ['priceCents', 'downPaymentCents', 'amountCents', 'termMonths', 'annualIncomeCents', 'housingCostCents', 'employment', 'disbursementAccountId'])
    assert.equal(a[k], f[k], k);
  assert.equal(a.loanId, null); assert.equal(a.failureCode, null); assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.deepEqual(a.offer, { type: 'approved', amountFinancedCents: 2_500_000, termMonths: 60, aprBps: 549, paymentCents: 47_741, finalPaymentCents: 47_768,
    financeChargeCents: 364_487, totalOfPaymentsCents: 2_864_487, issuedOn: today, expiresOn: addDays(today, 7) });
  assert.equal(59 * 47_741 + 47_768, 2_864_487);
  assert.deepEqual((await cu.c.get(`/api/auto-loans/applications/${a.id}`)).body.application, a);
  assert.deepEqual((await cu.c.get('/api/auto-loans/applications')).body.applications, [a]);
  assert.equal(await bal(cu.chk), before);
  assert.equal((await one('SELECT count(*)::int n FROM journal_entries')).n, entries);
  assert.equal((await cu.c.get('/api/loans')).body.loans.length, 0);
  const credit = (await cu.c.get('/api/credit')).body;
  assert.equal(credit.inquiries.filter(i => i.kind === 'hard' && i.source === 'loan').length, 1);
  assert.equal(credit.score, 775);                                                   // the pull counts against later scores
  const ev = await audits('autoloan.apply', cu.uid);
  assert.equal(ev.length, 1); assert.deepEqual(ev[0].detail, { application: a.id, decision: 'approved' });
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${a.id}/notice`)).body.error, 'no_notice');
});

test('R15: a used car at 780 is priced at 649 bps; newest application lists first', async () => {
  const cu = await customer('Drew');
  const first = (await apply(cu)).body.application;
  const used = await customer('Drew2');
  const r = await apply(used, { product: 'auto_used' });
  assert.equal(r.body.application.offer.aprBps, 649);
  const second = (await apply(cu, { product: 'auto_used' })).body.application;
  assert.deepEqual((await cu.c.get('/api/auto-loans/applications')).body.applications.map(x => x.id), [second.id, first.id]);
});

test('R5-R9: each invalid field is refused with its own code, nothing is created and no credit is pulled', async () => {
  const cu = await customer('Eden'), other = await customer('Finn');
  const year = Number(bankToday().slice(0, 4));
  const bad = (code, o, v) => [code, o, v];
  const veh = o => ({ vehicle: { year: 2024, make: 'Honda', model: 'Civic', vehicleId: '1HGCM82633A004352', ...o } });
  const cases = [
    bad('prohibited_field', { race: 'x' }), bad('prohibited_field', { dateOfBirth: '1990-01-01', product: 'nope' }), bad('unknown_field', { color2: 1 }),
    bad('bad_product', { product: 'personal' }), bad('bad_product', { product: undefined }),
    bad('bad_vehicle', { vehicle: null }), bad('bad_vehicle', { vehicle: [] }), bad('bad_vehicle', veh({ extra: 1 })), bad('bad_vehicle', veh({ year: 1989 })),
    bad('bad_vehicle', veh({ year: year + 2 })), bad('bad_vehicle', veh({ year: '2024' })), bad('bad_vehicle', veh({ make: '   ' })), bad('bad_vehicle', veh({ model: 'x'.repeat(41) })),
    bad('bad_vehicle', veh({ vehicleId: '1HGCM82633A00435' })), bad('bad_vehicle', veh({ vehicleId: '1HGCM82633A00435O' })), bad('bad_vehicle', veh({ vehicleId: '1hgcm82633a004352' })),
    bad('bad_price', { priceCents: 0 }), bad('bad_price', { priceCents: 100_000_001 }), bad('bad_price', { priceCents: '3000000' }), bad('bad_price', { priceCents: 30000.5 }),
    bad('bad_price', { priceCents: null }), bad('bad_price', { priceCents: true }),
    bad('bad_down_payment', { downPaymentCents: 3_000_000 }), bad('bad_down_payment', { downPaymentCents: -1 }), bad('bad_down_payment', { downPaymentCents: [1] }),
    bad('bad_amount', { amountCents: 499_999 }), bad('bad_amount', { amountCents: 2_500_001 }), bad('bad_amount', { priceCents: 20_000_000, amountCents: 10_000_001 }),
    bad('bad_term', { termMonths: 11 }), bad('bad_term', { termMonths: 73 }), bad('bad_term', { termMonths: 60.5 }),
    bad('bad_income', { annualIncomeCents: -1 }), bad('bad_income', { annualIncomeCents: 10_000_000_001 }), bad('bad_income', { annualIncomeCents: undefined }),
    bad('bad_housing', { housingCostCents: 100_000_001 }), bad('bad_housing', { housingCostCents: '1500' }),
    bad('bad_employment', { employment: 'student' }), bad('consent_required', { creditConsent: 'true' }), bad('consent_required', { creditConsent: false }),
    bad('bad_account', { disbursementAccountId: undefined }), bad('bad_account', { disbursementAccountId: 5 }),
    bad('not_found', { disbursementAccountId: 'abc' }), bad('not_found', { disbursementAccountId: newId() }), bad('not_found', { disbursementAccountId: other.chk })
  ];
  for (const [code, o] of cases) {
    const body = form(cu, o);
    for (const k of Object.keys(o)) if (o[k] === undefined) delete body[k];
    const r = await cu.c.post('/api/auto-loans/applications', body);
    assert.equal(r.body.error, code, JSON.stringify(o)); assert.ok(r.status === 400 || r.status === 404);
    assert.match(r.body.message, /\w/);
  }
  assert.equal(await apps(cu.uid), 0); assert.equal(await pulls(cu.uid), 0);
  assert.equal((await one("SELECT count(*)::int n FROM audit_events WHERE detail::text ILIKE '%race%' OR detail::text ILIKE '%dateOfBirth%'")).n, 0);
  // the boundaries are accepted
  const ok = await apply(cu, { priceCents: 500_000 + 1, downPaymentCents: 0, amountCents: 500_000, termMonths: 12, ...{ vehicle: { year: year + 1, make: 'M'.repeat(40), model: 'Z', vehicleId: vin() } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('R8, R35: the disbursement account must be an own, open deposit account', async () => {
  const cu = await customer('Gale'), other = await customer('Hale');
  const card = newId(), viewer = newId(), cust = newId(), mm = newId();
  await tx(env.pool, async c => {
    await c.query("INSERT INTO accounts (id, kind, name, number_last4, allow_negative) VALUES ($1,'credit_card','Cash+ Card','1111',true)", [card]);
    await c.query("INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Shared','2222'), ($2,'savings','Kid','3333'), ($3,'money_market','MM','4444')", [viewer, cust, mm]);
    await c.query("INSERT INTO account_owners VALUES ($1,$2,'owner'), ($3,$4,'viewer'), ($5,$4,'custodian'), ($6,$4,'joint_owner'), ($6,$7,'owner')",
      [card, cu.uid, viewer, cu.uid, cust, mm, other.uid]);
  });
  assert.equal((await apply(cu, { disbursementAccountId: card })).body.error, 'bad_account');
  for (const id of [viewer, cust]) assert.equal((await apply(cu, { disbursementAccountId: id })).body.error, 'not_found');
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.sav]);
  const fr = await apply(cu, { disbursementAccountId: cu.sav });
  assert.equal(fr.status, 409); assert.equal(fr.body.error, 'account_not_open');
  assert.equal(await apps(cu.uid), 0); assert.equal(await pulls(cu.uid), 0);
  const joint = await apply(cu, { disbursementAccountId: mm });                                     // joint owner of a money market
  assert.equal(joint.status, 200); assert.equal(joint.body.application.disbursementAccountId, mm);
});

test('R10: a customer under 18 cannot apply', async () => {
  const kid = await customer('Kit', { dob: bornYearsAgo(16) });
  const r = await apply(kid, { race: 'x', idempotencyKey: undefined });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_eligible');
  assert.equal(await apps(kid.uid), 0); assert.equal(await pulls(kid.uid), 0);
});

test('R11: request ids replay, conflict and belong to the customer; identical parallel requests create one application', async () => {
  const cu = await customer('Ivy'), other = await customer('Jules');
  const missing = form(cu); delete missing.idempotencyKey;
  assert.equal((await cu.c.post('/api/auto-loans/applications', missing)).body.error, 'idempotency_key_required');
  assert.equal((await apply(cu, { idempotencyKey: 'short' })).body.error, 'idempotency_key_required');
  const f = form(cu);
  const first = await cu.c.post('/api/auto-loans/applications', f);
  const again = await cu.c.post('/api/auto-loans/applications', f);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.application, first.body.application);
  const fresh = await signIn(env.base, cu.username, 'pw-Ivy');                                        // a new session replays too
  assert.equal((await fresh.post('/api/auto-loans/applications', f)).body.replayed, true);
  const diff = await fresh.post('/api/auto-loans/applications', { ...f, termMonths: 48 });
  assert.equal(diff.status, 422); assert.equal(diff.body.error, 'idempotency_conflict');
  assert.equal(await apps(cu.uid), 1); assert.equal(await pulls(cu.uid), 1);
  const theirs = await other.c.post('/api/auto-loans/applications', { ...f, disbursementAccountId: other.chk, vehicle: { ...f.vehicle, vehicleId: vin() } });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.application.id, first.body.application.id);
  const g = form(cu);
  const rs = await Promise.all([1, 2, 3].map(() => cu.c.post('/api/auto-loans/applications', g)));
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(new Set(rs.map(r => r.body.application.id)).size, 1);
  assert.equal(rs.filter(r => !r.body.replayed).length, 1);
  assert.equal(await apps(cu.uid), 2); assert.equal(await pulls(cu.uid), 2);
});

test('R12: at most 3 applications a bank date; replays and refusals do not count', async () => {
  const cu = await customer('Kai');
  const f = form(cu);
  assert.equal((await cu.c.post('/api/auto-loans/applications', f)).status, 200);
  assert.equal((await cu.c.post('/api/auto-loans/applications', f)).body.replayed, true);
  assert.equal((await apply(cu, { termMonths: 99 })).status, 400);
  assert.equal((await apply(cu)).status, 200); assert.equal((await apply(cu)).status, 200);
  const fourth = await apply(cu);
  assert.equal(fourth.status, 429); assert.equal(fourth.body.error, 'too_many_applications');
  assert.equal(await apps(cu.uid), 3); assert.equal(await pulls(cu.uid), 3);
  assert.equal((await cu.c.post('/api/auto-loans/applications', f)).body.replayed, true);    // still replays
  daysLater(1);
  assert.equal((await apply(cu)).status, 200);                                             // a new bank date
});

test('R13: one live application per vehicle, by any customer; declined and expired ones do not block', async () => {
  const a = await customer('Lane'), b = await customer('Mika'), low = await customer('Nell', { score: 550 });
  const v = { year: 2023, make: 'Ford', model: 'F-150', vehicleId: vin() };
  assert.equal((await apply(low, { vehicle: v })).body.application.status, 'declined');
  assert.equal((await apply(a, { vehicle: v })).body.application.status, 'approved');
  const busy = await apply(b, { vehicle: v });
  assert.equal(busy.status, 409); assert.equal(busy.body.error, 'vehicle_in_use');
  daysLater(8);                                                                            // the offer expired
  assert.equal((await apply(b, { vehicle: v })).status, 200);
  clock.now = realNow;
  const ref = { year: 2023, make: 'Kia', model: 'EV6', vehicleId: vin() };
  assert.equal((await apply(a, { ...COUNTER, vehicle: ref })).body.application.status, 'referred');
  assert.equal((await apply(b, { vehicle: ref })).body.error, 'vehicle_in_use');
  // two customers at once, same vehicle: one application
  const c1 = await customer('Oak'), c2 = await customer('Pia');
  const same = { year: 2022, make: 'Mazda', model: 'CX-5', vehicleId: vin() };
  const rs = await Promise.all([apply(c1, { vehicle: same }), apply(c2, { vehicle: same })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal((await one('SELECT count(*)::int n FROM auto_loan_applications WHERE vehicle_id = $1', [same.vehicleId])).n, 1);
});

// ---------- deciding ----------
test('R16, R29: an automatic decline has no offer and an adverse action notice with the engine\'s reasons', async () => {
  const cu = await customer('Quinn', { score: 550 });
  const r = await apply(cu, { annualIncomeCents: 3_000_000 });
  const a = r.body.application;
  assert.equal(a.status, 'declined'); assert.equal(a.decision, 'declined'); assert.equal(a.offer, null);
  const nt = (await cu.c.get(`/api/auto-loans/applications/${a.id}/notice`)).body.notice;
  assert.equal(nt.applicationId, a.id); assert.equal(nt.kind, 'decline'); assert.equal(nt.issuedOn, bankToday()); assert.equal(nt.creditor, 'USA Banc');
  assert.deepEqual(nt.reasons.map(x => x.code), ['low_credit_score', 'high_debt_to_income']);
  assert.ok(nt.reasons.every(x => typeof x.text === 'string' && x.text.length > 5));
  assert.deepEqual(nt.creditScore, { value: 550, min: 300, max: 850, source: 'Simulated credit file' });
  assert.match(nt.ecoaStatement, /Equal Credit Opportunity Act/); assert.equal(nt.counterOffer, null);
  await stepUp(cu);
  const acc = await cu.c.post(`/api/auto-loans/applications/${a.id}/accept`, { idempotencyKey: key() });
  assert.equal(acc.status, 409); assert.equal(acc.body.error, 'invalid_state');
});

test('R17, R19, R20: counteroffer and large amounts are referred to the staff queue, oldest first', async () => {
  const cu = await customer('Rae', { displayName: 'Rae Referred' });
  const c1 = (await apply(cu, COUNTER)).body.application, c2 = (await apply(cu, LARGE)).body.application;
  assert.equal(c1.status, 'referred'); assert.equal(c1.decision, 'referred'); assert.equal(c1.offer, null);
  assert.equal(c2.status, 'referred'); assert.equal(c2.offer, null);
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${c1.id}/notice`)).body.error, 'no_notice');
  const q = (await officer.c.get('/api/staff/auto-loans/queue')).body.queue;
  const mine = q.filter(x => [c1.id, c2.id].includes(x.id));
  assert.deepEqual(mine.map(x => x.id), [c1.id, c2.id]);
  assert.deepEqual(mine[0], { id: c1.id, createdAt: c1.createdAt, applicantName: 'Rae Referred', product: 'auto_new', amountCents: 2_500_000, termMonths: 60, score: 780, referralReason: 'counteroffer' });
  assert.equal(mine[1].referralReason, 'large_amount'); assert.equal(mine[1].score, 775);
  const ts = q.map(x => Date.parse(x.createdAt));
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
  const v = (await officer.c.get(`/api/staff/auto-loans/applications/${c1.id}`)).body;
  assert.deepEqual(v.application, c1);
  assert.equal(v.review.applicantId, cu.uid); assert.equal(v.review.applicantName, 'Rae Referred'); assert.equal(v.review.score, 780);
  assert.equal(v.review.engineOutcome, 'counteroffer'); assert.equal(v.review.engineAprBps, 549); assert.equal(v.review.referralReason, 'counteroffer');
  assert.deepEqual(v.review.engineReasons.map(x => x.rule), ['max_dti']);
  assert.ok(v.review.dtiBps > 4500); assert.equal(v.review.ltvBps, 8333);
  assert.deepEqual(v.review.suggestedOffer, { amountCents: 2_500_000, termMonths: 72, aprBps: 549, paymentCents: v.review.suggestedOffer.paymentCents });
  assert.ok(Number.isInteger(v.review.suggestedOffer.paymentCents));
  assert.deepEqual(v.actions, []);
  const v2 = (await officer.c.get(`/api/staff/auto-loans/applications/${c2.id}`)).body.review;
  assert.equal(v2.engineOutcome, 'approved'); assert.equal(v2.suggestedOffer, null); assert.equal(v2.referralReason, 'large_amount');
  // other statuses are not in the queue, and the review view works for any status
  const appr = (await apply(cu)).body.application;
  assert.ok(!(await officer.c.get('/api/staff/auto-loans/queue')).body.queue.some(x => x.id === appr.id));
  assert.equal((await officer.c.get(`/api/staff/auto-loans/applications/${appr.id}`)).body.review.referralReason, null);
  for (const id of [newId(), 'zzz']) assert.equal((await officer.c.get(`/api/staff/auto-loans/applications/${id}`)).body.error, 'not_found');
});

test('R18: identical financial inputs give identical decisions, whatever the name, age, employment, account or vehicle', async () => {
  const a = await customer('Sam', { displayName: 'DECLINE Sam' }), b = await customer('Tia', { dob: '1950-01-01' });
  const ra = (await apply(a, { employment: 'unemployed', vehicle: { year: 1990, make: 'A', model: 'B', vehicleId: vin() } })).body.application;
  const rb = (await apply(b, { employment: 'employed', disbursementAccountId: b.sav })).body.application;
  assert.equal(ra.decision, rb.decision); assert.deepEqual(ra.offer, rb.offer);
});

// ---------- staff review ----------
test('R21: staff cannot review their own application, and it is not in their queue', async () => {
  const own = (await apply(officer2, COUNTER)).body.application;
  assert.ok(!(await officer2.c.get('/api/staff/auto-loans/queue')).body.queue.some(x => x.id === own.id));
  assert.ok((await officer.c.get('/api/staff/auto-loans/queue')).body.queue.some(x => x.id === own.id));
  const g = await officer2.c.get(`/api/staff/auto-loans/applications/${own.id}`);
  assert.equal(g.status, 403); assert.equal(g.body.error, 'own_application');
  for (const act of ['approve', 'decline', 'counter']) {
    const r = await officer2.c.post(`/api/staff/auto-loans/applications/${own.id}/${act}`, {});
    assert.equal(r.status, 403); assert.equal(r.body.error, 'own_application');
  }
  assert.equal((await one('SELECT status FROM auto_loan_applications WHERE id = $1', [own.id])).status, 'referred');
});

test('R22, R25, R26, R28: approve sets a new 7-day offer at the engine APR; a second action is refused', async () => {
  const cu = await customer('Uma');
  const a = (await apply(cu, COUNTER)).body.application;
  for (const reason of [undefined, '', '   ', 'x'.repeat(501), 5])
    assert.equal((await officer.c.post(`/api/staff/auto-loans/applications/${a.id}/approve`, { reason })).body.error, 'bad_reason');
  assert.equal((await audits('autoloan.approve', officer.uid)).length, 0);
  daysLater(10);                                                                           // referred applications never expire
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${a.id}`)).body.application.status, 'referred');
  const r = await officer.c.post(`/api/staff/auto-loans/applications/${a.id}/approve`, { reason: '  Verified income with pay stubs  ' });
  assert.equal(r.status, 200);
  const x = r.body.application, d = bankToday();
  assert.equal(x.status, 'approved'); assert.equal(x.decision, 'referred');
  assert.equal(x.offer.type, 'approved'); assert.equal(x.offer.amountFinancedCents, 2_500_000); assert.equal(x.offer.termMonths, 60); assert.equal(x.offer.aprBps, 549);
  assert.equal(x.offer.issuedOn, d); assert.equal(x.offer.expiresOn, addDays(d, 7));
  const v = (await officer.c.get(`/api/staff/auto-loans/applications/${a.id}`)).body;
  assert.equal(v.actions.length, 1);
  assert.deepEqual({ ...v.actions[0], id: 0, at: 0 }, { id: 0, at: 0, action: 'approve', actorId: officer.uid, reason: 'Verified income with pay stubs', reasonCodes: [],
    offer: { amountCents: 2_500_000, termMonths: 60, aprBps: 549 } });
  const ev = await audits('autoloan.approve', officer.uid);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].detail, { application: a.id, applicant: cu.uid, reason: 'Verified income with pay stubs' });
  for (const act of ['approve', 'decline', 'counter']) {
    const again = await officer2.c.post(`/api/staff/auto-loans/applications/${a.id}/${act}`, { reason: 'again', reasonCodes: ['other_policy'], amountCents: 2_000_000, termMonths: 60, aprBps: 549 });
    assert.equal(again.status, 409); assert.equal(again.body.error, 'invalid_state');
  }
  assert.equal((await audits('autoloan.decline', officer2.uid)).length, 0);
  // the engine-approved application can't be reviewed either
  const auto = (await apply(cu)).body.application;
  assert.equal((await officer.c.post(`/api/staff/auto-loans/applications/${auto.id}/approve`, { reason: 'x' })).body.error, 'invalid_state');
  // D+7 accepts, D+8 is expired
  await stepUp(cu);
  daysLater(18);
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${a.id}`)).body.application.status, 'expired');
  const late = await cu.c.post(`/api/auto-loans/applications/${a.id}/accept`, { idempotencyKey: key() });
  assert.equal(late.status, 410); assert.equal(late.body.error, 'offer_expired');
  assert.equal((await cu.c.get('/api/loans')).body.loans.length, 0);
  daysLater(17);
  const ok = await cu.c.post(`/api/auto-loans/applications/${a.id}/accept`, { idempotencyKey: key() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('R23, R26, R29: decline needs a reason and 1-4 distinct codes; the notice lists them in order', async () => {
  const cu = await customer('Vic');
  const a = (await apply(cu, LARGE)).body.application;
  const url = `/api/staff/auto-loans/applications/${a.id}/decline`;
  assert.equal((await officer.c.post(url, { reasonCodes: ['other_policy'] })).body.error, 'bad_reason');
  for (const reasonCodes of [undefined, [], ['nope'], ['other_policy', 'other_policy'], ['low_credit_score', 'high_debt_to_income', 'high_loan_to_value', 'other_policy', 'insufficient_income'], 'other_policy'])
    assert.equal((await officer.c.post(url, { reason: 'r', reasonCodes })).body.error, 'bad_reason_codes');
  const r = await officer.c.post(url, { reason: 'Could not verify employment', reasonCodes: ['employment_not_verified', 'insufficient_income'] });
  assert.equal(r.status, 200); assert.equal(r.body.application.status, 'declined'); assert.equal(r.body.application.offer, null);
  assert.equal(r.body.application.decision, 'referred');
  const nt = (await cu.c.get(`/api/auto-loans/applications/${a.id}/notice`)).body.notice;
  assert.equal(nt.kind, 'decline'); assert.deepEqual(nt.reasons.map(x => x.code), ['employment_not_verified', 'insufficient_income']);
  assert.equal(nt.creditScore.value, 780); assert.equal(nt.counterOffer, null);
  const act = (await officer.c.get(`/api/staff/auto-loans/applications/${a.id}`)).body.actions;
  assert.equal(act[0].action, 'decline'); assert.deepEqual(act[0].reasonCodes, ['employment_not_verified', 'insufficient_income']); assert.equal(act[0].offer, null);
  const ev = await audits('autoloan.decline', officer.uid);
  assert.deepEqual(ev.at(-1).detail, { application: a.id, applicant: cu.uid, reason: 'Could not verify employment', reasonCodes: ['employment_not_verified', 'insufficient_income'] });
});

test('R24, R27, R29, R31: a counter-offer has its own terms and disclosure, a counter notice, and funds on its own terms', async () => {
  const cu = await customer('Wren');
  const a = (await apply(cu, COUNTER)).body.application;
  const url = `/api/staff/auto-loans/applications/${a.id}/counter`;
  const base = { reason: 'DTI too high at 60 months', reasonCodes: ['high_debt_to_income'] };
  for (const t of [{}, { amountCents: 2_500_000, termMonths: 60, aprBps: 549 }, { amountCents: 2_600_000, termMonths: 60, aprBps: 549 },
    { amountCents: 499_999, termMonths: 60, aprBps: 549 }, { amountCents: 2_200_000, termMonths: 73, aprBps: 549 }, { amountCents: 2_200_000, termMonths: 72, aprBps: 548 },
    { amountCents: 2_200_000, termMonths: 72, aprBps: 750 }, { amountCents: '2200000', termMonths: 72, aprBps: 599 }, { amountCents: 2_200_000, termMonths: 72, aprBps: 599.5 }])
    assert.equal((await officer.c.post(url, { ...base, ...t })).body.error, 'bad_counter', JSON.stringify(t));
  assert.equal((await officer.c.post(url, { reasonCodes: ['high_debt_to_income'], amountCents: 2_200_000, termMonths: 72, aprBps: 599 })).body.error, 'bad_reason');
  assert.equal((await officer.c.post(url, { reason: 'x', amountCents: 2_200_000, termMonths: 72, aprBps: 599 })).body.error, 'bad_reason_codes');
  const r = await officer.c.post(url, { ...base, amountCents: 2_200_000, termMonths: 72, aprBps: 749 });                 // +200 bps is allowed
  assert.equal(r.status, 200);
  const x = r.body.application, d = bankToday();
  assert.equal(x.status, 'countered'); assert.equal(x.decision, 'referred');
  assert.equal(x.offer.type, 'countered'); assert.equal(x.offer.amountFinancedCents, 2_200_000); assert.equal(x.offer.termMonths, 72); assert.equal(x.offer.aprBps, 749);
  assert.equal(x.offer.totalOfPaymentsCents, x.offer.amountFinancedCents + x.offer.financeChargeCents);
  assert.equal(x.offer.paymentCents * 71 + x.offer.finalPaymentCents, x.offer.totalOfPaymentsCents);
  assert.equal(x.offer.issuedOn, d); assert.equal(x.offer.expiresOn, addDays(d, 7));
  const nt = (await cu.c.get(`/api/auto-loans/applications/${a.id}/notice`)).body.notice;
  assert.equal(nt.kind, 'counter'); assert.deepEqual(nt.reasons.map(y => y.code), ['high_debt_to_income']); assert.deepEqual(nt.counterOffer, x.offer);
  const act = (await officer.c.get(`/api/staff/auto-loans/applications/${a.id}`)).body.actions;
  assert.deepEqual(act[0].offer, { amountCents: 2_200_000, termMonths: 72, aprBps: 749 });
  assert.deepEqual((await audits('autoloan.counter', officer.uid)).at(-1).detail.reasonCodes, ['high_debt_to_income']);
  await stepUp(cu);
  const before = await bal(cu.chk);
  const acc = await cu.c.post(`/api/auto-loans/applications/${a.id}/accept`, { idempotencyKey: key() });
  assert.equal(acc.status, 200);
  assert.deepEqual({ ...acc.body.loan, id: 0, originationEntryId: 0, disbursementEntryId: 0 }, { id: 0, originationEntryId: 0, disbursementEntryId: 0,
    principalCents: 2_200_000, aprBps: 749, termMonths: 72, paymentCents: x.offer.paymentCents, disbursedToAccountId: cu.chk });
  assert.equal(await bal(cu.chk) - before, 2_200_000n);
  const notice = (await cu.c.get(`/api/auto-loans/applications/${a.id}/notice`)).body.notice;                     // still there once funded
  assert.equal(notice.kind, 'counter');
});

test('R25: two staff acting at the same moment: exactly one succeeds', async () => {
  const cu = await customer('Xan');
  const a = (await apply(cu, COUNTER)).body.application;
  const rs = await Promise.all([
    officer.c.post(`/api/staff/auto-loans/applications/${a.id}/approve`, { reason: 'ok' }),
    officer2.c.post(`/api/staff/auto-loans/applications/${a.id}/decline`, { reason: 'no', reasonCodes: ['other_policy'] })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(rs.find(r => r.status === 409).body.error, 'invalid_state');
  assert.equal((await one('SELECT count(*)::int n FROM auto_loan_actions WHERE application_id = $1', [a.id])).n, 1);
});

// ---------- accepting and funding ----------
test('R30-R33, R36: accept needs step-up, then opens one loan and pays out exactly once through two balanced entries', async () => {
  const cu = await customer('Yara');
  const a = (await apply(cu, { vehicle: { year: 2024, make: 'Toyota', model: 'RAV4', vehicleId: vin() } })).body.application;
  const url = `/api/auto-loans/applications/${a.id}/accept`;
  assert.equal((await cu.c.post(url, {})).body.error, 'idempotency_key_required');
  const su = await cu.c.post(url, { idempotencyKey: key() });
  assert.equal(su.status, 403); assert.equal(su.body.error, 'stepup_required');
  await stepUp(cu);
  const fund = await systemAccount(env.pool, 'loan_disbursement');
  const before = await bal(cu.chk), fundBefore = await bal(fund);
  const k = key();
  const r = await cu.c.post(url, { idempotencyKey: k });
  assert.equal(r.status, 200); assert.equal(r.body.replayed, false);
  const { application: x, loan } = r.body;
  assert.equal(x.status, 'funded'); assert.equal(x.loanId, loan.id); assert.equal(x.failureCode, null);
  assert.deepEqual({ ...loan, id: 0, originationEntryId: 0, disbursementEntryId: 0 }, { id: 0, originationEntryId: 0, disbursementEntryId: 0,
    principalCents: 2_500_000, aprBps: 549, termMonths: 60, paymentCents: 47_741, disbursedToAccountId: cu.chk });
  assert.equal(await bal(cu.chk) - before, 2_500_000n); assert.equal(await bal(fund), fundBefore);
  const acct = await one('SELECT * FROM accounts WHERE id = $1', [loan.id]);
  assert.equal(acct.kind, 'loan'); assert.equal(acct.name, 'New Auto Loan'); assert.equal(acct.balance_cents, -2_500_000n);
  assert.equal((await one('SELECT role FROM account_owners WHERE account_id = $1 AND user_id = $2', [loan.id, cu.uid])).role, 'owner');
  const ents = (await env.q(`SELECT e.id, e.idempotency_key, e.kind, l.account_id, l.amount_cents, l.category, l.posted_on FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id
     WHERE e.id = ANY($1) ORDER BY e.kind = 'loan_disbursement', l.amount_cents`, [[loan.originationEntryId, loan.disbursementEntryId]])).rows;
  assert.deepEqual(ents.map(e => [e.idempotency_key, e.kind, e.account_id, e.amount_cents]), [
    [`${cu.uid}:auto-loans:${a.id}:originate`, 'loan_origination', loan.id, -2_500_000n], [`${cu.uid}:auto-loans:${a.id}:originate`, 'loan_origination', fund, 2_500_000n],
    [`${cu.uid}:auto-loans:${a.id}:disburse`, 'loan_disbursement', fund, -2_500_000n], [`${cu.uid}:auto-loans:${a.id}:disburse`, 'loan_disbursement', cu.chk, 2_500_000n]]);
  assert.equal(ents[3].category, 'Loans'); assert.ok(ents.every(e => e.posted_on === bankToday()));
  // a normal loan of the loans module
  assert.ok((await cu.c.get('/api/loans')).body.loans.some(l => l.id === loan.id));
  const lv = (await cu.c.get(`/api/loans/${loan.id}`)).body.loan;
  assert.equal(lv.principal, '25000.00'); assert.equal(lv.apr, '5.49'); assert.equal(lv.term, 60); assert.equal(lv.payment, '477.41');
  assert.equal(lv.original.rows.length, 60); assert.equal(lv.original.totalInterest, toStr(BigInt(a.offer.financeChargeCents)));
  assert.equal(lv.collateral, '2024 Toyota RAV4'); assert.equal(lv.originatedOn, bankToday());
  assert.ok((await cu.c.get('/api/credit')).body.alerts.some(al => al.kind === 'new_account'));
  assert.equal((await audits('autoloan.accept', cu.uid)).length, 1);
  const dis = await audits('autoloan.disburse', cu.uid);
  assert.equal(dis.length, 1); assert.equal(dis[0].detail.application, a.id); assert.equal(dis[0].detail.loan, loan.id); assert.equal(dis[0].detail.amountCents, 2_500_000);
  // replay, conflict, a different key
  const entries = (await one('SELECT count(*)::int n FROM journal_entries')).n;
  const again = await cu.c.post(url, { idempotencyKey: k });
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.deepEqual(again.body.loan, loan); assert.deepEqual(again.body.application, x);
  const fresh = await signIn(env.base, cu.username, 'pw-Yara'); await stepUp(fresh);
  assert.equal((await fresh.post(url, { idempotencyKey: k, disbursementAccountId: cu.sav })).body.error, 'idempotency_conflict');
  const other = await cu.c.post(url, { idempotencyKey: key() });
  assert.equal(other.status, 409); assert.equal(other.body.error, 'already_accepted'); assert.equal(other.body.loanId, loan.id);
  assert.equal((await one('SELECT count(*)::int n FROM journal_entries')).n, entries);
  assert.equal((await audits('autoloan.accept', cu.uid)).length, 1);
  assert.equal((await one('SELECT count(*)::int n FROM loans l JOIN account_owners o ON o.account_id = l.account_id WHERE o.user_id = $1', [cu.uid])).n, 1);
});

test('R32: parallel accepts fund one loan, with the same key or different keys', async () => {
  const cu = await customer('Zed'); await stepUp(cu);
  const a = (await apply(cu)).body.application, b = (await apply(cu)).body.application;
  const k = key();
  const same = await Promise.all([1, 2, 3, 4].map(() => cu.c.post(`/api/auto-loans/applications/${a.id}/accept`, { idempotencyKey: k })));
  assert.ok(same.every(r => r.status === 200));
  assert.equal(same.filter(r => r.body.replayed === false).length, 1);
  assert.equal(new Set(same.map(r => r.body.loan.id)).size, 1);
  const diff = await Promise.all([1, 2, 3, 4].map(() => cu.c.post(`/api/auto-loans/applications/${b.id}/accept`, { idempotencyKey: key() })));
  assert.deepEqual(diff.map(r => r.status).sort(), [200, 409, 409, 409]);
  assert.ok(diff.filter(r => r.status === 409).every(r => r.body.error === 'already_accepted'));
  assert.equal(await bal(cu.chk), 100_000n + 5_000_000n);
  assert.equal((await one(`SELECT count(*)::int n FROM journal_entries WHERE idempotency_key LIKE $1`, [`${cu.uid}:auto-loans:%`])).n, 4);
});

test('R34, R36: an account that is not open fails funding cleanly; the customer can accept again', async () => {
  const cu = await customer('Abel'); await stepUp(cu);
  const a = (await apply(cu)).body.application, url = `/api/auto-loans/applications/${a.id}/accept`;
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.chk]);
  const accounts = (await one('SELECT count(*)::int n FROM accounts')).n, entries = (await one('SELECT count(*)::int n FROM journal_entries')).n;
  const k = key();
  const r = await cu.c.post(url, { idempotencyKey: k });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'account_not_open');
  assert.equal((await one('SELECT count(*)::int n FROM accounts')).n, accounts); assert.equal((await one('SELECT count(*)::int n FROM journal_entries')).n, entries);
  const v = (await cu.c.get(`/api/auto-loans/applications/${a.id}`)).body.application;
  assert.equal(v.status, 'funding_failed'); assert.equal(v.failureCode, 'account_not_open'); assert.deepEqual(v.offer, a.offer); assert.equal(v.loanId, null);
  const ev = await audits('autoloan.funding_failed', cu.uid);
  assert.equal(ev.length, 1); assert.deepEqual(ev[0].detail, { application: a.id, code: 'account_not_open' });
  assert.equal((await audits('autoloan.accept', cu.uid)).length, 0);
  // a closed account chosen at accept fails the same way
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [cu.sav]);
  assert.equal((await cu.c.post(url, { idempotencyKey: key(), disbursementAccountId: cu.sav })).body.error, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [cu.sav]);
  // R35: bad accounts are refused and change nothing
  const other = await customer('Bea');
  assert.equal((await cu.c.post(url, { idempotencyKey: key(), disbursementAccountId: other.chk })).body.error, 'not_found');
  assert.equal((await cu.c.post(url, { idempotencyKey: key(), disbursementAccountId: 'x' })).body.error, 'not_found');
  assert.equal((await cu.c.post(url, { idempotencyKey: key(), disbursementAccountId: 7 })).body.error, 'bad_account');
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${a.id}`)).body.application.status, 'funding_failed');
  // the same key as the failed attempt, now to the open savings account
  const ok = await cu.c.post(url, { idempotencyKey: k, disbursementAccountId: cu.sav });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.replayed, false);
  assert.equal(ok.body.application.status, 'funded'); assert.equal(ok.body.application.failureCode, null);
  assert.equal(ok.body.loan.disbursedToAccountId, cu.sav); assert.equal(await bal(cu.sav), 2_500_000n);
  // funding_failed still expires on the offer's original date
  const b = (await apply(cu, { disbursementAccountId: cu.sav })).body.application;
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [cu.sav]);
  assert.equal((await cu.c.post(`/api/auto-loans/applications/${b.id}/accept`, { idempotencyKey: key() })).body.error, 'account_not_open');
  daysLater(8); await stepUp(cu);
  assert.equal((await cu.c.get(`/api/auto-loans/applications/${b.id}`)).body.application.status, 'expired');
  assert.equal((await cu.c.post(`/api/auto-loans/applications/${b.id}/accept`, { idempotencyKey: key(), disbursementAccountId: cu.sav })).status, 410);
});

test('R33: every account touched by this feature equals the sum of its lines, and every entry balances', async () => {
  const bad = (await env.q(`SELECT a.id FROM accounts a LEFT JOIN ledger_lines l ON l.account_id = a.id GROUP BY a.id HAVING a.balance_cents <> coalesce(sum(l.amount_cents), 0)`)).rows;
  assert.deepEqual(bad, []);
  const unbalanced = (await env.q(`SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.idempotency_key LIKE '%:auto-loans:%' GROUP BY e.id HAVING sum(l.amount_cents) <> 0`)).rows;
  assert.deepEqual(unbalanced, []);
  assert.ok((await one(`SELECT count(*)::int n FROM journal_entries WHERE idempotency_key LIKE '%:auto-loans:%'`)).n >= 8);
});
