// Cards (M6): decisions, issuing, payments, autopay, purchases, controls, disputes, rewards and access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, signIn } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { minimumDue, monthlyInterest, luhnValid } from '../../lib/cards.mjs';
import { bankToday, addDays } from '../../lib/bank-date.mjs';
const T = () => `'${bankToday()}'::date`;                       // the bank date the server uses (Central Time)

let env, nizam, jordan;
before(async () => {
  env = await testEnv();
  nizam = await signIn(env.base, 'nizam@helixbots.ai', 'nizam');
  jordan = await signIn(env.base, 'jordan@usabanc.example', 'jordan-demo-pass');
});
after(async () => { await env.close(); });

let n = 0;
const key = () => `test-key-${++n}-${Date.now()}`;
const bal = async id => (await env.q('SELECT balance_cents FROM accounts WHERE id = $1', [id])).rows[0].balance_cents;
const audits = async action => (await env.q('SELECT * FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows;
async function stepUp(c) {
  const s = await c.post('/api/stepup');
  assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200);
}
/** A fresh customer (mfa off) with a funded checking account. */
async function customer(name, { dob = null, funds = 5_000_00n } = {}) {
  const username = `${name.toLowerCase()}@cards.test`, uid = newId(), chk = newId();
  await tx(env.pool, async c => {
    await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2, date_of_birth) VALUES ($1,$2,$3,$4,false,'55',$5)`,
      [uid, username, name, await hashPassword('pw-' + name), dob]);
    await c.query(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Smart Checking','1234')`, [chk]);
    await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [chk, uid]);
    await post(c, { key: `test:fund:${username}`, kind: 'seed', lines: [{ accountId: chk, amountCents: funds, description: 'Opening deposit' },
      { accountId: await systemAccount(c, 'equity'), amountCents: -funds, description: 'Opening deposit' }] });
  });
  return { c: await signIn(env.base, username, 'pw-' + name), uid, chk, username };
}
const apply = (c, b) => c.post('/api/cards/applications', { idempotencyKey: key(), income: '90000', housing: '1500', ...b });
const nizamCard = async () => (await nizam.get('/api/cards')).body.credit.find(x => x.last4 === '0088');
const nizamDebit = async () => (await nizam.get('/api/cards')).body.debit.find(x => x.account.last4 === '4471');

test('seed: debit cards on checking and teen accounts, Cash+ ··0088 with terms, a statement and rewards', async () => {
  const r = await nizam.get('/api/cards');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.debit.map(d => d.account.last4).sort(), ['4471', '5120']);
  assert.ok(r.body.debit.every(d => /^•••• •••• •••• \d{4}$/.test(d.masked)));
  assert.equal(r.body.debit.find(d => d.account.last4 === '5120').holder, 'Ava');
  const cc = r.body.credit[0];
  assert.equal(cc.last4, '0088'); assert.equal(cc.creditLimit, '2500.00'); assert.equal(cc.owed, '418.20'); assert.equal(cc.available, '2081.80');
  assert.equal(cc.card.last4, '0088');
  const d = (await nizam.get(`/api/cards/credit/${cc.id}`)).body;
  assert.equal(d.statement.balance, '259.71');                       // closed before the later purchases
  assert.equal(d.statement.minimumDue, '35.00');
  assert.equal(d.statement.dueDate, d.account.paymentDue);
  assert.equal(d.rewards.balance, '8.35');                            // 2% of 259.71 + 68.50 + 89.99, each rounded down
  const s = (await nizam.get(`/api/cards/credit/${cc.id}/statements/${d.statement.id}`)).body;
  assert.deepEqual(s.transactions.map(t => t.description), ['Skyway Airlines']);
  // running the seed again adds nothing
  const before = (await env.q('SELECT (SELECT count(*) FROM cards) k, (SELECT count(*) FROM card_statements) s, (SELECT count(*) FROM card_rewards) r')).rows[0];
  await tx(env.pool, async c => (await import('../../lib/seeds/cards.mjs')).seed(c));
  assert.deepEqual((await env.q('SELECT (SELECT count(*) FROM cards) k, (SELECT count(*) FROM card_statements) s, (SELECT count(*) FROM card_rewards) r')).rows[0], before);
});

test('the lineup is data: four cards, each with an APR range, an annual fee and an intro offer', async () => {
  const r = await nizam.get('/api/cards/products');
  assert.deepEqual(r.body.products.map(p => p.kind), ['cash_back', 'travel', 'secured', 'student']);
  for (const p of r.body.products) { assert.match(p.aprMin, /^\d+\.\d\d$/); assert.match(p.annualFee, /^\d+\.\d\d$/); assert.ok(p.introOffer.length > 10); }
  assert.equal(r.body.products.find(p => p.code === 'voyager').annualFee, '95.00');
  assert.equal(r.body.products.find(p => p.code === 'secured').depositMin, '300.00');
});

