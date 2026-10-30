// Family debit cards: requests, approvals, controls and the owner's ceiling, freeze/replace/cancel, authorizations through
// the ledger, notifications, audit and access. Requirement numbers (R1–R36) are in each test's name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn, client } from '../helpers.mjs';
import { randomInt } from 'node:crypto';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { bankToday, addDays, clock } from '../../lib/bank-date.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });

let n = 0;
const key = () => `fc-key-${++n}-${Date.now()}`;
const uid4 = () => newId().slice(0, 8);
const yearsAgo = (y, days = 0) => { const [Y, M, D] = bankToday().split('-'); return addDays(`${Number(Y) - y}-${M}-${D}`, days); };
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const audits = async (action, cardId) => (await env.q("SELECT * FROM audit_events WHERE action = $1 AND detail->>'card' = $2 ORDER BY id", [action, cardId])).rows;
const alerts = async c => (await c.get('/api/alerts')).body.items.filter(i => i.kind === 'family_card');
const viewOnly = (acct, mode = 'view_only') => env.q(`INSERT INTO family_controls (account_id, mode, daily_limit_cents, weekly_limit_cents) VALUES ($1,$2,5000,15000)
  ON CONFLICT (account_id) DO UPDATE SET mode = $2`, [acct, mode]);
const noStepUp = uid => env.q('UPDATE sessions SET stepup_at = NULL WHERE user_id = $1', [uid]);
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, code, JSON.stringify(r.body)); assert.ok(r.body.message); };

/** A customer with no one-time code at sign-in (so no step-up until they ask for one). */
async function person(name, { dob = '1985-05-05' } = {}) {
  const username = `${name.toLowerCase()}.${uid4()}@family-cards.test`, id = newId();
  await env.q(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2, date_of_birth) VALUES ($1,$2,$3,$4,false,'55',$5)`,
    [id, username, name, await hashPassword('pw-' + name), dob]);
  return { id, username, name, c: await signIn(env.base, username, 'pw-' + name) };
}
async function account(kind, owners, funds = 1_000_00n) {
  const id = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,$2,$3,'4321')`, [id, kind, kind === 'teen_checking' ? 'Teen Checking' : 'Smart Checking']);
    for (const [u, role] of owners) await c.query('INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,$3)', [id, u.id, role]);
    if (funds) await post(c, { key: `test:fund:${id}`, kind: 'seed', lines: [{ accountId: id, amountCents: funds, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -funds, description: 'Opening deposit' }] });
  });
  return id;
}
/** A parent with a checking account, a teen (15) on a Teen Checking account they are custodian of, and an adult friend. */
async function family({ teenFunds = 300_00n, checkingFunds = 1_000_00n } = {}) {
  const owner = await person('Riley'), teen = await person('Sam', { dob: yearsAgo(15) }), adult = await person('Jordan');
  await env.q(`INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent')`, [owner.id, teen.id]);
  const checking = await account('checking', [[owner, 'owner']], checkingFunds);
  const teenAcct = await account('teen_checking', [[owner, 'custodian'], [teen, 'minor']], teenFunds);
  return { owner, teen, adult, checking, teenAcct };
}
const minorReq = (f, extra = {}) => f.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: f.teenAcct, form: 'physical', cardholder: { type: 'minor', userId: f.teen.id }, ...extra });
const adultReq = (f, extra = {}) => f.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: f.checking, form: 'virtual', cardholder: { type: 'adult', username: f.adult.username }, ...extra });
const VALID_ID = (name, ssn) => ({ legalName: name, dob: '1985-05-05', line1: '123 Main Street', line2: '', city: 'Austin', state: 'TX', zip: '78701', ssn });
let ssnN = 0;                                                     // a different valid SSN each time (area 201 and up, never 666)
const freshSsn = () => `${201 + (++ssnN)}${10 + randomInt(89)}${1000 + randomInt(8999)}`;
/** An active card for the teen (approved by the stepped-up owner). */
async function activeMinorCard(f, extra) {
  const r = await minorReq(f, extra); assert.equal(r.status, 200, JSON.stringify(r.body));
  await stepUp(f.owner.c);
  const a = await f.owner.c.post(`/api/family-cards/${r.body.card.id}/approve`, {}); assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body.card;
}
async function activeAdultCard(f, extra) {
  const r = await adultReq(f, extra); assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await f.adult.c.post(`/api/family-cards/${r.body.card.id}/approve`, { identity: VALID_ID('Jordan Reyes', freshSsn()) });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.card.status, 'active', JSON.stringify(a.body));
  return a.body.card;
}
const buy = (c, cardId, b = {}) => c.post(`/api/family-cards/${cardId}/authorize`, { idempotencyKey: key(), merchant: 'Corner Cafe', category: 'Food & Dining', channel: 'in_store', amountCents: 1250, ...b });

// ---------- access ----------
test('R1: every endpoint is 401 signed_out without a session', async () => {
  const c = client(env.base), id = newId();
  const calls = [['POST', '/api/family-cards'], ['GET', '/api/family-cards'], ['GET', `/api/family-cards/${id}`], ['POST', `/api/family-cards/${id}/approve`],
    ['POST', `/api/family-cards/${id}/decline`], ['PUT', `/api/family-cards/${id}/controls`], ['POST', `/api/family-cards/${id}/freeze`],
    ['POST', `/api/family-cards/${id}/unfreeze`], ['POST', `/api/family-cards/${id}/replace`], ['POST', `/api/family-cards/${id}/cancel`],
    ['POST', `/api/family-cards/${id}/authorize`]];
  for (const [m, p] of calls) err(await c.call(m, p, m === 'GET' ? undefined : { pan: '4111111111111111', idempotencyKey: key() }), 401, 'signed_out');
});

test('R2, R3: strangers get 404 on every card route, roles get 403, and nothing changes', async () => {
  const f = await family(), stranger = await person('Morgan');
  const card = await activeMinorCard(f);
  const before = (await env.q('SELECT * FROM family_cards WHERE id = $1', [card.id])).rows[0];
  await stepUp(stranger.c);
  for (const id of [card.id, newId(), 'not-a-uuid', '123']) {
    err(await stranger.c.get(`/api/family-cards/${id}`), 404, 'not_found');
    for (const [p, b] of [['approve', {}], ['decline', {}], ['freeze', {}], ['unfreeze', {}], ['replace', { reason: 'lost' }], ['cancel', {}]])
      err(await stranger.c.post(`/api/family-cards/${id}/${p}`, b), 404, 'not_found');
    err(await stranger.c.call('PUT', `/api/family-cards/${id}/controls`, { dailyCents: 100 }), 404, 'not_found');
    err(await buy(stranger.c, id), 404, 'not_found');
  }
  assert.deepEqual((await env.q('SELECT * FROM family_cards WHERE id = $1', [card.id])).rows[0], before);
  const list = (await stranger.c.get('/api/family-cards')).body;
  assert.deepEqual(list, { issued: [], held: [] });
  // the cardholder can't do the owner's things; the owner can't spend
  await stepUp(f.teen.c);
  err(await f.teen.c.call('PUT', `/api/family-cards/${card.id}/controls`, { dailyCents: 100 }), 403, 'issuer_only');
  err(await f.teen.c.post(`/api/family-cards/${card.id}/replace`, { reason: 'lost' }), 403, 'issuer_only');
  err(await f.teen.c.post(`/api/family-cards/${card.id}/cancel`, {}), 403, 'issuer_only');
  err(await buy(f.owner.c, card.id), 403, 'holder_only');
  assert.equal((await f.teen.c.post(`/api/family-cards/${card.id}/freeze`, {})).body.card.status, 'frozen');
  err(await f.teen.c.post(`/api/family-cards/${card.id}/unfreeze`, {}), 403, 'issuer_only');
  // the approver of a minor's card is the owner; of an adult's card, the cardholder
  const p1 = (await minorReq(f, { form: 'virtual' })).body.card;
  err(await f.teen.c.post(`/api/family-cards/${p1.id}/approve`, {}), 403, 'not_approver');
  err(await f.teen.c.post(`/api/family-cards/${p1.id}/decline`, {}), 403, 'not_approver');
  const p2 = (await adultReq(f)).body.card;
  err(await f.owner.c.post(`/api/family-cards/${p2.id}/approve`, { identity: VALID_ID('Jordan Reyes', freshSsn()) }), 403, 'not_approver');
  err(await f.owner.c.post(`/api/family-cards/${p2.id}/decline`, {}), 403, 'not_approver');
});

