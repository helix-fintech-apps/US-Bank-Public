// Family debit cards: an owner issues a card to their teen (custodian of a Teen Checking account) or to another adult
// customer (owner of a checking account, the cardholder gets no access to the account). The request is approved by the
// custodian with step-up (minor) or by the cardholder with a simulated identity check (adult). The owner sets spend
// controls, which can never be higher than the owner's own limits (the ceiling), and freezes, replaces or cancels the
// card. The cardholder makes simulated authorizations that post to the owner's account through card_network_settlement.
// Simulated: no real card network, card number, PIN or mailing. No card number or security code exists anywhere.
import { randomInt } from 'node:crypto';
import { AppError, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requestKey, fingerprintOf, conflict } from '../idempotency.mjs';
import { requireUser, requireStepUp, audit, newId } from '../auth.mjs';
import { accountFor } from '../access.mjs';
import { post, systemAccount } from '../ledger.mjs';
import { usd } from '../money.mjs';
import { CATEGORIES, isCategory } from '../categories.mjs';
import { checkMinorSpend, controlsFor as familyControlsFor } from '../controls.mjs';
import { readIdentity, screen, keepIdentity } from '../onboarding.mjs';
import { limitsFor } from '../money-movement/limits.mjs';
import { bankToday } from '../bank-date.mjs';
import { SETTLEMENT } from '../cards.mjs';

const FEATURE = 'family-cards';
const BRAND = 'USA Banc Debit';
const STATUSES = ['pending', 'review', 'declined', 'active', 'frozen', 'canceled'];
const LIVE = ['pending', 'review', 'active', 'frozen'];                 // statuses that hold a card's place (R10)
const FORMS = ['physical', 'virtual'];
const EXP_YEARS = { physical: 4, virtual: 2 };
const MAX_PER_ACCOUNT = 5;                                              // live family cards per account (R10)
const MINOR_AGES = [13, 17];                                            // Teen Checking ages (products.teen_checking)
const CHANNELS = ['in_store', 'online', 'atm'];
const MAX_AUTH_CENTS = 10_000_000;                                      // simulated authorizations: demo cap ($100,000)
const REPLACE_REASONS = ['lost', 'stolen', 'damaged'];
const LIMITS = { perTransactionCents: ['per_txn_cents', 1n], dailyCents: ['daily_cents', 1n], atmDailyCents: ['atm_daily_cents', 0n] };
const CONTROL_FIELDS = [...Object.keys(LIMITS), 'onlineEnabled', 'categories'];
const MODES = ['any', 'allow', 'deny'];
// Field names that would carry a card number or a security code: never accepted, at any depth (R12).
const CARD_DATA = new Set(['pan', 'cardnumber', 'number', 'cvv', 'cvv2', 'cvc', 'cvc2', 'securitycode']);
const DECLINES = {
  card_not_active: "The card isn't active yet.", card_canceled: 'The card was canceled.', card_frozen: 'The card is frozen.',
  account_closed: 'The account is closed.', account_frozen: 'The account is frozen.', account_unavailable: "The account can't be used right now.",
  online_off: 'Online purchases are turned off for this card.', category_not_allowed: "This kind of store isn't allowed on this card.",
  card_transaction_limit: "It's over the card's limit per purchase.", card_daily_limit: "It's over the card's daily limit.",
  card_atm_limit: "It's over the card's daily ATM limit.", category_off: 'This kind of store is turned off in the family controls.',
  daily_limit: "It's over the family daily spending limit.", weekly_limit: "It's over the family 7-day spending limit.",
  insufficient_funds: "There isn't enough money in the account."
};

const err = (status, code, message) => new AppError(status, code, message);
const notFound = () => err(404, 'not_found', 'Card not found.');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = v => (v == null ? null : Number(v));                     // ok-number: integer cents in JSON, as the API contract asks (bounded by the ceiling)
const ageOn = (dob, today) => {                                         // whole years on a bank date, both 'YYYY-MM-DD'
  const [y, m, d] = today.split('-').map(Number), [by, bm, bd] = String(dob).split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

/** R12: refuses a body holding a card number or security code field anywhere in it (checked without recursion limits). */
function noCardData(body) {
  const stack = [body];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    for (const [k, x] of Object.entries(v)) {
      if (CARD_DATA.has(k.toLowerCase().replace(/[_-]/g, ''))) throw err(400, 'card_data_not_accepted', "Don't send card numbers or security codes. Family cards never need them.");
      stack.push(x);
    }
  }
}

