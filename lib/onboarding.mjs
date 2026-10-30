// Account opening: the product catalog, disclosures, a simulated identity check (CIP + OFAC) and new account numbers.
// The full SSN is never stored or logged: only its last 4 digits and a keyed hash used to spot duplicates.
import { createHmac, randomInt } from 'node:crypto';
import { AppError } from './http.mjs';
import { toStr } from './money.mjs';
import { DEMO_FALLBACKS } from './demo-keys.mjs';
import { readDate as readRealDate } from './dates.mjs';
import { bankToday } from './bank-date.mjs';

/** Today's disclosure set. Bump the version when a document changes; old acceptances keep their version. */
export const DISCLOSURE_VERSION = '2026-10-01';
const DOCS = {
  deposit_agreement: ['Deposit Account Agreement', 'How your account works, how we post deposits and payments, and how either of us can close it.'],
  truth_in_savings: ['Truth in Savings disclosure', 'The rate, APY, minimum to open, and fees for this account.'],
  fee_schedule: ['Consumer fee schedule', 'Every fee we may charge. USA Banc demo accounts have no monthly fee.'],
  privacy_notice: ['Privacy notice', 'What we collect, why, and how to limit sharing.'],
  esign_consent: ['E-Sign consent', 'You agree to get disclosures, notices and statements electronically.'],
  cd_terms: ['CD terms', 'Your rate is fixed until maturity. Taking money out early costs a penalty of some days of interest.'],
  joint_terms: ['Joint ownership terms', 'Each owner can use all the money. If one owner dies, the money belongs to the other (right of survivorship).'],
  teen_terms: ['Teen account terms', 'A parent or guardian owns the account with the teen and sets spending controls.'],
  utma_terms: ['Custodial (UTMA) terms', 'The money belongs to the child for good. The custodian manages it for the child until they come of age.']
};
export function disclosuresFor(p, ownership) {
  const keys = ['deposit_agreement', 'truth_in_savings', 'fee_schedule', 'privacy_notice', 'esign_consent'];
  if (p.kind === 'cd') keys.push('cd_terms');
  if (ownership === 'joint') keys.push('joint_terms');
  if (p.kind === 'teen_checking') keys.push('teen_terms');
  if (p.kind === 'custodial_savings') keys.push('utma_terms');
  return keys.map(k => ({ key: k, title: DOCS[k][0], summary: DOCS[k][1] }));
}
/** The applicant must accept today's version; a page left open across an update must re-read and sign again. */
export function checkEsign(d) {
  if (d?.accepted !== true) throw new AppError(400, 'esign_required', 'Read and accept the disclosures to continue.');
  if (d.version !== DISCLOSURE_VERSION) throw new AppError(409, 'disclosures_changed', 'The disclosures were updated. Please read and accept the new version.');
}

// Opening deposits by transfer above this need a banker (demo default; docs/RESEARCH.md §1 gives no figure).
export const MAX_OPENING_CENTS = 100_000_00n;
// The bank's deposit kinds that can fund a new account (not CDs: their money is locked until maturity).
export const FUNDING_KINDS = ['checking', 'savings', 'money_market', 'teen_checking', 'custodial_savings'];

export const productView = p => ({
  code: p.code, kind: p.kind, name: p.name, blurb: p.blurb,
  apy: p.apy_bp == null ? null : (p.apy_bp / 100).toFixed(2),            // ok-number: basis points to a display string
  termMonths: p.term_months, earlyWithdrawalDays: p.early_withdrawal_days,
  minOpen: toStr(p.min_open_cents), ownerships: p.ownerships,
  minorAges: p.minor_min_age == null ? null : [p.minor_min_age, p.minor_max_age]
});

