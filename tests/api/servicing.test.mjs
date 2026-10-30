import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testEnv, client, signIn } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });
const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'], AVA = ['ava@usabanc.example', 'ava-demo-pass'];
const acct = async last4 => (await env.q('SELECT id, balance_cents FROM accounts WHERE number_last4 = $1', [last4])).rows[0];
const stepUp = async c => { const s = await c.post('/api/stepup'); assert.equal((await c.post('/api/stepup/verify', { code: s.body.demoCode })).status, 200); };
const put = (c, p, b) => c.call('PUT', p, b);
const raw = (c, p, headers = {}) => fetch(env.base + p, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers } });
let n = 0;
const spend = (accountId, cents, description, system = 'card_settlement', kind = 'card_purchase') => tx(env.pool, async c => post(c, { key: `test:sv:${n++}`, kind, lines: [
  { accountId, amountCents: cents, description, category: cents < 0n ? 'Shopping' : 'Income' }, { accountId: await systemAccount(c, system), amountCents: -cents, description }] }));

test('activity filters: text, money in/out, amount range, category, account and dates', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const all = (await c.get('/api/activity?limit=100')).body.transactions;
  assert.equal(all.length, 19);
  assert.ok(all.some(t => t.account.last4 === '0088') && all.some(t => t.account.last4 === '5120'));   // every account the user can see
  const pay = (await c.get('/api/activity?q=payroll')).body.transactions;
  assert.equal(pay.length, 2); assert.ok(pay.every(t => /payroll/i.test(t.description)));
  assert.equal((await c.get('/api/activity?q=' + encodeURIComponent('100%'))).body.transactions.length, 0);   // % is literal, not a wildcard
  const ins = (await c.get('/api/activity?dir=in&limit=100')).body.transactions;
  assert.ok(ins.length && ins.every(t => !t.amount.startsWith('-')));
  const outs = (await c.get('/api/activity?dir=out&limit=100')).body.transactions;
  assert.equal(ins.length + outs.length, all.length);
  const mid = (await c.get('/api/activity?min=50&max=120&limit=100')).body.transactions;
  assert.deepEqual(mid.map(t => t.amount.replace('-', '')).sort(), ['51.90', '68.50', '70.00', '89.99', '94.20', '112.38'].sort());
  const food = (await c.get('/api/activity?category=' + encodeURIComponent('Food & Dining'))).body.transactions;
  assert.equal(food.length, 3); assert.ok(food.every(t => t.category === 'Food & Dining'));
  const chk = await acct('4471');
  const only = (await c.get(`/api/activity?account=${chk.id}&limit=100`)).body.transactions;
  assert.equal(only.length, 10); assert.ok(only.every(t => t.account.last4 === '4471'));
  const day = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const recent = (await c.get(`/api/activity?from=${day}&limit=100`)).body.transactions;
  assert.ok(recent.length && recent.every(t => t.postedOn >= day));
  assert.equal((await c.get('/api/activity?from=2026-02-31')).status, 400);
  assert.equal((await c.get('/api/activity?from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await c.get('/api/activity?min=abc')).status, 400);
  const jordanChk = await acct('3388');
  assert.equal((await c.get(`/api/activity?account=${jordanChk.id}`)).status, 404);
});

test('cursor pagination walks every line once, newest first, even when new activity arrives mid-way', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const all = (await c.get('/api/activity?limit=100')).body.transactions.map(t => t.id);
  const seen = []; let cursor = null, pages = 0;
  do {
    const r = await c.get('/api/activity?limit=3' + (cursor ? '&cursor=' + cursor : ''));
    assert.equal(r.status, 200); assert.ok(r.body.transactions.length <= 3);
    seen.push(...r.body.transactions.map(t => t.id)); cursor = r.body.nextCursor; pages++;
    if (pages === 2) await spend((await acct('0088')).id, -1234n, 'Bookshop, mid-pagination');   // newer than every cursor: must not shift later pages
  } while (cursor);
  assert.deepEqual(seen, all);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(pages, Math.ceil(all.length / 3));
  const rows = (await c.get('/api/activity?limit=100')).body.transactions;
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].postedOn > rows[i].postedOn || (rows[i - 1].postedOn === rows[i].postedOn && BigInt(rows[i - 1].id) > BigInt(rows[i].id)));
  assert.equal((await c.get('/api/activity?cursor=not-a-cursor')).status, 400);
});

