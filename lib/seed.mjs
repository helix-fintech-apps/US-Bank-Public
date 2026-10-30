// Demo customers and accounts. Every balance is built from ledger entries (opening deposit + history), so the
// ledger and the balances always agree. Safe to run twice: users are matched by username, entries by key.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './db.mjs';
import { hashPassword, newId } from './auth.mjs';
import { post, systemAccount } from './ledger.mjs';
import * as servicingSeed from './seeds/servicing.mjs';
import * as accountsFamilySeed from './seeds/accounts-family.mjs';
import * as loansCreditSeed from './seeds/loans-credit.mjs';
import * as moneyMovementSeed from './seeds/money-movement.mjs';
import * as cardsSeed from './seeds/cards.mjs';

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
/** A birth date that makes someone `years` old (plus a few months) on the day the data is seeded, so Ava stays a minor. */
export const bornYearsAgo = (years, on = new Date()) => { const d = new Date(on); d.setUTCDate(d.getUTCDate() - 120); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString().slice(0, 10); };

export const DEMO_USERS = [
  { username: 'nizam@helixbots.ai', password: 'nizam', name: 'Nizam', mfa: false, phone: '42' },                 // signs straight in
  { username: 'jordan@usabanc.example', password: 'jordan-demo-pass', name: 'Jordan', mfa: true, phone: '17' },   // gets a one-time code
  { username: 'ava@usabanc.example', password: 'ava-demo-pass', name: 'Ava', mfa: true, phone: '08', dob: bornYearsAgo(14) } // a minor, about 14
];

// Feature demo data lives in lib/seeds/<feature>.mjs (export async function seed(c)) and is listed here.
// Each one must be safe to run again (check for its own rows first) and run after the core data below.
import * as team from './seeds/team.mjs';
export const FEATURE_SEEDS = [team];
FEATURE_SEEDS.push(servicingSeed);
FEATURE_SEEDS.push(moneyMovementSeed);
FEATURE_SEEDS.push(accountsFamilySeed);
FEATURE_SEEDS.push(loansCreditSeed);
FEATURE_SEEDS.push(cardsSeed);

// Seeding runs inside one transaction. Parallel cold starts wait on this lock (a different key from migrate's
// 727001), so only one inserts the demo users and the rest see them instead of failing on users_username_key.
export const SEED_LOCK = 727002;

// A fingerprint of the seed: the file contents of lib/seed.mjs and every lib/seeds/*.mjs (functions, data constants and
// helpers alike) plus the migration file names, read once at module load. Once a version has run, cold starts skip
// seeding (one query instead of hundreds, which kept the first request past Vercel's time limit). Changing anything in a
// seed file, or adding a migration, changes the fingerprint, so the seed runs again. On Vercel these files are in the
// function: lib/seed.mjs imports every seed module (so the bundler traces them) and vercel.json includes db/migrations/**.
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The files the fingerprint covers: { 'lib/seed.mjs': text, 'lib/seeds/x.mjs': text, …, migrations: 'a.sql\nb.sql' }. */
export function seedFiles(lib = HERE, migrations = MIGRATIONS) {
  const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');          // line endings must not change the fingerprint (a Windows checkout is CRLF)
  const out = { 'lib/seed.mjs': read(path.join(lib, 'seed.mjs')) };
  for (const f of fs.readdirSync(path.join(lib, 'seeds')).filter(f => f.endsWith('.mjs')).sort())
    out[`lib/seeds/${f}`] = read(path.join(lib, 'seeds', f));
  out.migrations = fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort().join('\n');
  return out;
}
export const seedFingerprint = files => {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest('hex').slice(0, 16);
};
export const SEED_VERSION = seedFingerprint(seedFiles());

export async function seed(c) {
  await c.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK]);
  await c.query('CREATE TABLE IF NOT EXISTS seed_runs (version text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now())');
  if ((await c.query('SELECT 1 FROM seed_runs WHERE version = $1', [SEED_VERSION])).rowCount) return false;
  const fresh = await seedCore(c);
  for (const s of FEATURE_SEEDS) await s.seed(c);
  await c.query('INSERT INTO seed_runs (version) VALUES ($1)', [SEED_VERSION]);
  return fresh;
}

