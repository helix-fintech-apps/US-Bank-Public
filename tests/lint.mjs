// Fast checks with no browser, on every page in public/:
// - every internal link and asset resolves to a file (Vercel clean URLs)
// - every #anchor, on the same page or another page, has a matching id
// - every page has a title and says it is a demo
// - no page uses another bank's name as its own title
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from './serve.mjs';

const pub = path.resolve('public');
const pages = fs.readdirSync(pub, { recursive: true }).filter(f => f.endsWith('.html'));
const errors = [], notes = new Set();
// signed-in app pages that feature PRs are adding; a link to one is allowed until it lands (and noted)
const PLANNED_APP = new Set();   // every /app page is built; add a path here only while its feature is in progress
const SHELL = html => html.includes('/assets/client.js');           // signed-in pages get the demo notice from client.js
const ids = f => new Set([...fs.readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

for (const p of pages) {
  const file = path.join(pub, p), html = fs.readFileSync(file, 'utf8');
  if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${p}: missing <title>`);
  if (!/fictional demo bank|fictional bank/i.test(html) && !SHELL(html)) errors.push(`${p}: missing the "fictional demo bank" notice`);
  if (/<title>[^<]*U\.?S\.? Bank/i.test(html)) errors.push(`${p}: title uses another bank's name`);
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|tel:|data:)/.test(url)) continue;
    const [route, frag] = url.split('#');
    if (!route) { if (frag && !ids(file).has(frag)) errors.push(`${p}: no element with id "${frag}"`); continue; }
    if (!route.startsWith('/')) continue;
    const clean = route.split('?')[0];
    const target = resolve(clean);
    if (!target) { if (PLANNED_APP.has(clean)) notes.add(clean); else errors.push(`${p}: broken link ${url}`); continue; }
    if (frag && target.endsWith('.html') && !ids(target).has(frag)) errors.push(`${p}: ${url} has no element with id "${frag}"`);
  }
}
if (notes.size) console.log(`lint: links to app pages still being built: ${[...notes].join(', ')}`);
if (errors.length) { console.error(errors.map(e => '  - ' + e).join('\n')); console.error(`lint: ${errors.length} problem(s)`); process.exit(1); }
console.log(`lint: ${pages.length} pages ok, every link and anchor resolves`);