// ---------- controls ----------
const DEFAULT_CONTROLS = { perTransactionCents: null, dailyCents: null, atmDailyCents: null, onlineEnabled: true, categories: { mode: 'any', list: [] } };
const controlsOf = k => ({ perTransactionCents: k.per_txn_cents, dailyCents: k.daily_cents, atmDailyCents: k.atm_daily_cents,
  onlineEnabled: k.online_enabled, categories: { mode: k.category_mode, list: [...k.category_list] } });
const controlsView = x => ({ perTransactionCents: cents(x.perTransactionCents), dailyCents: cents(x.dailyCents), atmDailyCents: cents(x.atmDailyCents),
  onlineEnabled: x.onlineEnabled, categories: { mode: x.categories.mode, list: [...x.categories.list] } });

/** The control fields of a request, checked for shape (R18). Returns only the fields given, limits as BigInt. */
function readControls(b, { allowEmpty = false } = {}) {
  const bad = what => err(400, 'bad_controls', what);
  if (!isObj(b)) throw bad('Card controls must be an object.');
  const keys = Object.keys(b), out = {};
  const unknown = keys.find(k => !CONTROL_FIELDS.includes(k));
  if (unknown) throw bad(`"${unknown}" isn't a card control.`);
  if (!keys.length && !allowEmpty) throw bad('Change at least one card control.');
  for (const [f, [, min]] of Object.entries(LIMITS)) {
    if (!(f in b)) continue;
    const v = b[f];
    if (v === null) { out[f] = null; continue; }
    if (typeof v !== 'number' || !Number.isInteger(v) || BigInt(v) < min) throw bad(`Enter ${f} as whole cents of ${min} or more, or null for no card limit.`);
    out[f] = BigInt(v);
  }
  if ('onlineEnabled' in b) {
    if (typeof b.onlineEnabled !== 'boolean') throw bad('onlineEnabled must be true or false.');
    out.onlineEnabled = b.onlineEnabled;
  }
  if ('categories' in b) {
    const c = b.categories;
    if (!isObj(c) || Object.keys(c).some(k => k !== 'mode' && k !== 'list')) throw bad('categories must be { "mode": "any" | "allow" | "deny", "list": [...] }.');
    if (!MODES.includes(c.mode)) throw bad('Choose a category mode of any, allow or deny.');
    const list = c.list === undefined ? [] : c.list;
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !isCategory(x))) throw bad('Choose categories from the list of merchant categories.');
    if (c.mode === 'any' && list.length) throw bad('The "any" mode allows every category, so leave its list empty.');
    out.categories = { mode: c.mode, list: [...new Set(list)].sort() };
  }
  return out;
}
/** The card's controls after a change, or a 400 when a per-purchase or ATM limit would be above the daily limit. */
function merged(cur, change) {
  const next = { ...cur, ...change };
  for (const f of ['perTransactionCents', 'atmDailyCents'])
    if (next[f] != null && next.dailyCents != null && next[f] > next.dailyCents) throw err(400, 'bad_controls', `${f} can't be more than dailyCents.`);
  return next;
}
const allowedSet = ({ mode, list }) => new Set(mode === 'any' ? CATEGORIES : mode === 'allow' ? list : CATEGORIES.filter(x => !list.includes(x)));
/** R20: true when the change raises a limit (a number to null included), turns online on, or allows a new category. */
function loosens(before, after) {
  for (const f of Object.keys(LIMITS)) if (before[f] != null && (after[f] == null || after[f] > before[f])) return true;
  if (!before.onlineEnabled && after.onlineEnabled) return true;
  const old = allowedSet(before.categories);
  return [...allowedSet(after.categories)].some(x => !old.has(x));
}

