// One date validator for every feature: a real calendar date as 'YYYY-MM-DD' (no 2026-02-30), in years 1900–2999
// (Postgres has no year 0, so 0000-01-01 must be a 400, not a database error).
import { AppError } from './http.mjs';

export const isDate = s => {
  const v = String(s ?? '');
  if (!/^(19|2\d)\d{2}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
};

/** The date, or a 400 in plain words. `code` keeps each feature's existing error code. */
export function readDate(s, what = 'Date', code = 'bad_date') {
  const v = String(s ?? '').trim();
  if (!isDate(v)) throw new AppError(400, code, `${what}: enter a real date, like 2026-11-15.`);
  return v;
}
