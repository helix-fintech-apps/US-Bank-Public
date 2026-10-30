// M2 + M5: open an account (solo, joint, minor) with a simulated identity check, joint co-owner invites, and
// family controls on a minor's account (limits, categories, freeze, mode, allowance, chores, savings goals).
import { AppError, refuse, clientIp } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { RULES, guard, MAX_LOOKUP_FAILS } from '../throttle.mjs';
import { accountFor, MOVE_MONEY } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { parseAmount, toStr, usd } from '../money.mjs';
import { accountView } from './accounts.mjs';
import { DISCLOSURE_VERSION, MAX_OPENING_CENTS, FUNDING_KINDS, disclosuresFor, checkEsign, productView, ageOn, readName, readDob, readDate,
  readIdentity, screen, keepIdentity, newLast4 } from '../onboarding.mjs';
import { CATEGORIES, MAX_LIMITS, MAX_ALLOWANCE, MAX_CHORE, MAX_GOALS, controlsFor, spent, checkMinorSpend, runDueAllowances } from '../controls.mjs';
import { issueCard, setCardFrozen, SETTLEMENT } from '../cards.mjs';
import { bankToday, addDays } from '../bank-date.mjs';

const FEATURE = 'accounts-family';
const OWN = ['owner', 'joint_owner'];                       // the customer's own money (not a child's)
const NO_LOGIN = '!';                                       // password_hash of a minor profile with no sign-in
const MAX_APPS_PER_DAY = 10;                                // duplicate-application throttle (RESEARCH §1 (d))
const MAX_PURCHASE = 1_000_00n;                             // simulated purchase cap
// Looking up another customer (a co-owner, or a child who already banks with us) is throttled: after this many failed
// lookups in 24 hours an applicant's lookups are refused. Demo value; RESEARCH §1 (d) asks for an abuse throttle.
export { MAX_LOOKUP_FAILS };
const NO_MINOR = "That username and date of birth don't match a young customer you're the parent or guardian of. Check them, or open Custodial Savings for a new profile.";
const NO_CO_OWNER = "We couldn't find an adult USA Banc customer with that username. Check it with them: joint owners must be 18 or older.";
const DEBIT_KINDS = ['checking', 'teen_checking'];          // accounts that come with a debit card

const keyOf = (u, body) => `${u.id}:${FEATURE}:${requestKey(body)}`;
const uuidOr404 = (id, what = 'Not found.') => { if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new AppError(404, 'not_found', what); };
const text = (s, field, min = 2, max = 80) => {
  const v = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (v.length < min || v.length > max) throw new AppError(400, 'bad_' + field, `Enter a ${field} of ${min} to ${max} characters.`);
  return v;
};
const product = async (c, code) => {
  const p = (await c.query('SELECT * FROM products WHERE code = $1', [String(code ?? '')])).rows[0];
  if (!p) throw new AppError(400, 'bad_product', 'Choose an account type.');
  return p;
};
const adultCheck = u => {
  if (u.dateOfBirth && ageOn(u.dateOfBirth) < 18)
    throw new AppError(403, 'minor_applicant', 'You must be 18 or older to open an account. A parent or guardian can open one for you.');
};
const where = (a, n = '') => `${a.name} ··${a.number_last4 ?? a.last4}${n}`;

// ---------- views ----------
async function applicationView(c, app) {
  const p = (await c.query('SELECT * FROM products WHERE code = $1', [app.product_code])).rows[0];
  const acct = app.account_id ? (await c.query('SELECT a.*, t.maturity_date FROM accounts a LEFT JOIN account_terms t ON t.account_id = a.id WHERE a.id = $1', [app.account_id])).rows[0] : null;
  const inv = app.co_owner_id ? (await c.query('SELECT i.status, u.username FROM joint_invites i JOIN users u ON u.id = i.invitee_id WHERE i.account_id = $1 AND i.invitee_id = $2', [app.account_id, app.co_owner_id])).rows[0] : null;
  const minor = app.minor_id ? (await c.query('SELECT display_name FROM users WHERE id = $1', [app.minor_id])).rows[0] : null;
  return {
    id: app.id, state: app.state, reasons: app.reasons, product: productView(p), ownership: app.ownership,
    ssnLast4: app.ssn_last4, deposit: toStr(app.opening_deposit_cents), createdAt: app.created_at,
    account: acct ? { id: acct.id, name: acct.name, last4: acct.number_last4, status: acct.status, balance: toStr(acct.balance_cents), maturityDate: acct.maturity_date } : null,
    coOwner: inv ? { username: inv.username, status: inv.status } : null,
    minorName: minor?.display_name ?? null
  };
}