test('changing a category stores an override for this user only; the ledger line is untouched', async () => {
  const c = await signIn(env.base, ...NIZAM), j = await signIn(env.base, ...JORDAN);
  const line = (await env.q("SELECT l.id, l.category FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE a.number_last4 = '7781' LIMIT 1")).rows[0];
  const r = await put(c, `/api/activity/${line.id}/category`, { category: 'Gifts & Donations' });
  assert.equal(r.status, 200); assert.equal(r.body.category, 'Gifts & Donations'); assert.equal(r.body.overridden, true);
  assert.equal((await env.q('SELECT category FROM ledger_lines WHERE id = $1', [line.id])).rows[0].category, line.category);
  const mine = (await c.get('/api/activity?category=' + encodeURIComponent('Gifts & Donations'))).body.transactions;
  assert.deepEqual(mine.map(t => t.id), [String(line.id)]); assert.equal(mine[0].originalCategory, line.category);
  const theirs = (await j.get('/api/activity?limit=100')).body.transactions.find(t => t.id === String(line.id));   // joint owner keeps their own view
  assert.equal(theirs.category, line.category); assert.equal(theirs.overridden, false);
  assert.equal((await put(c, `/api/activity/${line.id}/category`, { category: 'Made Up' })).status, 400);
  const nizamLine = (await env.q("SELECT l.id FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE a.number_last4 = '4471' LIMIT 1")).rows[0].id;
  assert.equal((await put(j, `/api/activity/${nizamLine}/category`, { category: 'Other' })).status, 404);
  const sysLine = (await env.q("SELECT l.id FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE a.kind = 'system' LIMIT 1")).rows[0].id;
  assert.equal((await put(c, `/api/activity/${sysLine}/category`, { category: 'Other' })).status, 404);
  const a = (await env.q("SELECT detail FROM audit_events WHERE action = 'activity.recategorize' ORDER BY id DESC LIMIT 1")).rows[0].detail;
  assert.deepEqual(a, { line: String(line.id), from: line.category, to: 'Gifts & Donations' });
  assert.equal((await put(c, `/api/activity/${line.id}/category`, { category: null })).body.overridden, false);
  assert.equal((await env.q('SELECT count(*)::int n FROM category_overrides WHERE line_id = $1', [line.id])).rows[0].n, 0);
});

test('spending insights are summed on the server from the ledger, leaving out transfers', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const month = new Date().toISOString().slice(0, 7);
  const r = await c.get('/api/insights?month=' + month);
  assert.equal(r.status, 200);
  const want = (await env.q(`SELECT coalesce(sum(-l.amount_cents), 0)::bigint s FROM ledger_lines l JOIN account_owners o ON o.account_id = l.account_id
     JOIN users u ON u.id = o.user_id WHERE u.username = $1 AND l.amount_cents < 0 AND l.category <> 'Transfers' AND to_char(l.posted_on, 'YYYY-MM') = $2`, [NIZAM[0], month])).rows[0].s;
  const cents = s => BigInt(s.replace('.', ''));
  assert.equal(cents(r.body.spending), want);
  assert.equal(r.body.categories.reduce((s, x) => s + cents(x.amount), 0n), want);
  assert.ok(!r.body.categories.some(x => x.category === 'Transfers'));
  assert.equal(r.body.trend.length, 6); assert.equal(r.body.trend.at(-1).spending, r.body.spending);
  assert.equal((await c.get('/api/insights?month=2999-01')).status, 400);
});

