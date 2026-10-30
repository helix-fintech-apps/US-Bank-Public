// Loans and credit score pages: layout at desktop and phone width, apply → decision → accept → pay, and the credit tools.
import assert from 'node:assert/strict';

export default async function ({ test, base, logIn, shots }) {
  const signIn = async (page, user, pass) => { await logIn(page, user, pass); await page.waitForURL('**/app'); };
  const nizamIn = page => signIn(page, 'nizam@helixbots.ai', 'nizam');
  const asimIn = page => signIn(page, 'asim@helixbots.ai', 'asim');
  const noSideways = async (page, what) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `${what} is ${over}px wider than the screen`);
  };
  const enterCode = async page => {                                     // the step-up dialog from client.js
    await page.waitForSelector('dialog.stepup #su-demo:not([hidden])');
    await page.fill('#su-code', (await page.textContent('#su-demo b')).trim());
    await page.click('#su-go');
  };

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await test(`credit score page: gauge, history, factors, pulls, alerts and offers, labeled simulated (${label})`, async page => {
      await nizamIn(page);
      await page.goto(base + '/app/credit');
      await page.waitForSelector('#factors .cs-factor');
      assert.match(await page.textContent('.lc-note'), /Simulated: no real credit bureau/);
      assert.match(await page.textContent('#score'), /^\d{3}$/);
      assert.equal(await page.locator('#hist-table tbody tr').count(), 12);
      assert.equal(await page.locator('#factors .cs-factor').count(), 5);
      assert.match(await page.textContent('#factors'), /17% of your card limits/);
      assert.ok(await page.locator('#offers a[href="/app/cards"]').count() === 1);
      assert.ok(await page.locator('#offers a[href^="/app/loans?apply="]').count() >= 1);
      assert.match(await page.textContent('#inquiries'), /Personal Loan application.*Simulated bureau/s);
      assert.match(await page.textContent('#alerts'), /New hard inquiry/);
      await noSideways(page, 'credit page');
      if (shots) await page.screenshot({ path: `${shots}/${label}-credit.png`, fullPage: true });
    }, { width: w, height: h });

    await test(`loans list and loan detail with schedule, payments and payoff quote (${label})`, async page => {
      await asimIn(page);
      await page.goto(base + '/app/loans');
      await page.waitForSelector('#loans .loan');
      assert.match(await page.textContent('#loans'), /Used Auto Loan ··6142/);
      assert.equal(await page.locator('#products .product').count(), 6);
      await noSideways(page, 'loans list');
      if (shots) await page.screenshot({ path: `${shots}/${label}-loans.png`, fullPage: true });
      await page.click('#loans .loan a');
      await page.waitForSelector('#remaining tbody tr');
      assert.equal(await page.locator('#payments tbody tr').count(), 3);
      assert.equal(await page.locator('#remaining tbody tr').count(), 57);
      assert.equal(await page.textContent('#tot-principal'), '$18,500.00');
      assert.match(await page.textContent('#payoff-total'), /^\$\d/);
      await noSideways(page, 'loan detail');
      if (shots) await page.screenshot({ path: `${shots}/${label}-loan-detail.png`, fullPage: true });
    }, { width: w, height: h });

    await test(`apply page with a vehicle, and a declined decision with ranked reasons (${label})`, async page => {
      await nizamIn(page);
      await page.goto(base + '/app/loans?apply=auto_used');
      await page.waitForSelector('#vehicleValue');
      await noSideways(page, 'apply page');
      if (shots) await page.screenshot({ path: `${shots}/${label}-apply.png`, fullPage: true });
      await page.fill('#amount', '15000'); await page.fill('#annualIncome', '90000'); await page.fill('#housingPayment', '1500');
      await page.fill('#vehicleValue', '20000'); await page.fill('#legalName', 'Pat DECLINE');
      await page.click('#submit');
      await enterCode(page);
      await page.waitForSelector('#decision[data-decision="declined"]');
      assert.match(await page.textContent('#reasons'), /DECLINE/);
      await noSideways(page, 'decision page');
      if (shots) await page.screenshot({ path: `${shots}/${label}-declined.png`, fullPage: true });
    }, { width: w, height: h });
  }

  await test('what-if: paying down the card shows a higher simulated score', async page => {
    await nizamIn(page);
    await page.goto(base + '/app/credit');
    await page.waitForSelector('#whatif');
    await page.fill('#payDown', '418.20');
    await page.click('#sim-go');
    await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Simulated score'));
    assert.match(await page.textContent('#result'), /\+20 points/);
  });

  await test('credit alerts: mark one read, then all', async page => {
    await nizamIn(page);
    await page.goto(base + '/app/credit');
    await page.waitForSelector('#alerts li.unread');
    await page.click('#alerts li.unread .mark');
    await page.waitForFunction(() => !document.querySelector('#alerts li.unread') || document.querySelector('#allread'));
    await page.click('#allread');
    await page.waitForFunction(() => !document.querySelector('#alerts li.unread'));
  });

  await test("Nizam's waiting offer: accept it from the list, phone width", async page => {
    await nizamIn(page);
    await page.goto(base + '/app/loans');
    await page.waitForSelector('#waiting li');
    assert.match(await page.textContent('#waiting'), /Personal Loan: \$8,000\.00/);
    await page.click('#waiting a.btn');
    await page.waitForSelector('#decision[data-decision="approved"]');
    if (shots) await page.screenshot({ path: `${shots}/phone-offer.png`, fullPage: true });
    await noSideways(page, 'offer page');
    await page.click('#accept');
    await enterCode(page);
    await page.waitForSelector('#done');
    await page.click('#done a');
    await page.waitForSelector('#pay');
    assert.equal(await page.textContent('#owed'), '$8,000.00');
    await noSideways(page, 'new loan');
  }, { width: 390, height: 844 });

  await test('prequalify, apply with a code, accept the offer, then pay and pay off', async page => {
    await nizamIn(page);
    await page.goto(base + '/app/loans?apply=personal');
    await page.waitForSelector('#amount');
    await page.fill('#amount', '10000'); await page.fill('#annualIncome', '120000'); await page.fill('#housingPayment', '1650');
    await page.click('#check');
    await page.waitForSelector('#estimate');
    assert.match(await page.textContent('#estimate'), /likely qualify.*no effect on your score/s);
    await page.click('#submit');
    await enterCode(page);
    await page.waitForSelector('#decision[data-decision="approved"]');
    assert.equal(await page.textContent('#o-amount'), '$10,000.00');
    if (shots) await page.screenshot({ path: `${shots}/desktop-approved.png`, fullPage: true });
    await page.click('#accept');                                          // the code from a moment ago still counts
    await page.waitForSelector('#done');
    await page.click('#done a');
    await page.waitForSelector('#pay');
    assert.equal(await page.textContent('#owed'), '$10,000.00');
    await page.click('#pay-go');
    await page.waitForFunction(() => /principal/.test(document.querySelector('#ok')?.textContent ?? ''));
    assert.equal(await page.locator('#payments tbody tr').count(), 1);
    await page.check('input[value=payoff]');
    await page.click('#pay-go');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Paid off');
    assert.match(await page.textContent('#ok'), /paid off/);
  });

  await test('a minor is told credit tools are for adults', async page => {
    await logIn(page, 'ava@usabanc.example', 'ava-demo-pass');
    await page.waitForSelector('#step-code:not([hidden])');
    await page.locator('#code input').first().fill((await page.textContent('#democode')).trim());
    await page.waitForURL('**/app');
    await page.goto(base + '/app/credit');
    await page.waitForSelector('.err');
    assert.match(await page.textContent('.err'), /18 or older/);
  });
}
