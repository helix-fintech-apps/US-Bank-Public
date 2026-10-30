// Loans & credit demo data. Every dollar goes through the ledger; every pull is labeled Simulated. Safe to run again:
// a credit file is added only for someone who has none, and a seeded loan only if its ledger key is new.
//  - Nizam: a credit file with 12 months of history, a soft and a hard pull, and an approved Personal Loan offer that is
//    waiting for him to accept (so the accept → disburse → repay flow is one click away). No loan account yet.
//  - Asim: a used-car loan with three autopay payments, so the loan page has a schedule and history.
//  - Zak: a personal loan five payments in, a declined HELOC application with its reasons, and a late payment on file.
//  - Jordan: a credit file and a card application's hard pull.
import { newId } from '../auth.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { toStr } from '../money.mjs';
import { schedule, monthlyPayment, addMonths } from '../loans-credit/amortize.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const FILES = {
  'nizam@helixbots.ai': { base: 732, late: 0, oldest: 96, debt: 0n, kinds: ['installment'], history: [718, 721, 719, 724, 727, 726, 731, 734, 733, 738, 740] },
  'jordan@usabanc.example': { base: 700, late: 0, oldest: 62, debt: 21000n, kinds: ['installment'], history: [662, 660, 665, 668, 667, 671, 670, 674, 676, 679, 680] },
  'asim@helixbots.ai': { base: 705, late: 0, oldest: 40, debt: 0n, kinds: [], history: [698, 701, 699, 704, 708, 712, 710, 714, 717, 716, 719] },
  'zak@helixbots.ai': { base: 690, late: 1, oldest: 30, debt: 35000n, kinds: [], history: [671, 668, 664, 659, 662, 660, 655, 652, 648, 646, 644] }
};

const LOANS = [
  { user: 'asim@helixbots.ai', product: 'auto_used', name: 'Used Auto Loan', principal: 1850000n, apr: 749, term: 60, paid: 3, last4: '6142',
    collateral: { value: '21000.00', vehicle: '2021 Subaru Outback' }, label: '2021 Subaru Outback', score: 718, income: 9600000n, housing: 180000n,
    paidTo: 'Paid to dealer for 2021 Subaru Outback (simulated)' },
  { user: 'zak@helixbots.ai', product: 'personal', name: 'Personal Loan', principal: 600000n, apr: 1899, term: 24, paid: 5, last4: '7142',
    collateral: null, label: null, score: 648, income: 7800000n, housing: 180000n,
    paidTo: 'Sent to your account at another bank (simulated)' }
];

