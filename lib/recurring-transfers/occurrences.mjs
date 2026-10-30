// The dates a recurring transfer is due on, counted from its start date (occurrence 0). Pure date math on 'YYYY-MM-DD'
// bank dates; no business-day or holiday shifting.
import { addDays } from '../bank-date.mjs';

const pad = n => String(n).padStart(2, '0');

/**
 * The date of occurrence `i` (0 = startDate). weekly: every 7 days. monthly: the start date's day of the month in each
 * following month, or that month's last day when it is shorter (a 31st start runs Jan 31, Feb 28, Mar 31, Apr 30 ...).
 */
export function occurrence(startDate, cadence, i) {
  if (cadence === 'weekly') return addDays(startDate, 7 * i);
  const [y, m, d] = startDate.split('-').map(Number);
  const t = (m - 1) + i, ny = y + Math.floor(t / 12), nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** The first occurrence index >= `from` dated on or after `date`. */
export function firstOnOrAfter(startDate, cadence, from, date) {
  let i = from;
  if (cadence === 'weekly') {                                   // jump close, then step (dates are whole days apart)
    const days = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400_000);
    i = Math.max(from, Math.floor(days / 7));
  } else {
    const [y1, m1] = startDate.split('-').map(Number), [y2, m2] = date.split('-').map(Number);
    i = Math.max(from, (y2 - y1) * 12 + (m2 - m1) - 1);
  }
  while (occurrence(startDate, cadence, i) < date) i++;
  return i;
}