test('statement totals tie to the ledger to the cent: opening + lines = closing', async () => {
  const c = await signIn(env.base, ...NIZAM);
  for (const last4 of ['4471', '9302', '5120', '7781']) {
    const a = await acct(last4);
    const list = await c.get(`/api/statements/${a.id}`);
    assert.equal(list.status, 200); assert.ok(list.body.statements.length >= 1);
    for (const { month } of list.body.statements) {
      const s = (await c.get(`/api/statements/${a.id}/${month}`)).body;
      const cents = v => BigInt(v.replace('.', ''));
      const sum = (await env.q(`SELECT (SELECT coalesce(sum(amount_cents), 0) FROM ledger_lines WHERE account_id = $1 AND posted_on < $2::date)::bigint open,
          (SELECT coalesce(sum(amount_cents), 0) FROM ledger_lines WHERE account_id = $1 AND posted_on < $2::date + interval '1 month')::bigint close,
          (SELECT count(*) FROM ledger_lines WHERE account_id = $1 AND posted_on >= $2::date AND posted_on < $2::date + interval '1 month')::int n`, [a.id, month + '-01'])).rows[0];
      assert.equal(cents(s.opening), sum.open, `${last4} ${month} opening`);
      assert.equal(cents(s.closing), sum.close, `${last4} ${month} closing`);
      assert.equal(cents(s.opening) + cents(s.moneyIn) - cents(s.moneyOut), cents(s.closing));
      assert.equal(s.lines.length, sum.n);
      assert.equal(s.lines.reduce((t, l) => t + cents(l.amount), cents(s.opening)), cents(s.closing));
      if (s.lines.length) assert.equal(s.lines.at(-1).balance, s.closing);
    }
    const now = (await c.get(`/api/statements/${a.id}/${list.body.statements[0].month}`)).body;
    assert.equal(now.partial, true); assert.equal(BigInt(now.closing.replace('.', '')), (await acct(last4)).balance_cents);
  }
  const card = await acct('0088');
  assert.equal((await c.get(`/api/statements/${card.id}`)).status, 404);
  const chk = await acct('4471');
  assert.equal((await c.get(`/api/statements/${chk.id}/2999-01`)).status, 404);
  assert.equal((await c.get(`/api/statements/${chk.id}/2026-13`)).status, 404);
});

