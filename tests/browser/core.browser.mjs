// Core pages: landing, sign-in, dashboard. Every feature adds its own tests/browser/<feature>.browser.mjs like this one.
import assert from 'node:assert/strict';

export default async function ({ test, base, logIn, shots }) {
  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const route of ['/', '/login']) {
      await test(`${route} renders on ${label} with no sideways scroll`, async page => {
        const r = await page.goto(base + route); assert.equal(r.status(), 200);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `page is ${over}px wider than the screen`);
        if (shots) await page.screenshot({ path: `${shots}/${label}${route === '/' ? '-home' : route.replace(/\//g, '-')}.png`, fullPage: route === '/' });
      }, { width: w, height: h });
    }
  }

  await test('mega menu opens one panel at a time and closes on Escape', async page => {
    await page.goto(base + '/');
    await page.click('button[aria-controls="m-personal"]');
    assert.equal(await page.$$eval('.mega', m => m.filter(x => !x.hidden).length), 1);
    await page.click('button[aria-controls="m-family"]');
    assert.equal(await page.$$eval('.mega', m => m.filter(x => !x.hidden).length), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.mega', m => m.filter(x => !x.hidden).length), 0);
  });

  await test('wrong password is refused and stays on the log-in page', async page => {
    await logIn(page, 'nizam@helixbots.ai', 'wrong');
    await page.waitForFunction(() => document.querySelector('#err1').textContent.length > 0);
    assert.match(await page.textContent('#err1'), /don't match/);
    assert.ok(page.url().endsWith('/login'));
  });

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await test(`demo user signs straight in and sees accounts from the database (${label})`, async page => {
      await logIn(page, 'nizam@helixbots.ai', 'nizam');
      await page.waitForURL('**/app');
      await page.waitForSelector('.acct');
      assert.match(await page.textContent('#hi'), /Welcome back, Nizam/);
      assert.equal(await page.locator('.acct').count(), 5);
      assert.match(await page.textContent('#tot'), /\$12,718\.55/);
      await page.waitForSelector('#tx tr td .dt');
      assert.ok((await page.locator('#tx tr').count()) >= 5);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `dashboard is ${over}px wider than the screen`);
      if (shots) await page.screenshot({ path: `${shots}/${label}-app.png`, fullPage: true });
    }, { width: w, height: h });
  }

  await test('a user with codes on enters the one-time code, then lands on their accounts', async page => {
    await logIn(page, 'jordan@usabanc.example', 'jordan-demo-pass');
    await page.waitForSelector('#step-code:not([hidden])');
    assert.match(await page.textContent('#phone'), /17/);
    const code = (await page.textContent('#democode')).trim();
    if (shots) await page.screenshot({ path: `${shots}/desktop-code.png` });
    await page.locator('#code input').first().fill(code);              // typing all 6 digits submits
    await page.waitForURL('**/app');
    await page.waitForSelector('.acct');
    assert.match(await page.textContent('#hi'), /Jordan/);
    assert.equal(await page.locator('.acct').count(), 2);
  });

  await test('choosing an account shows its own activity', async page => {
    await logIn(page, 'nizam@helixbots.ai', 'nizam');
    await page.waitForSelector('.acct');
    await page.click('.acct:has-text("Cash+ Card")');
    await page.waitForFunction(() => document.querySelector('#tx-h').textContent.includes('Cash+ Card'));
    assert.match(await page.textContent('#tx'), /Skyway Airlines/);
  });

  await test('log out ends the session; the dashboard then sends you to log in', async page => {
    await logIn(page, 'nizam@helixbots.ai', 'nizam');
    await page.waitForSelector('.acct');
    await Promise.all([page.waitForURL('**/login'), page.click('#signout')]);
    await page.goto(base + '/app');
    await page.waitForURL('**/login?next=%2Fapp');
  });

  await test('the home page signs in directly, and hands a code step to /login', async page => {
    await page.goto(base + '/');
    await page.fill('#hl-user', 'nizam@helixbots.ai'); await page.fill('#hl-pass', 'nizam');
    await Promise.all([page.waitForURL('**/app'), page.click('#hero-login button[type=submit]')]);
    await page.waitForSelector('.acct');
    await page.goto(base + '/');
    await page.fill('#hl-user', 'jordan@usabanc.example'); await page.fill('#hl-pass', 'jordan-demo-pass');
    await Promise.all([page.waitForURL('**/login#code'), page.click('#hero-login button[type=submit]')]);
    await page.waitForSelector('#step-code:not([hidden])');
    await page.locator('#code input').first().fill((await page.textContent('#democode')).trim());
    await page.waitForURL('**/app');
  });

  const PUBLIC = ['/open', '/cards', '/loans', '/credit', '/family', '/pay', '/learn', '/support', '/locations', '/about', '/security', '/enroll', '/forgot-password', '/business'];
  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await test(`all ${PUBLIC.length} info pages load on ${label} with no sideways scroll`, async page => {
      for (const route of PUBLIC) {
        const r = await page.goto(base + route); assert.equal(r.status(), 200, route);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `${route} is ${over}px wider than the screen`);
      }
    }, { width: w, height: h });
  }

  await test('the mortgage link on the home page opens the mortgage section', async page => {
    await page.goto(base + '/');
    await Promise.all([page.waitForURL('**/loans#mortgage'), page.click('.lt.big')]);
    assert.match(await page.textContent('#mortgage h2'), /Mortgage/);
  });
}