// ---------- requesting ----------
test('R4: a custodian asks for a card for their teen: pending, in both lists and detail, no ledger entry', async () => {
  const f = await family();
  const entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const r = await minorReq(f, { controls: { dailyCents: 4000 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, false);
  const k = r.body.card;
  assert.deepEqual({ ...k, id: null, createdAt: null }, {
    id: null, accountId: f.teenAcct, issuerUserId: f.owner.id, cardholder: { userId: f.teen.id, name: 'Sam', kind: 'minor' }, form: 'physical',
    status: 'pending', endReason: null, brand: null, last4: null, expMonth: null, expYear: null,
    controls: { perTransactionCents: null, dailyCents: 4000, atmDailyCents: null, onlineEnabled: true, categories: { mode: 'any', list: [] } },
    replacesCardId: null, replacedByCardId: null, createdAt: null, activatedAt: null });
  assert.ok(!isNaN(Date.parse(k.createdAt)));
  assert.deepEqual((await f.owner.c.get('/api/family-cards')).body.issued.map(x => x.id), [k.id]);
  const held = (await f.teen.c.get('/api/family-cards')).body.held;
  assert.deepEqual(held.map(x => x.id), [k.id]); assert.equal(held[0].accountId, null);
  const d = await f.teen.c.get(`/api/family-cards/${k.id}`);
  assert.equal(d.status, 200); assert.deepEqual(d.body.authorizations, []); assert.equal(d.body.card.accountId, null);
  assert.equal((await f.owner.c.get(`/api/family-cards/${k.id}`)).body.card.accountId, f.teenAcct);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  const [ev] = await audits('familycard.request', k.id);
  assert.equal(ev.user_id, f.owner.id); assert.equal(ev.detail.account, f.teenAcct); assert.equal(ev.detail.cardholder, f.teen.id);
});

test('R5: an adult cardholder gains no access to the account, before or after the card is active', async () => {
  const f = await family();
  const r = await adultReq(f);
  assert.equal(r.status, 200);
  assert.equal(r.body.card.cardholder.kind, 'adult'); assert.equal(r.body.card.cardholder.name, 'Jordan');
  const check = async () => {
    assert.ok(!(await f.adult.c.get('/api/me')).body.accounts.some(a => a.id === f.checking));
    err(await f.adult.c.get(`/api/accounts/${f.checking}/transactions`), 404, 'not_found');
  };
  await check();
  assert.deepEqual((await f.adult.c.get('/api/family-cards')).body.held.map(x => x.id), [r.body.card.id]);
  // username matched trimmed and ignoring case
  const again = await f.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: f.checking, form: 'physical', cardholder: { type: 'adult', username: `  ${f.adult.username.toUpperCase()} ` } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await f.adult.c.post(`/api/family-cards/${r.body.card.id}/approve`, { identity: VALID_ID('Jordan Reyes', freshSsn()) });
  await check();
  assert.equal((await env.q('SELECT count(*)::int n FROM account_owners WHERE user_id = $1', [f.adult.id])).rows[0].n, 0);
});

test('R6, R7, R8, R9: request validation, in the documented order, creating nothing', async () => {
  const f = await family(), other = await person('Casey');
  const otherAcct = await account('checking', [[other, 'owner']]);
  const count = async () => (await env.q('SELECT count(*)::int n FROM family_cards WHERE issuer_user_id = $1', [f.owner.id])).rows[0].n;
  const base = { accountId: f.checking, form: 'virtual', cardholder: { type: 'adult', username: f.adult.username } };
  const req = b => f.owner.c.post('/api/family-cards', { idempotencyKey: key(), ...base, ...b });
  err(await req({ form: 'plastic' }), 400, 'bad_form');
  err(await req({ form: undefined }), 400, 'bad_form');
  for (const h of [null, 'x', [], { type: 'kid', userId: f.teen.id }, { type: 'minor', userId: 'abc' }, { type: 'minor', userId: 5 }, { type: 'adult', username: '  ' }, { type: 'adult' }])
    err(await req({ cardholder: h }), 400, 'bad_cardholder');
  for (const ctl of [{ dailyCents: '4000' }, { dailyCents: 1.5 }, { dailyCents: 0 }, { atmDailyCents: -1 }, { nope: 1 }, { onlineEnabled: 'yes' },
    { categories: { mode: 'some' } }, { categories: { mode: 'allow', list: ['Snacks'] } }, { categories: { mode: 'any', list: ['Travel'] } },
    { dailyCents: 100, perTransactionCents: 101 }, { dailyCents: 100, atmDailyCents: 101 }, [], 'x'])
    err(await req({ controls: ctl }), 400, 'bad_controls');
  err(await req({ accountId: undefined }), 400, 'bad_account');
  err(await req({ accountId: 42 }), 400, 'bad_account');
  for (const a of ['nope', newId(), otherAcct]) err(await req({ accountId: a }), 404, 'not_found');
  // a joint owner or viewer of an account can't issue on it
  const jointAcct = await account('checking', [[other, 'owner'], [f.owner, 'joint_owner']]);
  const viewAcct = await account('checking', [[other, 'owner'], [f.owner, 'viewer']]);
  err(await req({ accountId: jointAcct }), 404, 'not_found');
  err(await req({ accountId: viewAcct }), 404, 'not_found');
  err(await req({ accountId: f.teenAcct }), 400, 'bad_account');                                                  // adult on teen checking
  err(await req({ cardholder: { type: 'minor', userId: f.teen.id } }), 400, 'bad_account');                     // minor on checking
  const savings = await account('savings', [[f.owner, 'owner']]);
  err(await req({ accountId: savings }), 400, 'bad_account');
  // R7: minors
  const mreq = b => req({ accountId: f.teenAcct, cardholder: { type: 'minor', userId: f.teen.id }, ...b });
  err(await mreq({ cardholder: { type: 'minor', userId: newId() } }), 404, 'cardholder_not_found');
  const unlinked = await person('Drew', { dob: yearsAgo(14) });
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [f.teenAcct, unlinked.id]);
  err(await mreq({ cardholder: { type: 'minor', userId: unlinked.id } }), 404, 'cardholder_not_found');           // not linked to the owner
  const otherTeen = await person('Lee', { dob: yearsAgo(14) });
  await env.q(`INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent')`, [f.owner.id, otherTeen.id]);
  err(await mreq({ cardholder: { type: 'minor', userId: otherTeen.id } }), 404, 'cardholder_not_found');          // not a minor on this account
  for (const dob of [yearsAgo(13, 1), yearsAgo(18), null]) {                                                       // 12 (13 tomorrow), 18 today, no date of birth
    const m = await person('Kid', { dob });
    await env.q(`INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent')`, [f.owner.id, m.id]);
    await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [f.teenAcct, m.id]);
    err(await mreq({ cardholder: { type: 'minor', userId: m.id } }), 400, 'wrong_age');
  }
  for (const dob of [yearsAgo(13), yearsAgo(18, 1)]) {                                                              // 13 today, 17 (18 tomorrow): fine
    const m = await person('Teen', { dob });
    await env.q(`INSERT INTO family_links (guardian_id, minor_id, relationship) VALUES ($1,$2,'parent')`, [f.owner.id, m.id]);
    await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'minor')", [f.teenAcct, m.id]);
    assert.equal((await mreq({ cardholder: { type: 'minor', userId: m.id } })).status, 200);
  }
  // R8: adults
  const minorUser = await person('Pat', { dob: yearsAgo(17) }), noDob = await person('Quinn', { dob: null });
  const a1 = await req({ cardholder: { type: 'adult', username: 'nobody@family-cards.test' } }), a2 = await req({ cardholder: { type: 'adult', username: minorUser.username } });
  err(a1, 404, 'cardholder_not_found'); err(a2, 404, 'cardholder_not_found'); assert.equal(a1.body.message, a2.body.message);
  err(await req({ cardholder: { type: 'adult', username: f.owner.username } }), 400, 'self_cardholder');
  const co = await person('Avery');
  await env.q("INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'viewer')", [f.checking, co.id]);
  err(await req({ cardholder: { type: 'adult', username: co.username } }), 409, 'already_on_account');
  assert.equal((await req({ cardholder: { type: 'adult', username: noDob.username } })).status, 200);              // no date of birth: an adult
  // the order: bad_form before bad_cardholder before bad_controls before bad_account
  err(await req({ form: 'x', cardholder: null, controls: { x: 1 }, accountId: 1 }), 400, 'bad_form');
  err(await req({ cardholder: null, controls: { x: 1 }, accountId: 1 }), 400, 'bad_cardholder');
  err(await req({ controls: { x: 1 }, accountId: 1 }), 400, 'bad_controls');
  assert.equal(await count(), 3);
});

