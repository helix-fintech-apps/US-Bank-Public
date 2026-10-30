// Cards pages: list, credit and debit detail, apply flow. This file runs before core.browser.mjs on the same database,
// so anything that moves money uses its own fresh customers; Nizam's balances and account count stay as seeded.
import assert from 'node:assert/strict';
import { tx } from '../../lib/db.mjs';
import { hashPassword, newId } from '../../lib/auth.mjs';
import { post, systemAccount } from '../../lib/ledger.mjs';
import { luhnValid } from '../../lib/cards.mjs';

export default async function ({ test, base, logIn, shots, env }) {
  const customer = async name => {
    const username = `${name}@cards-ui.test`, uid = newId(), chk = newId();
    await tx(env.pool, async c => {
      await c.query(`INSERT INTO users (id, username, display_name, password_hash, mfa_required, phone_last2) VALUES ($1,$2,$3,$4,false,'55')`,
        [uid, username, name.replace(/\+.*/, ''), await hashPassword('pw')]);
      await c.query(`INSERT INTO accounts (id, kind, name, number_last4) VALUES ($1,'checking','Smart Checking','2468')`, [chk]);
      await c.query(`INSERT INTO account_owners (account_id, user_id, role) VALUES ($1,$2,'owner')`, [chk, uid]);
      await post(c, { key: `ui:fund:${username}`, kind: 'seed', lines: [{ accountId: chk, amountCents: 3_000_00n, description: 'Opening deposit' },
        { accountId: await systemAccount(c, 'equity'), amountCents: -3_000_00n, description: 'Opening deposit' }] });
    });
    return username;
  };
  const noSideways = async (page, what) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `${what} is ${over}px wider than the screen`);
  };
  const consoleErrors = page => { const errs = []; page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url ?? '')) errs.push(m.text() + ' @ ' + (m.location()?.url ?? '')); }); return errs; };
  const enterCode = async page => {
    await page.waitForSelector('dialog.stepup #su-demo b');
    await page.fill('#su-code', (await page.textContent('#su-demo b')).trim());
    await page.click('#su-go');
  };
  const signedIn = async (page, user, pass = 'pw') => { await logIn(page, user, pass); await page.waitForURL('**/app'); };
  const cashPlus = async () => (await env.q("SELECT id FROM accounts WHERE number_last4 = '0088'")).rows[0].id;

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await test(`cards list shows the Cash+ Card and debit cards, last 4 only (${label})`, async page => {
      const errs = consoleErrors(page);
      await signedIn(page, 'nizam@helixbots.ai', 'nizam');
      await page.goto(base + '/app/cards');
      await page.waitForSelector('#credit .c-tile');
      assert.match(await page.textContent('#credit'), /•••• •••• •••• 0088/);
      assert.match(await page.textContent('#credit'), /\$418\.20/);
      assert.equal(await page.locator('#debit .c-tile').count(), 2);
      assert.ok(!(await page.content()).match(/\d{12,}/), 'no full card numbers on the page');
      await noSideways(page, 'cards list');
      assert.deepEqual(errs, [], errs.join(' / '));
      if (shots) await page.screenshot({ path: `${shots}/${label}-cards.png`, fullPage: true });
    }, { width: w, height: h });

    await test(`credit card detail: statement, minimum due, payment options (${label})`, async page => {
      const errs = consoleErrors(page);
      await signedIn(page, 'nizam@helixbots.ai', 'nizam');
      await page.goto(base + `/app/cards-detail?account=${await cashPlus()}`);
      await page.waitForSelector('#st-body .stat');
      assert.match(await page.textContent('#mindue'), /\$35\.00/);
      assert.match(await page.textContent('#st-body'), /\$259\.71/);
      assert.match(await page.textContent('#st-body'), /Skyway Airlines/);
      assert.match(await page.textContent('#pay'), /Statement balance\s*\$259\.71/);
      assert.match(await page.textContent('#view'), /greater of \$35\.00 or 1%/);
      await noSideways(page, 'card detail');
      assert.deepEqual(errs, [], errs.join(' / '));
      if (shots) await page.screenshot({ path: `${shots}/${label}-card-detail.png`, fullPage: true });
    }, { width: w, height: h });

    await test(`apply page lists the lineup and prequalifies with a soft check (${label})`, async page => {
      const errs = consoleErrors(page);
      await signedIn(page, 'nizam@helixbots.ai', 'nizam');
      await page.goto(base + '/app/cards-apply');
      await page.waitForSelector('.prod-tile');
      assert.equal(await page.locator('.prod-tile').count(), 4);
      await page.fill('#pq [name=income]', '85000'); await page.fill('#pq [name=housing]', '1400');
      await page.click('#pq button');
      await page.waitForSelector('.prequal .pq');
      assert.match(await page.textContent('#pq-out'), /score: 742/);       // the /app/credit score (was a separate username hash, 764)
      assert.match(await page.textContent('#pq-out'), /doesn't affect your score|does not change your score/);
      await noSideways(page, 'apply page');
      assert.deepEqual(errs, [], errs.join(' / '));
      if (shots) await page.screenshot({ path: `${shots}/${label}-cards-apply.png`, fullPage: true });
    }, { width: w, height: h });
  }

  await test('debit card: lock declines a purchase at once, unlock restores it (no money moves)', async page => {
    await signedIn(page, 'nizam@helixbots.ai', 'nizam');
    await page.goto(base + '/app/cards');
    await page.click('#debit .c-tile:has-text("··4471")');
    await page.waitForSelector('#lock');
    const before = (await env.q("SELECT balance_cents FROM accounts WHERE number_last4 = '4471'")).rows[0].balance_cents;
    await page.click('#lock');
    await page.waitForSelector('#unlock');
    assert.match(await page.textContent('.pcard'), /Locked/);
    await page.click('#buy button');
    await page.waitForFunction(() => /Declined/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#flash'), /locked/);
    await page.click('#unlock');
    await enterCode(page);                                                  // unlocking asks for a one-time code, like unfreezing
    await page.waitForSelector('#lock');
    assert.equal((await env.q("SELECT balance_cents FROM accounts WHERE number_last4 = '4471'")).rows[0].balance_cents, before);
    if (shots) await page.screenshot({ path: `${shots}/desktop-debit-detail.png`, fullPage: true });
  });

  await test('card controls: online off declines a simulated online purchase; turning it back on asks for a code (phone)', async page => {
    const errs = consoleErrors(page);
    const user = await customer('cleo+score700');
    await tx(env.pool, async c => (await import('../../lib/seeds/cards.mjs')).seed(c));
    await signedIn(page, user);
    await page.goto(base + '/app/cards');
    await page.click('#debit .c-tile');
    await page.waitForSelector('button[role=switch][data-channel=online]');
    await noSideways(page, 'debit detail');
    await page.click('button[role=switch][data-channel=online]');
    await page.waitForFunction(() => document.querySelector('button[role=switch][data-channel=online]')?.getAttribute('aria-checked') === 'false');
    await page.selectOption('#buy [name=channel]', 'online');
    await page.click('#buy button');
    await page.waitForFunction(() => /Declined \(simulated\)/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#flash'), /turned off/);
    assert.match(await page.textContent('#buy-h'), /Simulated/);
    await page.click('button[role=switch][data-channel=online]');
    await enterCode(page);
    await page.waitForFunction(() => document.querySelector('button[role=switch][data-channel=online]')?.getAttribute('aria-checked') === 'true');
    await page.fill('.ctl-lim[data-channel=atm] [name=limit]', '60');
    await page.click('.ctl-lim[data-channel=atm] button');
    await page.waitForFunction(() => /daily limit \$60\.00/.test(document.querySelector('#flash').textContent));
    await noSideways(page, 'debit detail after changes');
    const real = errs.filter(e => !/status of (422|403)/.test(e));             // the decline and the step-up ask are expected responses
    assert.deepEqual(real, [], real.join(' / '));
    if (shots) await page.screenshot({ path: `${shots}/phone-debit-controls.png`, fullPage: true });
  }, { width: 390, height: 844 });

  await test('Zak sees his open dispute and locked debit card (phone)', async page => {
    const errs = consoleErrors(page);
    await signedIn(page, 'zak@helixbots.ai', 'zak');
    await page.goto(base + '/app/cards');
    await page.waitForSelector('#credit .c-tile');
    assert.match(await page.textContent('#debit'), /Locked/);
    await page.click('#credit .c-tile');
    await page.waitForSelector('#dp-h');
    assert.match(await page.textContent('#view'), /Airline tickets/);
    assert.match(await page.textContent('#view'), /Open, provisional credit given/);
    await noSideways(page, 'credit detail');
    assert.deepEqual(errs, [], errs.join(' / '));
  }, { width: 390, height: 844 });

  await test('the full virtual number shows only after a one-time code, then hides', async page => {
    await signedIn(page, 'nizam@helixbots.ai', 'nizam');
    await page.goto(base + `/app/cards-detail?account=${await cashPlus()}`);
    await page.click('#reveal');
    await enterCode(page);
    await page.waitForSelector('#vnum');
    const num = (await page.textContent('#vnum')).match(/[\d ]{19}/)[0].replace(/ /g, '');
    assert.ok(luhnValid(num)); assert.ok(num.endsWith('0088'));
  }, { width: 390, height: 844 });

  await test('a new customer applies (with a code), is approved, buys, disputes and pays', async page => {
    const user = await customer('pat+score780');
    await signedIn(page, user);
    await page.goto(base + '/app/cards-apply?product=cash_plus');
    await page.waitForSelector('.prod-tile');
    await page.fill('#apply [name=income]', '70000'); await page.fill('#apply [name=housing]', '1200');
    await page.check('#apply [name=consent]');
    await page.click('#apply button.pri');
    await enterCode(page);
    await page.waitForSelector('.decision.approve');
    assert.match(await page.textContent('#result'), /approved/);
    assert.match(await page.textContent('#result'), /\$7,000\.00/);
    if (shots) await page.screenshot({ path: `${shots}/desktop-cards-approved.png`, fullPage: true });
    await page.click('text=Go to your card');
    await page.waitForSelector('#buy');
    await page.fill('#buy [name=merchant]', 'Gadget Hub'); await page.fill('#buy [name=amount]', '80.00');
    await page.click('#buy button');
    await page.waitForFunction(() => /Approved \(simulated\): Gadget Hub/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#owed'), /\$80\.00/);
    await page.click('[data-dispute]');
    await page.selectOption('#dlg [name=reason]', 'not_received');
    await page.click('#dlg-go');
    await page.waitForFunction(() => /Dispute opened/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#owed'), /\$0\.00/);
    assert.match(await page.textContent('[data-resolve]'), /Demo: simulate/);     // no "you win" choice: the bank's rules decide
    await page.click('[data-resolve]');
    await page.waitForFunction(() => /re-billed|billed again/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#owed'), /\$80\.00/);
    await page.check('#pay [value=current]');
    await page.click('#pay button.pri');
    await page.waitForFunction(() => /Payment of \$80\.00/.test(document.querySelector('#flash').textContent));
    assert.match(await page.textContent('#owed'), /\$0\.00/);
    await page.click('#autopay button.pri');
    await page.waitForFunction(() => /Autopay is on/.test(document.querySelector('#flash').textContent));
    await noSideways(page, 'card detail after actions');
  });

  await test('a DECLINE applicant sees plain-words reasons', async page => {
    const user = await customer('dana+decline');
    await signedIn(page, user);
    await page.goto(base + '/app/cards-apply');
    await page.waitForSelector('.prod-tile');
    await page.click('[data-pick=campus]');
    await page.fill('#apply [name=income]', '30000'); await page.fill('#apply [name=housing]', '800');
    await page.check('#apply [name=consent]');
    await page.click('#apply button.pri');
    await enterCode(page);
    await page.waitForSelector('.decision.decline');
    assert.match(await page.textContent('#result'), /late payment or collection/);
    assert.match(await page.textContent('#result'), /adverse action notice/);
    if (shots) await page.screenshot({ path: `${shots}/phone-cards-declined.png`, fullPage: true });
  }, { width: 390, height: 844 });

  await test('a short score gets the Secured Card counteroffer; accepting takes the deposit', async page => {
    const user = await customer('sam+score640');
    await signedIn(page, user);
    await page.goto(base + '/app/cards-apply?product=cash_plus');
    await page.waitForSelector('.prod-tile');
    await page.fill('#apply [name=income]', '40000'); await page.fill('#apply [name=housing]', '900');
    await page.check('#apply [name=consent]');
    await page.click('#apply button.pri');
    await enterCode(page);
    await page.waitForSelector('.decision.counteroffer #accept');
    assert.match(await page.textContent('#result'), /Secured Card/);
    await page.fill('#accept [name=deposit]', '400');
    await page.click('#accept button.pri');
    await page.waitForSelector('text=Go to your card');
    assert.equal((await env.q(`SELECT a.balance_cents FROM accounts a JOIN account_owners o ON o.account_id = a.id JOIN users u ON u.id = o.user_id
      WHERE u.username = $1 AND a.kind = 'checking'`, [user])).rows[0].balance_cents, 2_600_00n);
  });

  await test('a minor is told credit cards are for 18 and older', async page => {
    await logIn(page, 'ava@usabanc.example', 'ava-demo-pass');
    await page.waitForSelector('#step-code:not([hidden])');
    await page.locator('#code input').first().fill((await page.textContent('#democode')).trim());
    await page.waitForURL('**/app');
    await page.goto(base + '/app/cards-apply');
    await page.waitForFunction(() => /18 and older/.test(document.querySelector('#result').textContent));
    assert.ok(await page.locator('#flow').isHidden());
    await page.goto(base + '/app/cards');
    await page.waitForSelector('#debit .c-tile');
    assert.ok(await page.locator('#apply').isHidden());
  });
}
