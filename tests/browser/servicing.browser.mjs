// Servicing pages: activity, statements, alerts, settings, plus the unread-alerts pill on the dashboard.
// Leaves Nizam's password, phone and sign-in code setting as they were, so later browser tests still sign in the same way.
import assert from 'node:assert/strict';

const PAGES = [['/app/activity', '#list li[data-id]'], ['/app/statements', '#lines tr'], ['/app/alerts', '#inbox li'], ['/app/settings', '#devices li']];

export default async function ({ test, base, logIn, shots }) {
  const signedIn = async page => { await logIn(page, 'nizam@helixbots.ai', 'nizam'); await page.waitForURL('**/app'); };
  const consoleErrors = page => {                                            // fonts are blocked by the runner on purpose
    const errs = [];
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url ?? '')) errs.push(m.text()); });
    return errs;
  };
  const noSideScroll = async (page, what) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `${what} is ${over}px wider than the screen`);
  };

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const [route, ready] of PAGES) {
      await test(`${route} renders on ${label} with no sideways scroll or console errors`, async page => {
        const errs = consoleErrors(page);
        await signedIn(page);
        await page.goto(base + route);
        await page.waitForSelector(ready);
        await page.waitForLoadState('load');                       // not 'networkidle': it never settles on a loaded machine (3 one-off 30 s timeouts); the ready selector above is the real signal
        await page.waitForTimeout(400);                              // late script errors still show up before the assertion below
        await noSideScroll(page, route);
        assert.deepEqual(errs, [], 'console errors');
        if (shots) await page.screenshot({ path: `${shots}/${label}${route.replace(/\//g, '-')}.png`, fullPage: true });
      }, { width: w, height: h });
    }
  }

  await test('the dashboard shows the unread alerts count and links to the inbox', async page => {
    await signedIn(page);
    await page.waitForSelector('#alerts-pill:not([hidden])');
    assert.match(await page.textContent('#alerts-pill'), /^\d+ unread alerts?$/);
    await Promise.all([page.waitForURL('**/app/alerts'), page.click('#alerts-pill')]);
    await page.waitForSelector('#inbox li.unread');
  });

  await test('activity: search, then change a category without leaving the page', async page => {
    await signedIn(page);
    await page.goto(base + '/app/activity');
    await page.waitForSelector('#list li[data-id]');
    await page.fill('#f-q', 'payroll'); await page.click('#filters button.pri');
    await page.waitForFunction(() => document.querySelectorAll('#list li[data-id]').length === 2);
    const sel = page.locator('#list li[data-id] .sv-cat').first();
    await sel.selectOption('Other');
    await page.waitForFunction(() => document.querySelector('#list li[data-id] .sv-cat').classList.contains('over'));
    await sel.selectOption('Income');                                       // back to the original: the override is removed
    await page.waitForFunction(() => !document.querySelector('#list li[data-id] .sv-cat').classList.contains('over'));
    assert.match(await page.textContent('#spent'), /^\$[\d,]+\.\d{2}$/);
  });

  await test('statements: totals show and the PDF downloads', async page => {
    await signedIn(page);
    await page.goto(base + '/app/statements');
    await page.waitForSelector('#tiles div');
    assert.match(await page.textContent('#tiles'), /Opening balance.*Money in.*Money out.*Closing balance/s);
    const href = await page.getAttribute('#pdf', 'href');
    const r = await page.request.get(base + href);
    assert.equal(r.status(), 200); assert.equal(r.headers()['content-type'], 'application/pdf');
  });

  await test('alerts: mark everything read clears the badge; add and remove an alert', async page => {
    await signedIn(page);
    await page.goto(base + '/app/alerts');
    await page.waitForSelector('#inbox li.unread');
    await page.click('#allread');
    await page.waitForFunction(() => !document.querySelector('#inbox li.unread') && document.getElementById('sv-unread').hidden);
    assert.match(await page.textContent('#inbox'), /Would be emailed to nizam@helixbots\.ai \(simulated/);
    const before = await page.locator('#rules li[data-id]').count();
    await page.selectOption('#a-kind', 'large_purchase'); await page.fill('#a-amt', '250'); await page.click('#add button.pri');
    await page.waitForFunction(n => document.querySelectorAll('#rules li[data-id]').length === n + 1, before);
    assert.match(await page.textContent('#rules'), /Large purchase · over \$250\.00/);
    await page.locator('#rules li[data-id]').last().locator('.del').click();
    await page.waitForFunction(n => document.querySelectorAll('#rules li[data-id]').length === n, before);
  });

  await test('settings: a contact change asks for a code, then shows the change', async page => {
    await signedIn(page);
    await page.goto(base + '/app/settings');
    await page.waitForSelector('#p-view dd');
    await page.click('#p-edit');
    await page.fill('#p-line2', 'Apt 4B');
    await page.click('#p-form button.pri');
    await page.waitForSelector('dialog.stepup #su-demo:not([hidden]) b');
    if (shots) await page.screenshot({ path: `${shots}/desktop-settings-stepup.png` });
    await page.fill('#su-code', (await page.textContent('#su-demo b')).trim());
    await page.click('#su-go');
    await page.waitForSelector('#p-notices .sv-ok');
    assert.match(await page.textContent('#p-view'), /Apt 4B/);
  });

  await test('settings: send a secure message and get the simulated reply', async page => {
    await signedIn(page);
    await page.goto(base + '/app/settings#messages');
    await page.waitForSelector('#threads button');
    await page.click('#m-new');
    await page.fill('#m-subj', 'Travel notice'); await page.fill('#m-body', 'I will be in Lisbon next week.');
    await page.click('#reply button.pri');
    await page.waitForSelector('.sv-msg.bank');
    assert.match(await page.textContent('#thread'), /automatic reply \(simulated\)/);
    await page.waitForFunction(() => document.querySelector('#threads').textContent.includes('Travel notice'));
  });

  await test('settings: sign out another device from the security center', async page => {
    const other = await page.context().browser().newContext();               // a second device
    const p2 = await other.newPage();
    await p2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await logIn(p2, 'nizam@helixbots.ai', 'nizam'); await p2.waitForURL('**/app');
    await signedIn(page);
    await page.goto(base + '/app/settings#security');
    await page.waitForSelector('#devices li');
    const n = await page.locator('#devices li').count();
    assert.ok(n >= 2); assert.equal(await page.locator('#devices .sv-tag').count(), 1);
    await page.locator('#devices li:not(:has(.sv-tag)) .out').first().click();
    await page.waitForFunction(k => document.querySelectorAll('#devices li').length === k - 1, n);
    assert.equal(await page.locator('#devices .sv-tag').count(), 1);           // still signed in here
    await other.close();
  });

  await test('settings: overdraft coverage switches on and off, with the fee forgiveness note', async page => {
    await signedIn(page);
    await page.goto(base + '/app/settings#overdraft');
    await page.waitForSelector('#od li button[role=switch]');
    assert.match(await page.textContent('#od-help'), /waive it when you bring your available balance back/);
    const sw = page.locator('#od li').first().locator('button[role=switch]');
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    await sw.click();
    await page.waitForFunction(() => document.querySelector('#od li button[role=switch]').getAttribute('aria-checked') === 'true' && /Covered/.test(document.querySelector('#od li').textContent));
    assert.match(await page.textContent('#od li'), /Covered \(simulated\).*still declines anything that would take the account below \$0\.00/);
    await page.locator('#od li').first().locator('button[role=switch]').click();
    await page.waitForFunction(() => /Not covered/.test(document.querySelector('#od li').textContent));
  });
}