const ACTION_WORDS = {
  'family.controls.update': 'Spending controls changed', 'family.mode': 'Mode changed', 'family.freeze': 'Frozen', 'family.unfreeze': 'Unfrozen',
  'family.allowance.create': 'Allowance set up', 'family.allowance.stop': 'Allowance stopped', 'family.allowance.paid': 'Allowance paid',
  'family.allowance.skipped': 'Allowance skipped', 'family.chore.create': 'Chore added', 'family.chore.submit': 'Chore marked done',
  'family.chore.paid': 'Chore approved and paid', 'family.chore.cancel': 'Chore removed', 'family.goal.create': 'Savings goal added',
  'family.goal.set_aside': 'Money set aside for a goal', 'family.goal.release': 'Money released from a goal',
  'family.spend.allowed': 'Purchase allowed', 'family.purchase': 'Purchase posted', 'family.spend.declined': 'Purchase declined', 'account.open': 'Account opened'
};
function activityText(e) {
  const d = e.detail ?? {}, base = ACTION_WORDS[e.action] ?? e.action;
  const after = d.after && `daily $${d.after.daily}, 7-day $${d.after.weekly}${d.after.held.length ? `, off: ${d.after.held.join(', ')}` : ''}`;
  const bits = [after, d.target === 'card' || d.target === 'account' ? d.target : null, d.amount && `$${d.amount}`, d.category, d.title, d.name, d.target && /^\d/.test(d.target) && `goal $${d.target}`, d.mode && d.mode.replace('_', '-'), d.reason && reasonWords(d.reason)];
  return [base, bits.filter(Boolean).join(' · ')].filter(Boolean).join(': ');
}
const reasonWords = r => ({ account_frozen: 'account frozen', card_frozen: 'card frozen', category_off: 'category turned off', daily_limit: 'over daily limit',
  weekly_limit: 'over 7-day limit', account_unavailable: 'account not available' }[r] ?? r);

async function familyAccount(c, a) {
  const ctl = await controlsFor(c, a.id), s = await spent(c, a.id);
  const minor = (await c.query(`SELECT u.id, u.display_name, u.date_of_birth, u.password_hash <> $2 AS has_login FROM account_owners o JOIN users u ON u.id = o.user_id
     WHERE o.account_id = $1 AND o.role = 'minor'`, [a.id, NO_LOGIN])).rows[0];
  const parent = (await c.query(`SELECT u.display_name FROM account_owners o JOIN users u ON u.id = o.user_id WHERE o.account_id = $1 AND o.role = 'custodian' LIMIT 1`, [a.id])).rows[0];
  const allowances = (await c.query(`SELECT al.*, f.name, f.number_last4 FROM allowances al JOIN accounts f ON f.id = al.from_account_id
     WHERE al.account_id = $1 AND al.active ORDER BY al.created_at`, [a.id])).rows;
  const lastRuns = (await c.query(`SELECT r.* FROM allowance_runs r JOIN allowances al ON al.id = r.allowance_id WHERE al.account_id = $1 ORDER BY r.run_on DESC, r.at DESC LIMIT 5`, [a.id])).rows;
  const chores = (await c.query("SELECT * FROM chores WHERE account_id = $1 AND status <> 'canceled' ORDER BY (status = 'paid'), created_at DESC LIMIT 20", [a.id])).rows;
  const goals = (await c.query('SELECT * FROM savings_goals WHERE account_id = $1 ORDER BY created_at', [a.id])).rows;
  const setAside = goals.reduce((t, g) => t + BigInt(g.saved_cents), 0n);
  const events = (await c.query(`SELECT e.at, e.action, e.detail, u.display_name AS who FROM audit_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.detail->>'accountId' = $1 AND e.action LIKE 'family.%' ORDER BY e.id DESC LIMIT 12`, [a.id])).rows;
  const left = (lim, used) => toStr(lim - used > 0n ? lim - used : 0n);
  const custodian = a.role === 'custodian';
  return {
    account: accountView(a), role: a.role,
    minor: minor ? { name: minor.display_name, age: minor.date_of_birth ? ageOn(minor.date_of_birth) : null, hasLogin: minor.has_login } : null,
    parentName: parent?.display_name ?? null,
    canManage: custodian && ctl.mode === 'managed',
    controls: {
      mode: ctl.mode, dailyLimit: toStr(ctl.daily_limit_cents), weeklyLimit: toStr(ctl.weekly_limit_cents), heldCategories: ctl.held_categories,
      cardFrozen: ctl.card_frozen, accountFrozen: a.status === 'frozen', spentToday: toStr(s.today), spentWeek: toStr(s.week),
      leftToday: left(ctl.daily_limit_cents, s.today), leftWeek: left(ctl.weekly_limit_cents, s.week), updatedAt: ctl.updated_at
    },
    allowances: allowances.map(al => ({ id: al.id, amount: toStr(al.amount_cents), cadence: al.cadence, nextRunOn: al.next_run_on,
      from: custodian ? `${al.name} ··${al.number_last4}` : 'a parent' })),
    allowanceRuns: lastRuns.map(r => ({ runOn: r.run_on, status: r.status, reason: custodian ? r.reason : (r.status === 'paid' ? null : 'Not paid this time.') })),
    chores: chores.map(ch => ({ id: ch.id, title: ch.title, reward: toStr(ch.reward_cents), status: ch.status, paidAt: ch.paid_at })),
    goals: goals.map(g => ({ id: g.id, name: g.name, target: toStr(g.target_cents), saved: toStr(g.saved_cents), targetDate: g.target_date,
      pct: String(g.saved_cents >= g.target_cents ? 100n : (BigInt(g.saved_cents) * 100n) / BigInt(g.target_cents)) })),
    setAside: toStr(setAside), freeToSetAside: toStr(BigInt(a.balance_cents) - setAside > 0n ? BigInt(a.balance_cents) - setAside : 0n),
    activity: events.map(e => ({ at: e.at, who: e.who ?? 'USA Banc', text: activityText(e) }))
  };
}

