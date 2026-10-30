// The loan decision: rules come from the loan_rules table, APRs from loan_rate_bands. Pure (no database), so tests
// can run boundaries directly. Ratios are compared exactly in BigInt: debts·10000·12 <= limit·annual income.
import { monthlyPayment, maxPrincipal } from './amortize.mjs';

const TERMS = [12, 24, 36, 48, 60, 72, 84, 120, 180, 240];
const STEP = 10000n;                                                     // counteroffers are whole hundreds of dollars
export const pct = bps => `${Math.floor(bps / 100)}${bps % 100 ? '.' + String(bps % 100).padStart(2, '0').replace(/0$/, '') : ''}%`;   // ok-number: basis points to text

/** The APR for a score: the highest band the score reaches, or null (below every band). */
export const aprFor = (bands, score) => bands.filter(b => score >= b.min_score).sort((a, b) => b.min_score - a.min_score)[0]?.apr_bps ?? null;

/**
 * a: { product, rules, bands, score, amountCents, term, annualIncomeCents, otherDebtCents (monthly, without the new loan),
 *      collateralValueCents, lienCents, flagged }
 * -> { decision, reasons: [{ rule, text }], aprBps, dtiBps, ltvBps, offer: { amountCents, term, aprBps, paymentCents } | null }
 */
export function decide(a) {
  const rules = [...a.rules].sort((x, y) => x.rank - y.rank);
  const apr = aprFor(a.bands, a.score) ?? Math.max(...a.bands.map(b => b.apr_bps));
  const income = BigInt(a.annualIncomeCents), debts = BigInt(a.otherDebtCents), value = BigInt(a.collateralValueCents ?? 0), lien = BigInt(a.lienCents ?? 0);

  const dti = (amt, term) => { const pay = monthlyPayment(amt, apr, term); return { pay, num: (debts + pay) * 120000n }; };   // ×10000 bps ×12 months
  const fails = (amt, term) => rules.filter(r => {
    if (r.rule === 'min_score') return a.score < r.limit_value;
    if (r.rule === 'max_dti') return income <= 0n || dti(amt, term).num > BigInt(r.limit_value) * income;
    return value <= 0n || (amt + (r.rule === 'max_cltv' ? lien : 0n)) * 10000n > BigInt(r.limit_value) * value;
  });
  const words = (r, amt, term) => {
    if (r.rule === 'min_score') return `${r.reason} (your simulated score: ${a.score}; our minimum: ${r.limit_value}).`;
    if (r.rule === 'max_dti') return income <= 0n ? `${r.reason} (no income was entered).` : `${r.reason} (${pct(Number((dti(amt, term).num + income / 2n) / income))} with this loan; our limit is ${pct(r.limit_value)}).`;
    const ratio = value > 0n ? pct(Number(((amt + (r.rule === 'max_cltv' ? lien : 0n)) * 10000n + value / 2n) / value)) : 'unknown';
    return `${r.reason} (${ratio}; our limit is ${pct(r.limit_value)}).`;
  };

  const amount = BigInt(a.amountCents), term = a.term;
  const { pay } = dti(amount, term);
  const dtiBps = income > 0n ? Number((dti(amount, term).num + income / 2n) / income) : null;                 // ok-number: a ratio
  const ltvRule = rules.find(r => r.rule === 'max_ltv' || r.rule === 'max_cltv');
  const ltvBps = ltvRule && value > 0n ? Number(((amount + (ltvRule.rule === 'max_cltv' ? lien : 0n)) * 10000n + value / 2n) / value) : null;   // ok-number: a ratio
  const base = { aprBps: apr, dtiBps, ltvBps };
  const offer = (amt, t) => ({ amountCents: amt, term: t, aprBps: apr, paymentCents: monthlyPayment(amt, apr, t) });

  const failed = fails(amount, term);
  const reasons = failed.map(r => ({ rule: r.rule, text: words(r, amount, term) }));
  if (a.flagged) return { ...base, decision: 'declined', offer: null,
    reasons: [{ rule: 'flag', text: 'We could not verify the applicant (demo: names containing DECLINE are always declined).' }, ...reasons] };
  if (!failed.length) return { ...base, decision: 'approved', reasons: [], offer: { amountCents: amount, term, aprBps: apr, paymentCents: pay } };
  if (failed.some(r => !r.counter) || aprFor(a.bands, a.score) == null) return { ...base, decision: 'declined', reasons, offer: null };

  // Counteroffer: the same amount over a longer term, else the most we can lend at the asked-for term, else at the longest term.
  const { min_amount_cents: min, max_term: maxTerm } = a.product;
  for (const t of TERMS.filter(t => t > term && t <= maxTerm)) if (!fails(amount, t).length) return { ...base, decision: 'counteroffer', reasons, offer: offer(amount, t) };
  const cap = t => {
    let m = amount;
    const dr = rules.find(r => r.rule === 'max_dti');
    if (dr) { const room = BigInt(dr.limit_value) * income / 120000n - debts; m = [m, maxPrincipal(room, apr, t, STEP)].sort((x, y) => (x < y ? -1 : 1))[0]; }
    if (ltvRule) { let c = BigInt(ltvRule.limit_value) * value / 10000n - (ltvRule.rule === 'max_cltv' ? lien : 0n); c -= c % STEP; if (c < m) m = c; }
    return m;
  };
  for (const t of [term, maxTerm]) {
    const m = cap(t);
    if (m >= BigInt(min) && m < amount && !fails(m, t).length) return { ...base, decision: 'counteroffer', reasons, offer: offer(m, t) };
  }
  return { ...base, decision: 'declined', reasons, offer: null };
}