test('R9, R24: account status and view-only mode refuse a request; R19: initial controls above the ceiling', async () => {
  const f = await family();
  await viewOnly(f.teenAcct);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [f.teenAcct]);
  err(await minorReq(f), 409, 'view_only');                                                                        // view_only before account_not_open
  await viewOnly(f.teenAcct, 'managed');
  err(await minorReq(f), 409, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [f.teenAcct]);
  err(await minorReq(f, { controls: { dailyCents: 5001 } }), 422, 'over_owner_limit');                           // family daily limit $50
  assert.equal((await minorReq(f, { controls: { dailyCents: 5000 } })).status, 200);                               // equal is fine
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [f.checking]);
  err(await adultReq(f), 409, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [f.checking]);
  // the owner's own internal daily limit is the ceiling on checking
  await stepUp(f.owner.c);
  assert.equal((await f.owner.c.call('PUT', '/api/pay/limits/internal', { daily: '100.00', monthly: '1000.00' })).status, 200);
  err(await adultReq(f, { controls: { perTransactionCents: 10001 } }), 422, 'over_owner_limit');
  const ok = await adultReq(f, { controls: { perTransactionCents: 10000, dailyCents: 10000, atmDailyCents: 0, onlineEnabled: false, categories: { mode: 'deny', list: ['Gaming', 'Gaming', 'ATM cash'] } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.card.controls, { perTransactionCents: 10000, dailyCents: 10000, atmDailyCents: 0, onlineEnabled: false, categories: { mode: 'deny', list: ['ATM cash', 'Gaming'] } });
});

test('R10: one live card per holder and form, five per account, also under simultaneous requests', async () => {
  const f = await family();
  const first = (await adultReq(f, { form: 'virtual' })).body.card;
  err(await adultReq(f, { form: 'virtual' }), 409, 'card_exists');
  assert.equal((await adultReq(f, { form: 'physical' })).status, 200);
  await f.owner.c.post(`/api/family-cards/${first.id}/cancel`, {});
  assert.equal((await adultReq(f, { form: 'virtual' })).status, 200);                                             // canceling frees the place
  // 7 people at once on a fresh account: exactly 5 cards (the account already has none)
  const g = await family(), people = [];
  for (let i = 0; i < 7; i++) people.push(await person(`P${i}`));
  const rs = await Promise.all(people.map(p => g.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: g.checking, form: 'virtual', cardholder: { type: 'adult', username: p.username } })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 200, 200, 200, 200, 422, 422], JSON.stringify(rs.map(r => r.body.error)));
  assert.ok(rs.filter(r => r.status === 422).every(r => r.body.error === 'card_limit'));
  assert.equal((await env.q("SELECT count(*)::int n FROM family_cards WHERE account_id = $1", [g.checking])).rows[0].n, 5);
  // card_exists comes before card_limit; declining frees a place
  err(await g.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: g.checking, form: 'virtual', cardholder: { type: 'adult', username: people.find((p, i) => rs[i].status === 200).username } }), 409, 'card_exists');
  const pending = rs.find(r => r.status === 200).body.card, holder = people.find(p => p.id === pending.cardholder.userId);
  assert.equal((await holder.c.post(`/api/family-cards/${pending.id}/decline`, {})).body.card.endReason, 'rejected');
  const late = people.find((p, i) => rs[i].status === 422);
  assert.equal((await g.owner.c.post('/api/family-cards', { idempotencyKey: key(), accountId: g.checking, form: 'virtual', cardholder: { type: 'adult', username: late.username } })).status, 200);
});

test('R11: request ids: replay returns the card as it is now, a different request is refused, keys are per owner, races make one card', async () => {
  const f = await family(), g = await family();
  const k = key(), body = { idempotencyKey: k, accountId: f.checking, form: 'virtual', cardholder: { type: 'adult', username: f.adult.username } };
  const first = await f.owner.c.post('/api/family-cards', body);
  await f.owner.c.post(`/api/family-cards/${first.body.card.id}/cancel`, {});
  const again = await f.owner.c.post('/api/family-cards', body);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(again.body.card.id, first.body.card.id); assert.equal(again.body.card.status, 'canceled');
  err(await f.owner.c.post('/api/family-cards', { ...body, form: 'physical' }), 422, 'idempotency_conflict');
  for (const bad of [undefined, 'short', 'has space!!', 'x'.repeat(101), {}, ['abcdefgh']])
    err(await f.owner.c.post('/api/family-cards', { ...body, idempotencyKey: bad }), 400, 'idempotency_key_required');
  // another owner with the same key string gets their own card
  const theirs = await g.owner.c.post('/api/family-cards', { ...body, accountId: g.checking, cardholder: { type: 'adult', username: g.adult.username } });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.replayed, false); assert.notEqual(theirs.body.card.id, first.body.card.id);
  // two identical requests at the same moment
  const k2 = key(), b2 = { idempotencyKey: k2, accountId: f.teenAcct, form: 'virtual', cardholder: { type: 'minor', userId: f.teen.id } };
  const rs = await Promise.all([f.owner.c.post('/api/family-cards', b2), f.owner.c.post('/api/family-cards', b2), f.owner.c.post('/api/family-cards', b2)]);
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
  assert.equal(new Set(rs.map(r => r.body.card.id)).size, 1);
  assert.deepEqual(rs.map(r => r.body.replayed).sort(), [false, true, true]);
  // a refused request does not use up the id
  const k3 = key();
  err(await f.owner.c.post('/api/family-cards', { idempotencyKey: k3, accountId: f.checking, form: 'bad', cardholder: body.cardholder }), 400, 'bad_form');
  assert.equal((await f.owner.c.post('/api/family-cards', { idempotencyKey: k3, accountId: f.checking, form: 'physical', cardholder: body.cardholder })).status, 200);
  assert.equal((await audits('familycard.request', first.body.card.id)).length, 1);
});