// Cards used to score from a hash of the username (lib/cards.mjs baseScore); they now use the /app/credit score (R7).
test('the card score is the credit-file score: the same every time, and a "score" + 3 digits username scores that', async () => {
  const { c } = await customer('kim+score705');
  assert.equal((await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' })).body.score, 705);
  assert.equal((await c.get('/api/credit')).body.score, 705);
  assert.equal((await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' })).body.score, 705);
});

test('prequalify is a soft check: no score change; applying is a hard check that lowers it', async () => {
  const { c } = await customer('pq+score780');
  const a = await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' });
  assert.equal(a.status, 200); assert.equal(a.body.check, 'soft'); assert.equal(a.body.score, 780);
  assert.equal(a.body.offers.find(o => o.productCode === 'cash_plus').result, 'likely');
  assert.equal((await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' })).body.score, 780);
  await stepUp(c);
  assert.equal((await apply(c, { productCode: 'campus' })).status, 200);
  // the hard check lowers the score by the inquiry factor (−5) and never raises it: the new card counts toward card use
  // only once its first statement reports (lib/loans-credit/credit.mjs inputsFor), the same score /app/credit shows
  const after = (await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' })).body.score;
  assert.equal(after, 775); assert.ok(after <= 780, `a hard pull raised the score to ${after}`);
  const credit = (await c.get('/api/credit')).body;
  assert.equal(credit.factors.find(f => f.key === 'inquiries').impact, -5); assert.equal(credit.score, after);
  assert.equal((await audits('cards.prequalify')).length >= 3, true);
});

test('applying needs a fresh one-time code', async () => {
  const { c } = await customer('su+score780');
  const r = await apply(c, { productCode: 'cash_plus' });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
});

test('approve: a limit and APR from the score tier, an owned card account and a masked card', async () => {
  const { c, uid } = await customer('ok+score780');
  await stepUp(c);
  const k = key();
  const r = await c.post('/api/cards/applications', { idempotencyKey: k, productCode: 'cash_plus', income: '90000', housing: '1500' });
  assert.equal(r.status, 200);
  const a = r.body.application;
  assert.equal(a.decision, 'approve'); assert.equal(a.check, 'hard');
  assert.equal(a.offer.creditLimit, '9000.00');                        // tier allows $10,000; 10% of $90,000 income caps it
  assert.equal(a.offer.apr, '19.24');
  assert.ok(a.accountId);
  assert.equal((await env.q('SELECT role FROM account_owners WHERE account_id = $1 AND user_id = $2', [a.accountId, uid])).rows[0].role, 'owner');
  const acct = (await env.q('SELECT * FROM accounts WHERE id = $1', [a.accountId])).rows[0];
  assert.equal(acct.kind, 'credit_card'); assert.equal(acct.credit_limit_cents, 900000n);
  const card = (await env.q('SELECT * FROM cards WHERE account_id = $1', [a.accountId])).rows[0];
  assert.equal(card.last4, acct.number_last4); assert.match(card.pan_token, /^tok_/);
  // the same submit again returns the same decision, with no second hard check
  const again = await c.post('/api/cards/applications', { idempotencyKey: k, productCode: 'cash_plus', income: '90000', housing: '1500' });
  assert.equal(again.body.application.id, a.id); assert.equal(again.body.replayed, true);
  const audit = (await audits('cards.decision')).find(e => e.detail.applicationId === a.id);
  assert.equal(audit.detail.decision, 'approve'); assert.ok(audit.detail.reasons.length);
  assert.ok((await audits('cards.issue')).some(e => e.detail.accountId === a.accountId && e.detail.creditLimit === '9000.00'));
});

test('a travel card charges its annual fee through the ledger', async () => {
  const { c } = await customer('fee+score790');
  await stepUp(c);
  const a = (await apply(c, { productCode: 'voyager' })).body.application;
  assert.equal(a.decision, 'approve');
  assert.equal(await bal(a.accountId), -9500n);
});

test('decline with plain-words reasons: a DECLINE name always declines; a low score declines', async () => {
  const d1 = await customer('dee+DECLINE');
  await stepUp(d1.c);
  const r1 = (await apply(d1.c, { productCode: 'secured', deposit: '300', fromAccountId: d1.chk })).body.application;
  assert.equal(r1.decision, 'decline'); assert.equal(r1.accountId, null); assert.equal(r1.offer, null);
  assert.equal(r1.reasons[0].code, 'file_flag'); assert.match(r1.reasons[0].text, /late payment|collection/);
  assert.equal(await bal(d1.chk), 5_000_00n);                          // no deposit taken
  const d2 = await customer('lo+score500');
  await stepUp(d2.c);
  const r2 = (await apply(d2.c, { productCode: 'cash_plus', income: '5000', housing: '0' })).body.application;
  assert.equal(r2.decision, 'decline');
  assert.deepEqual(r2.reasons.map(x => x.code), ['score_floor', 'income_min']);
  assert.ok(r2.reasons.every(x => /^[A-Z].+\.$/.test(x.text)));
  const audit = (await audits('cards.decision')).find(e => e.detail.applicationId === r2.id);
  assert.deepEqual(audit.detail.reasons.map(x => x.code), ['score_floor', 'income_min']);
});

test('counteroffer: the secured card when the score is short; the deposit becomes the limit', async () => {
  const { c, chk } = await customer('mid+score640');
  await stepUp(c);
  const a = (await apply(c, { productCode: 'cash_plus' })).body.application;
  assert.equal(a.decision, 'counteroffer'); assert.equal(a.offer.productCode, 'secured'); assert.equal(a.accountId, null);
  assert.equal(a.reasons[0].code, 'score_for_product'); assert.match(a.reasons[0].text, /640/);
  assert.equal((await c.post(`/api/cards/applications/${a.id}/accept`, { deposit: '100', fromAccountId: chk })).body.error, 'bad_amount');
  const ok = await c.post(`/api/cards/applications/${a.id}/accept`, { deposit: '500', fromAccountId: chk });
  assert.equal(ok.status, 200);
  const acct = (await env.q('SELECT * FROM accounts WHERE id = $1', [ok.body.application.accountId])).rows[0];
  assert.equal(acct.credit_limit_cents, 50000n);
  assert.equal(await bal(chk), 4_500_00n);
  assert.equal((await env.q('SELECT security_deposit_cents FROM credit_accounts WHERE account_id = $1', [acct.id])).rows[0].security_deposit_cents, 50000n);
  // accepting twice issues once
  const again = await c.post(`/api/cards/applications/${a.id}/accept`, { deposit: '500', fromAccountId: chk });
  assert.equal(again.body.application.accountId, acct.id); assert.equal(await bal(chk), 4_500_00n);
});

test('counteroffer: a lower limit when the ask is too high or housing takes a large share', async () => {
  const { c } = await customer('hi+score780');
  await stepUp(c);
  const a = (await apply(c, { productCode: 'cash_plus', requestedLimit: '20000' })).body.application;
  assert.equal(a.decision, 'counteroffer'); assert.equal(a.offer.productCode, 'cash_plus'); assert.equal(a.offer.creditLimit, '9000.00');
  assert.equal(a.reasons[0].code, 'requested_limit');
  const b = (await apply(c, { productCode: 'cash_plus', income: '60000', housing: '2250' })).body.application;   // 45% of income
  assert.equal(b.decision, 'counteroffer'); assert.equal(b.offer.creditLimit, '3000.00');                        // half of $6,000
  const ok = await c.post(`/api/cards/applications/${b.id}/accept`, {});
  assert.equal(ok.status, 200);
  assert.equal((await env.q('SELECT credit_limit_cents FROM accounts WHERE id = $1', [ok.body.application.accountId])).rows[0].credit_limit_cents, 300000n);
  assert.equal((await c.post(`/api/cards/applications/${b.id}/accept`, {})).body.application.accountId, ok.body.application.accountId);
});

test('a minor cannot prequalify or apply for credit', async () => {
  const ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  const p = await ava.post('/api/cards/prequalify', { income: '1000', housing: '0' });
  assert.equal(p.status, 403); assert.equal(p.body.error, 'minor');
  await stepUp(ava);
  const a = await apply(ava, { productCode: 'campus' });
  assert.equal(a.status, 403); assert.equal(a.body.error, 'minor');
  assert.equal((await ava.get('/api/cards')).body.canApply, false);
  assert.equal((await env.q("SELECT count(*)::int n FROM credit_applications a JOIN users u ON u.id = a.user_id WHERE u.username = 'ava@usabanc.example'")).rows[0].n, 0);
  assert.ok((await audits('cards.minor_refused')).length >= 2);
});

test('minimum due: golden values for the demo rule (greater of $35 or 1% + interest, at most the balance)', () => {
  assert.equal(minimumDue(0n), 0n);
  assert.equal(minimumDue(2000n), 2000n);                              // $20.00 balance: pay it all
  assert.equal(minimumDue(41820n), 3500n);                             // $418.20: $35 floor
  assert.equal(minimumDue(350000n), 3500n);                            // $3,500: 1% is exactly $35
  assert.equal(minimumDue(1000000n, 15000n), 25000n);                  // $10,000 + $150 interest: $100 + $150
  assert.equal(minimumDue(523456n, 1000n), 6235n);                     // 1% of $5,234.56 = $52.3456 -> $52.35, + $10
  assert.equal(monthlyInterest(100000n, 2224), 1853n);                 // $1,000 at 22.24% / 12 = $18.533 -> $18.53
});

test('payments: minimum then statement balance, idempotent, and never more than what is owed', async () => {
  const cc = await nizamCard(), chk = (await env.q("SELECT id FROM accounts WHERE number_last4 = '4471'")).rows[0].id;
  const startChk = await bal(chk), startCard = await bal(cc.id);
  const over = await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: key(), fromAccountId: chk, type: 'custom', amount: '418.21' });
  assert.equal(over.status, 422); assert.equal(over.body.error, 'overpay'); assert.match(over.body.message, /\$418\.20/);
  const k = key();
  const p1 = await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: k, fromAccountId: chk, type: 'minimum' });
  assert.equal(p1.status, 200); assert.equal(p1.body.payment.amount, '35.00');
  const p2 = await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: k, fromAccountId: chk, type: 'minimum' });
  assert.equal(p2.body.replayed, true); assert.equal(p2.body.payment.id, p1.body.payment.id);
  assert.equal(await bal(chk), startChk - 3500n); assert.equal(await bal(cc.id), startCard + 3500n);
  const d = (await nizam.get(`/api/cards/credit/${cc.id}`)).body;
  assert.equal(d.statement.minimumLeft, '0.00'); assert.equal(d.statement.statementLeft, '224.71');
  assert.equal((await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: key(), fromAccountId: chk, type: 'minimum' })).body.error, 'nothing_due');
  const p3 = await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: key(), fromAccountId: chk, type: 'statement' });
  assert.equal(p3.body.payment.amount, '224.71');
  assert.equal(await bal(cc.id), startCard + 25971n);
  assert.ok((await audits('cards.payment')).length >= 2);
  // can't pay from a card or an account you only manage for a child
  const teen = (await env.q("SELECT id FROM accounts WHERE number_last4 = '5120'")).rows[0].id;
  assert.equal((await nizam.post(`/api/cards/credit/${cc.id}/payments`, { idempotencyKey: key(), fromAccountId: teen, type: 'custom', amount: '1' })).status, 404);
});

