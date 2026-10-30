import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { seed } from '../../lib/seed.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { toStr } from '../../lib/money.mjs';
import { monthlyPayment, monthInterest, dailyInterest, schedule, maxPrincipal } from '../../lib/loans-credit/amortize.mjs';
import { bankToday } from '../../lib/bank-date.mjs';
const T = () => `'${bankToday()}'::date`;                       // the bank date the server uses (Central Time)
import { decide } from '../../lib/loans-credit/decide.mjs';

let env, nizam, jordan, ava, asim, zak;
const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'];
before(async () => {
  env = await testEnv();
  nizam = await signIn(env.base, ...NIZAM); jordan = await signIn(env.base, ...JORDAN); ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  asim = await signIn(env.base, 'asim@helixbots.ai', 'asim'); zak = await signIn(env.base, 'zak@helixbots.ai', 'zak');
});
after(async () => { await env.close(); });

const stepUp = async c => { const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); };
const acct = async last4 => (await env.q('SELECT id, balance_cents FROM accounts WHERE number_last4 = $1', [last4])).rows[0];
const uid = async name => (await env.q('SELECT id FROM users WHERE username = $1', [name])).rows[0].id;
const freshInquiries = async () => env.q("UPDATE credit_pulls SET at = at - interval '13 months' WHERE at > now() - interval '1 day'");   // this run's checks stop counting
const PERSONAL = { product: 'personal', amount: '10000', term: 36, annualIncome: '120000', housingPayment: '1650', employment: 'employed' };
let k = 0; const key = () => `test-key-${++k}-${Date.now()}`;

// ---------- amortization ----------
test('golden: $10,000 at 7.74% for 36 months is $312.17 a month, $1,237.96 interest, last payment $312.01', () => {
  // r = 0.00645; (1.00645)^36 = 1.2604317985…; 10000 × 0.00645 × 1.2604318 / 0.2604318 = 312.1656… → 312.17
  assert.equal(monthlyPayment(1000000n, 774, 36), 31217n);
  const s = schedule(1000000n, 774, 36);
  assert.equal(s.length, 36);
  assert.deepEqual(s[0], { n: 1, payment: 31217n, interest: 6450n, principal: 24767n, balance: 975233n });     // 10000 × 0.00645 = 64.50
  assert.deepEqual(s[1], { n: 2, payment: 31217n, interest: 6290n, principal: 24927n, balance: 950306n });     // 9752.33 × 0.00645 = 62.902 → 62.90
  assert.deepEqual(s[35], { n: 36, payment: 31201n, interest: 200n, principal: 31001n, balance: 0n });
  assert.equal(s.reduce((t, r) => t + r.principal, 0n), 1000000n);
  assert.equal(s.reduce((t, r) => t + r.interest, 0n), 123796n);
});

test('more golden values: $25,000 at 24.99% for 84 months, $1,000 at 0% for 12 months', () => {
  // r = 0.2499/12 = 0.020825; (1.020825)^84 = 5.6481859…; 25000 × 0.020825 × 5.6481859 / 4.6481859 = 632.631… → 632.63
  assert.equal(monthlyPayment(2500000n, 2499, 84), 63263n);
  assert.equal(monthlyPayment(100000n, 0, 12), 8333n);                          // 1000 / 12 = 83.333 → 83.33
  const z = schedule(100000n, 0, 12);
  assert.equal(z.at(-1).payment, 8337n);                                        // 11 × 83.33 = 916.63; the last pays 83.37
  assert.equal(z.reduce((t, r) => t + r.principal, 0n), 100000n);
});

test('every schedule pays principal back exactly, in exactly the term', () => {
  for (const [p, bps, n] of [[100000n, 774, 12], [2500000n, 2499, 84], [1234567n, 1349, 60], [75000000n, 699, 240], [500001n, 1, 72], [1850000n, 749, 60]]) {
    const s = schedule(p, bps, n);
    assert.equal(s.length, n, `${p}/${bps}/${n} rows`);
    assert.equal(s.reduce((t, r) => t + r.principal, 0n), p, `${p}/${bps}/${n} principal`);
    assert.ok(s.every(r => r.payment === r.principal + r.interest && r.principal >= 0n));
    assert.ok(s.at(-1).payment <= s[0].payment + 100n);
  }
  assert.ok(monthlyPayment(maxPrincipal(31217n, 774, 36), 774, 36) <= 31217n);
  assert.equal(maxPrincipal(31217n, 774, 36), 1000000n);
});