test('R12: card numbers and security codes are refused anywhere in any write body, before anything else', async () => {
  const f = await family(), card = await activeMinorCard(f);
  const names = ['pan', 'cardNumber', 'card_number', 'CARD-NUMBER', 'number', 'cvv', 'CVV2', 'cvc', 'cvc_2', 'securityCode', 'security_code'];
  for (const nm of names) {
    err(await minorReq(f, { extra: { deep: [{ [nm]: '4111111111111111' }] } }), 400, 'card_data_not_accepted');
    err(await f.owner.c.post('/api/family-cards', { [nm]: '1' }), 400, 'card_data_not_accepted');                 // before idempotency_key_required
  }
  for (const [m, p] of [['POST', 'approve'], ['POST', 'decline'], ['PUT', 'controls'], ['POST', 'freeze'], ['POST', 'unfreeze'], ['POST', 'replace'], ['POST', 'cancel']])
    err(await f.owner.c.call(m, `/api/family-cards/${card.id}/${p}`, { reason: 'lost', dailyCents: 10, x: { cvv: '123' } }), 400, 'card_data_not_accepted');
  err(await buy(f.teen.c, card.id, { cardNumber: '4111' }), 400, 'card_data_not_accepted');
  assert.equal((await f.owner.c.get(`/api/family-cards/${card.id}`)).body.card.status, 'active');
  // nothing in the card's row, its view or the schema looks like a full number or a security code
  const cols = (await env.q("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE 'family_card%'", [env.schema])).rows.map(r => r.column_name);
  assert.ok(!cols.some(c => /pan|number|cvv|cvc|security/.test(c)), cols.join());
  assert.deepEqual(Object.keys((await f.owner.c.get(`/api/family-cards/${card.id}`)).body.card).filter(x => /pan|number|cvv|cvc|security/i.test(x)), []);
});

// ---------- approving ----------
test('R14, R17: a minor\'s card needs the custodian\'s step-up; activation values; states and order', async () => {
  const f = await family();
  const k = (await minorReq(f)).body.card;
  await noStepUp(f.owner.id);
  err(await f.owner.c.post(`/api/family-cards/${k.id}/approve`, {}), 403, 'stepup_required');
  assert.equal((await f.owner.c.get(`/api/family-cards/${k.id}`)).body.card.status, 'pending');
  await viewOnly(f.teenAcct);
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [f.teenAcct]);
  err(await f.owner.c.post(`/api/family-cards/${k.id}/approve`, {}), 409, 'view_only');
  await viewOnly(f.teenAcct, 'managed');
  err(await f.owner.c.post(`/api/family-cards/${k.id}/approve`, {}), 409, 'account_not_open');
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [f.teenAcct]);
  await stepUp(f.owner.c);
  const a = (await f.owner.c.post(`/api/family-cards/${k.id}/approve`, {})).body.card;
  const [y, m] = bankToday().split('-').map(Number);
  assert.equal(a.status, 'active'); assert.equal(a.brand, 'USA Banc Debit'); assert.match(a.last4, /^\d{4}$/);
  assert.equal(a.expMonth, m); assert.equal(a.expYear, y + 4); assert.ok(a.activatedAt);
  err(await f.owner.c.post(`/api/family-cards/${k.id}/approve`, {}), 409, 'invalid_state');
  err(await f.owner.c.post(`/api/family-cards/${k.id}/decline`, {}), 409, 'invalid_state');
  assert.equal((await audits('familycard.approve', k.id))[0].user_id, f.owner.id);
  const v = (await minorReq(f, { form: 'virtual' })).body.card;
  assert.equal((await f.owner.c.post(`/api/family-cards/${v.id}/approve`, {})).body.card.expYear, y + 2);
});

test('R15: an adult cardholder confirms their identity: approved, review or declined; validation; no SSN anywhere', async () => {
  const f = await family();
  const k = (await adultReq(f, { form: 'physical' })).body.card;
  const id = b => f.adult.c.post(`/api/family-cards/${k.id}/approve`, { identity: b });
  const ssn = freshSsn();
  err(await f.adult.c.post(`/api/family-cards/${k.id}/approve`, {}), 400, 'bad_name');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), legalName: '1' }), 400, 'bad_name');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), dob: '2026-02-30' }), 400, 'bad_date');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), dob: '2999-01-01' }), 400, 'bad_dob');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), zip: '7' }), 400, 'bad_address');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), ssn: '000123456' }), 400, 'bad_ssn');
  err(await id({ ...VALID_ID('Jordan Reyes', ssn), dob: yearsAgo(17) }), 400, 'too_young');
  assert.equal((await f.owner.c.get(`/api/family-cards/${k.id}`)).body.card.status, 'pending');
  await noStepUp(f.adult.id);
  const ok = await id(VALID_ID('Jordan Reyes', ssn));                                                              // no step-up needed
  assert.equal(ok.status, 200); assert.equal(ok.body.card.status, 'active'); assert.equal(ok.body.card.accountId, null);
  const [y] = bankToday().split('-').map(Number);
  assert.equal(ok.body.card.expYear, y + 4);
  assert.equal((await env.q('SELECT ssn_last4 FROM customer_identities WHERE user_id = $1', [f.adult.id])).rows[0].ssn_last4, ssn.slice(5));
  assert.equal((await audits('familycard.approve', k.id))[0].user_id, f.adult.id);
  // review (a name on the simulated watch list) and declined (TEST DECLINE)
  const g = await family();
  const r1 = (await adultReq(g, { form: 'physical' })).body.card, r2 = (await adultReq(g, { form: 'virtual' })).body.card;
  const rev = await g.adult.c.post(`/api/family-cards/${r1.id}/approve`, { identity: VALID_ID('Jordan Test Ofac', freshSsn()) });
  assert.equal(rev.status, 200); assert.equal(rev.body.card.status, 'review'); assert.equal(rev.body.card.endReason, null);
  const dec = await g.adult.c.post(`/api/family-cards/${r2.id}/approve`, { identity: VALID_ID('Jordan Test Decline', freshSsn()) });
  assert.equal(dec.status, 200); assert.equal(dec.body.card.status, 'declined'); assert.equal(dec.body.card.endReason, 'identity');
  assert.equal((await audits('familycard.review', r1.id)).length, 1);
  assert.equal((await audits('familycard.identity_declined', r2.id)).length, 1);
  // the owner hears each outcome; nothing holds the SSN
  const notes = await alerts(g.owner.c);
  assert.equal(notes.length, 2); assert.ok(notes.every(x => x.body.includes('Jordan')));
  assert.deepEqual(await alerts(g.adult.c), []);
  const dump = JSON.stringify([(await env.q("SELECT detail FROM audit_events WHERE action LIKE 'familycard.%'")).rows, (await env.q('SELECT * FROM notifications')).rows, ok.body, rev.body, dec.body], (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  assert.ok(!dump.includes(ssn), 'the full SSN leaked');
});

test('R16: the approver can refuse a pending request, even when the account is not open', async () => {
  const f = await family();
  const k = (await minorReq(f)).body.card;
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [f.teenAcct]);
  await noStepUp(f.owner.id);
  const d = await f.owner.c.post(`/api/family-cards/${k.id}/decline`, {});
  assert.equal(d.status, 200); assert.equal(d.body.card.status, 'declined'); assert.equal(d.body.card.endReason, 'rejected');
  assert.equal((await audits('familycard.decline', k.id)).length, 1);
  err(await f.owner.c.post(`/api/family-cards/${k.id}/decline`, {}), 409, 'invalid_state');
  const a = (await adultReq(f)).body.card;
  assert.equal((await f.adult.c.post(`/api/family-cards/${a.id}/decline`, {})).body.card.endReason, 'rejected');
});

