// Business days and cut-offs for money movement. All bank dates are Central Time (CT) calendar dates, from the one
// bank clock in lib/bank-date.mjs (tests move it with `clock.now = () => new Date(...)`; it moves every feature's "today").
import { clock, ct, bankToday, addDays, BANK_TZ } from '../bank-date.mjs';
export { clock, ct, addDays };
export const TZ = BANK_TZ;

// Federal Reserve holiday schedule (no ACH or wire settlement). A holiday on a Saturday is not moved to Friday;
// one on a Sunday moves to Monday. Data, not code: add a year when the Fed publishes it.
export const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25',
  '2028-01-17', '2028-02-21', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-10-09', '2028-11-23', '2028-12-25'
]);

// Cut-offs in CT, minutes after midnight (docs/RESEARCH.md §2.2 "cutoff ~late afternoon", §2.3 domestic wire to another bank 4:30 pm CT).
// wire_intl: international wires (lib/routes/wire-screening.mjs), 3:00 pm CT.
export const CUTOFF = { ach: 17 * 60, wire: 16 * 60 + 30, wire_intl: 15 * 60 };

export const today = bankToday;

export const isBusinessDay = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !HOLIDAYS.has(d); };
export const nextBusinessDay = d => { let x = addDays(d, 1); while (!isBusinessDay(x)) x = addDays(x, 1); return x; };
export function addBusinessDays(d, n) { let x = d; for (let i = 0; i < n; i++) x = nextBusinessDay(x); return x; }

/** The business day a request made now is processed on: today if it's a business day and before the cut-off, else the next one. */
export function processingDay(rail, at = clock.now()) {
  const { date, minutes } = ct(at);
  return isBusinessDay(date) && minutes < CUTOFF[rail] ? date : nextBusinessDay(date);
}

/** Monthly runs keep their day of the month, clamped to short months (the 31st runs on Feb 28). */
export function addMonth(d, anchorDay) {
  const [y, m] = d.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}