test('an over-limit purchase is declined and recorded; the balance does not move', async () => {
  const cc = await nizamCard();
  const before = await bal(cc.id);
  const over = BigInt(cc.available.replace('.', '')) + 1n;
  const amt = `${over / 100n}.${String(over % 100n).padStart(2, '0')}`;
  const r = await nizam.post(`/api/cards/card/${cc.card.id}/purchases`, { idempotencyKey: key(), merchant: 'Big TV Store', amount: amt, category: 'Shopping' });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'over_limit'); assert.equal(r.body.authorization.result, 'declined');
  assert.equal(await bal(cc.id), before);
  assert.equal((await env.q("SELECT result, reason FROM card_authorizations WHERE merchant = 'Big TV Store'")).rows[0].reason, 'over_limit');
  const ok = await nizam.post(`/api/cards/card/${cc.card.id}/purchases`, { idempotencyKey: key(), merchant: 'Corner Bakery', amount: '10.00', category: 'Food & Dining' });
  assert.equal(ok.status, 200); assert.equal(ok.body.rewardsEarned, '0.20');           // 2% cash back
  assert.equal(await bal(cc.id), before - 1000n);
});

test('a locked card is declined at once; unlocking lets it work; a minor can lock but not unlock', async () => {
  const d = await nizamDebit(), chk = d.account.id, before = await bal(chk);
  assert.equal((await nizam.post(`/api/cards/card/${d.id}/lock`, { locked: true })).body.card.status, 'locked');
  const r = await nizam.post(`/api/cards/card/${d.id}/purchases`, { idempotencyKey: key(), merchant: 'Gas Station', amount: '40.00', category: 'Auto & Transport' });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'card_locked');
  assert.equal(await bal(chk), before);
  await stepUp(nizam);                                                 // unlocking needs a fresh code, like unfreezing (R16)
  assert.equal((await nizam.post(`/api/cards/card/${d.id}/lock`, { locked: false })).status, 200);
  const ok = await nizam.post(`/api/cards/card/${d.id}/purchases`, { idempotencyKey: key(), merchant: 'Gas Station', amount: '40.00', category: 'Auto & Transport' });
  assert.equal(ok.status, 200); assert.equal(await bal(chk), before - 4000n);
  assert.ok((await audits('cards.lock')).length && (await audits('cards.unlock')).length);
  const ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  const teen = (await ava.get('/api/cards')).body.debit[0];
  assert.equal((await ava.post(`/api/cards/card/${teen.id}/lock`, { locked: true })).status, 200);
  assert.equal((await ava.post(`/api/cards/card/${teen.id}/lock`, { locked: false })).body.error, 'custodian_only');
  assert.equal((await nizam.post(`/api/cards/card/${teen.id}/lock`, { locked: false })).status, 200);
});