// ---------- decision rules ----------
const RULES = [{ rule: 'min_score', limit_value: 600, counter: false, rank: 1, reason: 'Credit score is below our minimum for this loan' },
  { rule: 'max_dti', limit_value: 4300, counter: true, rank: 2, reason: 'Debt payments are too high compared with income' }];
const BANDS = [{ min_score: 760, apr_bps: 774 }, { min_score: 720, apr_bps: 999 }, { min_score: 600, apr_bps: 2499 }];
const PROD = { min_amount_cents: 100000, max_term: 84 };
const ask = o => decide({ product: PROD, rules: RULES, bands: BANDS, score: 770, amountCents: 1000000n, term: 36, annualIncomeCents: 12000000n, otherDebtCents: 150000n, ...o });

test('decision: approve prices APR by score band; decline ranks reasons; counteroffer offers a longer term or a lower amount', () => {
  const a = ask({});
  assert.equal(a.decision, 'approved'); assert.equal(a.offer.aprBps, 774); assert.equal(a.offer.paymentCents, 31217n);
  assert.equal(ask({ score: 730 }).offer.aprBps, 999);
  const d = ask({ score: 590, annualIncomeCents: 3000000n });
  assert.equal(d.decision, 'declined');
  assert.deepEqual(d.reasons.map(r => r.rule), ['min_score', 'max_dti']);
  assert.match(d.reasons[0].text, /score: 590; our minimum: 600/);
  assert.match(d.reasons[1].text, /our limit is 43%/);
  const longer = ask({ annualIncomeCents: 5000000n });                       // $4,166.67/mo: 43% is $1,791.67, under $1,812.17; over 48 months it fits
  assert.equal(longer.decision, 'counteroffer'); assert.equal(longer.offer.amountCents, 1000000n); assert.ok(longer.offer.term > 36);
  const lower = ask({ annualIncomeCents: 4500000n, term: 84 });               // already at the longest term: offer less
  assert.equal(lower.decision, 'counteroffer'); assert.equal(lower.offer.term, 84); assert.ok(lower.offer.amountCents < 1000000n);
  assert.equal(lower.offer.amountCents % 10000n, 0n);
  assert.equal(ask({ flagged: true }).decision, 'declined');
});

test('decision: the DTI limit is inclusive, to the cent', () => {
  const pay = monthlyPayment(1000000n, 774, 36), debts = 150000n + pay;       // 1812.17 a month
  // DTI = debts × 12 / income. Exactly 43% when income = debts × 12 / 0.43; pick debts divisible by 43 to get whole cents.
  const extra = (43n - (debts % 43n)) % 43n, at = (debts + extra) * 1200n / 43n;
  const ok = ask({ otherDebtCents: 150000n + extra, annualIncomeCents: at });
  assert.equal(ok.decision, 'approved'); assert.equal(ok.dtiBps, 4300);
  assert.notEqual(ask({ otherDebtCents: 150000n + extra, annualIncomeCents: at - 1n }).decision, 'approved');
});

// ---------- API: prequalify, apply, decide ----------
test('prequalify is a soft check: the score does not move and no hard inquiry is added; applying adds one', async () => {
  await freshInquiries();
  const before = (await nizam.get('/api/credit')).body;
  const hard = async () => (await env.q("SELECT count(*)::int n FROM credit_pulls WHERE user_id = $1 AND kind = 'hard'", [await uid(NIZAM[0])])).rows[0].n;
  const h0 = await hard();
  const pq = await nizam.post('/api/loans/prequalify', { product: 'personal', amount: '10000', term: 36, annualIncome: '120000' });
  assert.equal(pq.status, 200); assert.equal(pq.body.softCheck, true); assert.equal(pq.body.likely, 'approved'); assert.match(pq.body.simulated, /no real credit bureau/);
  const mid = (await nizam.get('/api/credit')).body;
  assert.equal(mid.score, before.score); assert.equal(await hard(), h0);
  assert.ok(mid.inquiries.some(i => i.kind === 'soft' && /prequalification/.test(i.label)));
  await stepUp(nizam);
  assert.equal((await nizam.post('/api/loans/applications', PERSONAL)).status, 200);
  const after = (await nizam.get('/api/credit')).body;
  assert.equal(await hard(), h0 + 1);
  assert.equal(after.score, before.score - 5);
  assert.ok(after.inquiries.some(i => i.kind === 'hard' && i.label === 'Personal Loan application'));
});

test('apply needs a step-up code', async () => {
  const c = await signIn(env.base, ...NIZAM);                                  // Nizam signs in without a code
  const r = await c.post('/api/loans/applications', PERSONAL);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
  await stepUp(c);
  assert.equal((await c.post('/api/loans/applications', PERSONAL)).status, 200);
});