// ---------- the owner's ceiling (4.3) ----------
/** The owner's own internal daily limit, and on a Teen Checking account no more than its family daily limit (BigInt cents). */
async function ceilingFor(c, ownerId, account) {
  let cap = BigInt((await limitsFor(c, ownerId, 'internal')).daily);
  if (account.kind === 'teen_checking') {
    const f = await familyControlsFor(c, account.id);
    if (f && BigInt(f.daily_limit_cents) < cap) cap = BigInt(f.daily_limit_cents);
  }
  return cap;
}
function checkCeiling(change, cap) {
  for (const f of Object.keys(LIMITS))
    if (change[f] != null && change[f] > cap) throw err(422, 'over_owner_limit', `Card limits can't be more than your own daily limit of ${usd(cap)}.`);
}

// ---------- cards ----------
const SELECT_CARD = 'SELECT k.*, u.display_name AS holder_name FROM family_cards k JOIN users u ON u.id = k.holder_user_id';
const cardView = (k, viewerId) => ({
  id: k.id, accountId: viewerId === k.issuer_user_id ? k.account_id : null, issuerUserId: k.issuer_user_id,
  cardholder: { userId: k.holder_user_id, name: k.holder_name, kind: k.holder_kind }, form: k.form, status: k.status, endReason: k.end_reason,
  brand: k.last4 ? BRAND : null, last4: k.last4, expMonth: k.exp_month, expYear: k.exp_year, controls: controlsView(controlsOf(k)),
  replacesCardId: k.replaces_card_id, replacedByCardId: k.replaced_by_card_id, createdAt: k.created_at, activatedAt: k.activated_at
});
const authView = a => ({ id: a.id, cardId: a.card_id, cardholderUserId: a.cardholder_user_id, merchant: a.merchant, category: a.category,
  channel: a.channel, amountCents: cents(a.amount_cents), decision: a.decision, reasonCode: a.reason_code, entryId: a.entry_id, createdAt: a.created_at });
const loadCard = async (c, id) => (await c.query(`${SELECT_CARD} WHERE k.id = $1`, [id])).rows[0];

/** A card the caller issued or holds, with their side of it; anything else is a 404 (R2). `lock` holds the row for a change. */
async function cardFor(c, u, id, { lock = false } = {}) {
  if (!isUuid(id)) throw notFound();
  const k = (await c.query(`${SELECT_CARD} WHERE k.id = $1 AND (k.issuer_user_id = $2 OR k.holder_user_id = $2)${lock ? ' FOR UPDATE OF k' : ''}`, [id, u.id])).rows[0];
  if (!k) throw notFound();
  return { card: k, isOwner: k.issuer_user_id === u.id };
}
const ownerOnly = s => { if (!s.isOwner) throw err(403, 'issuer_only', 'Only the person who issued this card can do that.'); };
const inState = (k, ok) => { if (!ok.includes(k.status)) throw err(409, 'invalid_state', `This card is ${k.status}, so that can't be done now.`); };

/** The card's account, whether it is in family view-only mode, and the R24 refusals (view_only first, then account_not_open). */
async function accountOf(c, k) {
  const a = (await c.query('SELECT id, kind, name, number_last4, status, balance_cents FROM accounts WHERE id = $1', [k.account_id])).rows[0];
  const viewOnly = a.kind === 'teen_checking' && (await c.query('SELECT mode FROM family_controls WHERE account_id = $1', [a.id])).rows[0]?.mode === 'view_only';
  return { ...a, viewOnly };
}
function usable(a) {
  if (a.viewOnly) throw err(409, 'view_only', 'This Teen Checking account is in view-only mode. Switch to managed mode first.');
  if (a.status !== 'open') throw err(409, 'account_not_open', "The card's account isn't open.");
}

/** Brand values for a card that becomes active today: a new last 4 (never `avoid`) and an expiry from the bank's month. */
function activation(form, avoid = null) {
  let last4;
  do last4 = String(randomInt(0, 10_000)).padStart(4, '0'); while (last4 === avoid);
  const [y, m] = bankToday().split('-').map(Number);
  return { last4, expMonth: m, expYear: y + EXP_YEARS[form] };
}
const activate = (c, k) => {
  const v = activation(k.form);
  return c.query(`UPDATE family_cards SET status = 'active', last4 = $2, exp_month = $3, exp_year = $4, activated_at = now() WHERE id = $1`, [k.id, v.last4, v.expMonth, v.expYear]);
};