test('simulated purchases settle through the cards settlement account (…34), with an idempotency key', async () => {
  const d = await nizamDebit();
  const k = key(), body = { idempotencyKey: k, merchant: 'Book Nook', amount: '12.00', category: 'Shopping' };
  const r = await nizam.post(`/api/cards/card/${d.id}/purchases`, body);
  assert.equal(r.status, 200); assert.equal(r.body.authorization.channel, 'in_store');
  const legs = (await env.q(`SELECT l.account_id FROM card_authorizations a JOIN ledger_lines l ON l.entry_id = a.entry_id WHERE a.id = $1`, [r.body.authorization.id])).rows.map(x => x.account_id);
  assert.ok(legs.includes('00000000-0000-4000-8000-000000000034'));
  const again = await nizam.post(`/api/cards/card/${d.id}/purchases`, body);
  assert.equal(again.body.replayed, true); assert.equal(again.body.authorization.id, r.body.authorization.id);
  assert.equal((await env.q('SELECT count(*)::int n FROM card_authorizations WHERE idempotency_key LIKE $1', [`%:${k}`])).rows[0].n, 1);
  assert.equal((await audits('cards.purchase.approved')).at(-1).detail.simulated, true);
});

test('channel controls: a channel turned off declines; daily limits hold; international needs the switch or a trip', async () => {
  const { c, chk } = await customer('ctl+score700');
  await tx(env.pool, async q => (await import('../../lib/seeds/cards.mjs')).seed(q));
  const card = (await c.get('/api/cards')).body.debit[0];
  const buy = (b) => c.post(`/api/cards/card/${card.id}/purchases`, { idempotencyKey: key(), merchant: 'Shop', amount: '20.00', ...b });
  const ctl = (await c.get(`/api/cards/card/${card.id}`)).body.controls;
  assert.deepEqual(ctl.map(x => x.channel), ['in_store', 'online', 'contactless', 'atm', 'international']);
  assert.equal(ctl.find(x => x.channel === 'atm').dailyLimit, '500.00');           // default
  // tightening needs no code
  const off = await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'online', enabled: false });
  assert.equal(off.status, 200); assert.equal(off.body.controls.find(x => x.channel === 'online').enabled, false);
  const before = await bal(chk);
  const r = await buy({ channel: 'online' });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'channel_off'); assert.equal(await bal(chk), before);
  assert.equal((await buy({ channel: 'in_store' })).status, 200);
  // turning it back on is loosening: step-up first
  const on0 = await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'online', enabled: true });
  assert.equal(on0.status, 403); assert.equal(on0.body.error, 'stepup_required');
  await stepUp(c);
  assert.equal((await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'online', enabled: true })).status, 200);
  assert.equal((await buy({ channel: 'online' })).status, 200);
  // ATM: $50 a day
  await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'atm', dailyLimit: '50.00' });
  assert.equal((await buy({ channel: 'atm', amount: '40.00' })).status, 200);
  const atm = await buy({ channel: 'atm', amount: '20.00' });
  assert.equal(atm.body.error, 'channel_limit');
  assert.equal((await c.get(`/api/cards/card/${card.id}`)).body.controls.find(x => x.channel === 'atm').usedToday, '40.00');
  assert.equal((await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'atm', dailyLimit: '20000.00' })).body.error, 'bad_amount');
  // international: off declines, a trip covering today allows it
  await c.post(`/api/cards/card/${card.id}/controls`, { channel: 'international', enabled: false });
  assert.equal((await buy({ international: true })).body.error, 'international_off');
  const today = bankToday(), later = addDays(bankToday(), 5);
  assert.equal((await c.post(`/api/cards/card/${card.id}/travel`, { destination: 'Mexico City', startOn: today, endOn: later })).status, 200);
  assert.equal((await buy({ international: true })).status, 200);
  const a = (await audits('cards.controls.set')).filter(x => x.detail.cardId === card.id);
  assert.ok(a.length >= 4); assert.equal(a.find(x => x.detail.channel === 'online' && x.detail.after.enabled).detail.steppedUp, true);
});