// ---------- controls ----------
test('R18: controls validation, partial updates, sorted lists, states', async () => {
  const f = await family(), card = await activeAdultCard(f);
  const put = b => f.owner.c.call('PUT', `/api/family-cards/${card.id}/controls`, b);
  for (const b of [{}, { nope: 1 }, { idempotencyKey: key(), dailyCents: 10 }, { dailyCents: '10' }, { dailyCents: 0 }, { perTransactionCents: 0 }, { atmDailyCents: -5 },
    { dailyCents: 2.5 }, { onlineEnabled: 1 }, { categories: { mode: 'allow', list: ['Nope'] } }, { categories: { mode: 'any', list: ['Travel'] } },
    { categories: { mode: 'none' } }, { categories: { mode: 'allow', list: 'Travel' } }, { categories: null }])
    err(await put(b), 400, 'bad_controls');
  const r = await put({ dailyCents: 5000, categories: { mode: 'allow', list: ['Travel', 'Groceries', 'Travel', 'ATM cash'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.card.controls, { perTransactionCents: null, dailyCents: 5000, atmDailyCents: null, onlineEnabled: true, categories: { mode: 'allow', list: ['ATM cash', 'Groceries', 'Travel'] } });
  err(await put({ perTransactionCents: 5001 }), 400, 'bad_controls');                                              // above the stored daily limit
  err(await put({ atmDailyCents: 5001 }), 400, 'bad_controls');
  assert.equal((await put({ atmDailyCents: 0, perTransactionCents: 5000 })).body.card.controls.atmDailyCents, 0);
  const [ev] = (await audits('familycard.controls', card.id)).slice(-1);
  assert.equal(ev.detail.before.perTransactionCents, null); assert.equal(ev.detail.after.perTransactionCents, 5000);
  // states and the R24 order
  await env.q("UPDATE accounts SET status = 'frozen' WHERE id = $1", [f.checking]);
  err(await put({ nope: 1 }), 409, 'account_not_open');                                                            // account before validation
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [f.checking]);
  await f.owner.c.post(`/api/family-cards/${card.id}/cancel`, {});
  err(await put({ dailyCents: 10 }), 409, 'invalid_state');
  const d = (await adultReq(f, { form: 'physical' })).body.card;
  await f.adult.c.post(`/api/family-cards/${d.id}/decline`, {});
  err(await f.owner.c.call('PUT', `/api/family-cards/${d.id}/controls`, { dailyCents: 10 }), 409, 'invalid_state');
  const p = (await adultReq(f, { form: 'virtual' })).body.card;                                                    // pending works
  assert.equal((await f.owner.c.call('PUT', `/api/family-cards/${p.id}/controls`, { dailyCents: 10 })).status, 200);
});

test('R19, R20: the ceiling, and step-up only for loosening', async () => {
  const f = await family(), card = await minorReq(f).then(r => r.body.card);
  const put = b => f.owner.c.call('PUT', `/api/family-cards/${card.id}/controls`, b);
  await noStepUp(f.owner.id);
  err(await put({ dailyCents: 5001 }), 422, 'over_owner_limit');                                                  // family daily limit $50 (default)
  assert.equal((await put({ dailyCents: 5000 })).status, 200);                                                     // null -> number: tightening, equal to the ceiling
  assert.equal((await put({ dailyCents: 4000, onlineEnabled: false, categories: { mode: 'deny', list: ['Gaming'] } })).status, 200);
  assert.equal((await put({ dailyCents: 4000 })).status, 200);                                                     // nothing changes
  for (const b of [{ dailyCents: 4001 }, { dailyCents: null }, { onlineEnabled: true }, { categories: { mode: 'any' } },
    { categories: { mode: 'deny', list: [] } }, { categories: { mode: 'allow', list: ['Gaming'] } }, { dailyCents: 100, onlineEnabled: true }])
    err(await put(b), 403, 'stepup_required');
  assert.equal((await put({ categories: { mode: 'allow', list: ['Groceries'] } })).status, 200);                  // a smaller allowed set
  assert.equal((await put({ categories: { mode: 'deny', list: ['Gaming'] } })).status, 403);
  const now = (await f.owner.c.get(`/api/family-cards/${card.id}`)).body.card.controls;
  assert.deepEqual(now, { perTransactionCents: null, dailyCents: 4000, atmDailyCents: null, onlineEnabled: false, categories: { mode: 'allow', list: ['Groceries'] } });
  await stepUp(f.owner.c);
  assert.equal((await put({ dailyCents: null, onlineEnabled: true, categories: { mode: 'any' } })).status, 200);
  // lowering the family daily limit lowers what may be set
  await f.owner.c.post(`/api/family/${f.teenAcct}/controls`, { dailyLimit: '20.00', weeklyLimit: '150.00' });
  err(await put({ perTransactionCents: 2001 }), 422, 'over_owner_limit');
  // over_owner_limit comes before step-up, and bad_controls before both
  await noStepUp(f.owner.id);
  err(await put({ atmDailyCents: 99999 }), 422, 'over_owner_limit');
  err(await put({ atmDailyCents: 99999, x: 1 }), 400, 'bad_controls');
  // the owner's own internal limit on checking
  const g = await family(), a = await activeAdultCard(g);
  await stepUp(g.owner.c);
  await g.owner.c.call('PUT', '/api/pay/limits/internal', { daily: '75.00', monthly: '500.00' });
  err(await g.owner.c.call('PUT', `/api/family-cards/${a.id}/controls`, { dailyCents: 7501 }), 422, 'over_owner_limit');
  assert.equal((await g.owner.c.call('PUT', `/api/family-cards/${a.id}/controls`, { dailyCents: 7500 })).status, 200);
});

// ---------- freeze, replace, cancel ----------
test('R21, R33: freeze by either side, unfreeze by the owner with step-up; the owner hears when the cardholder freezes', async () => {
  const f = await family(), card = await activeMinorCard(f);
  await noStepUp(f.teen.id);
  assert.equal((await f.teen.c.post(`/api/family-cards/${card.id}/freeze`, {})).body.card.status, 'frozen');
  err(await f.teen.c.post(`/api/family-cards/${card.id}/freeze`, {}), 409, 'invalid_state');
  const notes = await alerts(f.owner.c);
  assert.equal(notes.length, 1); assert.match(notes[0].body, /Sam/);
  assert.deepEqual(await alerts(f.teen.c), []);
  await noStepUp(f.owner.id);
  err(await f.owner.c.post(`/api/family-cards/${card.id}/unfreeze`, {}), 403, 'stepup_required');
  assert.equal((await f.owner.c.get(`/api/family-cards/${card.id}`)).body.card.status, 'frozen');
  await stepUp(f.owner.c);
  assert.equal((await f.owner.c.post(`/api/family-cards/${card.id}/unfreeze`, {})).body.card.status, 'active');
  err(await f.owner.c.post(`/api/family-cards/${card.id}/unfreeze`, {}), 409, 'invalid_state');
  await noStepUp(f.owner.id);
  assert.equal((await f.owner.c.post(`/api/family-cards/${card.id}/freeze`, {})).body.card.status, 'frozen');   // the owner freezing: no notification
  assert.equal((await alerts(f.owner.c)).length, 1);
  // view-only mode: unfreeze refused, freeze and reads still work
  await viewOnly(f.teenAcct);
  await stepUp(f.owner.c);
  err(await f.owner.c.post(`/api/family-cards/${card.id}/unfreeze`, {}), 409, 'view_only');
  assert.equal((await f.owner.c.get('/api/family-cards')).status, 200);
  assert.equal((await audits('familycard.freeze', card.id)).length, 2);
  assert.equal((await audits('familycard.unfreeze', card.id)).length, 1);
});

test('R22, R27: replace keeps holder, controls, status and today\'s totals; new last 4; needs step-up', async () => {
  const f = await family(), card = await activeAdultCard(f, { controls: { dailyCents: 3000 } });
  assert.equal((await buy(f.adult.c, card.id, { amountCents: 2000 })).body.authorization.decision, 'approved');
  await f.adult.c.post(`/api/family-cards/${card.id}/freeze`, {});
  await noStepUp(f.owner.id);
  err(await f.owner.c.post(`/api/family-cards/${card.id}/replace`, { reason: 'lost' }), 403, 'stepup_required');
  await stepUp(f.owner.c);
  err(await f.owner.c.post(`/api/family-cards/${card.id}/replace`, { reason: 'bored' }), 400, 'bad_reason');
  const r = await f.owner.c.post(`/api/family-cards/${card.id}/replace`, { reason: 'stolen' });
  assert.equal(r.status, 200);
  const { card: nw, replaced: old } = r.body;
  assert.equal(old.status, 'canceled'); assert.equal(old.endReason, 'replaced'); assert.equal(old.replacedByCardId, nw.id);
  assert.equal(nw.status, 'frozen'); assert.equal(nw.replacesCardId, card.id); assert.notEqual(nw.last4, card.last4);
  assert.deepEqual(nw.controls, card.controls); assert.equal(nw.form, card.form); assert.deepEqual(nw.cardholder, card.cardholder);
  assert.equal(nw.accountId, f.checking); assert.equal(nw.brand, 'USA Banc Debit'); assert.ok(nw.activatedAt);
  err(await f.owner.c.post(`/api/family-cards/${card.id}/replace`, { reason: 'lost' }), 409, 'invalid_state');
  assert.equal((await audits('familycard.replace', card.id))[0].detail.newCard, nw.id);
  await f.owner.c.post(`/api/family-cards/${nw.id}/unfreeze`, {});
  const d = await buy(f.adult.c, nw.id, { amountCents: 1001 });
  assert.equal(d.body.authorization.reasonCode, 'card_daily_limit');                                               // 2000 already used today
  assert.equal((await buy(f.adult.c, nw.id, { amountCents: 1000 })).body.authorization.decision, 'approved');
  assert.equal((await buy(f.adult.c, card.id, { amountCents: 1 })).body.authorization.reasonCode, 'card_canceled');
  // a replacement of a replacement keeps the chain
  const r2 = (await f.owner.c.post(`/api/family-cards/${nw.id}/replace`, { reason: 'damaged' })).body.card;
  assert.equal(r2.status, 'active');
  assert.equal((await buy(f.adult.c, r2.id, { amountCents: 1 })).body.authorization.reasonCode, 'card_daily_limit');
  const pend = (await adultReq(f, { form: 'physical' })).body.card;
  err(await f.owner.c.post(`/api/family-cards/${pend.id}/replace`, { reason: 'lost' }), 409, 'invalid_state');
});

test('R23, R24: cancel from any live status; canceled cards stay readable; closed accounts', async () => {
  const f = await family();
  const p = (await adultReq(f, { form: 'physical' })).body.card, a = await activeMinorCard(f);
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [f.teenAcct]);
  await stepUp(f.owner.c);
  err(await f.owner.c.call('PUT', `/api/family-cards/${a.id}/controls`, { dailyCents: 10 }), 409, 'account_not_open');
  err(await f.owner.c.post(`/api/family-cards/${a.id}/replace`, { reason: 'lost' }), 409, 'account_not_open');
  assert.equal((await buy(f.teen.c, a.id)).body.authorization.reasonCode, 'account_closed');
  assert.equal((await f.teen.c.post(`/api/family-cards/${a.id}/freeze`, {})).body.card.status, 'frozen');
  err(await f.owner.c.post(`/api/family-cards/${a.id}/unfreeze`, {}), 409, 'account_not_open');
  await noStepUp(f.owner.id);
  for (const k of [p, a]) {
    const r = await f.owner.c.post(`/api/family-cards/${k.id}/cancel`, {});
    assert.equal(r.status, 200); assert.equal(r.body.card.status, 'canceled'); assert.equal(r.body.card.endReason, 'canceled');
    err(await f.owner.c.post(`/api/family-cards/${k.id}/cancel`, {}), 409, 'invalid_state');
    err(await f.owner.c.post(`/api/family-cards/${k.id}/freeze`, {}), 409, 'invalid_state');
  }
  const d = (await f.owner.c.get(`/api/family-cards/${a.id}`)).body;
  assert.equal(d.authorizations.length, 1);
  assert.deepEqual((await f.owner.c.get('/api/family-cards?status=canceled')).body.issued.map(x => x.id).sort(), [p.id, a.id].sort());
  assert.deepEqual((await f.owner.c.get('/api/family-cards?status=active')).body.issued, []);
  err(await f.owner.c.get('/api/family-cards?status=gone'), 400, 'bad_status');
});

// ---------- authorizations ----------
test('R25, R33, R34, R35: an approved authorization posts one balanced entry and is seen by both sides', async () => {
  const f = await family(), card = await activeAdultCard(f);
  const before = await bal(f.checking), k = key();
  const r = await f.adult.c.post(`/api/family-cards/${card.id}/authorize`, { idempotencyKey: k, merchant: '  Corner Cafe ', category: 'Food & Dining', channel: 'in_store', amountCents: 1250 });
  assert.equal(r.status, 200);
  const a = r.body.authorization;
  assert.equal(r.body.replayed, false);
  assert.deepEqual({ ...a, id: null, entryId: null, createdAt: null }, { id: null, cardId: card.id, cardholderUserId: f.adult.id, merchant: 'Corner Cafe',
    category: 'Food & Dining', channel: 'in_store', amountCents: 1250, decision: 'approved', reasonCode: null, entryId: null, createdAt: null });
  assert.equal(await bal(f.checking), before - 1250n);
  const e = (await env.q('SELECT * FROM journal_entries WHERE id = $1', [a.entryId])).rows[0];
  assert.equal(e.kind, 'family_card_purchase'); assert.equal(e.memo, `Family card ··${card.last4} (Jordan)`);
  assert.equal(e.created_by, f.adult.id); assert.equal(e.idempotency_key, `${f.adult.id}:family-cards:auth:${k}`);
  const lines = (await env.q('SELECT l.*, a.system_code FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = $1 ORDER BY amount_cents', [a.entryId])).rows;
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].account_id, lines[0].amount_cents, lines[0].description, lines[0].category, lines[0].posted_on], [f.checking, -1250n, 'Corner Cafe', 'Food & Dining', bankToday()]);
  assert.deepEqual([lines[1].system_code, lines[1].amount_cents, lines[1].description, lines[1].posted_on], ['card_network_settlement', 1250n, `Corner Cafe ··${card.last4}`, bankToday()]);
  // ATM
  const atm = (await buy(f.adult.c, card.id, { merchant: 'Main St ATM', channel: 'atm', category: undefined, amountCents: 2000 })).body.authorization;
  assert.equal(atm.category, 'ATM cash');
  const al = (await env.q('SELECT * FROM ledger_lines WHERE entry_id = $1 AND account_id = $2', [atm.entryId, f.checking])).rows[0];
  assert.equal(al.description, 'ATM withdrawal, Main St ATM'); assert.equal(al.category, 'ATM cash');
  // both sides see it; the owner sees the posting
  for (const c of [f.owner.c, f.adult.c]) assert.deepEqual((await c.get(`/api/family-cards/${card.id}`)).body.authorizations.map(x => x.id), [atm.id, a.id]);
  assert.ok((await f.owner.c.get(`/api/accounts/${f.checking}/transactions`)).body.transactions.some(t => t.description === 'Corner Cafe' && t.amount === '-12.50'));
  // a decline posts nothing
  const entries = (await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
  const d = (await buy(f.adult.c, card.id, { amountCents: 500_000 })).body.authorization;
  assert.equal(d.decision, 'declined'); assert.equal(d.reasonCode, 'insufficient_funds'); assert.equal(d.entryId, null);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries')).rows[0].n, entries);
  // notifications: owner only, approved and declined with name, merchant and code
  const notes = await alerts(f.owner.c);
  assert.equal(notes.length, 4);                                                                                    // identity outcome + 3 decisions
  const dn = notes.find(x => /declined/.test(x.title));
  assert.match(dn.body, /Jordan/); assert.match(dn.body, /Corner Cafe/); assert.match(dn.body, /insufficient_funds/);
  assert.ok(notes.some(x => /approved/.test(x.title) && x.body.includes('Jordan') && x.body.includes('Corner Cafe')));
  assert.deepEqual(await alerts(f.adult.c), []);
  // audit
  const [ap] = await audits('familycard.auth_approved', card.id), [dc] = await audits('familycard.auth_declined', card.id);
  assert.equal(ap.user_id, f.adult.id); assert.equal(ap.detail.authorization, a.id); assert.equal(ap.detail.amountCents, 1250); assert.equal(ap.detail.merchant, 'Corner Cafe'); assert.equal(ap.detail.channel, 'in_store');
  assert.equal(dc.detail.reasonCode, 'insufficient_funds');
  // R35: balances equal their lines, entries balance, money out equals money in
  const sums = (await env.q(`SELECT (SELECT sum(amount_cents)::bigint FROM ledger_lines WHERE account_id = $1) lines, (SELECT balance_cents FROM accounts WHERE id = $1) bal`, [f.checking])).rows[0];
  assert.equal(sums.lines, sums.bal);
  const bad = (await env.q(`SELECT e.id FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id WHERE e.kind = 'family_card_purchase' GROUP BY e.id HAVING sum(l.amount_cents) <> 0 OR count(*) <> 2`)).rows;
  assert.deepEqual(bad, []);
  const flows = (await env.q(`SELECT (sum(l.amount_cents) FILTER (WHERE a.system_code = 'card_network_settlement'))::bigint inn, (sum(l.amount_cents) FILTER (WHERE a.system_code IS NULL))::bigint out
    FROM journal_entries e JOIN ledger_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id WHERE e.kind = 'family_card_purchase'`)).rows[0];
  assert.equal(flows.inn, -flows.out);
});

