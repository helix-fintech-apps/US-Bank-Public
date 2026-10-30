// The bank's business date: one "today" for every feature (family limits, cards, statements, loans, money movement).
// It is the America/Chicago (Central Time) calendar date, the zone the bank's cut-offs use (docs/RESEARCH.md §2.2).
// Tests move the clock with `clock.now = () => new Date(...)`; money movement's calendar uses this same clock.
export const clock = { now: () => new Date() };
export const BANK_TZ = 'America/Chicago';

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: BANK_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** { date: 'YYYY-MM-DD', minutes } for an instant, in Central Time. */
export function ct(at = clock.now()) {
  const p = Object.fromEntries(fmt.formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
/** The bank date of an instant ('YYYY-MM-DD', Central Time). */
export const bankDateOf = at => ct(at).date;
/** Today's bank date. Pass it into SQL instead of current_date wherever it decides business logic. */
export const bankToday = () => ct().date;
/** 'YYYY-MM-DD' plus n calendar days. */
export const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