test("a parent's controls on a teen card apply to the minor, who can't change them", async () => {
  const ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  const teen = (await ava.get('/api/cards')).body.debit[0];
  const ctl = (await ava.get(`/api/cards/card/${teen.id}`)).body.controls;
  assert.equal(ctl.find(x => x.channel === 'online').enabled, false);              // seeded by the custodian
  assert.equal(ctl.find(x => x.channel === 'atm').dailyLimit, '40.00');
  const r = await ava.post(`/api/cards/card/${teen.id}/purchases`, { idempotencyKey: key(), merchant: 'Game Store', amount: '5.00', channel: 'online' });
  assert.equal(r.body.error, 'channel_off');
  assert.equal((await ava.post(`/api/cards/card/${teen.id}/controls`, { channel: 'online', enabled: true })).body.error, 'custodian_only');
  assert.equal((await jordan.post(`/api/cards/card/${teen.id}/controls`, { channel: 'online', enabled: false })).status, 404);
});

test('credit limit is enforced by the ledger: down to minus the limit, no further; payments and bank charges still post', async () => {
  const { c, chk } = await customer('lim+score780');
  await stepUp(c);
  const acct = (await apply(c, { productCode: 'cash_plus' })).body.application.accountId;
  const limit = BigInt((await env.q('SELECT credit_limit_cents FROM accounts WHERE id = $1', [acct])).rows[0].credit_limit_cents);
  const settle = '00000000-0000-4000-8000-000000000034';
  const charge = (cents, k) => tx(env.pool, q => post(q, { key: k, kind: 'test_charge', lines: [
    { accountId: acct, amountCents: -cents, description: 'Test charge' }, { accountId: settle, amountCents: cents, description: 'Test' }] }));
  await charge(limit, 'test:lim:1');                                    // exactly to the limit is fine
  assert.equal(await bal(acct), -limit);
  await assert.rejects(charge(1n, 'test:lim:2'), e => e.code === 'over_limit' && e.status === 409);
  assert.equal(await bal(acct), -limit);
  const card = (await c.get(`/api/cards/credit/${acct}`)).body.card;
  const r = await c.post(`/api/cards/card/${card.id}/purchases`, { idempotencyKey: key(), merchant: 'One More Thing', amount: '1.00' });
  assert.equal(r.body.error, 'over_limit'); assert.equal(r.body.authorization.result, 'declined');
  // bank charges may go over (interest), as on real cards
  const { bankCharge } = await import('../../lib/cards.mjs');
  await tx(env.pool, q => bankCharge(q, () => post(q, { key: 'test:lim:fee', kind: 'card_interest', lines: [
    { accountId: acct, amountCents: -500n, description: 'Interest' }, { accountId: settle, amountCents: 500n, description: 'Test' }] })));
  assert.equal(await bal(acct), -limit - 500n);
  // backward compatible: a card already past its limit still takes payments (and still refuses new spending)
  assert.equal((await c.post(`/api/cards/credit/${acct}/payments`, { idempotencyKey: key(), fromAccountId: chk, type: 'custom', amount: '1.00' })).status, 200);
  assert.equal(await bal(acct), -limit - 400n);
  await assert.rejects(charge(1n, 'test:lim:3'), e => e.code === 'over_limit');
  // deposit accounts keep their old rule
  await assert.rejects(tx(env.pool, q => post(q, { key: 'test:lim:chk', kind: 'test_charge', lines: [
    { accountId: chk, amountCents: -1_000_000_00n, description: 'Too much' }, { accountId: settle, amountCents: 1_000_000_00n, description: 'Test' }] })), e => e.code === 'insufficient_funds');
});

test('team logins get useful card data: Asim has autopay and a trip; Zak has an open dispute and a locked card', async () => {
  const asim = await signIn(env.base, 'asim@helixbots.ai', 'asim'), zak = await signIn(env.base, 'zak@helixbots.ai', 'zak');
  const a = (await asim.get('/api/cards')).body;
  const ac = a.credit.find(x => x.last4 === '6122');
  const ad = (await asim.get(`/api/cards/credit/${ac.id}`)).body;
  assert.equal(ad.autopay.type, 'statement'); assert.ok(ad.statement); assert.ok(Number(ad.rewards.balance) > 0);
  const adb = a.debit.find(x => x.account.last4 === '6120');
  assert.equal((await asim.get(`/api/cards/card/${adb.id}`)).body.travelNotices[0].destination, 'Toronto, Canada');
  const z = (await zak.get('/api/cards')).body;
  const zd = (await zak.get(`/api/cards/credit/${z.credit.find(x => x.last4 === '7132').id}`)).body;
  assert.equal(zd.disputes.length, 1); assert.equal(zd.disputes[0].status, 'open'); assert.equal(zd.disputes[0].amount, '125.00');
  assert.equal(z.debit.find(x => x.account.last4 === '7130').status, 'locked');
  const nd = await nizamDebit();
  assert.equal((await nizam.get(`/api/cards/card/${nd.id}`)).body.controls.find(x => x.channel === 'international').enabled, false);
});