async function seedCore(c) {
  if ((await c.query("SELECT 1 FROM users WHERE username = 'nizam@helixbots.ai'")).rowCount) return false;
  const ids = {};
  for (const u of DEMO_USERS) {
    ids[u.name] = newId();
    await c.query('INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2, date_of_birth) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [ids[u.name], u.username, u.name, await hashPassword(u.password), u.mfa, u.phone, u.dob ?? null]);
  }
  const sys = async code => systemAccount(c, code);
  const acct = async ({ kind, name, last4, owners, allowNegative = false, limit = null, apy = null, dueIn = null }) => {
    const id = newId();
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4, allow_negative, credit_limit_cents, apy_bp, payment_due, opened_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE current_date + $8::int END, now() - interval '400 days')`,
      [id, kind, name, last4, allowNegative, limit, apy, dueIn]);
    for (const [who, role] of owners) await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, ids[who], role]);
    return id;
  };
  const chk = await acct({ kind: 'checking', name: 'Smart Checking', last4: '4471', owners: [['Nizam', 'owner']] });
  const sav = await acct({ kind: 'savings', name: 'Bright Savings', last4: '9302', owners: [['Nizam', 'owner']], apy: 410 });
  const card = await acct({ kind: 'credit_card', name: 'Cash+ Card', last4: '0088', owners: [['Nizam', 'owner']], allowNegative: true, limit: 250000n, dueIn: 17 });
  const teen = await acct({ kind: 'teen_checking', name: "Ava's Teen Checking", last4: '5120', owners: [['Nizam', 'custodian'], ['Ava', 'minor']] });
  const joint = await acct({ kind: 'savings', name: 'Family Vacation Savings', last4: '7781', owners: [['Nizam', 'owner'], ['Jordan', 'joint_owner']], apy: 410 });
  const jchk = await acct({ kind: 'checking', name: 'Smart Checking', last4: '3388', owners: [['Jordan', 'owner']] });

  let n = 0;
  const one = async (account, other, cents, description, category, daysAgo, kind = 'seed') =>
    post(c, { key: `seed:${n++}`, kind, lines: [
      { accountId: account, amountCents: cents, description, category, postedOn: day(daysAgo) },
      { accountId: await sys(other), amountCents: -cents, description, postedOn: day(daysAgo) }] });

  // opening balances first (oldest), then history, so no deposit account ever dips below zero
  await one(chk, 'equity', 137675n, 'Opening deposit', 'Transfers', 30);
  await one(sav, 'equity', 110831n, 'Opening deposit', 'Transfers', 30);
  await one(teen, 'equity', 7000n, 'Opening deposit', 'Transfers', 30);
  await one(joint, 'equity', 850000n, 'Opening deposit', 'Transfers', 30);
  await one(jchk, 'equity', 120000n, 'Opening deposit', 'Transfers', 30);
  await one(chk, 'ach_clearing', 184255n, 'Direct deposit, Northwind Robotics payroll', 'Income', 16);
  await one(chk, 'billpay_clearing', -165000n, 'Rent, Riverside Apartments', 'Housing', 12);
  await one(chk, 'billpay_clearing', -9420n, 'City Power & Light', 'Bills & Utilities', 10);
  await one(card, 'card_settlement', -25971n, 'Skyway Airlines', 'Travel', 9);
  await one(chk, 'card_settlement', -5190n, 'Shell, fuel', 'Auto & Transport', 7);
  await post(c, { key: `seed:${n++}`, kind: 'transfer', lines: [
    { accountId: chk, amountCents: -20000n, description: 'Transfer to Bright Savings ··9302', category: 'Transfers', postedOn: day(6) },
    { accountId: sav, amountCents: 20000n, description: 'Transfer from Smart Checking ··4471', category: 'Transfers', postedOn: day(6) }] });
  await one(chk, 'card_settlement', -11238n, 'Whole Foods Market', 'Groceries', 5);
  await one(card, 'card_settlement', -6850n, 'Trattoria Roma', 'Food & Dining', 5);
  await one(chk, 'p2p_clearing', -4000n, 'USA Pay to Sam Ortiz', 'Transfers', 4);
  await one(chk, 'card_settlement', -725n, 'Blue Bottle Coffee', 'Food & Dining', 3);
  await one(card, 'card_settlement', -8999n, 'Online marketplace', 'Shopping', 3);
  await one(chk, 'ach_clearing', 184255n, 'Direct deposit, Northwind Robotics payroll', 'Income', 2);
  await one(teen, 'card_settlement', -600n, 'School cafeteria', 'Food & Dining', 2);
  await one(sav, 'interest_expense', 412n, 'Interest paid', 'Income', 1);
  return true;
}