async function notifyOwner(c, ownerId, ref, title, body) {
  await c.query(`INSERT INTO notifications (user_id, kind, ref, title, body) VALUES ($1, 'family_card', $2, $3, $4) ON CONFLICT (user_id, ref) DO NOTHING`, [ownerId, ref, title, body]);
}

// ---------- the request (5.1) ----------
function readCardholder(h) {
  const bad = () => err(400, 'bad_cardholder', 'Choose who the card is for: { "type": "minor", "userId" } or { "type": "adult", "username" }.');
  if (!isObj(h)) throw bad();
  if (h.type === 'minor' && typeof h.userId === 'string' && isUuid(h.userId)) return { type: 'minor', userId: h.userId.toLowerCase() };
  if (h.type === 'adult' && typeof h.username === 'string' && h.username.trim()) return { type: 'adult', username: h.username.trim().toLowerCase() };
  throw bad();
}
const NO_HOLDER = "We couldn't find a customer you can issue this card to. Check the details.";

async function findCardholder(c, u, account, h) {
  const today = bankToday();
  if (h.type === 'minor') {
    const m = (await c.query(`SELECT u.* FROM users u JOIN family_links f ON f.minor_id = u.id AND f.guardian_id = $2
       JOIN account_owners o ON o.user_id = u.id AND o.account_id = $3 AND o.role = 'minor' WHERE u.id = $1`, [h.userId, u.id, account.id])).rows[0];
    if (!m) throw err(404, 'cardholder_not_found', NO_HOLDER);
    const age = m.date_of_birth ? ageOn(m.date_of_birth, today) : null;
    if (age == null || age < MINOR_AGES[0] || age > MINOR_AGES[1]) throw err(400, 'wrong_age', `A family card for a minor is for ages ${MINOR_AGES[0]} to ${MINOR_AGES[1]}.`);
    return m;
  }
  if (h.username === u.username) throw err(400, 'self_cardholder', "You can't issue a family card to yourself.");
  // unknown and under-18 get the same answer, so the lookup can't tell who banks here or who is a child; profiles with no sign-in can't approve
  const a = (await c.query("SELECT * FROM users WHERE username = $1 AND password_hash <> '!'", [h.username])).rows[0];
  if (!a || (a.date_of_birth && ageOn(a.date_of_birth, today) < 18)) throw err(404, 'cardholder_not_found', NO_HOLDER);
  if ((await c.query('SELECT 1 FROM account_owners WHERE account_id = $1 AND user_id = $2', [account.id, a.id])).rowCount)
    throw err(409, 'already_on_account', 'This person is already on the account. Family cards are for people who are not.');
  return a;
}

// ---------- authorizations (5.8) ----------
function readAuth(b) {
  const amount = b.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AUTH_CENTS)
    throw err(400, 'bad_amount', `Enter amountCents as whole cents from 1 to ${MAX_AUTH_CENTS}.`);
  if (!CHANNELS.includes(b.channel)) throw err(400, 'bad_channel', 'Choose in_store, online or atm.');
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim() : '';
  if (merchant.length < 2 || merchant.length > 60) throw err(400, 'bad_merchant', 'Enter a merchant name of 2 to 60 characters.');
  let category = b.category;
  if (b.channel === 'atm') {
    if (category != null && category !== 'ATM cash') throw err(400, 'bad_category', 'An ATM withdrawal has the category "ATM cash".');
    category = 'ATM cash';
  } else if (typeof category !== 'string' || !isCategory(category)) throw err(400, 'bad_category', 'Choose a merchant category from the list.');
  return { amount: BigInt(amount), channel: b.channel, merchant, category };
}

/** Approved totals today (bank date) for a replacement chain: all channels, and ATM only (R27). */
const usedToday = async (c, chainId, today) => (await c.query(`SELECT coalesce(sum(amount_cents), 0)::bigint AS day,
    coalesce(sum(amount_cents) FILTER (WHERE channel = 'atm'), 0)::bigint AS atm
  FROM family_card_authorizations WHERE chain_id = $1 AND bank_date = $2 AND decision = 'approved'`, [chainId, today])).rows[0];