test('card prequalify and apply show on the credit file as soft and hard pulls (source card)', async () => {
  const { c, uid } = await customer('pull+score760');
  await c.post('/api/cards/prequalify', { income: '90000', housing: '1500' });
  await stepUp(c);
  await apply(c, { productCode: 'cash_plus' });
  const pulls = (await env.q('SELECT kind, source, label FROM credit_pulls WHERE user_id = $1 ORDER BY at', [uid])).rows;
  assert.deepEqual(pulls.map(p => [p.kind, p.source]), [['soft', 'card'], ['hard', 'card']]);
  assert.match(pulls[1].label, /Cash\+ Card application/);
});

test("family controls on a minor's account also decline simulated card purchases", async () => {
  const ava = await signIn(env.base, 'ava@usabanc.example', 'ava-demo-pass');
  const teen = (await ava.get('/api/cards')).body.debit[0];
  await env.q('UPDATE family_controls SET card_frozen = true WHERE account_id = $1', [teen.account.id]);
  try {
    const before = await bal(teen.account.id);
    const r = await ava.post(`/api/cards/card/${teen.id}/purchases`, { idempotencyKey: key(), merchant: 'Snack Bar', amount: '2.00', category: 'Food & Dining' });
    assert.equal(r.status, 422); assert.equal(r.body.error, 'card_frozen'); assert.match(r.body.message, /frozen by a parent/);
    assert.equal(r.body.authorization.result, 'declined'); assert.equal(await bal(teen.account.id), before);
  } finally { await env.q('UPDATE family_controls SET card_frozen = false WHERE account_id = $1', [teen.account.id]); }
});

test('travel notice: add and cancel', async () => {
  const d = await nizamDebit();
  const t = addDays(bankToday(), 7), e = addDays(bankToday(), 14);
  assert.equal((await nizam.post(`/api/cards/card/${d.id}/travel`, { destination: 'Lisbon, Portugal', startOn: e, endOn: t })).body.error, 'bad_dates');
  const r = await nizam.post(`/api/cards/card/${d.id}/travel`, { destination: 'Lisbon, Portugal', startOn: t, endOn: e });
  assert.equal(r.status, 200);
  assert.equal((await nizam.get(`/api/cards/card/${d.id}`)).body.travelNotices[0].destination, 'Lisbon, Portugal');
  assert.equal((await nizam.del(`/api/cards/card/${d.id}/travel/${r.body.notice.id}`)).status, 200);
  assert.equal((await nizam.get(`/api/cards/card/${d.id}`)).body.travelNotices.length, 0);
});

test('report lost and replace: needs step-up, closes the old card, issues a new last 4', async () => {
  const { c, chk } = await customer('rep+score700');
  const d = (await c.get('/api/cards')).body.debit;
  assert.equal(d.length, 0);                                           // test customers get no seeded card
  await tx(env.pool, async q => (await import('../../lib/seeds/cards.mjs')).seed(q));
  const card = (await c.get('/api/cards')).body.debit[0];
  assert.equal(card.account.id, chk);
  const r0 = await c.post(`/api/cards/card/${card.id}/replace`, { reason: 'lost' });
  assert.equal(r0.status, 403); assert.equal(r0.body.error, 'stepup_required');
  await stepUp(c);
  const r = await c.post(`/api/cards/card/${card.id}/replace`, { reason: 'lost' });
  assert.equal(r.status, 200); assert.notEqual(r.body.card.last4, card.last4); assert.equal(r.body.replaced.status, 'closed');
  const old = await c.post(`/api/cards/card/${card.id}/purchases`, { idempotencyKey: key(), merchant: 'Thief Mart', amount: '5.00' });
  assert.equal(old.body.error, 'card_closed');
  assert.equal((await c.post(`/api/cards/card/${r.body.card.id}/purchases`, { idempotencyKey: key(), merchant: 'Grocer', amount: '5.00' })).status, 200);
  const a = (await audits('cards.replace')).at(-1);
  assert.equal(a.detail.oldLast4, card.last4); assert.equal(a.detail.newLast4, r.body.card.last4);
});

