// Full account numbers are stored only encrypted (AES-256-GCM, key from ACCOUNT_ENCRYPTION_KEY) and never logged or
// returned; screens and the audit trail see the last 4 digits. Routing numbers are checked with the ABA checksum.
// Without ACCOUNT_ENCRYPTION_KEY a built-in demo key is used, like CARD_PAN_KEY and SSN_PEPPER (all data is fictional);
// lib/app.mjs logs one warning line at startup (lib/demo-keys.mjs). A key that is set but malformed still refuses.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../http.mjs';
import { DEMO_FALLBACKS } from '../demo-keys.mjs';

const DEMO_KEY = createHash('sha256').update(DEMO_FALLBACKS.ACCOUNT_ENCRYPTION_KEY).digest();   // 32 bytes
function key() {
  const raw = String(process.env.ACCOUNT_ENCRYPTION_KEY ?? '').trim();
  if (!raw) return DEMO_KEY;
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new AppError(503, 'not_configured', "Adding account numbers isn't available right now. Please try again later.");
  return k;
}
export const hasKey = () => { try { key(); return true; } catch { return false; } };

/** 'v1.<iv>.<tag>.<ciphertext>' (base64url). `bind` (e.g. the owner's id) is authenticated, so a value can't be moved to another row. */
export function seal(plain, bind) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(String(bind)));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}
export function open(sealed, bind) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(bind))); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** ABA routing number: 9 digits, 3-7-1 weighted sum divisible by 10. */
export function abaOk(r) {
  if (!/^\d{9}$/.test(r)) return false;
  const d = [...r].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
export function routing(v) {
  const r = String(v ?? '').replace(/\D/g, '');
  if (!abaOk(r)) throw new AppError(400, 'bad_routing', "That routing number isn't valid. It's the 9 digits at the bottom left of a check.");
  return r;
}
export function accountNumber(v, what = 'account number') {
  const n = String(v ?? '').replace(/[\s-]/g, '');
  if (!/^\d{4,17}$/.test(n)) throw new AppError(400, 'bad_account_number', `Enter the ${what}: 4 to 17 digits.`);
  return n;
}