/** R26: the first reason to decline, or null (before the family controls and the balance, which are checked by the caller). */
async function declineFor(c, k, a, x, cap, today) {
  if (['pending', 'review', 'declined'].includes(k.status)) return 'card_not_active';
  if (k.status === 'canceled') return 'card_canceled';
  if (k.status === 'frozen') return 'card_frozen';
  if (a.status === 'closed') return 'account_closed';
  if (a.status === 'frozen') return 'account_frozen';
  if (a.status !== 'open') return 'account_unavailable';
  if (x.channel === 'online' && !k.online_enabled) return 'online_off';
  if (x.channel !== 'atm' && !allowedSet({ mode: k.category_mode, list: k.category_list }).has(x.category)) return 'category_not_allowed';
  const eff = v => (v != null && BigInt(v) < cap ? BigInt(v) : cap);
  if (x.amount > eff(k.per_txn_cents)) return 'card_transaction_limit';
  const used = await usedToday(c, k.chain_id, today);
  if (BigInt(used.day) + x.amount > eff(k.daily_cents)) return 'card_daily_limit';
  if (x.channel === 'atm' && BigInt(used.atm) + x.amount > eff(k.atm_daily_cents)) return 'card_atm_limit';
  return null;
}

// ---------- routes ----------
export function register(r) {
  // Every route runs its own checks in the order the requirements give, request ids included (lib/app.mjs ownKeys).
  const add = (method, path, fn) => r.add(method, path, { ownKeys: true }, async ({ req, pool, params, body, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if (method !== 'GET') noCardData(body);
    return fn(c, req, u, body, params, query);
  }));

  // 1. the owner asks for a card
  add('POST', '/api/family-cards', async (c, req, u, body) => {
    const key = `${u.id}:${FEATURE}:${requestKey(body)}`, fingerprint = fingerprintOf({}, body);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);              // the same request twice at once: one card
    const prev = (await c.query('SELECT id, request_fingerprint FROM family_cards WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) {
      if (prev.request_fingerprint !== fingerprint) throw conflict();
      return { card: cardView(await loadCard(c, prev.id), u.id), replayed: true };
    }
    if (!FORMS.includes(body.form)) throw err(400, 'bad_form', 'Choose a physical or virtual card.');
    const h = readCardholder(body.cardholder);
    const change = body.controls === undefined ? {} : readControls(body.controls, { allowEmpty: true });
    const controls = merged({ ...DEFAULT_CONTROLS }, change);
    if (typeof body.accountId !== 'string') throw err(400, 'bad_account', 'Choose the account the card spends from.');
    const a = await accountFor(c, u.id, body.accountId, ['owner', 'custodian']);
    const fits = h.type === 'minor' ? a.kind === 'teen_checking' && a.role === 'custodian' : a.kind === 'checking' && a.role === 'owner';
    if (!fits) throw err(400, 'bad_account', h.type === 'minor' ? "A minor's family card spends from their Teen Checking account." : 'A family card for an adult spends from your checking account.');
    const holder = await findCardholder(c, u, a, h);
    usable(await accountOf(c, { account_id: a.id }));
    checkCeiling(change, await ceilingFor(c, u.id, a));
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${FEATURE}:account:${a.id}`]);   // places on the account are counted one request at a time
    if ((await c.query('SELECT 1 FROM family_cards WHERE account_id = $1 AND holder_user_id = $2 AND form = $3 AND status = ANY($4)', [a.id, holder.id, body.form, LIVE])).rowCount)
      throw err(409, 'card_exists', `${holder.display_name} already has a ${body.form} family card on this account.`);
    if ((await c.query('SELECT count(*)::int n FROM family_cards WHERE account_id = $1 AND status = ANY($2)', [a.id, LIVE])).rows[0].n >= MAX_PER_ACCOUNT)
      throw err(422, 'card_limit', `An account can have up to ${MAX_PER_ACCOUNT} family cards. Cancel one first.`);
    const id = newId();
    await c.query(`INSERT INTO family_cards (id, account_id, issuer_user_id, holder_user_id, holder_kind, form, per_txn_cents, daily_cents, atm_daily_cents,
        online_enabled, category_mode, category_list, chain_id, idempotency_key, request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1,$13,$14)`,
      [id, a.id, u.id, holder.id, h.type, body.form, controls.perTransactionCents, controls.dailyCents, controls.atmDailyCents,
        controls.onlineEnabled, controls.categories.mode, controls.categories.list, key, fingerprint]);
    await audit(c, req, u.id, 'familycard.request', { card: id, account: a.id, cardholder: holder.id, kind: h.type, form: body.form });
    return { card: cardView(await loadCard(c, id), u.id), replayed: false };
  });

  // 2. the caller's cards: issued as owner, held as cardholder
  add('GET', '/api/family-cards', async (c, req, u, body, params, query) => {
    if (query.status !== undefined && !STATUSES.includes(query.status)) throw err(400, 'bad_status', `Status must be one of ${STATUSES.join(', ')}.`);
    const list = async col => (await c.query(`${SELECT_CARD} WHERE k.${col} = $1 AND ($2::text IS NULL OR k.status = $2) ORDER BY k.created_at DESC, k.id DESC`,
      [u.id, query.status ?? null])).rows.map(k => cardView(k, u.id));
    return { issued: await list('issuer_user_id'), held: await list('holder_user_id') };
  });

  // 3. one card with its authorizations
  add('GET', '/api/family-cards/:id', async (c, req, u, body, params) => {
    const { card } = await cardFor(c, u, params.id);
    const auths = (await c.query('SELECT * FROM family_card_authorizations WHERE card_id = $1 ORDER BY seq DESC LIMIT 100', [card.id])).rows;
    return { card: cardView(card, u.id), authorizations: auths.map(authView) };
  });

  // 4, 5. the approver: the custodian for a minor (with step-up), the cardholder for an adult (identity check)
  const approver = s => { if (s.card.holder_kind === 'minor' ? !s.isOwner : s.isOwner) throw err(403, 'not_approver', s.card.holder_kind === 'minor' ? 'Only the parent who asked for this card can approve it.' : 'Only the cardholder can confirm this card.'); };
  add('POST', '/api/family-cards/:id/approve', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    approver(s);
    inState(k, ['pending']);
    usable(await accountOf(c, k));
    if (k.holder_kind === 'minor') {
      requireStepUp(u);
      await activate(c, k);
      await audit(c, req, u.id, 'familycard.approve', { card: k.id });
      return { card: cardView(await loadCard(c, k.id), u.id) };
    }
    const id = readIdentity(isObj(body.identity) ? body.identity : {});
    if (ageOn(id.dob, bankToday()) < 18) throw err(400, 'too_young', 'Family cardholders for a checking account must be 18 or older.');
    const sc = await screen(c, u, id);
    if (sc.state === 'approved') { await keepIdentity(c, u.id, id, sc.hash); await activate(c, k); }
    else await c.query('UPDATE family_cards SET status = $2, end_reason = $3 WHERE id = $1', [k.id, sc.state === 'review' ? 'review' : 'declined', sc.state === 'review' ? null : 'identity']);
    await audit(c, req, u.id, { approved: 'familycard.approve', review: 'familycard.review', declined: 'familycard.identity_declined' }[sc.state],
      { card: k.id, state: sc.state, reasons: sc.reasons, ofacHit: sc.ofacHit });
    const said = { approved: 'confirmed their identity. The card is active.', review: 'confirmed their details. We are reviewing them, which can take 2 business days.',
      declined: "tried to confirm their identity, but we couldn't. The card was not issued." }[sc.state];
    await notifyOwner(c, k.issuer_user_id, `family-card:identity:${k.id}`, `Family card ${sc.state === 'approved' ? 'confirmed' : sc.state === 'review' ? 'in review' : 'not issued'}`,
      `${k.holder_name} ${said}`);
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });
  add('POST', '/api/family-cards/:id/decline', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    approver(s);
    inState(k, ['pending']);
    await c.query(`UPDATE family_cards SET status = 'declined', end_reason = 'rejected' WHERE id = $1`, [k.id]);
    await audit(c, req, u.id, 'familycard.decline', { card: k.id });
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });

  // 6. controls: tightening needs nothing, loosening needs step-up, nothing above the owner's ceiling
  add('PUT', '/api/family-cards/:id/controls', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    ownerOnly(s);
    inState(k, LIVE);
    const a = await accountOf(c, k);
    usable(a);
    const change = readControls(body), before = controlsOf(k), after = merged(before, change);
    checkCeiling(change, await ceilingFor(c, u.id, a));
    if (loosens(before, after)) requireStepUp(u);
    await c.query(`UPDATE family_cards SET per_txn_cents = $2, daily_cents = $3, atm_daily_cents = $4, online_enabled = $5, category_mode = $6, category_list = $7 WHERE id = $1`,
      [k.id, after.perTransactionCents, after.dailyCents, after.atmDailyCents, after.onlineEnabled, after.categories.mode, after.categories.list]);
    await audit(c, req, u.id, 'familycard.controls', { card: k.id, before: controlsView(before), after: controlsView(after) });
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });

  // 7, 8. freeze (owner or cardholder, no step-up), unfreeze (owner, step-up)
  add('POST', '/api/family-cards/:id/freeze', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    inState(k, ['active']);
    await c.query(`UPDATE family_cards SET status = 'frozen' WHERE id = $1`, [k.id]);
    await audit(c, req, u.id, 'familycard.freeze', { card: k.id, by: s.isOwner ? 'owner' : 'cardholder' });
    if (!s.isOwner) await notifyOwner(c, k.issuer_user_id, `family-card:freeze:${newId()}`, 'Family card frozen',
      `${k.holder_name} froze the family card ··${k.last4}. You can unfreeze it.`);
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });
  add('POST', '/api/family-cards/:id/unfreeze', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    ownerOnly(s);
    inState(k, ['frozen']);
    usable(await accountOf(c, k));
    requireStepUp(u);
    await c.query(`UPDATE family_cards SET status = 'active' WHERE id = $1`, [k.id]);
    await audit(c, req, u.id, 'familycard.unfreeze', { card: k.id });
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });

  // 9. replace: a new last 4 for the same cardholder, account, form, controls and status; today's totals carry over
  add('POST', '/api/family-cards/:id/replace', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    ownerOnly(s);
    inState(k, ['active', 'frozen']);
    usable(await accountOf(c, k));
    if (!REPLACE_REASONS.includes(body.reason)) throw err(400, 'bad_reason', 'Tell us whether the card was lost, stolen or damaged.');
    requireStepUp(u);
    const id = newId(), v = activation(k.form, k.last4);
    await c.query(`UPDATE family_cards SET status = 'canceled', end_reason = 'replaced' WHERE id = $1`, [k.id]);   // first, so the new card can take its place
    await c.query(`INSERT INTO family_cards (id, account_id, issuer_user_id, holder_user_id, holder_kind, form, status, last4, exp_month, exp_year,
        per_txn_cents, daily_cents, atm_daily_cents, online_enabled, category_mode, category_list, replaces_card_id, chain_id, activated_at)
      SELECT $2, account_id, issuer_user_id, holder_user_id, holder_kind, form, $3, $4, $5, $6,
        per_txn_cents, daily_cents, atm_daily_cents, online_enabled, category_mode, category_list, id, chain_id, now()
      FROM family_cards WHERE id = $1`, [k.id, id, k.status, v.last4, v.expMonth, v.expYear]);
    await c.query('UPDATE family_cards SET replaced_by_card_id = $2 WHERE id = $1', [k.id, id]);
    await audit(c, req, u.id, 'familycard.replace', { card: k.id, newCard: id, reason: body.reason });
    return { card: cardView(await loadCard(c, id), u.id), replaced: cardView(await loadCard(c, k.id), u.id) };
  });

  // 10. cancel for good (it stays in the lists and detail with its authorizations)
  add('POST', '/api/family-cards/:id/cancel', async (c, req, u, body, params) => {
    const s = await cardFor(c, u, params.id, { lock: true }), k = s.card;
    ownerOnly(s);
    inState(k, LIVE);
    await c.query(`UPDATE family_cards SET status = 'canceled', end_reason = 'canceled' WHERE id = $1`, [k.id]);
    await audit(c, req, u.id, 'familycard.cancel', { card: k.id });
    return { card: cardView(await loadCard(c, k.id), u.id) };
  });

  // 11. simulated purchase or ATM withdrawal by the cardholder: approved or declined (HTTP 200 either way)
  add('POST', '/api/family-cards/:id/authorize', async (c, req, u, body, params) => {
    const rid = requestKey(body);
    const s = await cardFor(c, u, params.id);
    if (s.isOwner) throw err(403, 'holder_only', 'Only the cardholder can use the card.');
    const key = `${u.id}:${FEATURE}:auth:${rid}`, fingerprint = fingerprintOf({ id: s.card.id }, body);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);              // the same authorization twice at once: one decision
    const prev = (await c.query('SELECT * FROM family_card_authorizations WHERE idempotency_key = $1', [key])).rows[0];
    if (prev) {
      if (prev.request_fingerprint !== fingerprint) throw conflict();
      return { authorization: authView(prev), replayed: true };
    }
    const x = readAuth(body);
    const k = (await c.query(`${SELECT_CARD} WHERE k.id = $1 FOR UPDATE OF k`, [s.card.id])).rows[0];   // one authorization at a time per card (R32)
    const a = (await c.query('SELECT id, kind, status FROM accounts WHERE id = $1 FOR UPDATE', [k.account_id])).rows[0];
    const today = bankToday(), cap = await ceilingFor(c, k.issuer_user_id, a);
    let reason = await declineFor(c, k, a, x, cap, today), entryId = null;
    if (!reason && a.kind === 'teen_checking') {                       // the parent's family controls (lib/controls.mjs), codes unchanged
      try { await checkMinorSpend(c, a.id, x.amount, x.category, { channel: 'card', req, userId: u.id }); }
      catch (e) { if (e.status !== 422) throw e; reason = e.code; }
    }
    if (!reason) {
      try {
        entryId = (await post(c, { key, kind: 'family_card_purchase', memo: `Family card ··${k.last4} (${k.holder_name})`, createdBy: u.id, lines: [
          { accountId: a.id, amountCents: -x.amount, description: x.channel === 'atm' ? `ATM withdrawal, ${x.merchant}` : x.merchant, category: x.category, postedOn: today },
          { accountId: await systemAccount(c, SETTLEMENT), amountCents: x.amount, description: `${x.merchant} ··${k.last4}`, postedOn: today }] })).entryId;
      } catch (e) { if (e.code !== 'insufficient_funds') throw e; reason = 'insufficient_funds'; }
    }
    const id = newId();
    await c.query(`INSERT INTO family_card_authorizations (id, card_id, chain_id, cardholder_user_id, idempotency_key, request_fingerprint, merchant, category,
        channel, amount_cents, decision, reason_code, entry_id, bank_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, k.id, k.chain_id, u.id, key, fingerprint, x.merchant, x.category, x.channel, x.amount, reason ? 'declined' : 'approved', reason, entryId, today]);
    await audit(c, req, u.id, reason ? 'familycard.auth_declined' : 'familycard.auth_approved', { card: k.id, authorization: id, amountCents: Number(x.amount),   // ok-number: at most MAX_AUTH_CENTS
      merchant: x.merchant, channel: x.channel, ...(reason ? { reasonCode: reason } : {}) });
    const what = x.channel === 'atm' ? 'ATM withdrawal' : 'purchase', card = k.last4 ? `the family card ··${k.last4}` : 'the family card';
    await notifyOwner(c, k.issuer_user_id, `family-card:auth:${id}`, `Family card ${what} ${reason ? 'declined' : 'approved'}`, reason
      ? `${k.holder_name}'s ${what} of ${usd(x.amount)} at ${x.merchant} with ${card} was declined: ${DECLINES[reason] ?? 'A family control said no.'} (${reason})`
      : `${k.holder_name} spent ${usd(x.amount)} at ${x.merchant} with ${card}.`);
    return { authorization: authView((await c.query('SELECT * FROM family_card_authorizations WHERE id = $1', [id])).rows[0]), replayed: false };
  });
}