test('the full virtual card number needs step-up, passes Luhn and is never stored or audited', async () => {
  const { c } = await customer('vn+score780');
  await stepUp(c);
  const app = (await apply(c, { productCode: 'campus' })).body.application;
  await env.q("UPDATE sessions SET stepup_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE username = 'vn+score780@cards.test')");
  const r0 = await c.post(`/api/cards/credit/${app.accountId}/virtual-number`, {});
  assert.equal(r0.status, 403); assert.equal(r0.body.error, 'stepup_required');
  const detail = (await c.get(`/api/cards/credit/${app.accountId}`)).body;
  assert.match(detail.card.masked, /^•••• •••• •••• \d{4}$/);
  // ids are UUIDs and a UUID's last group is 12 hex digits that are all decimal digits about 1 run in 300, so they are removed before looking for a card-length number
  assert.ok(!JSON.stringify(detail).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').match(/\d{12,}/));
  await stepUp(c);
  const r = await c.post(`/api/cards/credit/${app.accountId}/virtual-number`, {});
  assert.equal(r.status, 200);
  const num = r.body.number.replace(/ /g, '');
  assert.equal(num.length, 16); assert.ok(luhnValid(num)); assert.equal(num.slice(-4), detail.card.last4); assert.match(r.body.cvv, /^\d{3}$/);
  const dump = await env.q(`SELECT (SELECT json_agg(k)::text FROM cards k) || (SELECT json_agg(a)::text FROM audit_events a) || (SELECT json_agg(l)::text FROM ledger_lines l) t`);
  assert.ok(!dump.rows[0].t.includes(num), 'the full number must not be stored');
  assert.ok(!JSON.stringify(detail).includes(num) && !JSON.stringify((await c.get(`/api/cards/credit/${app.accountId}`)).body).includes(num), 'the detail never carries the full number, before or after viewing it');
  assert.ok((await audits('cards.virtual_number.view')).length);
});

// The customer used to pick the outcome ({ outcome: 'won' | 'lost' } to /resolve). Now "Simulate resolution" applies the
// bank's rules (R4): $120 not received → the merchant's proof wins (lost); a $20 claim is a small-claim write-off (won).
test('dispute: provisional credit through the ledger; lost re-bills with a new entry, won keeps the credit', async () => {
  const { c } = await customer('dis+score780');
  await stepUp(c);
  const heldSum = async () => (await env.q("SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = '00000000-0000-4000-8000-000000000033'")).rows[0].s;
  const held0 = await heldSum();                                        // the seed's open dispute (Zak) stays open
  const acct = (await apply(c, { productCode: 'cash_plus' })).body.application.accountId;
  const card = (await c.get(`/api/cards/credit/${acct}`)).body.card;
  for (const [m, a] of [['Gadget Hub', '120.00'], ['Pizza Place', '20.00']])
    assert.equal((await c.post(`/api/cards/card/${card.id}/purchases`, { idempotencyKey: key(), merchant: m, amount: a, category: 'Shopping' })).status, 200);
  const tx1 = (await c.get(`/api/cards/credit/${acct}`)).body.transactions;
  const gadget = tx1.find(t => t.description === 'Gadget Hub'), pizza = tx1.find(t => t.description === 'Pizza Place');
  assert.equal(gadget.disputable, true);
  const lineCount = async () => (await env.q('SELECT count(*)::int n FROM ledger_lines WHERE account_id = $1', [acct])).rows[0].n;
  const original = (await env.q('SELECT * FROM ledger_lines WHERE id = $1', [gadget.id])).rows[0];
  const b0 = await bal(acct);
  const k = key();
  const d = await c.post(`/api/cards/credit/${acct}/disputes`, { idempotencyKey: k, lineId: gadget.id, reason: 'not_received' });
  assert.equal(d.status, 200); assert.equal(d.body.dispute.status, 'open'); assert.equal(d.body.dispute.amount, '120.00');
  assert.equal(await bal(acct), b0 + 12000n);                          // provisional credit
  assert.equal((await c.post(`/api/cards/credit/${acct}/disputes`, { idempotencyKey: k, lineId: gadget.id, reason: 'not_received' })).body.replayed, true);
  assert.equal(await bal(acct), b0 + 12000n);
  assert.equal((await c.post(`/api/cards/credit/${acct}/disputes`, { idempotencyKey: key(), lineId: gadget.id, reason: 'duplicate' })).body.error, 'already_disputed');
  const n0 = await lineCount();
  const lost = await c.post(`/api/cards/disputes/${d.body.dispute.id}/simulate-resolution`, {});
  assert.equal(lost.body.dispute.status, 'resolved_lost'); assert.equal(lost.body.rule.code, 'merchant_proof');
  assert.equal(await bal(acct), b0);                                   // re-billed
  assert.equal(await lineCount(), n0 + 1);                             // by a new line
  assert.deepEqual((await env.q('SELECT * FROM ledger_lines WHERE id = $1', [gadget.id])).rows[0], original);
  assert.equal((await c.post(`/api/cards/disputes/${d.body.dispute.id}/simulate-resolution`, {})).body.error, 'already_resolved');
  const d2 = await c.post(`/api/cards/credit/${acct}/disputes`, { idempotencyKey: key(), lineId: pizza.id, reason: 'duplicate' });
  const won = await c.post(`/api/cards/disputes/${d2.body.dispute.id}/simulate-resolution`, {});
  assert.equal(won.body.dispute.status, 'resolved_won'); assert.equal(won.body.rule.code, 'small_claim');
  assert.equal(await bal(acct), b0 + 2000n);
  assert.equal(await heldSum(), held0);                                // every provisional credit was settled one way or the other
  assert.equal((await audits('cards.dispute.resolve')).length, 2);
  // a payment line is not a purchase and can't be disputed
  assert.equal((await nizam.post(`/api/cards/credit/${acct}/disputes`, { idempotencyKey: key(), lineId: gadget.id, reason: 'duplicate' })).status, 404);
});

test('statements: closing one charges interest on what was left unpaid; autopay pays on the due date, once', async () => {
  const { c, chk } = await customer('st+score780');
  await stepUp(c);
  const acct = (await apply(c, { productCode: 'cash_plus' })).body.application.accountId;
  const card = (await c.get(`/api/cards/credit/${acct}`)).body.card;
  await c.post(`/api/cards/card/${card.id}/purchases`, { idempotencyKey: key(), merchant: 'Furniture Co', amount: '1000.00', category: 'Home' });
  const s1 = await c.post(`/api/cards/credit/${acct}/statements`, {});
  assert.equal(s1.status, 200); assert.equal(s1.body.statement.balance, '1000.00'); assert.equal(s1.body.statement.minimumDue, '35.00');
  assert.equal((await c.post(`/api/cards/credit/${acct}/statements`, {})).body.error, 'too_soon');
  // a month passes with nothing paid
  await env.q(`UPDATE card_statements SET period_start = ${T()} - 60, period_end = ${T()} - 30, due_date = ${T()} - 5, created_at = now() - interval '30 days' WHERE id = $1`, [s1.body.statement.id]);
  const s2 = await c.post(`/api/cards/credit/${acct}/statements`, {});
  // $1,000 unpaid for the 30 days from s1's close to s2's, at 19.24% (actual/365, R5): 100000 × 1924 × 30 / 3,650,000
  // = 1581.37 -> $15.81 (the old flat month, $1,000 × 19.24% / 12, was $16.03 whatever the days)
  assert.equal(s2.body.statement.interest, '15.81');
  assert.equal(s2.body.statement.balance, '1015.81');
  assert.equal(s2.body.statement.minimumDue, '35.00');                 // 1% ($10.16) + $15.81 = $25.97 -> the $35 floor
  // autopay the statement balance
  assert.equal((await c.post(`/api/cards/credit/${acct}/autopay`, { type: 'statement', fromAccountId: chk })).status, 200);
  const chk0 = await bal(chk);
  assert.equal((await c.get(`/api/cards/credit/${acct}`)).body.autopayRun, null);   // not due yet
  await env.q(`UPDATE card_statements SET due_date = ${T()} WHERE id = $1`, [s2.body.statement.id]);
  const d = (await c.get(`/api/cards/credit/${acct}`)).body;
  assert.equal(d.autopayRun.result, 'paid'); assert.equal(d.autopayRun.amount, '1015.81');
  assert.equal(await bal(chk), chk0 - 101581n); assert.equal(d.account.owed, '0.00');
  assert.equal((await c.post('/api/cards/autopay/run', {})).body.results.length, 0);  // once per statement
  assert.equal(await bal(chk), chk0 - 101581n);
  assert.equal((await c.del(`/api/cards/credit/${acct}/autopay`)).body.autopay, null);
  assert.ok((await audits('cards.autopay.run')).length && (await audits('cards.autopay.cancel')).length);
});

test('rewards: cash back accrues on purchases and redeems to a deposit account through the ledger', async () => {
  const cc = await nizamCard(), chk = (await env.q("SELECT id FROM accounts WHERE number_last4 = '4471'")).rows[0].id;
  const d = (await nizam.get(`/api/cards/credit/${cc.id}`)).body;
  const r0 = BigInt(d.rewards.balance.replace('.', '')), c0 = await bal(chk);
  assert.ok(r0 > 0n);
  assert.equal((await nizam.post(`/api/cards/credit/${cc.id}/rewards/redeem`, { idempotencyKey: key(), toAccountId: chk, amount: '999.00' })).body.error, 'not_enough_rewards');
  const k = key();
  const r = await nizam.post(`/api/cards/credit/${cc.id}/rewards/redeem`, { idempotencyKey: k, toAccountId: chk });
  assert.equal(r.status, 200); assert.equal(r.body.rewards.balance, '0.00');
  assert.equal((await nizam.post(`/api/cards/credit/${cc.id}/rewards/redeem`, { idempotencyKey: k, toAccountId: chk })).body.replayed, true);
  assert.equal(await bal(chk), c0 + r0);
  assert.equal((await env.q("SELECT balance_cents FROM accounts WHERE system_code = 'card_rewards'")).rows[0].balance_cents, -r0);
});

test("someone else's card or card account is a 404, never a 403", async () => {
  const cc = await nizamCard(), d = await nizamDebit();
  const j = (await env.q("SELECT a.id FROM accounts a JOIN account_owners o ON o.account_id = a.id JOIN users u ON u.id = o.user_id WHERE u.username = 'jordan@usabanc.example' AND a.kind = 'checking'")).rows[0].id;
  for (const [m, p, b] of [['GET', `/api/cards/credit/${cc.id}`], ['GET', `/api/cards/card/${d.id}`], ['POST', `/api/cards/card/${d.id}/lock`, { locked: true }],
    ['POST', `/api/cards/card/${cc.card.id}/purchases`, { idempotencyKey: key(), merchant: 'x shop', amount: '1.00' }],
    ['POST', `/api/cards/credit/${cc.id}/payments`, { idempotencyKey: key(), fromAccountId: j, type: 'custom', amount: '1.00' }],
    ['POST', `/api/cards/credit/${cc.id}/virtual-number`, {}], ['POST', `/api/cards/credit/${cc.id}/autopay`, { type: 'minimum', fromAccountId: j }],
    ['GET', `/api/cards/credit/${cc.id}/statements/${(await nizam.get(`/api/cards/credit/${cc.id}`)).body.statement.id}`],
    ['GET', `/api/cards/card/not-a-uuid`]]) {
    const r = await jordan.call(m, p, b);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal((await nizam.get(`/api/cards/card/${d.id}`)).body.card.status, 'active');
  const apps = (await env.q("SELECT id FROM credit_applications LIMIT 1")).rows[0].id;
  assert.equal((await jordan.get(`/api/cards/applications/${apps}`)).status, 404);
});

test('the ledger still balances after all of the above', async () => {
  const bad = await env.q(`SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount_cents) s FROM ledger_lines GROUP BY 1) l ON l.account_id = a.id
     WHERE a.balance_cents <> coalesce(l.s, 0)`);
  assert.equal(bad.rowCount, 0);
  assert.equal((await env.q('SELECT entry_id FROM ledger_lines GROUP BY entry_id HAVING sum(amount_cents) <> 0')).rowCount, 0);
});