export function ageOn(dob, on = new Date()) {
  const d = new Date(dob + 'T00:00:00Z');
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  if (on.getUTCMonth() < d.getUTCMonth() || (on.getUTCMonth() === d.getUTCMonth() && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));
const bad = (field, message) => new AppError(400, 'bad_' + field, message);

export function readName(s, what = 'legal name') {
  const v = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z][A-Za-z .,'-]{1,79}$/.test(v)) throw bad('name', `Enter the ${what} using letters only, like "Ava Martinez".`);
  return v;
}
/** A real calendar date as 'YYYY-MM-DD': the shared validator (lib/dates.mjs). */
export const readDate = (s, what = 'Date') => readRealDate(s, what);
export function readDob(s, what = 'Date of birth') {
  const v = readDate(s, what);
  if (v > bankToday() || ageOn(v) > 120) throw bad('dob', `${what}: enter a real date.`);
  return v;
}

/** Name, date of birth, street address and SSN, checked for shape. Returns the cleaned identity (with the 9 digits). */
export function readIdentity(b = {}) {
  const legalName = readName(b.legalName);
  const dob = readDob(b.dob);
  const line1 = String(b.line1 ?? '').trim(), line2 = String(b.line2 ?? '').trim(), city = String(b.city ?? '').trim();
  const state = String(b.state ?? '').trim().toUpperCase(), zip = String(b.zip ?? '').trim();
  if (line1.length < 4 || line1.length > 100) throw bad('address', 'Enter your street address.');
  // CIP needs a residential street address (docs/RESEARCH.md §1 "Identity / KYC steps")
  if (/\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b/i.test(line1 + ' ' + line2)) throw bad('address', "Use your home street address. We can't use a PO box to confirm who you are.");
  if (line2.length > 100 || city.length < 2 || city.length > 60) throw bad('address', 'Enter your city.');
  if (!STATES.has(state)) throw bad('address', 'Choose your state.');
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw bad('address', 'Enter a 5-digit ZIP code.');
  const ssn = String(b.ssn ?? '').replace(/[\s-]/g, '');
  // SSA never issues area 000 or 666, group 00 or serial 0000. Area 9xx is an ITIN, which we accept.
  if (!/^\d{9}$/.test(ssn) || /^(000|666)/.test(ssn) || ssn.slice(3, 5) === '00' || ssn.slice(5) === '0000')
    throw bad('ssn', "That isn't a valid Social Security number. Check the 9 digits.");
  return { legalName, dob, address: { line1, line2, city, state, zip }, ssn, ssnLast4: ssn.slice(5) };
}

// Used exactly as set (never trimmed): stored SSN hashes were made with the raw value, so trimming a pepper that has a
// stray space or newline would stop every duplicate check from matching. Unset falls back to the demo pepper, as before.
const PEPPER = () => process.env.SSN_PEPPER ?? DEMO_FALLBACKS.SSN_PEPPER;
export const ssnHash = ssn => createHmac('sha256', PEPPER()).update(ssn).digest('hex');

/**
 * Simulated identity check and OFAC screen. No real vendor or watch list is called. Outcomes:
 *  - declined: a name with "TEST DECLINE", the SSN 123-45-6789, or an SSN on file for another customer
 *  - review:   a name with "TEST OFAC" (watch-list match), or a date of birth / SSN that differs from what we have on file
 *  - approved: everything else
 * Returns { state, reasons, ofacHit, hash }.
 */
export async function screen(c, user, id) {
  const hash = ssnHash(id.ssn), declined = [], review = [];
  if (/TEST DECLINE/i.test(id.legalName) || id.ssn === '123456789') declined.push("We couldn't confirm your identity with the details you gave.");
  const other = (await c.query('SELECT user_id FROM customer_identities WHERE ssn_hash = $1 AND user_id <> $2', [hash, user.id])).rows[0];
  if (other) declined.push('That Social Security number is on file for another customer. Call us if you think this is a mistake.');
  const mine = (await c.query('SELECT * FROM customer_identities WHERE user_id = $1', [user.id])).rows[0];
  if (mine && mine.ssn_hash !== hash) review.push("The Social Security number doesn't match the one we have on file.");
  const dobOnFile = mine?.date_of_birth ?? user.dateOfBirth;
  if (dobOnFile && dobOnFile !== id.dob) review.push("The date of birth doesn't match our records.");
  const ofacHit = /TEST OFAC/i.test(id.legalName);
  if (ofacHit) review.push('Your name is close to one on a government sanctions list. A banker will review it within 2 business days.');
  const state = declined.length ? 'declined' : review.length ? 'review' : 'approved';
  return { state, reasons: declined.length ? declined : review, ofacHit, hash };
}

/** Keeps the identity on file after an approved check (first one wins). */
export async function keepIdentity(c, userId, id, hash) {
  await c.query(`INSERT INTO customer_identities (user_id, legal_name, date_of_birth, address, ssn_last4, ssn_hash) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING`, [userId, id.legalName, id.dob, id.address, id.ssnLast4, hash]);
}

/** A last-4 account number no other account has. Openings take turns (advisory lock), so two can't pick the same one. */
export async function newLast4(c) {
  await c.query('SELECT pg_advisory_xact_lock(727010)');
  for (let i = 0; i < 25; i++) {
    const n = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!(await c.query('SELECT 1 FROM accounts WHERE number_last4 = $1', [n])).rowCount) return n;
  }
  const r = (await c.query(`SELECT lpad(g::text, 4, '0') n FROM generate_series(0, 9999) g
     WHERE lpad(g::text, 4, '0') NOT IN (SELECT number_last4 FROM accounts WHERE number_last4 IS NOT NULL) ORDER BY random() LIMIT 1`)).rows[0];
  if (!r) throw new AppError(503, 'no_numbers', "We can't open new accounts right now. Please try again later.");
  return r.n;
}
