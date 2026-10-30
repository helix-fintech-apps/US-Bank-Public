// Loan math in exact BigInt rationals: no floats anywhere. Rates are APR basis points (774 = 7.74%), money is cents.
// The monthly rate r = bps / 120000, so (1 + r) = (120000 + bps) / 120000 and (1 + r)^n = A^n / B^n exactly.
//
// Golden value, worked by hand: $10,000 at 7.74% for 36 months.
//   r = 0.0774 / 12 = 0.00645
//   (1.00645)^2 = 1.0129416025, ^3 = 1.019475075…, … ^36 = 1.2604317985…
//   payment = P·r·(1+r)^n / ((1+r)^n − 1) = 10000 × 0.00645 × 1.2604317985 / 0.2604317985
//           = 64.50 × 4.8397765… = 312.1656… → $312.17 (round half up to the cent)
//   month 1: interest 10000.00 × 0.00645 = 64.50, principal 312.17 − 64.50 = 247.67, balance 9752.33
//   month 2: interest  9752.33 × 0.00645 = 62.902… → 62.90, principal 249.27, balance 9503.06
//   35 × 312.17 = 10925.95 paid; month 36 owes 310.01 + 2.00 interest = $312.01 (the last payment absorbs rounding)
//   total interest = 10925.95 + 312.01 − 10000 = $1,237.96

const B = 120000n;
/** a / b rounded half up, for a >= 0 and b > 0 */
export const divRound = (a, b) => (2n * a + b) / (2n * b);

/** Fixed monthly payment in cents, exact to the cent. */
export function monthlyPayment(principalCents, aprBps, months) {
  const P = BigInt(principalCents), bps = BigInt(aprBps), n = BigInt(months);
  if (n <= 0n) throw new Error('term must be positive');
  if (bps === 0n) return divRound(P, n);
  const An = (B + bps) ** n, Bn = B ** n;
  return divRound(P * bps * An, B * (An - Bn));                 // P·(bps/B)·(A/B)^n / ((A/B)^n − 1)
}

/** One month's interest on a balance. */
export const monthInterest = (balanceCents, aprBps) => divRound(BigInt(balanceCents) * BigInt(aprBps), B);

/**
 * Interest for `days` days on a balance (actual/365), rounded half up to the cent. Every loan payment (scheduled, extra,
 * payoff) charges this for the days since the last payment before any principal. Worked by hand:
 *   $5,000.00 at 9.99% for 30 days = 500000 × 999 × 30 / 3,650,000 = 4105.479… → 4105 cents ($41.05)
 *   (a full month, 500000 × 999 / 120,000, would be 4162.5 → $41.63)
 */
export const dailyInterest = (balanceCents, aprBps, days) => divRound(BigInt(balanceCents) * BigInt(aprBps) * BigInt(Math.max(0, days)), 3650000n);

/** The largest principal (cents, rounded down to `step`) whose payment fits under maxPaymentCents. */
export function maxPrincipal(maxPaymentCents, aprBps, months, step = 10000n) {
  const pay = BigInt(maxPaymentCents), bps = BigInt(aprBps), n = BigInt(months);
  if (pay <= 0n) return 0n;
  let P = bps === 0n ? pay * n : (pay * B * ((B + bps) ** n - B ** n)) / (bps * (B + bps) ** n);
  P -= P % step;
  while (P > 0n && monthlyPayment(P, aprBps, months) > pay) P -= step;       // rounding the payment up can tip it over
  return P;
}

/**
 * The full schedule. Each row: { n, payment, interest, principal, balance } in cents. The final payment pays the
 * remaining balance plus its interest, so the principal column sums exactly to the loan amount.
 * With `payment` given (a loan already in progress), it projects from the current balance with that payment.
 */
export function schedule(principalCents, aprBps, months, payment = monthlyPayment(principalCents, aprBps, months)) {
  let bal = BigInt(principalCents); const rows = [];
  for (let n = 1; bal > 0n && n <= 1200; n++) {
    const interest = monthInterest(bal, aprBps);
    let principal = payment - interest;
    if (n >= months || principal >= bal) principal = bal;                     // last row absorbs rounding
    if (principal < 0n) principal = 0n;
    bal -= principal;
    rows.push({ n, payment: principal + interest, interest, principal, balance: bal });
  }
  return rows;
}

/** Add whole months to a 'YYYY-MM-DD' date; day clamped to 28 so every month has it. */
export function addMonths(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, Math.min(d, 28)));
  return t.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);   // ok-number: whole days, not money
