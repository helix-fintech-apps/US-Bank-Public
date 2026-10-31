// Personal loan servicing math (docs: the Personal Loan Servicing requirements, section 5). Exact BigInt integers, no floats.
// A loan's state is { P, I, R, AT, k, latePaid, feesPaid, paidOff }: principal owed, interest counted but unpaid (cents),
// the interest remainder (a numerator over 3,600,000 of a cent), the date interest is counted through, the next unpaid
// installment, the number of installments paid late, the fee cents already paid, and whether the loan is paid off.
// Terms are { aprBps, termMonths, paymentDay, paymentCents, lateFeeCents, originatedOn }.
//
// Golden value (5.9): 1,000,000 cents at 774 bps for 36 months, originated 2027-03-10, due on the 15th.
//   installment 1 is due 2027-04-15: days360 = 35, 1,000,000 × 774 × 35 = 27,090,000,000 / 3,600,000 = 7,525 exactly,
//   principal 31,217 − 7,525 = 23,692, balance 976,308. Over all 36 rows interest adds up to 125,140.
import { divRound } from '../loans-credit/amortize.mjs';
import { addDays } from '../bank-date.mjs';

export const DENOM = 3_600_000n;                               // 360 days × 10,000 bps: R is kept over this
export const LATE_DAYS = 10;                                   // a scheduled payment within 10 days after the due date is on time
export const LATE_FEE_PCT = 5n, LATE_FEE_MAX = 2500n;          // 5% of the installment, at most $25.00

const parts = d => d.split('-').map(Number);                   // ok-number: calendar fields, not money

/** 30/360 day count from a to b (5.5). */
export function days360(a, b) {
  let [y1, m1, d1] = parts(a), [y2, m2, d2] = parts(b);
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

/** Due date of installment j: day paymentDay of the j-th month after the month of originatedOn (5.4). */
export function dueDate(t, j) {
  const [y, m] = parts(t.originatedOn);
  return new Date(Date.UTC(y, m - 1 + j, t.paymentDay)).toISOString().slice(0, 10);
}

/** 5% of the installment, half up, capped at 2,500 cents (5.7). */
export const lateFee = paymentCents => { const f = divRound(BigInt(paymentCents) * LATE_FEE_PCT, 100n); return f > LATE_FEE_MAX ? LATE_FEE_MAX : f; };

/** Accrues state s to date d in place (5.6): rounds down, carries the fraction in R. */
export function accrue(t, s, d) {
  if (d <= s.AT) return s;
  const days = days360(s.AT, d);
  if (days > 0) {
    const N = s.P * BigInt(t.aprBps) * BigInt(days) + s.R;
    s.I += N / DENOM; s.R = N % DENOM;
  }
  s.AT = d;
  return s;
}

export const copy = s => ({ ...s });

/** Installment s.k's row (5.9 steps 1-3, 5-6, without the fee), applied to s in place; s.k moves on. */
export function step(t, s) {
  const j = s.k, due = dueDate(t, j);
  accrue(t, s, due);
  const interest = s.I; s.I = 0n;
  let principal = BigInt(t.paymentCents) - interest;
  if (principal < 0n) principal = 0n;
  if (j >= t.termMonths || principal >= s.P) principal = s.P;            // the final installment pays what is left
  s.P -= principal; s.k = j + 1;
  return { number: j, dueDate: due, feeCents: 0n, interestCents: interest, principalCents: principal, paymentCents: interest + principal, balanceAfterCents: s.P };
}

/** The rows still to pay, from a copy of s (s is not changed). */
export function rowsOf(t, s) {
  const c = copy(s), out = [];
  while (c.P > 0n && c.k <= t.termMonths) out.push(step(t, c));
  return out;
}

/** F(D): late fees due on bank date D (5.7). Installments in the schedule are k..last row; paid ones count when paid late. */
export function feesDue(t, s, D, rows = rowsOf(t, s)) {
  if (s.paidOff) return 0n;
  let late = s.latePaid;
  for (const r of rows) { if (addDays(r.dueDate, LATE_DAYS + 1) <= D) late++; else break; }
  const f = BigInt(t.lateFeeCents) * BigInt(late) - s.feesPaid;
  return f > 0n ? f : 0n;
}

/** The schedule as of D (5.9): rows with F(D) on the first, and their totals. */
export function scheduleAsOf(t, s, D) {
  const rows = s.paidOff ? [] : rowsOf(t, s);
  if (rows.length) { const f = feesDue(t, s, D, rows); rows[0].feeCents = f; rows[0].paymentCents += f; }
  const sum = k => rows.reduce((a, r) => a + r[k], 0n);
  return { rows, totals: { paymentsCents: sum('paymentCents'), feesCents: sum('feeCents'), interestCents: sum('interestCents'), principalCents: sum('principalCents') } };
}

/** Payoff figures on date d from a copy: { feeCents, interestCents, principalCents, amountCents }. */
export function payoffOn(t, s, d) {
  const feeCents = feesDue(t, s, d), c = accrue(t, copy(s), d);
  return { feeCents, interestCents: c.I, principalCents: c.P, amountCents: feeCents + c.I + c.P };
}