test('the statement PDF downloads as application/pdf', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const chk = await acct('4471'), month = new Date().toISOString().slice(0, 7);
  const r = await raw(c, `/api/statements/${chk.id}/${month}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="usa-banc-statement-4471-\d{4}-\d{2}\.pdf"/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(buf.length > 1500);
});

test("someone else's account statements are a 404", async () => {
  const j = await signIn(env.base, ...JORDAN);
  const chk = await acct('4471'), month = new Date().toISOString().slice(0, 7);
  assert.equal((await j.get(`/api/statements/${chk.id}`)).status, 404);
  assert.equal((await j.get(`/api/statements/${chk.id}/${month}`)).status, 404);
  assert.equal((await raw(j, `/api/statements/${chk.id}/${month}/pdf`)).status, 404);
  assert.equal((await j.get('/api/statements/not-a-uuid')).status, 404);
  const joint = await acct('7781');                                                     // a joint owner does get the shared account
  assert.equal((await j.get(`/api/statements/${joint.id}`)).status, 200);
  assert.deepEqual((await j.get('/api/statements')).body.accounts.map(a => a.last4).sort(), ['3388', '7781']);
});

test('alert rules fire on new activity once each; mark-read lowers the unread count', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const chk = await acct('4471');
  const before = (await c.get('/api/alerts')).body;
  assert.ok(before.items.length >= 3 && before.rules.length === 4);                    // seeded inbox and rules
  const low = await c.post('/api/alerts/rules', { kind: 'low_balance', accountId: chk.id, threshold: (BigInt(chk.balance_cents) / 100n - 50n).toString() + '.00', email: true });
  assert.equal(low.status, 200);
  assert.equal((await c.post('/api/alerts/rules', { kind: 'large_purchase', threshold: '75.00' })).status, 200);
  assert.equal((await c.post('/api/alerts/rules', { kind: 'large_purchase' })).status, 400);
  assert.equal((await c.post('/api/alerts/rules', { kind: 'low_balance', accountId: (await acct('3388')).id, threshold: '10' })).status, 404);
  assert.equal((await c.get('/api/alerts')).body.unread, before.unread);                // nothing new yet: rules only watch from now on
  await spend(chk.id, -8000n, 'Electronics store');                                    // over $75, and the balance dips under the low mark
  await spend(chk.id, -500n, 'Snack bar');                                             // still low: no second low-balance alert
  await spend(chk.id, 2500n, 'Refund from Electronics store', 'ach_clearing', 'ach_in');
  const a = (await c.get('/api/alerts')).body;
  const titles = a.items.map(i => i.title);
  assert.equal(titles.filter(t => t.startsWith('Low balance')).length, 1);
  assert.equal(titles.filter(t => t === 'Purchase over $75.00').length, 1);
  assert.equal(titles.filter(t => t === 'Purchase over $100.00').length, 2);          // only the two seeded ones: $80 is under the seeded $100 rule
  assert.ok(titles.includes('Deposit received: $25.00'));
  assert.equal(a.items.find(i => i.title.startsWith('Low balance')).emailTo, 'nizam@helixbots.ai');   // simulated email address
  assert.equal(a.unread, before.unread + 3);                                           // low balance, the $75 purchase, the deposit (seeded rule)
  assert.equal((await c.get('/api/alerts')).body.items.length, a.items.length);        // evaluating again adds nothing
  const r = await c.post('/api/alerts/read', { ids: [a.items[0].id] });
  assert.equal(r.body.unread, a.unread - 1);
  assert.equal((await c.get('/api/alerts/unread')).body.unread, a.unread - 1);
  assert.equal((await c.post('/api/alerts/read', { all: true })).body.unread, 0);
  const j = await signIn(env.base, ...JORDAN);                                          // someone else's alerts are invisible
  assert.equal((await j.post('/api/alerts/read', { ids: a.items.map(i => i.id) })).status, 200);
  assert.equal((await put(j, `/api/alerts/rules/${low.body.id}`, { active: false })).status, 404);
  assert.equal((await j.call('DELETE', `/api/alerts/rules/${low.body.id}`)).status, 404);
  assert.equal((await put(c, `/api/alerts/rules/${low.body.id}`, { active: false })).body.active, false);
  assert.equal((await c.call('DELETE', `/api/alerts/rules/${low.body.id}`)).status, 200);
});

test('a sign-in from a new device raises an alert', async () => {
  const c = await signIn(env.base, ...NIZAM);
  await c.post('/api/alerts/read', { all: true });
  await c.get('/api/alerts');
  const phone = client(env.base);
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.equal((await phone.call('POST', '/api/session', { username: NIZAM[0], password: NIZAM[1] }, { 'user-agent': ua })).status, 200);
  const a = (await c.get('/api/alerts')).body;
  const hit = a.items.filter(i => i.kind === 'new_device' && !i.read);
  assert.equal(hit.length, 1); assert.match(hit[0].body, /Safari on iOS/);
  assert.equal((await phone.call('POST', '/api/session', { username: NIZAM[0], password: NIZAM[1] }, { 'user-agent': ua })).status, 200);
  assert.equal((await c.get('/api/alerts')).body.items.filter(i => i.kind === 'new_device' && !i.read).length, 1);   // same device again: no new alert
});

test('changing contact details needs step-up and is audited with masked values', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const p = (await c.get('/api/profile')).body;
  assert.equal(p.email, 'nizam@helixbots.ai'); assert.equal(p.phone, '(555) 010-0142');
  const want = { email: 'nizam.new@example.com', phone: '(555) 010-9988', address: { line1: '77 Lake Shore Rd', city: 'Madison', state: 'wi', zip: '53703' } };
  const no = await put(c, '/api/profile', want);
  assert.equal(no.status, 403); assert.equal(no.body.error, 'stepup_required');
  assert.equal((await c.get('/api/profile')).body.email, 'nizam@helixbots.ai');
  await stepUp(c);
  assert.equal((await put(c, '/api/profile', { email: 'not-an-email' })).status, 400);
  assert.equal((await put(c, '/api/profile', { phone: '123' })).status, 400);
  assert.equal((await put(c, '/api/profile', { address: { line1: 'x', city: 'y', state: 'ZZ', zip: '1' } })).status, 400);
  const r = await put(c, '/api/profile', want);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['email', 'phone', 'address']);
  assert.equal(r.body.profile.address.state, 'WI'); assert.equal(r.body.profile.phoneLast2, '88');
  assert.match(r.body.notices[0], /old phone ending ··42/);
  assert.equal((await env.q('SELECT phone_last2 FROM users WHERE username = $1', [NIZAM[0]])).rows[0].phone_last2, '88');
  const ev = (await env.q("SELECT detail::text d, detail FROM audit_events WHERE action = 'profile.change' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(ev.detail.changes.map(x => x.field), ['email', 'phone', 'address']);
  assert.equal(ev.detail.changes[0].from, 'n•••@helixbots.ai');
  assert.equal(ev.detail.changes[1].from, '•••-•••-••42');
  for (const secret of ['nizam@helixbots.ai', 'nizam.new@', '5550100142', '5550109988', '1200 Harbor', '77 Lake Shore', '78701', '53703']) assert.ok(!ev.d.includes(secret), secret);
  assert.equal((await put(c, '/api/profile/estatements', { enabled: false })).body.estatements, false);
  assert.deepEqual((await env.q("SELECT detail FROM audit_events WHERE action = 'profile.estatements' ORDER BY id DESC LIMIT 1")).rows[0].detail, { from: true, to: false });
  await put(c, '/api/profile', { email: 'nizam@helixbots.ai', phone: '5550100142', address: { line1: '1200 Harbor View Dr', city: 'Austin', state: 'TX', zip: '78701' } });
});

test('security center: sign out one device, then sign out everywhere', async () => {
  const a = await signIn(env.base, ...NIZAM), b = await signIn(env.base, ...NIZAM);
  const s = (await a.get('/api/security')).body;
  assert.ok(s.sessions.length >= 2); assert.equal(s.sessions.filter(x => x.current).length, 1);
  assert.ok(s.signins.some(e => e.action === 'login.ok'));
  const bHash = createHash('sha256').update(b.jar.get('usab_sid')).digest('hex');
  const bId = createHash('sha256').update('session:' + bHash).digest('hex').slice(0, 32);
  assert.ok(s.sessions.some(x => x.id === bId && !x.current));
  const j = await signIn(env.base, ...JORDAN);
  assert.equal((await j.call('DELETE', `/api/security/sessions/${bId}`)).status, 404);      // not Jordan's session
  assert.equal((await b.get('/api/me')).status, 200);
  const r = await a.call('DELETE', `/api/security/sessions/${bId}`);
  assert.equal(r.status, 200); assert.equal(r.body.current, false);
  assert.equal((await b.get('/api/me')).status, 401);
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await a.call('DELETE', `/api/security/sessions/${bId}`)).status, 404);
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'session.revoke'")).rowCount >= 1);
  const c = await signIn(env.base, ...NIZAM);
  assert.equal((await a.del('/api/session', { everywhere: true })).status, 200);
  assert.equal((await a.get('/api/me')).status, 401); assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await j.get('/api/me')).status, 200);                                     // other customers stay signed in
});

test('turning one-time codes on or off needs step-up, is audited, and a minor cannot', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const no = await put(c, '/api/security/mfa', { required: true });
  assert.equal(no.status, 403); assert.equal(no.body.error, 'stepup_required');
  await stepUp(c);
  assert.equal((await put(c, '/api/security/mfa', { required: true })).body.mfaRequired, true);
  assert.deepEqual((await env.q("SELECT detail FROM audit_events WHERE action = 'security.mfa_change' ORDER BY id DESC LIMIT 1")).rows[0].detail, { from: false, to: true });
  assert.equal((await client(env.base).post('/api/session', { username: NIZAM[0], password: NIZAM[1] })).body.next, 'code');
  assert.equal((await put(c, '/api/security/mfa', { required: false })).body.mfaRequired, false);
  assert.equal((await client(env.base).post('/api/session', { username: NIZAM[0], password: NIZAM[1] })).body.next, 'done');
  const ava = await signIn(env.base, ...AVA);
  assert.equal((await ava.get('/api/security')).body.canChangeMfa, false);
  await stepUp(ava);
  const m = await put(ava, '/api/security/mfa', { required: false });
  assert.equal(m.status, 403); assert.equal(m.body.error, 'managed');
});

test('overdraft coverage: owners opt in or out; a minor cannot change the custodian setting', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const o = (await c.get('/api/overdraft')).body;
  assert.deepEqual(o.accounts.map(a => [a.last4, a.optedIn, a.canChange]), [['4471', false, true], ['5120', false, true]]);
  assert.equal(o.fee, '36.00');
  const chk = await acct('4471'), teen = await acct('5120'), sav = await acct('9302');
  assert.equal((await put(c, `/api/overdraft/${chk.id}`, { optedIn: true })).body.optedIn, true);
  assert.deepEqual((await env.q("SELECT detail FROM audit_events WHERE action = 'overdraft.change' ORDER BY id DESC LIMIT 1")).rows[0].detail,
    { account: chk.id, last4: '4471', from: false, to: true });
  assert.equal((await put(c, `/api/overdraft/${sav.id}`, { optedIn: true })).status, 404);
  const ava = await signIn(env.base, ...AVA);
  assert.equal((await ava.get('/api/overdraft')).body.accounts[0].canChange, false);
  const m = await put(ava, `/api/overdraft/${teen.id}`, { optedIn: true });
  assert.equal(m.status, 403); assert.equal(m.body.error, 'managed');
  const j = await signIn(env.base, ...JORDAN);
  assert.equal((await put(j, `/api/overdraft/${chk.id}`, { optedIn: false })).status, 404);
  assert.equal((await put(c, `/api/overdraft/${chk.id}`, { optedIn: false })).body.optedIn, false);
});

test('secure messages: threads with a simulated auto-reply, private to their owner', async () => {
  const c = await signIn(env.base, ...NIZAM);
  const t = await c.post('/api/messages', { subject: 'Card question', body: 'Can I raise my card limit?' });
  assert.equal(t.status, 200);
  const th = (await c.get(`/api/messages/${t.body.id}`)).body;
  assert.deepEqual(th.messages.map(m => m.sender), ['customer', 'bank']); assert.match(th.messages[1].body, /simulated/);
  assert.equal((await c.post(`/api/messages/${t.body.id}`, { body: 'Thanks!' })).status, 200);
  const list = (await c.get('/api/messages')).body.threads;
  assert.equal(list[0].id, t.body.id); assert.equal(list[0].unread, 1);
  assert.ok(list.some(x => x.subject === 'When does my paycheck arrive?'));
  assert.equal((await c.post('/api/messages', { subject: '', body: 'x' })).status, 400);
  const j = await signIn(env.base, ...JORDAN);
  assert.equal((await j.get(`/api/messages/${t.body.id}`)).status, 404);
  assert.equal((await j.post(`/api/messages/${t.body.id}`, { body: 'hi' })).status, 404);
});

test('changing a password: current password + step-up, a strength rule, and other devices are signed out', async () => {
  const a = await signIn(env.base, ...JORDAN), b = await signIn(env.base, ...JORDAN);
  await env.q('UPDATE sessions SET stepup_at = NULL WHERE token_hash = $1', [createHash('sha256').update(a.jar.get('usab_sid')).digest('hex')]);   // the sign-in code counted as step-up
  const no = await a.post('/api/security/password', { current: JORDAN[1], next: 'harbor-lights-2026' });
  assert.equal(no.status, 403); assert.equal(no.body.error, 'stepup_required');
  await stepUp(a);
  const wrong = await a.post('/api/security/password', { current: 'nope', next: 'harbor-lights-2026' });
  assert.equal(wrong.status, 401); assert.equal(wrong.body.error, 'bad_password');
  assert.ok((await env.q("SELECT 1 FROM audit_events WHERE action = 'password.change_bad_current'")).rowCount >= 1);   // kept although refused
  for (const weak of ['short1', 'onlyletterslong', '1234567890123', 'jordan-is-2026x', JORDAN[1]])
    assert.equal((await a.post('/api/security/password', { current: JORDAN[1], next: weak })).body.error, 'weak_password', weak);
  const ok = await a.post('/api/security/password', { current: JORDAN[1], next: 'harbor-lights-2026' });
  assert.equal(ok.status, 200); assert.ok(ok.body.otherSessionsEnded >= 1);
  assert.equal((await a.get('/api/me')).status, 200); assert.equal((await b.get('/api/me')).status, 401);
  assert.equal((await client(env.base).post('/api/session', { username: JORDAN[0], password: JORDAN[1] })).status, 401);
  await signIn(env.base, JORDAN[0], 'harbor-lights-2026');
  const rows = (await env.q("SELECT coalesce(detail::text, '') d FROM audit_events WHERE action LIKE 'password.%'")).rows.map(r => r.d).join('\n');
  assert.ok(!rows.includes('harbor-lights') && !rows.includes(JORDAN[1]));
});