/** Joint accounts the user owns with someone else, and joint invitations they sent that are still waiting. */
async function sharedAccounts(c, u) {
  const rows = (await c.query(`SELECT a.*, o.role, (SELECT array_agg(x.display_name ORDER BY x.display_name) FROM account_owners oo JOIN users x ON x.id = oo.user_id
       WHERE oo.account_id = a.id AND oo.user_id <> $1 AND oo.role IN ('owner', 'joint_owner')) AS others
     FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE o.user_id = $1 AND o.role IN ('owner', 'joint_owner') AND a.status <> 'closed' ORDER BY a.opened_at, a.name`, [u.id])).rows;
  const pending = (await c.query(`SELECT i.id, i.created_at, a.name, a.number_last4, x.display_name AS invitee FROM joint_invites i
     JOIN accounts a ON a.id = i.account_id JOIN users x ON x.id = i.invitee_id WHERE i.inviter_id = $1 AND i.status = 'pending' ORDER BY i.created_at`, [u.id])).rows;
  return {
    accounts: rows.filter(a => a.others?.length).map(a => ({ ...accountView(a), coOwners: a.others })),
    invites: pending.map(i => ({ id: i.id, invitee: i.invitee, account: { name: i.name, last4: i.number_last4 }, createdAt: i.created_at }))
  };
}

/** A custodian's minor account, its controls locked for update. View-only mode refuses changes unless allowViewOnly. */
async function managed(c, u, id, { allowViewOnly = false } = {}) {
  const a = await accountFor(c, u.id, id, ['custodian']);
  const ctl = await controlsFor(c, a.id, { lock: true });
  if (!ctl) throw new AppError(404, 'not_found', 'Account not found.');
  if (!allowViewOnly && ctl.mode !== 'managed')
    throw new AppError(409, 'view_only', 'This account is in view-only mode. Switch to managed mode to change it.');
  return { a, ctl };
}
/** The minor's own account (role minor) or the custodian's, for things either may do. */
async function familyMember(c, u, id) {
  const a = await accountFor(c, u.id, id, ['custodian', 'minor']);
  const ctl = await controlsFor(c, a.id);
  if (!ctl) throw new AppError(404, 'not_found', 'Account not found.');
  if (a.role === 'custodian' && ctl.mode !== 'managed')
    throw new AppError(409, 'view_only', 'This account is in view-only mode. Switch to managed mode to change it.');
  return { a, ctl };
}
/** One of the parent's own deposit accounts, to pay an allowance or a chore from. */
async function payerAccount(c, u, id) {
  const f = await accountFor(c, u.id, id, OWN);
  if (!FUNDING_KINDS.includes(f.kind) || f.status !== 'open') throw new AppError(400, 'bad_from', 'Choose one of your open checking, savings or money market accounts.');
  return f;
}

/** Refuses an applicant who already failed MAX_LOOKUP_FAILS lookups in 24 hours (audited; the refusal keeps its row). */
const lookupThrottle = (c, req, u, kind) => guard(c, req, u.id, RULES.lookup, { detail: { kind } });
/** The same refusal whether or not the username exists; audited, and the row is kept for the throttle. */
async function lookupFailed(c, req, u, kind) {
  await audit(c, req, u.id, 'account.lookup_failed', { kind });
  throw refuse(404, kind === 'minor' ? 'no_such_minor' : 'no_such_customer', kind === 'minor' ? NO_MINOR : NO_CO_OWNER);
}

