// Money is BigInt cents everywhere. Amounts come in as strings ("12.34") and go out as strings; no floats.
import { AppError } from './http.mjs';

export function parseAmount(s, { field = 'amount', min = 1n, max = 100_000_000_00n } = {}) {
  const v = String(s ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new AppError(400, 'bad_amount', `Enter ${field} in dollars and cents, like 25.00.`);
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (cents < min) throw new AppError(400, 'bad_amount', `${cap(field)} must be at least ${usd(min)}.`);
  if (cents > max) throw new AppError(400, 'bad_amount', `${cap(field)} can't be more than ${usd(max)}.`);
  return cents;
}

/** 123456n -> "1234.56", -5n -> "-0.05" */
export function toStr(cents) {
  const c = BigInt(cents), neg = c < 0n, a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** 123456n -> '$1,234.56' (-5n -> '-$0.05'): the one dollar format for messages. */
export const usd = cents => { const s = toStr(cents), neg = s.startsWith('-'), [i, f] = s.replace('-', '').split('.'); return `${neg ? '-' : ''}$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`; };

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