test('R26: each reason code', async () => {
  const f = await family({ checkingFunds: 100_00n });
  const card = await activeAdultCard(f, { controls: { perTransactionCents: 3000, dailyCents: 5000, atmDailyCents: 1500, onlineEnabled: false, categories: { mode: 'allow', list: ['Food & Dining', 'Groceries'] } } });
  const why = async b => { const r = await buy(f.adult.c, card.id, b); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.authorization.reasonCode; };
  assert.equal(await why({ channel: 'online', amountCents: 1 }), 'online_off');
  assert.equal(await why({ category: 'Gaming', amountCents: 1 }), 'category_not_allowed');
  assert.equal(await why({ channel: 'atm', category: 'ATM cash', amountCents: 100 }), null);                       // categories don't apply to ATM
  assert.equal(await why({ amountCents: 3001 }), 'card_transaction_limit');
  assert.equal(await why({ amountCents: 3000 }), null);                                                            // equal to the limit
  assert.equal(await why({ amountCents: 1901 }), 'card_daily_limit');                                              // 3100 + 1901 > 5000
  assert.equal(await why({ channel: 'atm', amountCents: 1401, category: undefined }), 'card_atm_limit');           // 100 + 1401 > 1500
  assert.equal(await why({ channel: 'atm', amountCents: 1400, category: undefined }), null);                       // exactly 1500 ATM, 4500 day
  // insufficient funds: the account never goes below zero
  await env.q("UPDATE family_cards SET daily_cents = NULL, per_txn_cents = NULL WHERE id = $1", [card.id]);
  assert.equal(await why({ amountCents: 5501 }), 'insufficient_funds');
  assert.equal(await bal(f.checking), 5500n);
  assert.equal(await why({ amountCents: 5500 }), null);
  assert.equal(await bal(f.checking), 0n);
  // account and card statuses come first
  for (const [st, code] of [['frozen', 'account_frozen'], ['pending', 'account_unavailable'], ['closed', 'account_closed']]) {
    await env.q('UPDATE accounts SET status = $2 WHERE id = $1', [f.checking, st]);
    assert.equal(await why({ channel: 'online', amountCents: 1 }), code);
  }
  await env.q("UPDATE accounts SET status = 'open' WHERE id = $1", [f.checking]);
  await f.adult.c.post(`/api/family-cards/${card.id}/freeze`, {});
  await env.q("UPDATE accounts SET status = 'closed' WHERE id = $1", [f.checking]);
  assert.equal(await why({ amountCents: 1 }), 'card_frozen');
  const g = await family(), p = (await adultReq(g)).body.card;
  assert.equal((await buy(g.adult.c, p.id)).body.authorization.reasonCode, 'card_not_active');
  await g.owner.c.post(`/api/family-cards/${p.id}/cancel`, {});
  assert.equal((await buy(g.adult.c, p.id)).body.authorization.reasonCode, 'card_canceled');
});

