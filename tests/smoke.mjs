// Browser test runner: one private database schema, the real API, one Chromium. Runs every tests/browser/*.browser.mjs
// (each exports a function that receives { test, base, logIn, shots, env }).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './helpers.mjs';

const env = await testEnv(), base = env.base;
const shots = process.env.SHOTS_DIR; if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let failed = 0;
async function test(name, fn, viewport = { width: 1280, height: 900 }) {
  const errors = [];
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());        // tests must not depend on the network
  try { await fn(page); assert.deepEqual(errors, [], 'script errors on the page'); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); }
  finally { await ctx.close(); }
}
const logIn = async (page, user, pass) => {
  await page.goto(base + '/login');
  await page.fill('#user', user); await page.fill('#pass', pass);
  await page.click('#step-creds button[type=submit]');
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.browser.mjs') && (!process.env.BROWSER_ONLY || f.includes(process.env.BROWSER_ONLY))).sort()) {   // BROWSER_ONLY=r5 runs one file
  console.log(`# ${f}`);
  await (await import(path.join(dir, f))).default({ test, base, logIn, shots, env });
}

await browser.close(); await env.close();
if (failed) { console.error(`browser: ${failed} failed`); process.exit(1); }
console.log('browser: all passed');
