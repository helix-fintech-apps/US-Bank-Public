// Pay & transfer (M4): every tab at desktop and phone width, and the main flows through the real API.
// Flows that move money put it back afterwards, so the other browser tests see the seeded balances.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { signIn } from '../helpers.mjs';

process.env.ACCOUNT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');      // test-only key for linking accounts
const TABS = ['transfer', 'p2p', 'ach', 'wire', 'bills', 'limits'];

export default async function ({ test, base, logIn, shots, env }) {
  const nizam = async page => { await logIn(page, 'nizam@helixbots.ai', 'nizam'); await page.waitForURL('**/app'); };
  const open = async (page, tab) => { await page.goto(`${base}/app/pay#${tab}`); await page.waitForSelector('#activity li:not(:has-text("Loading"))'); await page.waitForSelector(`#p-${tab}:not([hidden])`); };
  const stepUp = async page => {                                                   // the code prompt from client.js
    await page.waitForSelector('dialog.stepup .demo-code b');
    await page.fill('#su-code', (await page.textContent('dialog.stepup .demo-code b')).trim());
    await page.click('#su-go');
  };
  const msg = (page, form) => page.waitForFunction(f => document.querySelector(`${f} .mm-msg`).textContent.length > 0, form).then(() => page.textContent(`${form} .mm-msg`));
  const id = async last4 => (await env.q('SELECT id FROM accounts WHERE number_last4 = $1', [last4])).rows[0].id;

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await test(`Pay & transfer: every tab fits the ${label} screen`, async page => {
      await nizam(page);
      for (const tab of TABS) {
        await open(page, tab);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `${tab} is ${over}px wider than the screen`);
        if (shots) await page.screenshot({ path: `${shots}/${label}-pay-${tab}.png`, fullPage: true });
      }
      assert.match(await page.textContent('.dash-top'), /Pay & transfer/);
    }, { width: w, height: h });
  }

  await test('a transfer between your accounts shows in activity; an overdraft is refused in plain words', async page => {
    await nizam(page); await open(page, 'transfer');
    assert.match(await page.textContent('[data-left="internal"]'), /\$25,000\.00/);
    await page.fill('#f-transfer [name=amount]', '5.00');
    await page.click('#f-transfer button.pri');
    assert.match(await msg(page, '#f-transfer'), /Done\. \$5\.00 moved to Bright Savings ··9302/);
    await page.waitForSelector('#activity li:has-text("Transfer to Bright Savings")');
    await page.selectOption('#f-transfer [name=fromAccountId]', await id('9302'));
    await page.selectOption('#f-transfer [name=toAccountId]', await id('4471'));
    await page.fill('#f-transfer [name=amount]', '5.00');
    await page.click('#f-transfer button.pri');
    assert.match(await msg(page, '#f-transfer'), /moved to Smart Checking/);
    await page.fill('#f-transfer [name=amount]', '3000.00');
    await page.click('#f-transfer button.pri');
    await page.waitForFunction(() => /isn't enough/.test(document.querySelector('#f-transfer .mm-msg').textContent));
    assert.match(await page.textContent('#f-transfer .mm-msg'), /(Smart Checking ··4471|Bright Savings ··9302) has \$[\d,]+\.\d\d, which isn't enough/);
  });

  await test('USA Pay shows the warning and asks for a code before sending', async page => {
    await nizam(page); await open(page, 'p2p');
    assert.match(await page.textContent('#p2p-warn'), /Only send money to people you know/);
    await page.fill('#f-send [name=to]', 'jordan@usabanc.example');
    await page.fill('#f-send [name=amount]', '1.00');
    await page.click('#f-send button.pri');
    await stepUp(page);
    assert.match(await msg(page, '#f-send'), /Sent \$1\.00 to Jordan/);
    if (shots) await page.screenshot({ path: `${shots}/desktop-pay-p2p-sent.png`, fullPage: true });
    const j = await signIn(base, 'jordan@usabanc.example', 'jordan-demo-pass');     // Jordan sends it back
    const back = await j.post('/api/pay/p2p/send', { fromAccountId: await id('3388'), to: 'nizam@helixbots.ai', amount: '1.00', idempotencyKey: 'browser-' + Date.now() });
    assert.equal(back.status, 200);
  });

  await test('linking an external account: two simulated deposits to confirm, then the new-account hold shows', async page => {
    await nizam(page); await open(page, 'ach');
    await page.click('[data-link=deposits]');
    await page.fill('#f-link [name=nickname]', 'Browser test bank');
    await page.fill('#f-link [name=routing]', '123456780');
    await page.fill('#f-link [name=accountNumber]', '55501234');
    await page.click('#f-link button');
    await stepUp(page);
    const m = await msg(page, '#f-link');
    const [a1, a2] = [...m.matchAll(/\$(\d+\.\d\d)/g)].map(x => x[1]);
    assert.ok(a1 && a2, m);
    const f = '#externals li:has-text("Browser test bank") form';
    await page.fill(`${f} [name=amount1]`, a1); await page.fill(`${f} [name=amount2]`, a2);
    await page.click(`${f} button`);
    await page.waitForSelector('#externals li:has-text("Browser test bank") .sub:has-text("new-account hold")');
    assert.ok(!(await page.content()).includes('55501234'));
    if (shots) await page.screenshot({ path: `${shots}/desktop-pay-ach-linked.png`, fullPage: true });
  });

  await test('a wire shows the fee, the send day and the irrevocable warning, and needs the box ticked', async page => {
    await nizam(page); await open(page, 'wire');
    for (const [k, v] of [['recipientName', 'Pat Lee'], ['bankName', 'Prairie Bank'], ['routing', '123456780'], ['accountNumber', '000555123'], ['amount', '100.00']]) await page.fill(`#f-wire [name=${k}]`, v);
    await page.click('#wire-review');
    await page.waitForSelector('#wire-quote:not([hidden])');
    assert.match(await page.textContent('#wire-dl'), /Wire fee\$25\.00Total\$125\.00/);
    assert.match(await page.textContent('#wire-warn'), /irrevocable/);
    assert.equal(await page.isDisabled('#wire-send'), true);
    await page.check('#wire-ok');
    assert.equal(await page.isDisabled('#wire-send'), false);
    if (shots) await page.screenshot({ path: `${shots}/desktop-pay-wire-review.png`, fullPage: true });
    await page.click('#wire-back');
    assert.equal(await page.isHidden('#wire-quote'), true);
  });

  await test('bill pay: schedule a payment with a delivery estimate, then cancel it before it runs', async page => {
    await nizam(page); await open(page, 'bills');
    await page.fill('#f-bill [name=amount]', '20.00');
    await page.check('#f-bill [name=when][value=date]');
    const day = (await env.q("SELECT (current_date + 10)::text d")).rows[0].d;
    await page.fill('#f-bill [name=date]', day);
    await page.waitForFunction(() => /expected to arrive by/.test(document.querySelector('#bill-eta').textContent));
    await page.click('#f-bill button.pri');
    await stepUp(page);
    assert.match(await msg(page, '#f-bill'), /Scheduled once: next on .*arriving by/);
    await open(page, 'transfer');
    await page.click('#schedules li:has-text("City Power & Light") button');
    await page.waitForSelector('#schedules li:has-text("Nothing scheduled")');
  });

  await test('limits are on screen; lowering one is instant, raising it back asks for a code', async page => {
    await nizam(page); await open(page, 'limits');
    await page.selectOption('#limit-rail', 'p2p');
    await page.fill('#f-limit [name=daily]', '500.00');
    await page.click('#f-limit button');
    assert.match(await msg(page, '#f-limit'), /USA Pay: \$500\.00 a day/);
    await page.waitForSelector('#limits tr[data-rail=p2p] td:nth-child(2):has-text("$500.00")');
    await page.fill('#f-limit [name=daily]', '1000.00');
    await page.click('#f-limit button');
    await stepUp(page);
    await page.waitForFunction(() => /\$1,000\.00 a day/.test(document.querySelector('#f-limit .mm-msg').textContent));
  });

  await test('instant linking (simulated sign-in) verifies the account right away', async page => {
    await nizam(page); await open(page, 'ach');
    assert.match(await page.textContent('#instant-demo'), /user_good/);
    await page.selectOption('#instant-bank', 'summit');
    await page.fill('#f-instant [name=username]', 'user_good');
    await page.fill('#f-instant [name=password]', 'wrong');
    await page.click('#f-instant button');
    await stepUp(page);
    assert.match(await msg(page, '#f-instant'), /didn't accept that sign-in/);
    await page.fill('#f-instant [name=password]', 'pass_good');
    await page.click('#f-instant button');
    await page.waitForFunction(() => /Linked and verified/.test(document.querySelector('#f-instant .mm-msg').textContent));
    await page.waitForSelector('#externals li:has-text("Summit Savings Bank") .sub:has-text("linked instantly")');
    await page.click('[data-link=deposits]');
    assert.equal(await page.isVisible('#f-link [name=routing]'), true);
  });

  await test('an ACH transfer shows its status; it can be canceled, or finished with Simulate settlement', async page => {
    await nizam(page); await open(page, 'ach');
    page.on('dialog', d => d.accept());
    await page.check('#f-ach [name=direction][value=in]');
    await page.selectOption('#ext-pick', { label: 'Lakeside Credit Union checking ··6789' });
    for (const amt of ['11.00', '12.00']) {
      await page.fill('#f-ach [name=amount]', amt);
      await page.click('#f-ach button.pri');
      await page.waitForFunction(a => document.querySelector('#f-ach .mm-msg').textContent.includes(a), amt);
    }
    const row = amt => `#activity li:has-text("ACH from Lakeside"):has-text("$${amt}")`;
    await page.waitForSelector(`${row('12.00')} .mm-pill.pending`);
    assert.equal(await page.isVisible('#sim-note'), true);
    if (shots) await page.screenshot({ path: `${shots}/desktop-pay-ach-pending.png`, fullPage: true });
    await page.click(`${row('11.00')} [data-xcancel]`);
    await page.waitForSelector(`${row('11.00')} .mm-pill.canceled`);
    await page.click(`${row('12.00')} [data-sim]`);
    await page.waitForSelector(`${row('12.00')} .mm-pill.settled`);
    assert.match(await page.textContent(row('12.00')), /finished with Simulate settlement/);
    const sav = await env.q("SELECT balance_cents b FROM accounts WHERE number_last4 = '4471'");
    assert.ok(sav.rows[0].b > 0n);
  });

  await test('a teen sees why they can’t move money', async page => {
    await logIn(page, 'ava@usabanc.example', 'ava-demo-pass');
    await page.waitForSelector('#step-code:not([hidden])');
    await page.locator('#code input').first().fill((await page.textContent('#democode')).trim());
    await page.waitForURL('**/app');
    await open(page, 'transfer');
    assert.match(await page.textContent('#minor'), /parent or guardian/);
  }, { width: 390, height: 844 });
}