test('R26, R28, R29: a teen card: the ceiling and the family controls apply, and the card spends count as the teen\'s', async () => {
  const f = await family({ teenFunds: 500_00n }), card = await activeMinorCard(f);                                 // family limits: $50/day, $150/7 days
  const why = async b => (await buy(f.teen.c, card.id, b)).body.authorization.reasonCode;
  assert.equal(await why({ amountCents: 5001 }), 'card_transaction_limit');                                        // no card limit: the ceiling ($50) applies
  assert.equal(await why({ amountCents: 3000 }), null);
  // the teen's other spending counts towards the family daily limit
  await f.teen.c.post(`/api/family/${f.teenAcct}/purchase`, { idempotencyKey: key(), amount: '15.00', merchant: 'Snack Bar', category: 'Food & Dining' });
  assert.equal(await why({ amountCents: 501 }), 'daily_limit');                                                    // 3000 + 1500 + 501 > 5000 (family)
  // the parent's freeze flag and categories turned off
  await env.q("UPDATE family_controls SET held_categories = '{Gaming}' WHERE account_id = $1", [f.teenAcct]);
  assert.equal(await why({ category: 'Gaming', amountCents: 100 }), 'category_off');
  await env.q("UPDATE family_controls SET card_frozen = true WHERE account_id = $1", [f.teenAcct]);
  assert.equal(await why({ amountCents: 100 }), 'card_frozen');
  // $10 the teen spent yesterday counts for the 7 days, not for today
  await tx(env.pool, async c => post(c, { key: `test:yesterday:${f.teenAcct}`, kind: 'card_purchase', createdBy: f.teen.id, lines: [
    { accountId: f.teenAcct, amountCents: -1000n, description: 'Yesterday', category: 'Shopping', postedOn: addDays(bankToday(), -1) },
    { accountId: await systemAccount(c, 'card_network_settlement'), amountCents: 1000n, description: 'Yesterday', postedOn: addDays(bankToday(), -1) }] }));
  await env.q("UPDATE family_controls SET card_frozen = false, daily_limit_cents = 6500, weekly_limit_cents = 6500 WHERE account_id = $1", [f.teenAcct]);
  assert.equal(await why({ amountCents: 1600 }), 'weekly_limit');                                                  // today 6100 ≤ 6500, 7 days 7100 > 6500
  // lowering the ceiling below a stored card limit: decided with the lower ceiling, the stored limit is kept
  await env.q("UPDATE family_controls SET daily_limit_cents = 100000, weekly_limit_cents = 200000 WHERE account_id = $1", [f.teenAcct]);
  await stepUp(f.owner.c);
  assert.equal((await f.owner.c.call('PUT', `/api/family-cards/${card.id}/controls`, { perTransactionCents: 9000 })).status, 200);
  await f.owner.c.call('PUT', '/api/pay/limits/internal', { daily: '60.00', monthly: '500.00' });
  assert.equal(await why({ amountCents: 6001 }), 'card_transaction_limit');
  assert.equal(await why({ amountCents: 1600 }), null);                                                            // 3000 + 1600 = 4600 today
  assert.equal(await why({ amountCents: 1401 }), 'card_daily_limit');                                              // 4600 + 1401 > 6000 (ceiling)
  assert.equal((await f.owner.c.get(`/api/family-cards/${card.id}`)).body.card.controls.perTransactionCents, 9000);
  // approved card spending shows as the teen's in the family view
  const spentRow = (await env.q(`SELECT coalesce(sum(-l.amount_cents), 0)::bigint s FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND e.kind = 'family_card_purchase' AND e.created_by = $2`, [f.teenAcct, f.teen.id])).rows[0].s;
  assert.equal(spentRow, 4600n);
});