test('approve: APR priced by the score band, decision audited with inputs and no SSN', async () => {
  await freshInquiries(); await stepUp(nizam);
  const r = await nizam.post('/api/loans/applications', PERSONAL);
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, 'approved'); assert.equal(r.body.score, 742);
  assert.equal(r.body.offer.apr, '9.99');                                      // 720–759 band
  assert.equal(r.body.offer.payment, toStr(monthlyPayment(1000000n, 999, 36)));
  const a = (await env.q("SELECT detail FROM audit_events WHERE action = 'loan.decision' AND detail->>'application' = $1", [r.body.id])).rows[0].detail;
  assert.equal(a.decision, 'approved'); assert.equal(a.score, 742); assert.equal(a.annualIncome, '120000.00'); assert.equal(a.employment, 'employed');
  assert.ok(!/ssn|social/i.test(JSON.stringify(a)));
});

test('decline: plain-words reasons, ranked like an adverse action notice', async () => {
  await env.q('UPDATE credit_files SET base_score = 540 WHERE user_id = $1', [await uid(JORDAN[0])]);
  const r = await jordan.post('/api/loans/applications', { ...PERSONAL, annualIncome: '30000', housingPayment: '1400' });
  await env.q('UPDATE credit_files SET base_score = 700 WHERE user_id = $1', [await uid(JORDAN[0])]);
  assert.equal(r.status, 200); assert.equal(r.body.decision, 'declined'); assert.equal(r.body.offer, null);
  assert.equal(r.body.reasons.length, 2);
  assert.match(r.body.reasons[0], /^Credit score is below our minimum/);
  assert.match(r.body.reasons[1], /^Debt payments are too high compared with income/);
  const acc = await jordan.post(`/api/loans/applications/${r.body.id}/accept`, { depositAccountId: (await acct('3388')).id, idempotencyKey: key() });
  assert.equal(acc.status, 409); assert.equal(acc.body.error, 'declined');
});

test('a name containing DECLINE always declines', async () => {
  await stepUp(nizam);
  const r = await nizam.post('/api/loans/applications', { ...PERSONAL, legalName: 'Test DECLINE Person' });
  assert.equal(r.body.decision, 'declined'); assert.match(r.body.reasons[0], /DECLINE/);
});