async function pull(c, userId, { kind, source, label, score, at }) {
  const id = newId();
  await c.query('INSERT INTO credit_pulls (id, user_id, kind, source, label, score, at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, userId, kind, source, label, score, at]);
  if (kind === 'hard') await c.query(`INSERT INTO credit_alerts (user_id, kind, ref, title, body, created_at) VALUES ($1,'hard_pull',$2,'New hard inquiry on your file',$3,$4)
     ON CONFLICT DO NOTHING`, [userId, `pull:${id}`, `${label}. If you didn't apply, contact us. (Simulated: no real credit bureau.)`, at]);
  return id;
}

async function application(c, userId, a) {
  const id = newId();
  await c.query(`INSERT INTO loan_applications (id, user_id, product_code, amount_cents, term_months, annual_income_cents, housing_cents, employment, collateral, score,
      dti_bps, ltv_bps, pull_id, decision, reasons, offer_amount_cents, offer_term, offer_apr_bps, offer_payment_cents, offer_expires_at, status, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'employed',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, userId, a.product, a.amount, a.term, a.income, a.housing, a.collateral ?? null, a.score, a.dti ?? null, a.ltv ?? null, a.pullId, a.decision, JSON.stringify(a.reasons ?? []),
      a.offer ? a.amount : null, a.offer ? a.term : null, a.offer ? a.apr : null, a.offer ? monthlyPayment(a.amount, a.apr, a.term) : null,
      a.offer ? a.expires : null, a.status ?? 'decided', a.at]);
  await c.query("INSERT INTO audit_events (user_id, action, detail, at) VALUES ($1, 'loan.decision', $2, $3)", [userId,
    { application: id, product: a.product, amount: toStr(a.amount), term: a.term, score: a.score, bureau: 'Simulated', hardPull: a.pullId, decision: a.decision, reasons: a.reasons ?? [], seeded: true }, a.at]);
  return id;
}

async function seedLoan(c, userId, L) {
  const key = `seed:loans-credit:${L.user}`;
  if ((await c.query('SELECT 1 FROM journal_entries WHERE idempotency_key = $1', [`${key}:originate`])).rowCount) return;
  const start = new Date(Date.parse(addMonths(today(), -L.paid) + 'T00:00:00Z') - 5 * 86_400_000).toISOString().slice(0, 10);   // `paid` months and 5 days ago
  const pay = monthlyPayment(L.principal, L.apr, L.term), rows = schedule(L.principal, L.apr, L.term), loan = newId();
  const pullId = await pull(c, userId, { kind: 'hard', source: 'loan', label: `${L.name} application`, score: L.score, at: start });
  await c.query('UPDATE credit_alerts SET read_at = created_at WHERE user_id = $1 AND ref = $2', [userId, `pull:${pullId}`]);
  const app = await application(c, userId, { product: L.product, amount: L.principal, term: L.term, income: L.income, housing: L.housing, collateral: L.collateral,
    score: L.score, pullId, decision: 'approved', offer: true, apr: L.apr, expires: start, status: 'accepted', at: start });
  await c.query("INSERT INTO accounts (id, kind, name, number_last4, allow_negative, payment_due, opened_at) VALUES ($1, 'loan', $2, $3, true, $4, $5::date)",
    [loan, L.name, L.last4, addMonths(start, L.paid + 1), start]);
  await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1, $2, 'owner')", [loan, userId]);
  await c.query(`INSERT INTO loans (account_id, application_id, product_code, principal_cents, apr_bps, term_months, payment_cents, originated_on, next_due, last_paid_on, installments_paid, collateral_label)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [loan, app, L.product, L.principal, L.apr, L.term, pay, start, addMonths(start, L.paid + 1), addMonths(start, L.paid), L.paid, L.label]);
  await c.query("INSERT INTO credit_alerts (user_id, kind, ref, title, body, created_at, read_at) VALUES ($1, 'new_account', $2, 'New account on your file', $3, $4, $4)",
    [userId, `loan:${loan}`, `${L.name} ··${L.last4} opened ${start}. (Simulated: no real credit bureau.)`, start]);
  await post(c, { key: `${key}:originate`, kind: 'loan_origination', memo: `application ${app}`, lines: [
    { accountId: loan, amountCents: -L.principal, description: `${L.name} opened`, category: 'Loans', postedOn: start },
    { accountId: await systemAccount(c, 'loan_disbursement'), amountCents: L.principal, description: L.paidTo, postedOn: start }] });
  for (const r of rows.slice(0, L.paid)) {
    const d = addMonths(start, r.n), k = `${key}:pay:${r.n}`;
    const { entryId } = await post(c, { key: k, kind: 'loan_payment', lines: [
      { accountId: await systemAccount(c, 'loan_autopay_clearing'), amountCents: -r.payment, description: 'Autopay from external bank (ACH, simulated)', postedOn: d },
      { accountId: loan, amountCents: r.principal, description: 'Payment, principal', category: 'Loans', postedOn: d },
      { accountId: await systemAccount(c, 'loan_interest_income'), amountCents: r.interest, description: `Interest, loan ··${L.last4}`, postedOn: d }] });
    await c.query(`INSERT INTO loan_payments (id, loan_account_id, kind, amount_cents, principal_cents, interest_cents, entry_id, idempotency_key, posted_on)
      VALUES ($1,$2,'scheduled',$3,$4,$5,$6,$7,$8)`, [newId(), loan, r.payment, r.principal, r.interest, entryId, k, d]);
  }
}

export async function seed(c) {
  const users = (await c.query('SELECT id, username FROM users WHERE username = ANY($1)', [Object.keys(FILES)])).rows;
  const id = Object.fromEntries(users.map(u => [u.username, u.id]));
  for (const [name, f] of Object.entries(FILES)) {
    if (!id[name] || (await c.query('SELECT 1 FROM credit_files WHERE user_id = $1', [id[name]])).rowCount) continue;
    await c.query('INSERT INTO credit_files (user_id, base_score, late_payments, oldest_months, other_monthly_debt_cents, other_kinds) VALUES ($1,$2,$3,$4,$5,$6)',
      [id[name], f.base, f.late, f.oldest, f.debt, f.kinds]);
    for (const [i, s] of f.history.entries())
      await c.query(`INSERT INTO credit_score_history (user_id, month, score) VALUES ($1, date_trunc('month', current_date) - make_interval(months => $2), $3) ON CONFLICT DO NOTHING`, [id[name], 11 - i, s]);

    if (name === 'jordan@usabanc.example') await pull(c, id[name], { kind: 'hard', source: 'card', label: 'Cash+ Card application', score: 676, at: daysAgo(61) });
    if (name === 'nizam@helixbots.ai') {
      // A soft prequalify, then the application it led to: approved, with the offer open for 26 more days.
      await pull(c, id[name], { kind: 'soft', source: 'prequalify', label: 'Personal Loan prequalification', score: 747, at: daysAgo(5) });
      const pullId = await pull(c, id[name], { kind: 'hard', source: 'loan', label: 'Personal Loan application', score: 747, at: daysAgo(4) });
      await application(c, id[name], { product: 'personal', amount: 800000n, term: 36, income: 12000000n, housing: 165000n, score: 747, dti: 1933, pullId,
        decision: 'approved', offer: true, apr: 999, expires: new Date(Date.now() + 26 * 86_400_000), at: daysAgo(4) });
    }
    if (name === 'zak@helixbots.ai') {
      // A HELOC asked for and declined: score under the HELOC minimum, and the home already borrowed against too far.
      const pullId = await pull(c, id[name], { kind: 'hard', source: 'loan', label: 'Home Equity Line of Credit application', score: 641, at: daysAgo(20) });
      await application(c, id[name], { product: 'heloc', amount: 5000000n, term: 120, income: 7800000n, housing: 180000n, score: 641, ltv: 9200, pullId,
        collateral: { value: '350000.00', mortgageBalance: '272000.00' }, decision: 'declined', at: daysAgo(20),
        reasons: ['Credit score is below our minimum for this loan (your simulated score: 641; our minimum: 660).',
          'Total borrowing against the home is too high compared with its value (92%; our limit is 85%).'] });
    }
  }
  for (const L of LOANS) if (id[L.user]) await seedLoan(c, id[L.user], L);
}