test('R27: daily totals start again on the next bank day', async () => {
  const f = await family(), card = await activeAdultCard(f, { controls: { dailyCents: 1000 } });
  assert.equal((await buy(f.adult.c, card.id, { amountCents: 1000 })).body.authorization.decision, 'approved');
  assert.equal((await buy(f.adult.c, card.id, { amountCents: 1 })).body.authorization.reasonCode, 'card_daily_limit');
  const real = clock.now;
  try {
    clock.now = () => new Date(real().getTime() + 24 * 3600_000);
    assert.equal((await buy(f.adult.c, card.id, { amountCents: 1000 })).body.authorization.decision, 'approved');
    const posted = (await env.q(`SELECT l.posted_on FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.kind = 'family_card_purchase' AND l.account_id = $1 ORDER BY l.id DESC LIMIT 1`, [f.checking])).rows[0].posted_on;
    assert.equal(posted, bankToday());
  } finally { clock.now = real; }
});

test('R30, R31: authorization fields, the check order and request ids', async () => {
  const f = await family(), card = await activeAdultCard(f);
  const bad = async (b, code) => err(await buy(f.adult.c, card.id, b), 400, code);
  for (const v of [0, -1, 1.5, '100', 10_000_001, null]) await bad({ amountCents: v }, 'bad_amount');
  await bad({ channel: 'contactless' }, 'bad_channel');
  for (const m of ['x', ' y ', 'x'.repeat(61), 42, null]) await bad({ merchant: m }, 'bad_merchant');
  for (const c of ['Snacks', null, undefined]) await bad({ category: c }, 'bad_category');
  await bad({ channel: 'atm', category: 'Food & Dining' }, 'bad_category');
  await bad({ idempotencyKey: 'short' }, 'idempotency_key_required');
  await bad({ amountCents: 0, channel: 'x', merchant: '', category: 'x' }, 'bad_amount');
  assert.equal((await env.q('SELECT count(*)::int n FROM family_card_authorizations WHERE card_id = $1', [card.id])).rows[0].n, 0);
  assert.equal((await buy(f.adult.c, card.id, { merchant: 'x'.repeat(60) })).body.authorization.merchant, 'x'.repeat(60));
  // replay returns the first decision even when it would now be decided differently
  const k = key(), b = { idempotencyKey: k, merchant: 'Book Nook', category: 'Shopping', channel: 'online', amountCents: 700 };
  const first = await f.adult.c.post(`/api/family-cards/${card.id}/authorize`, b);
  await f.adult.c.post(`/api/family-cards/${card.id}/freeze`, {});
  const counts = async () => (await env.q(`SELECT (SELECT count(*) FROM journal_entries) e, (SELECT count(*) FROM audit_events WHERE action LIKE 'familycard.auth%') a, (SELECT count(*) FROM notifications) n`)).rows[0];
  const c0 = await counts();
  const again = await f.adult.c.post(`/api/family-cards/${card.id}/authorize`, b);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.deepEqual(again.body.authorization, first.body.authorization);
  assert.deepEqual(await counts(), c0);
  err(await f.adult.c.post(`/api/family-cards/${card.id}/authorize`, { ...b, amountCents: 701 }), 422, 'idempotency_conflict');
  // the order: 404 and holder_only before the replay, replay before field checks
  err(await f.owner.c.post(`/api/family-cards/${card.id}/authorize`, b), 403, 'holder_only');
  err(await f.adult.c.post(`/api/family-cards/${newId()}/authorize`, b), 404, 'not_found');
  err(await f.adult.c.post(`/api/family-cards/${card.id}/authorize`, { ...b, amountCents: 'x' }), 422, 'idempotency_conflict');
  // keys belong to the cardholder: the owner holding a card of their own with the same key string is separate
  const g = await family(), gc = await activeAdultCard(g);
  const theirs = await g.adult.c.post(`/api/family-cards/${gc.id}/authorize`, b);
  assert.equal(theirs.body.replayed, false); assert.equal(theirs.body.authorization.decision, 'approved');
});

test('R31, R32: simultaneous authorizations: one decision per key, limits and balance hold', async () => {
  const f = await family({ checkingFunds: 100_00n }), card = await activeAdultCard(f, { controls: { dailyCents: 6000, atmDailyCents: 3000 } });
  const k = key(), b = { idempotencyKey: k, merchant: 'Corner Cafe', category: 'Food & Dining', channel: 'in_store', amountCents: 500 };
  const same = await Promise.all(Array.from({ length: 6 }, () => f.adult.c.post(`/api/family-cards/${card.id}/authorize`, b)));
  assert.ok(same.every(r => r.status === 200));
  assert.equal(new Set(same.map(r => r.body.authorization.id)).size, 1);
  assert.equal((await env.q('SELECT count(*)::int n FROM journal_entries WHERE idempotency_key = $1', [`${f.adult.id}:family-cards:auth:${k}`])).rows[0].n, 1);
  const atm = await Promise.all(Array.from({ length: 8 }, () => buy(f.adult.c, card.id, { channel: 'atm', category: undefined, amountCents: 700 })));
  assert.equal(atm.filter(r => r.body.authorization.decision === 'approved').length, 4);                           // 4 × 700 = 2800 ≤ 3000
  const day = await Promise.all(Array.from({ length: 10 }, () => buy(f.adult.c, card.id, { amountCents: 900 })));
  assert.equal(day.filter(r => r.body.authorization.decision === 'approved').length, 3);                           // 500 + 2800 + 3 × 900 = 6000
  const used = (await env.q("SELECT sum(amount_cents)::bigint s FROM family_card_authorizations WHERE card_id = $1 AND decision = 'approved'", [card.id])).rows[0].s;
  assert.equal(used, 6000n);
  assert.equal(await bal(f.checking), 4000n);
  // the balance holds too
  const g = await family({ checkingFunds: 20_00n }), gc = await activeAdultCard(g);
  const rs = await Promise.all(Array.from({ length: 8 }, () => buy(g.adult.c, gc.id, { amountCents: 600 })));
  assert.equal(rs.filter(r => r.body.authorization.decision === 'approved').length, 3);
  assert.equal(await bal(g.checking), 200n);
});

test('R36: existing cards are untouched', async () => {
  const f = await family();
  const snap = async () => [(await f.owner.c.get('/api/cards')).body, (await f.teen.c.get('/api/cards')).body, (await f.adult.c.get('/api/cards')).body,
    (await env.q('SELECT * FROM cards ORDER BY id')).rows];
  const before = await snap();
  const k = await activeMinorCard(f), a = await activeAdultCard(f);
  await f.teen.c.post(`/api/family-cards/${k.id}/freeze`, {});
  await stepUp(f.owner.c);
  await f.owner.c.post(`/api/family-cards/${k.id}/replace`, { reason: 'lost' });
  await f.owner.c.post(`/api/family-cards/${a.id}/cancel`, {});
  await buy(f.adult.c, a.id);
  assert.deepEqual(await snap(), before);
});