export function register(r) {
  // ---------- products and disclosures ----------
  r.add('GET', '/api/products', async ({ req, pool }) => tx(pool, async c => {
    await requireUser(c, req);
    const ps = (await c.query('SELECT * FROM products ORDER BY sort')).rows;
    return { products: ps.map(productView), disclosureVersion: DISCLOSURE_VERSION, maxOpening: toStr(MAX_OPENING_CENTS) };
  }));

  r.add('GET', '/api/disclosures', async ({ req, pool, query }) => tx(pool, async c => {
    await requireUser(c, req);
    const p = await product(c, query.product);
    return { version: DISCLOSURE_VERSION, documents: disclosuresFor(p, query.ownership) };
  }));

  // ---------- applications ----------
  r.add('GET', '/api/applications', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const apps = (await c.query('SELECT * FROM applications WHERE applicant_id = $1 ORDER BY created_at DESC LIMIT 20', [u.id])).rows;
    const invites = (await c.query(`SELECT i.id, i.created_at, a.name, a.number_last4, a.kind, p.display_name AS inviter FROM joint_invites i
       JOIN accounts a ON a.id = i.account_id JOIN users p ON p.id = i.inviter_id WHERE i.invitee_id = $1 AND i.status = 'pending' ORDER BY i.created_at`, [u.id])).rows;
    const funding = (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
       WHERE o.user_id = $1 AND o.role = ANY($2) AND a.kind = ANY($3) AND a.status = 'open' ORDER BY (o.role = 'custodian'), (a.kind <> 'checking'), a.opened_at, a.name`, [u.id, MOVE_MONEY, FUNDING_KINDS])).rows;
    const minors = (await c.query(`SELECT u.id, u.display_name, u.date_of_birth, u.password_hash <> $2 AS has_login FROM family_links f JOIN users u ON u.id = f.minor_id
       WHERE f.guardian_id = $1 ORDER BY u.display_name`, [u.id, NO_LOGIN])).rows;
    const isMinor = !!u.dateOfBirth && ageOn(u.dateOfBirth) < 18;
    return {
      isMinor, applications: await Promise.all(apps.map(a => applicationView(c, a))),
      invites: invites.map(i => ({ id: i.id, inviter: i.inviter, account: { name: i.name, last4: i.number_last4, kind: i.kind }, createdAt: i.created_at })),
      fundingAccounts: isMinor ? [] : funding.map(accountView),
      minors: minors.filter(m => m.date_of_birth && ageOn(m.date_of_birth) < 18).map(m => ({ id: m.id, name: m.display_name, dob: m.date_of_birth, age: ageOn(m.date_of_birth), hasLogin: m.has_login }))
    };
  }));

  r.add('POST', '/api/applications', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const key = keyOf(u, body);
    await c.query('SELECT pg_advisory_xact_lock(727011, hashtext($1))', [u.id]);          // one application at a time per customer
    const prev = (await c.query('SELECT * FROM applications WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) return { ...(await applicationView(c, prev)), replayed: true };
    adultCheck(u);
    const today = (await c.query("SELECT count(*)::int n FROM applications WHERE applicant_id = $1 AND created_at > now() - interval '1 day'", [u.id])).rows[0].n;
    if (today >= MAX_APPS_PER_DAY) throw new AppError(429, 'too_many_applications', `You've sent ${MAX_APPS_PER_DAY} applications today. Please try again tomorrow or call us.`);

    const p = await product(c, body.product);
    const ownership = String(body.ownership ?? '');
    if (!p.ownerships.includes(ownership))
      throw new AppError(400, 'bad_ownership', ownership === 'joint' ? `${p.name} can't be opened as a joint account.` : ownership === 'minor' ? `${p.name} isn't an account for a child.` : `Choose who will own the ${p.name}.`);
    const id = readIdentity(body.identity);
    if (ageOn(id.dob) < 18) throw new AppError(400, 'too_young', 'You must be 18 or older to open an account. A parent or guardian can open one for you.');
    checkEsign(body.disclosures);

    // opening deposit: from an account the customer can move money from
    if (!body.funding?.fromAccountId) throw new AppError(400, 'bad_from', 'Choose an account to fund it from.');
    const from = await accountFor(c, u.id, body.funding?.fromAccountId, MOVE_MONEY);
    if (!FUNDING_KINDS.includes(from.kind) || from.status !== 'open') throw new AppError(400, 'bad_from', 'Choose an open checking, savings or money market account to fund it from.');
    const amount = parseAmount(body.funding?.amount, { field: 'opening deposit', min: BigInt(p.min_open_cents), max: MAX_OPENING_CENTS });
    if (BigInt(from.balance_cents) < amount)
      throw new AppError(409, 'insufficient_funds', `${where(from)} has ${usd(from.balance_cents)} available. Choose a smaller opening deposit or another account.`);

    // who else is on it
    let coOwner = null, minor = null;
    if (ownership === 'joint') {
      requireStepUp(u);                                                             // adding a joint owner is a risky action (RESEARCH §7)
      const name = String(body.coOwner ?? '').trim().toLowerCase();
      if (name === u.username) throw new AppError(400, 'self_joint', "You can't add yourself as a joint owner.");
      await lookupThrottle(c, req, u, 'co_owner');
      coOwner = name ? (await c.query('SELECT * FROM users WHERE username = $1 AND password_hash <> $2', [name, NO_LOGIN])).rows[0] : null;
      // unknown and under-18 get the same answer, so the lookup can't be used to learn who banks here or who is a child
      if (!coOwner || (coOwner.date_of_birth && ageOn(coOwner.date_of_birth) < 18)) await lookupFailed(c, req, u, 'co_owner');
    }
    if (ownership === 'minor') {
      const m = body.minor ?? {};
      if (m.id) {
        uuidOr404(m.id, 'Choose a child.');
        minor = (await c.query('SELECT u.* FROM family_links f JOIN users u ON u.id = f.minor_id WHERE f.guardian_id = $1 AND f.minor_id = $2', [u.id, m.id])).rows[0];
        if (!minor) throw new AppError(404, 'not_found', 'Choose a child.');
      } else if (m.username) {
        // only a child the applicant is already the parent or guardian of: a stranger can't attach themselves to a child
        const dob = readDob(m.dob, "Child's date of birth");
        await lookupThrottle(c, req, u, 'minor');
        minor = (await c.query(`SELECT u.* FROM users u JOIN family_links f ON f.minor_id = u.id AND f.guardian_id = $4
           WHERE u.username = $1 AND u.password_hash <> $2 AND u.date_of_birth = $3`, [String(m.username).trim().toLowerCase(), NO_LOGIN, dob, u.id])).rows[0];
        if (!minor || minor.id === u.id) await lookupFailed(c, req, u, 'minor');
      } else {
        if (p.kind !== 'custodial_savings') throw new AppError(400, 'needs_login', "Teen Checking needs the teen's own USA Banc username. Enter it, or open Custodial Savings instead.");
        minor = { id: null, display_name: readName(m.name, "child's name"), date_of_birth: readDob(m.dob, "Child's date of birth") };
      }
      const age = ageOn(minor.date_of_birth);
      if (age < p.minor_min_age || age > p.minor_max_age)
        throw new AppError(400, 'wrong_age', `${p.name} is for ages ${p.minor_min_age === 0 ? 'under 18' : `${p.minor_min_age} to ${p.minor_max_age}`}. ${minor.display_name} is ${age}.`);
    }
    // money in a child's account belongs to that child: it can only fund another account for the same child
    if (from.role === 'custodian') {
      const child = (await c.query("SELECT user_id FROM account_owners WHERE account_id = $1 AND role = 'minor'", [from.id])).rows[0];
      if (!minor?.id || child?.user_id !== minor.id) throw new AppError(400, 'childs_money', "Money in a child's account belongs to that child. Fund this account from your own account.");
      if ((await controlsFor(c, from.id))?.mode === 'view_only') {                  // view-only: the parent watches, money stays put
        await audit(c, req, u.id, 'transfer.refused', { reason: 'view_only', what: 'opening_deposit', account: from.number_last4, accountId: from.id });
        throw refuse(403, 'view_only', `${where(from)} is in view-only mode. Switch to managed mode to move money out of it.`);
      }
    }

    // simulated identity check + OFAC screen
    const s = await screen(c, u, id);
    let account = null, entryId = null;
    if (s.state === 'approved') {
      await keepIdentity(c, u.id, id, s.hash);
      if (minor && !minor.id) {                                                     // a new minor profile (no sign-in)
        minor.id = newId();
        await c.query('INSERT INTO users (id, username, display_name, password_hash, mfa_required, date_of_birth) VALUES ($1,$2,$3,$4,true,$5)',
          [minor.id, `minor-${minor.id.slice(0, 8)}@profiles.usabanc.example`, minor.display_name, NO_LOGIN, minor.date_of_birth]);
      }
      if (minor) await c.query('INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [u.id, minor.id, body.minor?.relationship === 'guardian' ? 'guardian' : 'parent']);
      const last4 = await newLast4(c), aid = newId();
      const name = minor ? `${minor.display_name.split(' ')[0]}'s ${p.name}` : p.name;
      await c.query(`INSERT INTO accounts (id, kind, name, number_last4, apy_bp, status) VALUES ($1,$2,$3,$4,$5,'open')`, [aid, p.kind, name, last4, p.apy_bp]);
      await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [aid, u.id, minor ? 'custodian' : 'owner']);
      if (minor) { await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [aid, minor.id]); await controlsFor(c, aid); }
      await c.query(`INSERT INTO account_terms (account_id, product_code, ownership, term_months, maturity_date, early_withdrawal_days, opened_by)
         VALUES ($1,$2,$3,$4, CASE WHEN $4::int IS NULL THEN NULL ELSE ($7::date + make_interval(months => $4::int))::date END, $5, $6)`,
        [aid, p.code, ownership, p.term_months, p.early_withdrawal_days, u.id, bankToday()]);
      if (coOwner) await c.query('INSERT INTO joint_invites (id, account_id, inviter_id, invitee_id) VALUES ($1,$2,$3,$4)', [newId(), aid, u.id, coOwner.id]);
      entryId = (await post(c, { key, kind: 'account_opening', createdBy: u.id, memo: `Opening deposit for ··${last4}`, lines: [
        { accountId: from.id, amountCents: -amount, description: `Opening deposit to ${name} ··${last4}`, category: 'Transfers' },
        { accountId: aid, amountCents: amount, description: `Opening deposit from ${where(from)}`, category: 'Transfers' }] })).entryId;
      // the debit card comes with the account, in the same transaction (the minor holds a teen account's card)
      if (DEBIT_KINDS.includes(p.kind)) await issueCard(c, { accountId: aid, holderId: minor?.id ?? u.id, type: 'debit' });
      account = { id: aid, last4 };
    }
    const appId = newId();
    await c.query(`INSERT INTO applications (id, idempotency_key, applicant_id, product_code, ownership, co_owner_id, minor_id, state, reasons, legal_name, date_of_birth,
        address, ssn_last4, ssn_hash, ofac_hit, funding_account_id, opening_deposit_cents, funding_entry_id, account_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [appId, key, u.id, p.code, ownership, coOwner?.id ?? null, minor?.id ?? null, s.state, s.reasons, id.legalName, id.dob, id.address, id.ssnLast4, s.hash,
        s.ofacHit, from.id, amount, entryId, account?.id ?? null]);
    for (const d of disclosuresFor(p, ownership))
      await c.query('INSERT INTO disclosure_acceptances (user_id, application_id, document_key, version, ip) VALUES ($1,$2,$3,$4,$5)',
        [u.id, appId, d.key, DISCLOSURE_VERSION, clientIp(req)]);
    await audit(c, req, u.id, 'account.application', { applicationId: appId, product: p.code, ownership, state: s.state, reasons: s.reasons, ofacHit: s.ofacHit, disclosureVersion: DISCLOSURE_VERSION });
    if (account) {
      await audit(c, req, u.id, 'account.open', { accountId: account.id, last4: account.last4, product: p.code, ownership, ...(minor ? { minorId: minor.id } : {}) });
      await audit(c, req, u.id, 'account.fund', { accountId: account.id, fromLast4: from.number_last4, amount: toStr(amount), entryId });
      if (coOwner) await audit(c, req, u.id, 'account.joint_invite', { accountId: account.id, invitee: coOwner.username });
    }
    return applicationView(c, (await c.query('SELECT * FROM applications WHERE id = $1', [appId])).rows[0]);
  }));

  // ---------- joint invites: the co-owner accepts with their own identity check ----------
  r.add('POST', '/api/invites/:id/accept', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    uuidOr404(params.id);
    const inv = (await c.query("SELECT * FROM joint_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending' FOR UPDATE", [params.id, u.id])).rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'That invitation was not found or was already answered.');
    adultCheck(u);
    const id = readIdentity(body.identity);
    if (ageOn(id.dob) < 18) throw new AppError(400, 'too_young', 'Joint owners must be 18 or older.');
    checkEsign(body.disclosures);
    const s = await screen(c, u, id);
    const status = s.state === 'approved' ? 'accepted' : s.state;
    if (s.state === 'approved') {
      await keepIdentity(c, u.id, id, s.hash);
      await c.query("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'joint_owner') ON CONFLICT DO NOTHING", [inv.account_id, u.id]);
    }
    await c.query('UPDATE joint_invites SET status = $2, reasons = $3, decided_at = now() WHERE id = $1', [inv.id, status, s.reasons]);
    const a = (await c.query('SELECT a.*, t.product_code FROM accounts a LEFT JOIN account_terms t ON t.account_id = a.id WHERE a.id = $1', [inv.account_id])).rows[0];
    const p = (await c.query('SELECT * FROM products WHERE code = $1', [a.product_code ?? 'bright_savings'])).rows[0];
    for (const d of disclosuresFor(p, 'joint'))
      await c.query('INSERT INTO disclosure_acceptances (user_id, invite_id, document_key, version) VALUES ($1,$2,$3,$4)', [u.id, inv.id, d.key, DISCLOSURE_VERSION]);
    await audit(c, req, u.id, 'account.joint_accept', { accountId: a.id, inviteId: inv.id, state: s.state, reasons: s.reasons, ofacHit: s.ofacHit });
    return { state: s.state, reasons: s.reasons, account: s.state === 'approved' ? { id: a.id, name: a.name, last4: a.number_last4 } : null };
  }));

  r.add('POST', '/api/invites/:id/decline', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    uuidOr404(params.id);
    const inv = (await c.query("UPDATE joint_invites SET status = 'declined', decided_at = now() WHERE id = $1 AND invitee_id = $2 AND status = 'pending' RETURNING *", [params.id, u.id])).rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'That invitation was not found or was already answered.');
    await audit(c, req, u.id, 'account.joint_decline', { accountId: inv.account_id, inviteId: inv.id });
    return { ok: true };
  }));

  // ---------- family ----------
  // Parents see each minor account they manage; a minor sees only their own. Due allowances are paid first.
  r.add('GET', '/api/family', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const accts = (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
       WHERE o.user_id = $1 AND o.role IN ('custodian', 'minor') AND a.status <> 'closed' ORDER BY a.opened_at, a.name`, [u.id])).rows;
    const ids = accts.map(a => a.id);
    const ran = ids.length ? await runDueAllowances(c, ids) : [];
    const fresh = ran.length ? (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.id = ANY($2) ORDER BY a.opened_at, a.name`, [u.id, ids])).rows : accts;
    const role = fresh.some(a => a.role === 'custodian') ? 'parent' : fresh.length ? 'minor' : 'none';
    const payers = role === 'parent' ? (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
       WHERE o.user_id = $1 AND o.role = ANY($2) AND a.kind = ANY($3) AND a.status = 'open' ORDER BY (a.kind <> 'checking'), a.opened_at, a.name`, [u.id, OWN, FUNDING_KINDS])).rows : [];
    const out = [];
    for (const a of fresh) out.push(await familyAccount(c, a));
    return { role, accounts: out, shared: await sharedAccounts(c, u), payFrom: payers.map(accountView), categories: CATEGORIES,
      maxLimits: { daily: toStr(MAX_LIMITS.daily), weekly: toStr(MAX_LIMITS.weekly) }, maxAllowance: toStr(MAX_ALLOWANCE), maxChore: toStr(MAX_CHORE), allowanceRuns: ran };
  }));

  r.add('POST', '/api/family/allowances/run', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ids = (await c.query("SELECT account_id FROM account_owners WHERE user_id = $1 AND role IN ('custodian', 'minor')", [u.id])).rows.map(x => x.account_id);
    return { runs: ids.length ? await runDueAllowances(c, ids) : [] };
  }));

  r.add('POST', '/api/family/:id/controls', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a, ctl } = await managed(c, u, params.id);
    const daily = parseAmount(body.dailyLimit, { field: 'daily limit', min: 0n, max: MAX_LIMITS.daily });
    const weekly = parseAmount(body.weeklyLimit, { field: '7-day limit', min: 0n, max: MAX_LIMITS.weekly });
    if (daily > weekly) throw new AppError(400, 'bad_limits', "The daily limit can't be more than the 7-day limit.");
    const cats = Array.isArray(body.heldCategories) ? [...new Set(body.heldCategories.map(String))] : [];
    const unknown = cats.find(x => !CATEGORIES.includes(x));
    if (unknown) throw new AppError(400, 'bad_category', `"${unknown.slice(0, 40)}" isn't a category we know.`);
    // loosening a control (a higher limit, a category turned back on) is a risky action: fresh code first
    if (daily > ctl.daily_limit_cents || weekly > ctl.weekly_limit_cents || ctl.held_categories.some(x => !cats.includes(x))) requireStepUp(u);
    await c.query('UPDATE family_controls SET daily_limit_cents = $2, weekly_limit_cents = $3, held_categories = $4, updated_by = $5, updated_at = now() WHERE account_id = $1',
      [a.id, daily, weekly, cats, u.id]);
    await audit(c, req, u.id, 'family.controls.update', { accountId: a.id,
      before: { daily: toStr(ctl.daily_limit_cents), weekly: toStr(ctl.weekly_limit_cents), held: ctl.held_categories },
      after: { daily: toStr(daily), weekly: toStr(weekly), held: cats } });
    return { ok: true };
  }));

  r.add('POST', '/api/family/:id/mode', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a, ctl } = await managed(c, u, params.id, { allowViewOnly: true });
    const mode = String(body.mode ?? '');
    if (!['managed', 'view_only'].includes(mode)) throw new AppError(400, 'bad_mode', 'Choose managed or view-only.');
    if (mode !== ctl.mode) {
      if (mode === 'managed') requireStepUp(u);                                   // managed loosens view-only: fresh code first
      await c.query('UPDATE family_controls SET mode = $2, updated_by = $3, updated_at = now() WHERE account_id = $1', [a.id, mode, u.id]);
      await audit(c, req, u.id, 'family.mode', { accountId: a.id, mode, before: ctl.mode });
    }
    return { ok: true, mode };
  }));

  // Freeze works in either mode (a parent can always stop spending). Unfreezing loosens a control: fresh code first.
  r.add('POST', '/api/family/:id/freeze', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a, ctl } = await managed(c, u, params.id, { allowViewOnly: true });
    const target = String(body.target ?? ''), frozen = body.frozen === true;
    if (!['card', 'account'].includes(target)) throw new AppError(400, 'bad_target', 'Choose the card or the account.');
    const now = target === 'card' ? ctl.card_frozen : a.status === 'frozen';
    if (now === frozen) return { ok: true, target, frozen };
    if (!frozen) requireStepUp(u);
    if (target === 'card') await setCardFrozen(c, a.id, frozen, u.id);           // one state with the Cards page lock
    else await c.query("UPDATE accounts SET status = $2 WHERE id = $1 AND status IN ('open', 'frozen')", [a.id, frozen ? 'frozen' : 'open']);
    await audit(c, req, u.id, frozen ? 'family.freeze' : 'family.unfreeze', { accountId: a.id, target });
    return { ok: true, target, frozen };
  }));

  r.add('POST', '/api/family/:id/allowances', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a } = await managed(c, u, params.id);
    if ((await c.query('SELECT 1 FROM allowances WHERE account_id = $1 AND active', [a.id])).rowCount)
      throw new AppError(409, 'has_allowance', 'This account already has an allowance. Stop it first to set up a new one.');
    const from = await payerAccount(c, u, body.fromAccountId);
    const amount = parseAmount(body.amount, { field: 'allowance', max: MAX_ALLOWANCE });
    const cadence = String(body.cadence ?? '');
    if (!['weekly', 'monthly'].includes(cadence)) throw new AppError(400, 'bad_cadence', 'Choose weekly or monthly.');
    const start = body.startOn ? readDate(body.startOn, 'First payment date') : null;
    const t = bankToday(), ok = { d: start ?? t };
    if (ok.d < t || ok.d > addDays(t, 60)) throw new AppError(400, 'bad_start', 'Choose a first payment date from today to 60 days from now.');
    const id = newId();
    await c.query('INSERT INTO allowances (id, account_id, from_account_id, amount_cents, cadence, next_run_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, a.id, from.id, amount, cadence, ok.d, u.id]);
    await audit(c, req, u.id, 'family.allowance.create', { accountId: a.id, allowanceId: id, amount: toStr(amount), cadence, fromLast4: from.number_last4, startOn: ok.d });
    return { id, nextRunOn: ok.d };
  }));

  r.add('DELETE', '/api/family/:id/allowances/:aid', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a } = await managed(c, u, params.id, { allowViewOnly: true });          // stopping money is always allowed
    uuidOr404(params.aid);
    const al = (await c.query('UPDATE allowances SET active = false WHERE id = $1 AND account_id = $2 AND active RETURNING *', [params.aid, a.id])).rows[0];
    if (!al) throw new AppError(404, 'not_found', 'That allowance was not found.');
    await audit(c, req, u.id, 'family.allowance.stop', { accountId: a.id, allowanceId: al.id, amount: toStr(al.amount_cents) });
    return { ok: true };
  }));

  r.add('POST', '/api/family/:id/chores', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a } = await managed(c, u, params.id);
    const title = text(body.title, 'chore name', 2, 80), reward = parseAmount(body.reward, { field: 'reward', max: MAX_CHORE });
    const id = newId();
    await c.query('INSERT INTO chores (id, account_id, title, reward_cents, created_by) VALUES ($1,$2,$3,$4,$5)', [id, a.id, title, reward, u.id]);
    await audit(c, req, u.id, 'family.chore.create', { accountId: a.id, choreId: id, title, amount: toStr(reward) });
    return { id };
  }));

  const choreFor = async (c, id) => {
    uuidOr404(id);
    return (await c.query('SELECT * FROM chores WHERE id = $1 FOR UPDATE', [id])).rows[0] ?? null;
  };
  r.add('POST', '/api/chores/:id/submit', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ch = await choreFor(c, params.id);
    if (!ch) throw new AppError(404, 'not_found', 'Chore not found.');
    await accountFor(c, u.id, ch.account_id, ['minor']);
    if (ch.status !== 'open') throw new AppError(409, 'chore_not_open', ch.status === 'submitted' ? 'You already marked this chore done. A parent will check it.' : 'This chore is finished.');
    await c.query("UPDATE chores SET status = 'submitted', submitted_at = now() WHERE id = $1", [ch.id]);
    await audit(c, req, u.id, 'family.chore.submit', { accountId: ch.account_id, choreId: ch.id, title: ch.title });
    return { ok: true };
  }));

  // Approving pays the reward from the parent's account, once (row lock + paid status + idempotency key).
  r.add('POST', '/api/chores/:id/approve', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ch = await choreFor(c, params.id);
    if (!ch) throw new AppError(404, 'not_found', 'Chore not found.');
    const { a } = await managed(c, u, ch.account_id);
    if (ch.status === 'paid') return { ok: true, replayed: true, entryId: ch.entry_id };
    if (ch.status === 'canceled') throw new AppError(409, 'chore_canceled', 'This chore was removed.');
    const from = await payerAccount(c, u, body.fromAccountId);
    const { entryId, replayed } = await post(c, { key: keyOf(u, body), kind: 'chore_reward', createdBy: u.id, memo: ch.title, lines: [
      { accountId: from.id, amountCents: -ch.reward_cents, description: `Chore reward to ${where(a)}: ${ch.title}`, category: 'Transfers' },
      { accountId: a.id, amountCents: ch.reward_cents, description: `Chore reward: ${ch.title}`, category: 'Income' }] });
    await c.query("UPDATE chores SET status = 'paid', approved_by = $2, paid_at = now(), entry_id = $3 WHERE id = $1", [ch.id, u.id, entryId]);
    await audit(c, req, u.id, 'family.chore.paid', { accountId: a.id, choreId: ch.id, title: ch.title, amount: toStr(ch.reward_cents), fromLast4: from.number_last4, entryId });
    return { ok: true, replayed, entryId };
  }));

  r.add('POST', '/api/chores/:id/cancel', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const ch = await choreFor(c, params.id);
    if (!ch) throw new AppError(404, 'not_found', 'Chore not found.');
    const { a } = await managed(c, u, ch.account_id);
    if (ch.status === 'paid') throw new AppError(409, 'chore_paid', 'This chore was already paid.');
    await c.query("UPDATE chores SET status = 'canceled' WHERE id = $1", [ch.id]);
    await audit(c, req, u.id, 'family.chore.cancel', { accountId: a.id, choreId: ch.id, title: ch.title });
    return { ok: true };
  }));

  // Savings goals: the parent (managed mode) or the minor can add one and set money aside (it stays in the account).
  r.add('POST', '/api/family/:id/goals', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const { a } = await familyMember(c, u, params.id);
    const name = text(body.name, 'goal name', 2, 60), target = parseAmount(body.target, { field: 'goal', max: 100_000_00n });
    const date = body.targetDate ? readDate(body.targetDate, 'Target date') : null;
    if (date && date <= bankToday()) throw new AppError(400, 'bad_date', 'Choose a target date in the future.');
    if ((await c.query('SELECT count(*)::int n FROM savings_goals WHERE account_id = $1', [a.id])).rows[0].n >= MAX_GOALS)
      throw new AppError(409, 'too_many_goals', `An account can have up to ${MAX_GOALS} savings goals.`);
    const id = newId();
    await c.query('INSERT INTO savings_goals (id, account_id, name, target_cents, target_date, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.id, name, target, date, u.id]);
    await audit(c, req, u.id, 'family.goal.create', { accountId: a.id, goalId: id, name, target: toStr(target) });
    return { id };
  }));

  r.add('POST', '/api/goals/:id/set-aside', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    uuidOr404(params.id);
    const g = (await c.query('SELECT * FROM savings_goals WHERE id = $1', [params.id])).rows[0];
    if (!g) throw new AppError(404, 'not_found', 'Goal not found.');
    const { a } = await familyMember(c, u, g.account_id);
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a.id]);
    const amount = parseAmount(body.amount, { field: 'amount', max: 100_000_00n }), release = body.release === true;
    const fresh = (await c.query('SELECT a.balance_cents, (SELECT coalesce(sum(saved_cents), 0)::bigint FROM savings_goals WHERE account_id = a.id) AS aside FROM accounts a WHERE a.id = $1', [a.id])).rows[0];
    if (release && amount > g.saved_cents) throw new AppError(400, 'too_much', `Only ${usd(g.saved_cents)} is set aside for ${g.name}.`);
    if (!release && fresh.aside + amount > fresh.balance_cents) {
      const free = fresh.balance_cents - fresh.aside;
      throw new AppError(409, 'not_enough', `You can set aside up to ${usd(free > 0n ? free : 0n)} more. The rest is already set aside or spent.`);
    }
    await c.query('UPDATE savings_goals SET saved_cents = saved_cents + $2 WHERE id = $1', [g.id, release ? -amount : amount]);
    await audit(c, req, u.id, release ? 'family.goal.release' : 'family.goal.set_aside', { accountId: a.id, goalId: g.id, name: g.name, amount: toStr(amount) });
    return { ok: true };
  }));

  // A practice purchase so a minor (and Helix) can see the controls work. Simulated: no card network is involved.
  r.add('POST', '/api/family/:id/purchase', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await accountFor(c, u.id, params.id, ['minor']);
    const key = keyOf(u, body);
    const prev = (await c.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) return { ok: true, replayed: true, entryId: prev.id };
    const amount = parseAmount(body.amount, { field: 'amount', max: MAX_PURCHASE });
    const category = String(body.category ?? '');
    if (!CATEGORIES.includes(category)) throw new AppError(400, 'bad_category', 'Choose what kind of store it is.');
    const merchant = text(body.merchant, 'store name', 2, 60);
    await checkMinorSpend(c, a.id, amount, category, { channel: 'card', req, userId: u.id });
    const { entryId } = await post(c, { key, kind: 'card_purchase', createdBy: u.id, memo: 'Simulated purchase', lines: [
      { accountId: a.id, amountCents: -amount, description: `${merchant} (simulated purchase)`, category },
      { accountId: await systemAccount(c, SETTLEMENT), amountCents: amount, description: `${merchant} (simulated purchase)` }] });   // the one card settlement account the Cards feature uses
    await audit(c, req, u.id, 'family.purchase', { accountId: a.id, amount: toStr(amount), category, entryId });
    return { ok: true, entryId };
  }));
}