test('counteroffer: a longer term for DTI, a lower amount for vehicle LTV', async () => {
  await freshInquiries(); await stepUp(nizam);
  const t = await nizam.post('/api/loans/applications', { ...PERSONAL, amount: '20000', annualIncome: '56000', housingPayment: '1400' });
  assert.equal(t.body.decision, 'counteroffer');
  assert.equal(t.body.offer.amount, '20000.00'); assert.ok(t.body.offer.term > 36);
  assert.match(t.body.reasons[0], /Debt payments are too high/);
  const v = await nizam.post('/api/loans/applications', { product: 'auto_used', amount: '30000', term: 60, annualIncome: '150000', housingPayment: '1650', employment: 'employed', vehicleValue: '20000' });
  assert.equal(v.body.decision, 'counteroffer');
  assert.equal(v.body.offer.amount, '24000.00');                               // 120% of $20,000
  assert.match(v.body.reasons[0], /vehicle's value \(150%; our limit is 120%\)/);
  const h = await nizam.post('/api/loans/applications', { product: 'home_equity', amount: '100000', term: 120, annualIncome: '180000', housingPayment: '2100', employment: 'employed', propertyValue: '400000', mortgageBalance: '280000' });
  assert.equal(h.body.decision, 'counteroffer'); assert.equal(h.body.offer.amount, '60000.00');   // 85% × 400k − 280k
});

test('DTI boundary through the API: exactly 43% is approved, one cent less income is not', async () => {
  await freshInquiries(); await stepUp(nizam);
  const id = await uid(NIZAM[0]);
  const loans = (await env.q("SELECT coalesce(sum(payment_cents), 0)::bigint s FROM loans l JOIN account_owners o ON o.account_id = l.account_id WHERE o.user_id = $1 AND l.status = 'active'", [id])).rows[0].s;
  const card = 2500n;                                                           // $418.20 owed: 3% is $12.55, so the $25 minimum
  const base = loans + card + monthlyPayment(1000000n, 999, 36);
  let housing = 150000n; housing += (43n - ((base + housing) % 43n)) % 43n;
  const income = (base + housing) * 1200n / 43n;
  const at = await nizam.post('/api/loans/applications', { ...PERSONAL, housingPayment: toStr(housing), annualIncome: toStr(income) });
  assert.equal(at.body.decision, 'approved'); assert.equal(at.body.dti, '43%');
  await freshInquiries(); await stepUp(nizam);
  const under = await nizam.post('/api/loans/applications', { ...PERSONAL, housingPayment: toStr(housing), annualIncome: toStr(income - 1n) });
  assert.equal(under.body.decision, 'counteroffer');
});

test('a minor cannot prequalify, apply or see a credit score', async () => {
  await stepUp(ava);
  for (const r of [await ava.post('/api/loans/applications', PERSONAL), await ava.post('/api/loans/prequalify', PERSONAL), await ava.get('/api/credit')]) {
    assert.equal(r.status, 403); assert.equal(r.body.error, 'not_eligible');
  }
  assert.equal((await env.q('SELECT count(*)::int n FROM loan_applications WHERE user_id = $1', [await uid('ava@usabanc.example')])).rows[0].n, 0);
});

// ---------- accept, disburse, repay ----------
async function approvedLoan(c = nizam, body = PERSONAL) {
  await freshInquiries(); await stepUp(c);
  const r = await c.post('/api/loans/applications', body);
  assert.equal(r.body.decision, 'approved');
  return r.body;
}

test('accept needs a step-up code and an unexpired offer', async () => {
  const app = await approvedLoan();
  await env.q('UPDATE sessions SET stepup_at = now() - interval \'10 minutes\'');
  const chk = (await acct('4471')).id;
  const r = await nizam.post(`/api/loans/applications/${app.id}/accept`, { depositAccountId: chk, idempotencyKey: key() });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
  await stepUp(nizam);
  await env.q("UPDATE loan_applications SET offer_expires_at = now() - interval '1 minute' WHERE id = $1", [app.id]);
  const late = await nizam.post(`/api/loans/applications/${app.id}/accept`, { depositAccountId: chk, idempotencyKey: key() });
  assert.equal(late.status, 410); assert.equal(late.body.error, 'offer_expired');
});

test('disbursement happens once: a retry returns the same loan, a second accept is refused', async () => {
  const app = await approvedLoan();
  const chk = await acct('4471'), idem = key();
  const body = { depositAccountId: chk.id, idempotencyKey: idem };
  const [a, b] = await Promise.all([nizam.post(`/api/loans/applications/${app.id}/accept`, body), nizam.post(`/api/loans/applications/${app.id}/accept`, body)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.loan.id, b.body.loan.id);
  assert.deepEqual([a.body.replayed, b.body.replayed].sort(), [false, true]);
  const again = await nizam.post(`/api/loans/applications/${app.id}/accept`, { ...body, idempotencyKey: key() });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_accepted');
  assert.equal((await acct('4471')).balance_cents, chk.balance_cents + 1000000n);
  const loan = (await env.q('SELECT balance_cents, kind FROM accounts WHERE id = $1', [a.body.loan.id])).rows[0];
  assert.equal(loan.kind, 'loan'); assert.equal(loan.balance_cents, -1000000n);
  const n = (await env.q("SELECT count(*)::int n FROM journal_entries WHERE kind = 'loan_disbursement' AND memo = $1", [`application ${app.id}`])).rows[0].n;
  assert.equal(n, 1);
  const funding = (await env.q("SELECT l.amount_cents FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.system_code = 'loan_disbursement' AND e.memo = $1", [`application ${app.id}`])).rows;
  assert.deepEqual(funding.map(x => x.amount_cents).sort(), [-1000000n, 1000000n]);
  const owners = (await env.q('SELECT role FROM account_owners WHERE account_id = $1', [a.body.loan.id])).rows;
  assert.deepEqual(owners, [{ role: 'owner' }]);
  for (const act of ['loan.accept', 'loan.disburse']) assert.equal((await env.q("SELECT count(*)::int n FROM audit_events WHERE action = $1 AND detail->>'loan' = $2", [act, a.body.loan.id])).rows[0].n, 1);
});

let loanId;
test('a scheduled payment splits into interest (to loan interest income) and principal; a retry pays once', async () => {
  const app = await approvedLoan(nizam, { ...PERSONAL, amount: '5000', term: 24 });
  await stepUp(nizam);
  const chk = (await acct('4471')).id;
  loanId = (await nizam.post(`/api/loans/applications/${app.id}/accept`, { depositAccountId: chk, idempotencyKey: key() })).body.loan.id;
  // the first installment, 30 days after the loan was booked: interest is charged for the days that passed (R6).
  // This test used to expect a full month's interest (monthInterest = $41.63) whatever the days; 30 days is $41.05.
  await env.q(`UPDATE loans SET originated_on = ${T()} - 30 WHERE account_id = $1`, [loanId]);
  const before = (await acct('4471')).balance_cents;
  const income = async () => (await env.q("SELECT balance_cents FROM accounts WHERE system_code = 'loan_interest_income'")).rows[0].balance_cents;
  const i0 = await income();
  const body = { fromAccountId: chk, kind: 'scheduled', idempotencyKey: key() };
  const p = await nizam.post(`/api/loans/${loanId}/payments`, body);
  assert.equal(p.status, 200);
  const pay = monthlyPayment(500000n, 999, 24), interest = dailyInterest(500000n, 999, 30);
  assert.equal(interest, 4105n);                                                                 // 500000 × 999 × 30 / 3,650,000 = 4105.48 → $41.05
  assert.equal(p.body.payment.amount, toStr(pay)); assert.equal(p.body.payment.interest, '41.05'); assert.equal(p.body.payment.principal, toStr(pay - interest));
  assert.notEqual(p.body.payment.interest, toStr(monthInterest(500000n, 999)));                  // not a flat month ($41.63)
  const r = await nizam.post(`/api/loans/${loanId}/payments`, body);
  assert.equal(r.body.replayed, true); assert.equal(r.body.payment.id, p.body.payment.id);
  assert.equal((await acct('4471')).balance_cents, before - pay);
  assert.equal(await income(), i0 + interest);
  assert.equal((await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [loanId])).rows[0].balance_cents, -(500000n - (pay - interest)));
  const d = await nizam.get(`/api/loans/${loanId}`);
  assert.equal(d.body.loan.installmentsPaid, 1); assert.equal(d.body.loan.original.totalPrincipal, '5000.00');
  assert.equal(d.body.loan.remaining.reduce((s, x) => s + BigInt(x.principal.replace('.', '')), 0n), 500000n - (pay - interest));
});

test('extra principal; no paying past payoff; payoff closes the loan', async () => {
  const chk = (await acct('4471')).id, owed = async () => -(await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [loanId])).rows[0].balance_cents;
  const o0 = await owed();
  const x = await nizam.post(`/api/loans/${loanId}/payments`, { fromAccountId: chk, kind: 'extra', amount: '500.00', idempotencyKey: key() });
  assert.equal(x.status, 200); assert.equal(x.body.payment.principal, '500.00'); assert.equal(x.body.payment.interest, '0.00');
  assert.equal(await owed(), o0 - 50000n);
  const over = await nizam.post(`/api/loans/${loanId}/payments`, { fromAccountId: chk, kind: 'extra', amount: '99999', idempotencyKey: key() });
  assert.equal(over.status, 400); assert.match(over.body.message, /can't be more than/);
  const exact = await nizam.post(`/api/loans/${loanId}/payments`, { fromAccountId: chk, kind: 'extra', amount: toStr(await owed()), idempotencyKey: key() });
  assert.equal(exact.status, 422); assert.equal(exact.body.error, 'use_payoff');
  await env.q(`UPDATE loans SET last_paid_on = ${T()} - 10 WHERE account_id = $1`, [loanId]);          // ten days of interest
  const q = await nizam.get(`/api/loans/${loanId}/payoff`);
  const owedNow = await owed(), accrued = (owedNow * 999n * 10n * 2n + 3650000n) / (2n * 3650000n);
  assert.equal(q.body.principal, toStr(owedNow)); assert.equal(q.body.interest, toStr(accrued)); assert.equal(q.body.total, toStr(owedNow + accrued));
  const po = await nizam.post(`/api/loans/${loanId}/payments`, { fromAccountId: chk, kind: 'payoff', idempotencyKey: key() });
  assert.equal(po.status, 200); assert.equal(po.body.payment.amount, q.body.total);
  assert.equal(po.body.loan.status, 'paid_off'); assert.equal(await owed(), 0n);
  assert.equal((await env.q('SELECT status FROM accounts WHERE id = $1', [loanId])).rows[0].status, 'closed');
  const more = await nizam.post(`/api/loans/${loanId}/payments`, { fromAccountId: chk, kind: 'scheduled', idempotencyKey: key() });
  assert.equal(more.status, 409); assert.equal(more.body.error, 'paid_off');
  assert.equal((await env.q("SELECT count(*)::int n FROM audit_events WHERE action = 'loan.paid_off' AND detail->>'loan' = $1", [loanId])).rows[0].n, 1);
});

test("someone else's loan and application are a 404", async () => {
  const seeded = (await env.q("SELECT id FROM accounts WHERE number_last4 = '6142'")).rows[0].id;   // Asim's car loan
  assert.equal((await asim.get(`/api/loans/${seeded}`)).status, 200);
  assert.equal((await nizam.get(`/api/loans/${seeded}`)).status, 404);
  assert.equal((await jordan.get(`/api/loans/${seeded}`)).status, 404);
  assert.equal((await jordan.get(`/api/loans/${seeded}/payoff`)).status, 404);
  const pay = await jordan.post(`/api/loans/${seeded}/payments`, { fromAccountId: (await acct('3388')).id, kind: 'scheduled', idempotencyKey: key() });
  assert.equal(pay.status, 404);
  assert.equal((await jordan.get(`/api/loans/${(await acct('4471')).id}`)).status, 404);                 // an account that isn't a loan
  const app = (await env.q('SELECT id FROM loan_applications WHERE user_id = $1 LIMIT 1', [await uid(NIZAM[0])])).rows[0].id;
  assert.equal((await jordan.get(`/api/loans/applications/${app}`)).status, 404);
  await stepUp(jordan);
  assert.equal((await jordan.post(`/api/loans/applications/${app}/accept`, { depositAccountId: (await acct('3388')).id, idempotencyKey: key() })).status, 404);
  const pay2 = await asim.post(`/api/loans/${seeded}/payments`, { fromAccountId: (await acct('3388')).id, kind: 'scheduled', idempotencyKey: key() });
  assert.equal(pay2.status, 404);                                               // paying from Jordan's checking
});

// ---------- credit tools ----------
test('credit score: 12 months of history, factors from real card balances, and a what-if simulator', async () => {
  await freshInquiries();
  const r = await nizam.get('/api/credit');
  assert.equal(r.status, 200); assert.match(r.body.simulated, /no real credit bureau/);
  assert.equal(r.body.history.length, 12); assert.equal(r.body.score, 742); assert.equal(r.body.history.at(-1).score, 742);
  assert.deepEqual(r.body.factors.map(f => f.key), ['payment', 'utilization', 'age', 'inquiries', 'mix']);
  assert.equal(r.body.factors[1].percent, 17);                                  // $418.20 of $2,500
  assert.ok(r.body.offers.some(o => o.product === 'personal' && o.apr === '9.99'));
  const card = await acct('0088');
  await tx(env.pool, async c => post(c, { key: 'test:card-spend', kind: 'seed', lines: [
    { accountId: card.id, amountCents: -100000n, description: 'Big purchase' }, { accountId: await systemAccount(c, 'card_settlement'), amountCents: 100000n, description: 'x' }] }));
  const r2 = await nizam.get('/api/credit');
  assert.equal(r2.body.factors[1].percent, 57); assert.equal(r2.body.score, 742 - 50);
  const s = await nizam.post('/api/credit/simulate', { payDown: '1418.20' });
  assert.equal(s.body.score, 742 + 20); assert.equal(s.body.change, 70);
  const miss = await nizam.post('/api/credit/simulate', { missPayment: true });
  assert.equal(miss.body.change, -45);
  const open = await nizam.post('/api/credit/simulate', { newCardLimit: '5000' });
  assert.equal(open.body.factors[3].impact, -10);                               // the new card adds a hard inquiry
  assert.equal((await nizam.get('/api/credit')).body.score, 692);               // simulating saves nothing
  const j = await jordan.get('/api/credit');
  assert.ok(j.body.inquiries.some(i => i.source === 'card' && i.kind === 'hard'));          // card applications show on the file
});

test('a new user gets a deterministic credit file', async () => {
  await env.q('DELETE FROM credit_score_history WHERE user_id = $1', [await uid(JORDAN[0])]);
  await env.q('DELETE FROM credit_files WHERE user_id = $1', [await uid(JORDAN[0])]);
  const a = (await jordan.get('/api/credit')).body;
  await env.q('DELETE FROM credit_score_history WHERE user_id = $1', [await uid(JORDAN[0])]);
  await env.q('DELETE FROM credit_files WHERE user_id = $1', [await uid(JORDAN[0])]);
  const b = (await jordan.get('/api/credit')).body;
  assert.equal(a.score, b.score); assert.deepEqual(a.history, b.history); assert.equal(a.history.length, 12);
});

test('seeding again adds nothing, and the ledger still balances', async () => {
  const count = async () => (await env.q('SELECT (SELECT count(*) FROM loans)::int + (SELECT count(*) FROM loan_payments)::int + (SELECT count(*) FROM credit_files)::int n')).rows[0].n;
  const n = await count();
  await tx(env.pool, seed);
  assert.equal(await count(), n);
  assert.equal((await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY 1) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`)).rowCount, 0);
  const seeded = (await env.q("SELECT a.balance_cents, l.principal_cents, (SELECT sum(principal_cents) FROM loan_payments p WHERE p.loan_account_id = a.id) paid FROM accounts a JOIN loans l ON l.account_id = a.id WHERE a.number_last4 = '6142'")).rows[0];
  assert.equal(-seeded.balance_cents, seeded.principal_cents - BigInt(seeded.paid));
});

// ---------- pulls, alerts, offers, system accounts, seeded data ----------
test('every pull is a credit_pull labeled Simulated, with the score it returned', async () => {
  const rows = (await env.q('SELECT bureau, kind, score FROM credit_pulls')).rows;
  assert.ok(rows.length >= 6);
  assert.ok(rows.every(r => r.bureau === 'Simulated' && r.score >= 300 && r.score <= 850));
  await assert.rejects(env.q("INSERT INTO credit_pulls (id, user_id, kind, source, label, bureau) SELECT gen_random_uuid(), id, 'soft', 'loan', 'x', 'TransUnion' FROM users LIMIT 1"));
  const c = (await nizam.get('/api/credit')).body;
  assert.ok(c.inquiries.length >= 2 && c.inquiries.every(i => i.bureau === 'Simulated'));
});

test('alerts: a hard pull, a new loan and a payoff each raise one monitoring alert; mark-read works and is private', async () => {
  const before = (await nizam.get('/api/credit')).body;
  const app = await approvedLoan(nizam, { ...PERSONAL, amount: '2000', term: 12 });
  await stepUp(nizam);
  const chk = (await acct('4471')).id;
  const loan = (await nizam.post(`/api/loans/applications/${app.id}/accept`, { depositAccountId: chk, idempotencyKey: key() })).body.loan;
  await nizam.post(`/api/loans/${loan.id}/payments`, { fromAccountId: chk, kind: 'payoff', idempotencyKey: key() });
  const after = (await nizam.get('/api/credit')).body;
  const fresh = after.alerts.filter(a => !before.alerts.some(b => b.id === a.id));
  assert.deepEqual(fresh.map(a => a.kind).sort(), ['hard_pull', 'new_account', 'paid_off']);
  assert.equal(after.unread, before.unread + 3);
  assert.equal((await nizam.get('/api/credit')).body.alerts.length, after.alerts.length);       // reading again adds nothing
  const one = await nizam.post('/api/credit/alerts/read', { ids: [fresh[0].id] });
  assert.equal(one.body.unread, after.unread - 1);
  const theirs = (await jordan.get('/api/credit')).body;
  const other = await nizam.post('/api/credit/alerts/read', { ids: theirs.alerts.map(a => a.id) });     // someone else's alerts don't change
  assert.equal(other.body.marked, 0);
  assert.equal((await jordan.get('/api/credit')).body.unread, theirs.unread);
  assert.equal((await nizam.post('/api/credit/alerts/read', {})).status, 400);
  assert.equal((await nizam.post('/api/credit/alerts/read', { all: true })).body.unread, 0);
});

test('prequalified offers are soft, expire, and route to the loan and card apply flows', async () => {
  const n = (await nizam.get('/api/credit')).body;
  const card = n.offers.find(o => o.kind === 'card');
  assert.equal(card.href, '/app/cards'); assert.match(card.note, /soft check/);
  assert.ok(n.offers.filter(o => o.kind === 'loan').every(o => o.href === `/app/loans?apply=${o.product}` && o.expiresOn > bankToday()));
  const z = (await zak.get('/api/credit')).body;                                // Zak's lower score: no card, no HELOC
  assert.ok(!z.offers.some(o => o.kind === 'card' || o.product === 'heloc'));
  assert.ok(z.offers.some(o => o.product === 'personal'));
});

test('loan money moves only through system accounts in the loans range (...040-...049)', async () => {
  const sys = (await env.q("SELECT id, system_code FROM accounts WHERE id::text LIKE '00000000-0000-4000-8000-00000000004_' ORDER BY id")).rows;
  assert.deepEqual(sys.map(s => s.system_code), ['loan_interest_income', 'loan_disbursement', 'loan_autopay_clearing']);
  assert.ok(sys.every(s => /^00000000-0000-4000-8000-0000000000(4\d)$/.test(s.id)));
  const touched = (await env.q(`SELECT DISTINCT a.system_code FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.kind LIKE 'loan_%' AND a.kind = 'system'`)).rows.map(r => r.system_code).sort();
  assert.deepEqual(touched, ['loan_autopay_clearing', 'loan_disbursement', 'loan_interest_income']);
  const unbalanced = (await env.q("SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.kind LIKE 'loan_%' GROUP BY e.id HAVING sum(l.amount_cents) <> 0")).rowCount;
  assert.equal(unbalanced, 0);
});

test('seeded: Nizam has an approved offer to accept, Asim a car loan, Zak a personal loan and a declined HELOC', async () => {
  const seededId = (await env.q("SELECT id FROM loan_applications WHERE user_id = $1 AND amount_cents = 800000 ORDER BY created_at LIMIT 1", [await uid(NIZAM[0])])).rows[0].id;
  const offer = (await nizam.get(`/api/loans/applications/${seededId}`)).body.application;
  assert.equal(offer.decision, 'approved'); assert.equal(offer.status, 'decided');
  assert.ok(offer && !offer.offer.expired); assert.equal(offer.offer.apr, '9.99');
  const a = (await asim.get('/api/loans')).body;
  assert.equal(a.loans.length, 1); assert.equal(a.loans[0].collateral, '2021 Subaru Outback'); assert.equal(a.loans[0].installmentsPaid, 3);
  const ad = (await asim.get(`/api/loans/${a.loans[0].id}`)).body.loan;
  assert.equal(ad.payments.length, 3); assert.equal(ad.remaining.length, 57); assert.equal(ad.original.totalPrincipal, '18500.00');
  const z = (await zak.get('/api/loans')).body;
  assert.equal(z.loans[0].installmentsPaid, 5);
  const heloc = z.applications.find(x => x.product.code === 'heloc');
  assert.equal(heloc.decision, 'declined'); assert.equal(heloc.reasons.length, 2);
  const zc = (await zak.get('/api/credit')).body;
  assert.equal(zc.factors[0].rating, 'poor');                                   // the late payment on file
  assert.ok(zc.alerts.some(x => x.kind === 'hard_pull' && !x.read));
  // Accepting Nizam's seeded offer disburses it to checking
  await stepUp(nizam);
  const chk = await acct('4471');
  const r = await nizam.post(`/api/loans/applications/${offer.id}/accept`, { depositAccountId: chk.id, idempotencyKey: key() });
  assert.equal(r.status, 200); assert.equal(r.body.loan.principal, '8000.00'); assert.equal(r.body.loan.payment, toStr(monthlyPayment(800000n, 999, 36)));
  assert.equal((await acct('4471')).balance_cents, chk.balance_cents + 800000n);
});

test('auto and home equity loans: accept a secured offer, schedule matches the term, collateral recorded', async () => {
  await freshInquiries(); await stepUp(asim);
  const chk = (await acct('6120')).id;
  const auto = await asim.post('/api/loans/applications', { product: 'auto_new', amount: '30000', term: 60, annualIncome: '150000', housingPayment: '1800', employment: 'employed', vehicleValue: '32000', vehicle: '2026 Kia EV6' });
  assert.equal(auto.body.decision, 'approved'); assert.equal(auto.body.ltv, '93.75%');
  const l1 = (await asim.post(`/api/loans/applications/${auto.body.id}/accept`, { depositAccountId: chk, idempotencyKey: key() })).body.loan;
  assert.equal(l1.collateral, '2026 Kia EV6');
  const d1 = (await asim.get(`/api/loans/${l1.id}`)).body.loan;
  assert.equal(d1.original.rows.length, 60); assert.equal(d1.original.totalPrincipal, '30000.00');
  await freshInquiries(); await stepUp(asim);
  const he = await asim.post('/api/loans/applications', { product: 'home_equity', amount: '40000', term: 120, annualIncome: '150000', housingPayment: '1800', employment: 'employed', propertyValue: '500000', mortgageBalance: '300000' });
  assert.equal(he.body.decision, 'approved'); assert.equal(he.body.ltv, '68%');
  const l2 = (await asim.post(`/api/loans/applications/${he.body.id}/accept`, { depositAccountId: chk, idempotencyKey: key() })).body.loan;
  const d2 = (await asim.get(`/api/loans/${l2.id}`)).body.loan;
  assert.equal(d2.original.rows.length, 120); assert.equal(d2.original.totalPrincipal, '40000.00');
});
