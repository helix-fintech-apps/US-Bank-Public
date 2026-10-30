// Open an account + Family pages. These flows move demo money, so they run against their own database schema
// (a second test server) and never change the balances the core dashboard tests check.
import assert from 'node:assert/strict';
import { testEnv } from '../helpers.mjs';

export default async function ({ test, shots }) {
  const env = await testEnv(), base = env.base;
  const logIn = async (page, user, pass) => {
    await page.goto(base + '/login');
    await page.fill('#user', user); await page.fill('#pass', pass);
    await page.click('#step-creds button[type=submit]');
    if (!/@helixbots\.ai$/.test(user)) {                                      // Helix team logins sign straight in
      await page.waitForSelector('#step-code:not([hidden])');
      await page.locator('#code input').first().fill((await page.textContent('#democode')).trim());
    }
    await page.waitForURL('**/app');
  };
  const NIZAM = ['nizam@helixbots.ai', 'nizam'], JORDAN = ['jordan@usabanc.example', 'jordan-demo-pass'], AVA = ['ava@usabanc.example', 'ava-demo-pass'];
  const noSideScroll = async (page, what) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `${what} is ${over}px wider than the screen`);
  };
  const fillIdentity = async (page, name = 'Nizam Ali') => {
    await page.fill('#legalName', name); await page.fill('#dob', '1988-04-12'); await page.fill('#ssn', '512-34-7788');
    await page.fill('#line1', '100 Harbor St'); await page.fill('#city', 'Minneapolis'); await page.selectOption('#state', 'MN'); await page.fill('#zip', '55401');
  };
  // the code dialog the browser shows before a risky action
  const stepUp = async page => {
    await page.waitForSelector('dialog.stepup #su-demo:not([hidden])');
    await page.fill('#su-code', (await page.textContent('#su-demo b')).trim());
    await page.click('#su-go');
  };

  const consoleErrors = page => {                                            // fonts are blocked by the runner on purpose
    const errs = [];
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url ?? '')) errs.push(m.text()); });
    return errs;
  };
  const ASIM = ['asim@helixbots.ai', 'asim'], ZAK = ['zak@helixbots.ai', 'zak'];

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const [route, who] of [['/app/open', NIZAM], ['/app/family', NIZAM], ['/app/family', AVA], ['/app/open', AVA], ['/app/family', ZAK]]) {
      await test(`${route} for ${who[0].split('@')[0]} renders on ${label} with no sideways scroll or console errors`, async page => {
        const errs = consoleErrors(page);
        await logIn(page, ...who);
        await page.goto(base + route);
        await page.waitForSelector(route === '/app/open' ? (who === AVA ? '#minor-note:not([hidden])' : '.af-prod') : '.fam');
        assert.ok(await page.locator('.dash-nav a[href="/app/family"]').count());
        await noSideScroll(page, route);
        assert.ok(await page.locator('.sv-sub a[href="/app/open"]').count(), 'pill nav');
        assert.deepEqual(errs, [], 'console errors');
        if (shots) await page.screenshot({ path: `${shots}/${label}-af-${who[0].split('@')[0]}${route.replace(/\//g, '-')}.png`, fullPage: true });
      }, { width: w, height: h });
    }
  }

  await test('open a savings account: four steps, e-sign, approved and funded', async page => {
    await logIn(page, ...NIZAM);
    await page.goto(base + '/app/open');
    await page.click('.af-prod:has-text("Bright Savings")');
    assert.equal(await page.isVisible('#back'), false, 'back visible');
    assert.equal(await page.isVisible('#co-owner'), false, 'co-owner visible');
    await page.click('#next');
    await fillIdentity(page);
    await page.click('#next');
    assert.match(await page.textContent('#min-note'), /\$25\.00 to open/);
    await page.fill('#amount', '40.00');
    await page.click('#next');
    await page.waitForSelector('#docs li');
    assert.match(await page.textContent('#review'), /···-··-7788/);
    await page.click('#next');
    assert.match(await page.textContent('#form-err'), /accept the disclosures/);
    await page.check('#esign');
    await page.click('#next');
    await page.waitForSelector('#result:not([hidden])');
    assert.equal((await page.textContent('#result-state')).trim(), 'Approved', await page.textContent('#result'));
    assert.match(await page.textContent('#result'), /Bright Savings ··\d{4}.* is open with \$40\.00/);
    if (shots) await page.screenshot({ path: `${shots}/desktop-af-open-approved.png`, fullPage: true });
    await page.goto(base + '/app');
    await page.waitForSelector('.acct');
    assert.equal(await page.locator('.acct:has-text("Bright Savings")').count(), 2);
  });

  await test('a name on the simulated watch list goes to review and moves no money', async page => {
    await logIn(page, ...NIZAM);
    await page.goto(base + '/app/open');
    await page.click('.af-prod:has-text("Smart Checking")');
    await page.click('#next'); await fillIdentity(page, 'Nizam TEST OFAC Ali'); await page.click('#next');
    await page.click('#next'); await page.waitForSelector('#docs li'); await page.check('#esign'); await page.click('#next');
    await page.waitForSelector('#result:not([hidden])');
    assert.equal((await page.textContent('#result-state')).trim(), 'In review', await page.textContent('#result'));
    assert.match(await page.textContent('#result'), /sanctions list/);
    assert.match(await page.textContent('#result'), /No money moved/);
  }, { width: 390, height: 844 });

  await test('joint: a one-time code before inviting, then the co-owner accepts on their side', async page => {
    await logIn(page, ...NIZAM);
    await page.goto(base + '/app/open');
    await page.click('.af-prod:has-text("Premier Money Market")');
    await page.check('input[name=ownership][value=joint]');
    await page.fill('#co-owner', JORDAN[0]);
    await page.click('#next'); await fillIdentity(page); await page.click('#next');
    await page.click('#next'); await page.waitForSelector('#docs li');
    assert.match(await page.textContent('#docs'), /Joint ownership terms/);
    await page.check('#esign'); await page.click('#next');
    await stepUp(page);
    await page.waitForSelector('#result:not([hidden])');
    assert.match(await page.textContent('#result'), /invited jordan@usabanc\.example/);
    const ctx = page.context(); await ctx.clearCookies();
    await logIn(page, ...JORDAN);
    await page.goto(base + '/app/open');
    await page.waitForSelector('.invite');
    assert.match(await page.textContent('.invite h2'), /Nizam invited you/);
    await page.click('.inv-yes');
    const f = page.locator('.invite .inv-form');
    await f.locator('[data-k=legalName]').fill('Jordan Lee'); await f.locator('[data-k=dob]').fill('1990-01-01'); await f.locator('[data-k=ssn]').fill('521-11-2233');
    await f.locator('[data-k=line1]').fill('9 Elm St'); await f.locator('[data-k=city]').fill('Saint Paul'); await f.locator('[data-k=state]').selectOption('MN'); await f.locator('[data-k=zip]').fill('55102');
    await page.check('.inv-esign');
    await page.click('.inv-yes');
    await page.waitForSelector('.invite .af-badge');
    assert.match(await page.textContent('.invite'), /now a joint owner of Premier Money Market/);
    await page.goto(base + '/app'); await page.waitForSelector('.acct');
    assert.equal(await page.locator('.acct:has-text("Premier Money Market")').count(), 1);
  });

  await test('parent: tighten limits, add and pay a chore, freeze the card; every change shows in recent decisions', async page => {
    await logIn(page, ...NIZAM);
    await page.goto(base + '/app/family');
    await page.waitForSelector('.fam');
    assert.match(await page.textContent('.fam'), /\$10\.00 every week from Smart Checking ··4471/);
    await page.fill('input[name=dailyLimit]', '20.00');
    await page.check('input[name=cat][value="ATM cash"]');
    await page.click('form[data-act=controls] button');
    await page.waitForFunction(() => document.querySelector('input[name=dailyLimit]').value === '20.00' && /Spending controls changed/.test(document.querySelector('.fam').textContent));
    await page.fill('input[name=title]', 'Rake the leaves'); await page.fill('input[name=reward]', '6.00');
    await page.click('form[data-act=chore] button');
    await page.waitForSelector('li:has-text("Rake the leaves") button[data-act=approve]');
    await page.click('li:has-text("Rake the leaves") button[data-act=approve]');
    await page.waitForSelector('li:has-text("Rake the leaves") .af-badge.paid');
    assert.match(await page.textContent('.fam .bal'), /\$70\.00/);
    await page.click('button[data-act=freeze][data-target=card]');
    await page.waitForSelector('.af-badge.frozen');
    assert.match(await page.textContent('.fam'), /Chore approved and paid/);
    if (shots) await page.screenshot({ path: `${shots}/desktop-af-family-parent.png`, fullPage: true });
    await page.click('button[data-act=freeze][data-target=card]');                  // unfreeze: needs a code
    await stepUp(page);
    await page.waitForFunction(() => !document.querySelector('.af-badge.frozen'));
  });

  await test('minor: sees only their own account, a purchase in a turned-off category is declined, a small one is approved', async page => {
    await logIn(page, ...AVA);
    await page.goto(base + '/app/family');
    await page.waitForSelector('.fam');
    assert.equal(await page.locator('.fam').count(), 1);
    assert.equal(await page.locator('form[data-act=controls]').count(), 0);
    assert.match(await page.textContent('h1'), /My money/);
    await page.fill('input[name=merchant]', 'Game Hub'); await page.fill('input[name=amount]', '5.00');
    await page.selectOption('select[name=category]', 'Gaming');
    await page.click('form[data-act=purchase] button');
    await page.waitForFunction(() => /turned off by a parent/.test(document.querySelector('form[data-act=purchase]').closest('.fam-panel').querySelector('.af-err').textContent));
    await page.selectOption('select[name=category]', 'Food & Dining');
    await page.fill('input[name=merchant]', 'Taco Stand'); await page.fill('input[name=amount]', '4.50');
    await page.click('form[data-act=purchase] button');
    await page.waitForSelector('.af-ok:has-text("Approved")');
    assert.match(await page.textContent('.fam .bal'), /\$65\.50/);
    await page.click('button[data-act=submit]');
    await page.waitForSelector('.af-badge.submitted');
    await noSideScroll(page, 'family (minor)');
    if (shots) await page.screenshot({ path: `${shots}/phone-af-family-minor.png`, fullPage: true });
  }, { width: 390, height: 844 });

  await test('links from the public pages pick the account: ?product=cd, joint, custodial, teen', async page => {
    await logIn(page, ...NIZAM);
    for (const [q, code, more] of [['cd', 'cd_12'], ['money_market', 'premier_mm'], ['joint', 'smart_checking', 'joint'], ['custodial', 'custodial_savings', 'minor'], ['teen', 'teen_checking', 'minor']]) {
      await page.goto(`${base}/app/open?product=${q}`);
      await page.waitForSelector('.af-prod');
      assert.equal(await page.inputValue('input[name=product]:checked'), code, q);
      if (more === 'joint') assert.ok(await page.isVisible('#co-owner'), 'joint box');
      if (more === 'minor') assert.match(await page.textContent('#minor-choices'), /Ava, age \d+/, q);
    }
  });

  await test('Asim (phone): accepts Zak\'s joint invitation, then sees it shared and manages Mia\'s savings on Family', async page => {
    await logIn(page, ...ASIM);
    await page.goto(base + '/app/open');
    await page.waitForSelector('.invite');
    assert.match(await page.textContent('.invite h2'), /Zak invited you/);
    await page.click('.invite .inv-yes');
    const f = page.locator('.invite .inv-form');
    await f.locator('[data-k=legalName]').fill('Asim Khan'); await f.locator('[data-k=dob]').fill('1991-02-03'); await f.locator('[data-k=ssn]').fill('533-22-1144');
    await f.locator('[data-k=line1]').fill('5 Lake St'); await f.locator('[data-k=city]').fill('Duluth'); await f.locator('[data-k=state]').selectOption('MN'); await f.locator('[data-k=zip]').fill('55802');
    await page.check('.invite .inv-esign');
    await page.click('.invite .inv-yes');
    await page.waitForSelector('.invite .af-badge.approved');
    await page.click('.sv-sub a[href="/app/family"]');
    await page.waitForSelector('.fam-shared');
    assert.match(await page.textContent('.fam-shared'), /Team Trip Savings ··7133[\s\S]*with Zak/);
    assert.match(await page.textContent('.fam'), /Mia's Custodial Savings/);
    await page.fill('form[data-act=goal] input[name=name]', 'Art class'); await page.fill('form[data-act=goal] input[name=target]', '80.00');
    await page.click('form[data-act=goal] button');
    await page.waitForSelector('.goal:has-text("Art class")');
    await noSideScroll(page, 'family (asim)');
  }, { width: 390, height: 844 });

  await env.close();
}
