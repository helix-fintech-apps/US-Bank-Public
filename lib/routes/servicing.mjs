// Account servicing (M3): activity search + categories, spending insights, monthly statements (+ PDF), alerts and the
// in-app inbox, contact details, security center, overdraft settings and secure messages. Moves no money.
import { createHash, randomInt } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { AppError, refuse, clearCookie, isUuid } from '../http.mjs';
import { tx } from '../db.mjs';
import { requireUser, requireStepUp, audit, newId, checkPassword, hashPassword, SESSION_COOKIE, IDLE_MINUTES } from '../auth.mjs';
import { RULES, guard } from '../throttle.mjs';
import { SIGNIN_LABELS } from '../audit-actions.mjs';
import { accountFor, VIEW, MOVE_MONEY } from '../access.mjs';
import { parseAmount, toStr, usd } from '../money.mjs';
import { ageOf } from './accounts.mjs';
import { CATEGORIES, namesFor } from '../categories.mjs';
import { isDate } from '../dates.mjs';
import { bankToday } from '../bank-date.mjs';

const DEPOSIT = ['checking', 'savings', 'money_market', 'cd', 'teen_checking', 'custodial_savings'];
export { CATEGORIES };                                                // the shared list (lib/categories.mjs)
const UNCAT = 'Uncategorized';

// Overdraft coverage: demo defaults modeled on the fee-forgiveness flow in docs/RESEARCH.md §6 [usbank-overdraft]
// (bring the balance back to $0 or more by the deadline and the fee is waived). Settings only: no fee is ever posted.
export const OVERDRAFT = { kinds: ['checking', 'teen_checking'], feeCents: 3600n, smallOverdraftCents: 5000n, maxFeesPerDay: 3,
  deadline: '11:59 p.m. Central Time on the next business day' };
// Password rule (docs/RESEARCH.md §7): long enough, letters and numbers, not built from the username.
export const PASSWORD_MIN = 10;
const RULE_MAX = 20, PAGE_MAX = 100;

const isMinor = u => !!u.dateOfBirth && ageOf(u.dateOfBirth) < 18;
const bad = (code, msg) => new AppError(400, code, msg);
/** "$1,234.56" from cents, for text the server writes (alerts, PDF). */
export { usd };
/** Only these entry kinds are purchases ('seed' is the demo history). Fees, interest, clawbacks, payments, wires, ACH, bills and USA Pay are not, now or when a new kind is added. */
const PURCHASE_KINDS = ['card_purchase', 'seed'];

/** Every account the user can see (any role), oldest first. */
async function visible(c, userId) {
  return (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE o.user_id = $1 AND a.kind <> 'system'
     ORDER BY CASE a.kind WHEN 'checking' THEN 1 WHEN 'savings' THEN 2 WHEN 'credit_card' THEN 3 ELSE 4 END, a.opened_at, a.name`, [userId])).rows;
}
const acctBrief = a => ({ id: a.id, name: a.name, last4: a.number_last4, kind: a.kind, role: a.role });

// ---------- activity ----------
const lineOut = l => ({ id: String(l.id), postedOn: l.posted_on, description: l.description, amount: toStr(l.amount_cents),
  category: l.override ?? l.original ?? UNCAT, originalCategory: l.original ?? UNCAT, overridden: l.override != null,
  account: { id: l.account_id, name: l.name, last4: l.number_last4 } });

const encCursor = l => Buffer.from(JSON.stringify({ d: l.posted_on, i: String(l.id) })).toString('base64url');
function decCursor(s) {
  try { const v = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); if (isDate(v.d) && /^\d{1,18}$/.test(v.i)) return v; } catch {}
  throw bad('bad_cursor', 'That page link is out of date. Search again.');
}

/** Filters from the query string, checked. Amounts are dollars ("25.00"), compared with the absolute amount. */
function filters(q) {
  const f = {};
  for (const k of ['from', 'to']) if (q[k]) { if (!isDate(q[k])) throw bad('bad_date', 'Enter dates like 2026-10-01.'); f[k] = q[k]; }
  if (f.from && f.to && f.from > f.to) throw bad('bad_date', 'The start date must be on or before the end date.');
  if (q.min) f.min = parseAmount(q.min, { field: 'the smallest amount', min: 0n });
  if (q.max) f.max = parseAmount(q.max, { field: 'the largest amount', min: 0n });
  if (f.min != null && f.max != null && f.min > f.max) throw bad('bad_amount', 'The smallest amount must not be more than the largest.');
  if (q.dir) { if (!['in', 'out'].includes(q.dir)) throw bad('bad_dir', 'Choose money in or money out.'); f.dir = q.dir; }
  if (q.category) { if (![...CATEGORIES, UNCAT].includes(q.category)) throw bad('bad_category', 'Choose a category from the list.'); f.category = q.category; }
  if (q.q) f.q = String(q.q).trim().slice(0, 100);
  f.limit = Math.min(Math.max(parseInt(q.limit ?? '25', 10) || 25, 1), PAGE_MAX);
  if (q.cursor) f.cursor = decCursor(q.cursor);
  return f;
}

async function search(c, userId, accountIds, f) {
  const args = [userId, accountIds], where = ['l.account_id = ANY($2::uuid[])'];
  const $ = v => { args.push(v); return '$' + args.length; };
  const cat = `coalesce(o.category, l.category, '${UNCAT}')`;
  if (f.from) where.push(`l.posted_on >= ${$(f.from)}::date`);
  if (f.to) where.push(`l.posted_on <= ${$(f.to)}::date`);
  if (f.min != null) where.push(`abs(l.amount_cents) >= ${$(f.min)}::bigint`);
  if (f.max != null) where.push(`abs(l.amount_cents) <= ${$(f.max)}::bigint`);
  if (f.dir) where.push(f.dir === 'in' ? 'l.amount_cents > 0' : 'l.amount_cents < 0');
  if (f.category) where.push(`${cat} = ANY(${$(namesFor(f.category))}::text[])`);       // also lines posted under the category's older name
  if (f.q) where.push(`l.description ILIKE ${$('%' + f.q.replace(/[\\%_]/g, m => '\\' + m) + '%')}`);
  if (f.cursor) where.push(`(l.posted_on, l.id) < (${$(f.cursor.d)}::date, ${$(f.cursor.i)}::bigint)`);   // keyset, not OFFSET
  const rows = (await c.query(`SELECT l.id, l.posted_on, l.description, l.amount_cents, l.category AS original, o.category AS override,
      l.account_id, a.name, a.number_last4
    FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
    LEFT JOIN category_overrides o ON o.line_id = l.id AND o.user_id = $1
    WHERE ${where.join(' AND ')} ORDER BY l.posted_on DESC, l.id DESC LIMIT ${$(f.limit + 1)}`, args)).rows;
  const more = rows.length > f.limit, page = rows.slice(0, f.limit);
  return { transactions: page.map(lineOut), nextCursor: more ? encCursor(page.at(-1)) : null };
}

// ---------- statements ----------
async function statement(c, a, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month)) || !isDate(month + '-01')) throw new AppError(404, 'not_found', 'Statement not found.');   // shared validator: no year 0000
  const p = (await c.query(`SELECT $1::date s, ($1::date + interval '1 month' - interval '1 day')::date e, $2::date today`, [month + '-01', bankToday()])).rows[0];
  if (p.s > p.today) throw new AppError(404, 'not_found', 'Statement not found.');
  const opening = (await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1 AND posted_on < $2', [a.id, p.s])).rows[0].s;
  const rows = (await c.query(`SELECT id, posted_on, description, amount_cents FROM ledger_lines WHERE account_id = $1 AND posted_on BETWEEN $2 AND $3
     ORDER BY posted_on, id`, [a.id, p.s, p.e])).rows;
  let bal = opening, moneyIn = 0n, moneyOut = 0n;
  const lines = rows.map(l => {
    bal += l.amount_cents; if (l.amount_cents > 0n) moneyIn += l.amount_cents; else moneyOut -= l.amount_cents;
    return { id: String(l.id), postedOn: l.posted_on, description: l.description, amount: toStr(l.amount_cents), balance: toStr(bal) };
  });
  const closing = opening + moneyIn - moneyOut;
  const ledger = (await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint s FROM ledger_lines WHERE account_id = $1 AND posted_on <= $2', [a.id, p.e])).rows[0].s;
  if (closing !== ledger || bal !== closing) throw new Error(`statement ${a.id} ${month} does not tie to the ledger`);   // never show numbers that don't tie
  const partial = p.e > p.today;
  return { account: acctBrief(a), month, periodStart: p.s, periodEnd: partial ? p.today : p.e, partial,
    opening: toStr(opening), moneyIn: toStr(moneyIn), moneyOut: toStr(moneyOut), closing: toStr(closing), lines };
}

async function statementAccount(c, u, id) {
  const a = await accountFor(c, u.id, id);
  if (!DEPOSIT.includes(a.kind)) throw new AppError(404, 'not_found', 'Statements for this account are not available here.');
  return a;
}

const ascii = s => String(s).replace(/[·•]/g, '.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?');
export async function statementPdf(st) {
  const doc = await PDFDocument.create();
  doc.setTitle(`USA Banc statement ${st.account.name} ending ${st.account.last4}, ${st.month}`); doc.setAuthor('USA Banc (fictional demo bank)');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 48, navy = rgb(0.047, 0.176, 0.388), ink = rgb(0.06, 0.106, 0.176), muted = rgb(0.33, 0.38, 0.48), line = rgb(0.87, 0.89, 0.925);
  let page, y;
  const text = (s, x, size = 10, f = font, color = ink) => page.drawText(ascii(s), { x, y, size, font: f, color });
  const right = (s, xr, size = 10, f = font, color = ink) => text(s, xr - f.widthOfTextAtSize(ascii(s), size), size, f, color);
  const fit = (s, w, size = 10) => { let t = ascii(s); while (t.length > 1 && font.widthOfTextAtSize(t, size) > w) t = t.slice(0, -2) + '.'; return t; };
  const head = () => {
    text('Date', M, 9, bold, muted); text('Description', M + 70, 9, bold, muted); right('Amount', W - M - 100, 9, bold, muted); right('Balance', W - M, 9, bold, muted);
    y -= 8; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: line }); y -= 16;
  };
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };

  newPage();
  page.drawRectangle({ x: 0, y: H - 86, width: W, height: 86, color: navy });
  y = H - 46; text('USA Banc', M, 22, bold, rgb(1, 1, 1));
  y = H - 66; text('Fictional demo bank. This is not a real statement and no real money moved.', M, 9, font, rgb(0.8, 0.88, 0.98));
  y = H - 120; text(`${st.account.name} ending ${st.account.last4}`, M, 15, bold);
  y -= 18; text(`Statement period ${st.periodStart} to ${st.periodEnd}${st.partial ? ' (month to date)' : ''}`, M, 10, font, muted);
  y -= 34;
  const box = [['Opening balance', st.opening], ['Money in', st.moneyIn], ['Money out', '-' + st.moneyOut], ['Closing balance', st.closing]];
  const bw = (W - 2 * M) / 4;
  page.drawRectangle({ x: M, y: y - 24, width: W - 2 * M, height: 50, borderColor: line, borderWidth: 1 });
  box.forEach(([k, v], i) => { const x = M + 12 + i * bw; text(k, x, 9, font, muted); y -= 16; text(usd(BigInt(v.replace('.', ''))), x, 13, bold); y += 16; });
  y -= 60;
  text('Transactions', M, 12, bold); y -= 20; head();
  if (!st.lines.length) { text('No transactions this period.', M, 10, font, muted); y -= 16; }
  for (const l of st.lines) {
    if (y < M + 30) { newPage(); head(); }
    text(l.postedOn, M, 10); text(fit(l.description, 280), M + 70, 10);
    right(usd(BigInt(l.amount.replace('.', ''))), W - M - 100, 10); right(usd(BigInt(l.balance.replace('.', ''))), W - M, 10);
    y -= 18;
  }
  y -= 6; page.drawLine({ start: { x: M, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.8, color: line });
  right(`Closing balance ${usd(BigInt(st.closing.replace('.', '')))}`, W - M, 10, bold);
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`USA Banc demo statement  |  Page ${i + 1} of ${pages.length}`, { x: M, y: 24, size: 8, font, color: muted }));
  return doc.save();
}

// ---------- alerts ----------
const RULE_KINDS = { low_balance: 'Low balance', large_purchase: 'Large purchase', deposit: 'Deposit received', new_device: 'Sign-in from a new device' };
const ruleOut = r => ({ id: r.id, kind: r.kind, label: RULE_KINDS[r.kind], accountId: r.account_id, threshold: r.threshold_cents == null ? null : toStr(r.threshold_cents),
  email: r.email, active: r.active, createdAt: r.created_at });
const noteOut = n => ({ id: String(n.id), kind: n.kind, title: n.title, body: n.body, emailTo: n.email_to, createdAt: n.created_at, read: !!n.read_at });

/** Who the device looks like, from its user agent. */
export function device(ua) {
  const s = String(ua ?? '');
  const b = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /node|undici/i.test(s) ? 'API client' : 'A browser';
  const o = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}

async function notify(c, userId, { kind, ref, title, body, emailTo = null }) {
  await c.query('INSERT INTO notifications (user_id, kind, ref, title, body, email_to) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, ref) DO NOTHING',
    [userId, kind, ref, title, body, emailTo]);
}

/**
 * Checks the user's active rules against ledger lines and sign-ins they haven't looked at yet, and adds what fires to the inbox.
 * Runs on read (inbox, unread count) and can be called right after activity is posted. Each alert has a unique ref, so it is safe to repeat.
 */
export async function evaluateAlerts(c, userId) {
  const rules = (await c.query('SELECT * FROM alert_rules WHERE user_id = $1 AND active ORDER BY created_at FOR UPDATE', [userId])).rows;
  if (!rules.length) return;
  const email = (await c.query('SELECT email FROM user_profiles WHERE user_id = $1', [userId])).rows[0]?.email ?? null;
  const vis = await visible(c, userId), byId = new Map(vis.map(a => [a.id, a]));
  const { line: maxLine, ev: maxAudit } = (await c.query('SELECT (SELECT coalesce(max(id), 0) FROM ledger_lines)::bigint line, (SELECT coalesce(max(id), 0) FROM audit_events)::bigint ev')).rows[0];
  for (const r of rules) {
    const emailTo = r.email ? email : null;
    if (r.kind === 'new_device') {
      const evs = (await c.query(`SELECT e.id, e.at, e.user_agent FROM audit_events e WHERE e.user_id = $1 AND e.action = 'login.ok' AND e.id > $2 AND e.id <= $3
          AND NOT EXISTS (SELECT 1 FROM audit_events p WHERE p.user_id = e.user_id AND p.action = 'login.ok' AND p.id < e.id AND p.user_agent IS NOT DISTINCT FROM e.user_agent)
          ORDER BY e.id`, [userId, r.checked_audit_id, maxAudit])).rows;
      for (const e of evs) await notify(c, userId, { kind: 'new_device', ref: `device:${r.id}:${e.id}`, emailTo, title: 'Sign-in from a new device',
        body: `You signed in from ${device(e.user_agent)} on ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} UTC. If this wasn't you, change your password in Settings.` });
      await c.query('UPDATE alert_rules SET checked_audit_id = $2 WHERE id = $1', [r.id, maxAudit]);
      continue;
    }
    const kinds = r.kind === 'large_purchase' ? null : DEPOSIT;           // purchases on cards count too; balances and deposits are deposit accounts
    const ids = (r.account_id ? [byId.get(r.account_id)].filter(Boolean) : vis).filter(a => !kinds || kinds.includes(a.kind)).map(a => a.id);
    if (ids.length) {
      const lines = (await c.query(`SELECT l.id, l.account_id, l.amount_cents, l.description, l.posted_on, j.kind AS entry_kind,
          (SELECT sum(x.amount_cents) FROM ledger_lines x WHERE x.account_id = l.account_id AND x.id <= l.id)::bigint AS after
        FROM ledger_lines l JOIN journal_entries j ON j.id = l.entry_id
        WHERE l.account_id = ANY($1::uuid[]) AND l.id > $2 AND l.id <= $3 ORDER BY l.id`, [ids, r.checked_line_id, maxLine])).rows;
      for (const l of lines) {
        const a = byId.get(l.account_id), where = `${a.name} ··${a.number_last4}`, amt = l.amount_cents;
        if (r.kind === 'low_balance' && l.after < r.threshold_cents && l.after - amt >= r.threshold_cents)        // fires when the balance crosses below
          await notify(c, userId, { kind: r.kind, ref: `low:${r.id}:${l.id}`, emailTo, title: `Low balance: ${where}`,
            body: `Your balance is ${usd(l.after)}, under your alert amount of ${usd(r.threshold_cents)}.` });
        if (r.kind === 'large_purchase' && amt < 0n && -amt > r.threshold_cents && PURCHASE_KINDS.includes(l.entry_kind))
          await notify(c, userId, { kind: r.kind, ref: `purchase:${r.id}:${l.id}`, emailTo, title: `Purchase over ${usd(r.threshold_cents)}`,
            body: `${usd(-amt)} at ${l.description} on ${where}, ${l.posted_on}.` });
        if (r.kind === 'deposit' && amt > 0n && l.entry_kind !== 'transfer')
          await notify(c, userId, { kind: r.kind, ref: `deposit:${r.id}:${l.id}`, emailTo, title: `Deposit received: ${usd(amt)}`,
            body: `${l.description} to ${where}, ${l.posted_on}.` });
      }
    }
    await c.query('UPDATE alert_rules SET checked_line_id = $2 WHERE id = $1', [r.id, maxLine]);
  }
}
const unreadCount = async (c, userId) => (await c.query('SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId])).rows[0].n;

async function ruleFrom(c, u, b, existing) {
  const kind = existing?.kind ?? b.kind;
  if (!RULE_KINDS[kind]) throw bad('bad_rule', 'Choose an alert type.');
  let accountId = existing ? existing.account_id : null, threshold = existing?.threshold_cents ?? null;
  if (!existing && b.accountId && kind !== 'new_device') accountId = (await accountFor(c, u.id, b.accountId)).id;
  if (['low_balance', 'large_purchase'].includes(kind) && (b.threshold !== undefined || !existing))
    threshold = parseAmount(b.threshold, { field: 'the alert amount', min: 1n, max: 1_000_000_00n });
  return { kind, accountId, threshold, email: b.email === undefined ? existing?.email ?? false : b.email === true, active: b.active === undefined ? existing?.active ?? true : b.active === true };
}

// ---------- profile ----------
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));
const fmtPhone = p => (p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : null);
/** Masked for the audit trail and notices: enough to recognize, not enough to reuse. */
export const mask = {
  email: e => (e ? `${e[0]}•••@${e.split('@')[1]}` : null),
  phone: p => (p ? `•••-•••-••${p.slice(-2)}` : null),
  address: a => (a?.line1 ? `${a.line1.slice(0, 2)}••• ${a.city ?? ''}, ${a.state ?? ''} ${String(a.zip ?? '').slice(0, 3)}••` : null)
};
const addrOf = p => ({ line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, zip: p.zip });
const profileOut = (p, u) => ({ email: p.email, phone: fmtPhone(p.phone), phoneLast2: u.phoneLast2, address: addrOf(p), estatements: p.estatements });

async function profileRow(c, u, lock = false) {
  await c.query(`INSERT INTO user_profiles (user_id, email) VALUES ($1, CASE WHEN $2 ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' THEN $2 END) ON CONFLICT (user_id) DO NOTHING`, [u.id, u.username]);
  return (await c.query(`SELECT * FROM user_profiles WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [u.id])).rows[0];
}
function cleanProfile(b) {
  const out = {};
  if (b.email !== undefined) {
    const e = String(b.email ?? '').trim().toLowerCase();
    if (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('bad_email', 'Enter an email address like name@example.com.');
    out.email = e;
  }
  if (b.phone !== undefined) {
    let d = String(b.phone ?? '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (!/^[2-9]\d{9}$/.test(d)) throw bad('bad_phone', 'Enter a 10-digit US phone number, like (555) 010-0142.');
    out.phone = d;
  }
  if (b.address !== undefined) {
    const a = b.address ?? {}, t = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
    const addr = { line1: t(a.line1, 80), line2: t(a.line2, 80) || null, city: t(a.city, 40), state: t(a.state, 2).toUpperCase(), zip: t(a.zip, 10) };
    if (!addr.line1 || !addr.city) throw bad('bad_address', 'Enter a street address and city.');
    if (!STATES.has(addr.state)) throw bad('bad_address', 'Choose a US state.');
    if (!/^\d{5}(-\d{4})?$/.test(addr.zip)) throw bad('bad_address', 'Enter a 5-digit ZIP code.');
    addr.zip = addr.zip.slice(0, 5);
    out.address = addr;
  }
  return out;
}

// ---------- security ----------
const sessionId = tokenHash => createHash('sha256').update('session:' + tokenHash).digest('hex').slice(0, 32);   // safe to show; not the token
const SIGNIN_ACTIONS = SIGNIN_LABELS;                                          // lib/audit-actions.mjs

export function passwordProblem(pw, username, current) {
  const p = String(pw ?? ''), local = String(username).split('@')[0].toLowerCase();
  if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (p.length > 128) return 'Use 128 characters or fewer.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use both letters and numbers.';
  if (local.length >= 3 && p.toLowerCase().includes(local)) return "Don't use your username in your password.";
  if (p === current) return 'Choose a password you are not using now.';
  return null;
}

// ---------- messages ----------
async function threadFor(c, u, id) {
  const t = isUuid(id) ? (await c.query('SELECT * FROM message_threads WHERE id = $1 AND user_id = $2', [id, u.id])).rows[0] : null;
  if (!t) throw new AppError(404, 'not_found', 'Conversation not found.');
  return t;
}
const msgBody = (s, field = 'message') => { const v = String(s ?? '').trim(); if (!v || v.length > 2000) throw bad('bad_message', `Write a ${field} of up to 2,000 characters.`); return v; };
export const autoReply = name => `Thanks, ${name}. This is an automatic reply (simulated): a USA Banc banker would answer within one business day. For anything urgent, call 1-800-555-0100.`;
async function addMessage(c, u, t, body) {
  await c.query("INSERT INTO messages (thread_id, sender, body) VALUES ($1, 'customer', $2)", [t.id, body]);
  await c.query("INSERT INTO messages (thread_id, sender, body) VALUES ($1, 'bank', $2)", [t.id, autoReply(u.displayName)]);
  await c.query("UPDATE message_threads SET updated_at = now(), status = 'open' WHERE id = $1", [t.id]);
}

export function register(r) {
  // ----- activity, categories, insights -----
  r.add('GET', '/api/activity', async ({ req, pool, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const f = filters(query);
    const vis = await visible(c, u.id);
    const ids = query.account ? [(await accountFor(c, u.id, query.account)).id] : vis.map(a => a.id);
    return { accounts: vis.map(acctBrief), categories: CATEGORIES, ...(await search(c, u.id, ids, f)) };
  }));

  r.add('PUT', '/api/activity/:lineId/category', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const l = /^\d{1,18}$/.test(params.lineId) ? (await c.query(`SELECT l.*, o.category AS override FROM ledger_lines l
       LEFT JOIN category_overrides o ON o.line_id = l.id AND o.user_id = $2 WHERE l.id = $1`, [params.lineId, u.id])).rows[0] : null;
    if (!l || !(await visible(c, u.id)).some(a => a.id === l.account_id)) throw new AppError(404, 'not_found', 'Transaction not found.');
    const to = body.category == null || body.category === '' ? null : String(body.category);
    if (to !== null && !CATEGORIES.includes(to)) throw bad('bad_category', 'Choose a category from the list.');
    const from = l.override ?? l.category ?? UNCAT;
    if (to === null || to === l.category) await c.query('DELETE FROM category_overrides WHERE user_id = $1 AND line_id = $2', [u.id, l.id]);
    else await c.query(`INSERT INTO category_overrides (user_id, line_id, category) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, line_id) DO UPDATE SET category = EXCLUDED.category, updated_at = now()`, [u.id, l.id, to]);
    const now = to ?? l.category ?? UNCAT;
    await audit(c, req, u.id, 'activity.recategorize', { line: String(l.id), from, to: now });
    return { id: String(l.id), category: now, originalCategory: l.category ?? UNCAT, overridden: now !== (l.category ?? UNCAT) };
  }));

  r.add('GET', '/api/insights', async ({ req, pool, query }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const vis = await visible(c, u.id);
    const ids = query.account ? [(await accountFor(c, u.id, query.account)).id] : vis.map(a => a.id);
    const today = bankToday().slice(0, 7);
    const month = query.month ?? today;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isDate(month + '-01') || month > today) throw bad('bad_month', 'Choose a month up to this one.');   // no year 0000
    const cat = `coalesce(o.category, l.category, '${UNCAT}')`;
    const rows = (await c.query(`SELECT ${cat} AS category,
        sum(CASE WHEN l.amount_cents < 0 THEN -l.amount_cents ELSE 0 END)::bigint AS out_c, sum(CASE WHEN l.amount_cents > 0 THEN l.amount_cents ELSE 0 END)::bigint AS in_c
      FROM ledger_lines l LEFT JOIN category_overrides o ON o.line_id = l.id AND o.user_id = $1
      WHERE l.account_id = ANY($2::uuid[]) AND l.posted_on >= $3::date AND l.posted_on < $3::date + interval '1 month' GROUP BY 1`, [u.id, ids, month + '-01'])).rows;
    // spending leaves out moves between accounts (category Transfers)
    const spend = rows.filter(x => x.category !== 'Transfers' && x.out_c > 0n).sort((a, b) => (b.out_c > a.out_c ? 1 : b.out_c < a.out_c ? -1 : a.category.localeCompare(b.category)));
    const total = spend.reduce((s, x) => s + x.out_c, 0n), moneyIn = rows.reduce((s, x) => s + (x.category === 'Transfers' ? 0n : x.in_c), 0n);
    const trend = (await c.query(`SELECT to_char(m, 'YYYY-MM') AS month, coalesce((SELECT sum(-l.amount_cents) FROM ledger_lines l
        LEFT JOIN category_overrides o ON o.line_id = l.id AND o.user_id = $1
        WHERE l.account_id = ANY($2::uuid[]) AND l.amount_cents < 0 AND ${cat} <> 'Transfers' AND l.posted_on >= m AND l.posted_on < m + interval '1 month'), 0)::bigint AS out_c
      FROM generate_series(date_trunc('month', $3::date) - interval '5 months', date_trunc('month', $3::date), interval '1 month') m ORDER BY m`, [u.id, ids, month + '-01'])).rows;
    const top = trend.reduce((m, t) => (t.out_c > m ? t.out_c : m), 0n);
    return { month, spending: toStr(total), moneyIn: toStr(moneyIn),
      categories: spend.map(x => ({ category: x.category, amount: toStr(x.out_c), pct: Number((x.out_c * 100n) / (total || 1n)) })),   // ok-number: a whole percent for bar widths
      trend: trend.map(t => ({ month: t.month, spending: toStr(t.out_c), pct: Number((t.out_c * 100n) / (top || 1n)) })) };   // ok-number: bar height
  }));

  // ----- statements -----
  r.add('GET', '/api/statements', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const p = await profileRow(c, u);
    return { estatements: p.estatements, accounts: (await visible(c, u.id)).filter(a => DEPOSIT.includes(a.kind) && a.status !== 'closed').map(acctBrief) };
  }));
  r.add('GET', '/api/statements/:accountId', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await statementAccount(c, u, params.accountId);
    const months = (await c.query(`SELECT to_char(m, 'YYYY-MM') AS month, m + interval '1 month' > $2::date AS partial
       FROM generate_series(date_trunc('month', coalesce((SELECT min(posted_on) FROM ledger_lines WHERE account_id = $1), $2::date)), date_trunc('month', $2::date), interval '1 month') m
       ORDER BY m DESC LIMIT 24`, [a.id, bankToday()])).rows;
    return { account: acctBrief(a), statements: months };
  }));
  r.add('GET', '/api/statements/:accountId/:month', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    return statement(c, await statementAccount(c, u, params.accountId), params.month);
  }));
  r.add('GET', '/api/statements/:accountId/:month/pdf', async ({ req, res, pool, params }) => {
    const st = await tx(pool, async c => { const u = await requireUser(c, req); return statement(c, await statementAccount(c, u, params.accountId), params.month); });
    const bytes = await statementPdf(st);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="usa-banc-statement-${st.account.last4}-${st.month}.pdf"`);
    res.setHeader('cache-control', 'no-store');
    res.end(Buffer.from(bytes));
  });

  // ----- alerts -----
  r.add('GET', '/api/alerts', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await evaluateAlerts(c, u.id);
    const items = (await c.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [u.id])).rows;
    const rules = (await c.query('SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY created_at', [u.id])).rows;
    return { unread: await unreadCount(c, u.id), items: items.map(noteOut), rules: rules.map(ruleOut), kinds: RULE_KINDS,
      accounts: (await visible(c, u.id)).map(acctBrief), email: (await profileRow(c, u)).email };
  }));
  r.add('GET', '/api/alerts/unread', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    await evaluateAlerts(c, u.id);
    return { unread: await unreadCount(c, u.id) };
  }));
  r.add('POST', '/api/alerts/read', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if (body.all === true) await c.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    else {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(s => /^\d{1,18}$/.test(s)).slice(0, 100) : [];
      if (!ids.length) throw bad('bad_ids', 'Choose alerts to mark as read.');
      await c.query('UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE user_id = $1 AND id = ANY($2::bigint[])', [u.id, ids]);
    }
    return { unread: await unreadCount(c, u.id) };
  }));
  r.add('POST', '/api/alerts/rules', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if ((await c.query('SELECT count(*)::int n FROM alert_rules WHERE user_id = $1', [u.id])).rows[0].n >= RULE_MAX) throw bad('too_many_rules', `You can have up to ${RULE_MAX} alerts. Remove one first.`);
    const v = await ruleFrom(c, u, body);
    const id = newId();
    await c.query(`INSERT INTO alert_rules (id, user_id, kind, account_id, threshold_cents, email, active, checked_line_id, checked_audit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT coalesce(max(id), 0) FROM ledger_lines), (SELECT coalesce(max(id), 0) FROM audit_events))`,
      [id, u.id, v.kind, v.accountId, v.threshold, v.email, v.active]);   // only activity from now on fires
    await audit(c, req, u.id, 'alert_rule.create', { rule: id, kind: v.kind, threshold: v.threshold == null ? null : toStr(v.threshold), email: v.email });
    return ruleOut((await c.query('SELECT * FROM alert_rules WHERE id = $1', [id])).rows[0]);
  }));
  r.add('PUT', '/api/alerts/rules/:id', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const old = isUuid(params.id) ? (await c.query('SELECT * FROM alert_rules WHERE id = $1 AND user_id = $2 FOR UPDATE', [params.id, u.id])).rows[0] : null;
    if (!old) throw new AppError(404, 'not_found', 'Alert not found.');
    const v = await ruleFrom(c, u, body, old);
    await c.query('UPDATE alert_rules SET threshold_cents = $2, email = $3, active = $4 WHERE id = $1', [old.id, v.threshold, v.email, v.active]);
    await audit(c, req, u.id, 'alert_rule.change', { rule: old.id, from: { threshold: old.threshold_cents == null ? null : toStr(old.threshold_cents), email: old.email, active: old.active },
      to: { threshold: v.threshold == null ? null : toStr(v.threshold), email: v.email, active: v.active } });
    return ruleOut((await c.query('SELECT * FROM alert_rules WHERE id = $1', [old.id])).rows[0]);
  }));
  r.add('DELETE', '/api/alerts/rules/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const d = isUuid(params.id) ? await c.query('DELETE FROM alert_rules WHERE id = $1 AND user_id = $2 RETURNING kind', [params.id, u.id]) : { rowCount: 0 };
    if (!d.rowCount) throw new AppError(404, 'not_found', 'Alert not found.');
    await audit(c, req, u.id, 'alert_rule.delete', { rule: params.id, kind: d.rows[0].kind });
    return { ok: true };
  }));

  // ----- profile -----
  r.add('GET', '/api/profile', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    return profileOut(await profileRow(c, u), u);
  }));
  r.add('PUT', '/api/profile', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    requireStepUp(u);                                                                 // changing contact details is a risky action
    const next = cleanProfile(body), cur = await profileRow(c, u, true);
    const changes = [], notices = [];
    if (next.email && next.email !== cur.email) changes.push({ field: 'email', from: mask.email(cur.email), to: mask.email(next.email) });
    if (next.phone && next.phone !== cur.phone) changes.push({ field: 'phone', from: mask.phone(cur.phone), to: mask.phone(next.phone) });
    const oldAddr = addrOf(cur);
    if (next.address && JSON.stringify(next.address) !== JSON.stringify(oldAddr)) changes.push({ field: 'address', from: mask.address(oldAddr), to: mask.address(next.address) });
    if (!changes.length) return { changed: [], notices, profile: profileOut(cur, u) };
    const a = next.address ?? oldAddr;
    await c.query(`UPDATE user_profiles SET email = $2, phone = $3, address_line1 = $4, address_line2 = $5, city = $6, state = $7, zip = $8, updated_at = now() WHERE user_id = $1`,
      [u.id, next.email ?? cur.email, next.phone ?? cur.phone, a.line1, a.line2, a.city, a.state, a.zip]);
    const fields = changes.map(x => x.field);
    if (fields.includes('phone')) {
      await c.query('UPDATE users SET phone_last2 = $2 WHERE id = $1', [u.id, next.phone.slice(-2)]);           // codes now go to the new phone
      const ref = String(randomInt(0, 1_000_000)).padStart(6, '0');
      notices.push(`Simulated text message to your old phone ending ··${u.phoneLast2 ?? '••'}: "USA Banc: your phone number was changed. If this wasn't you, call 1-800-555-0100 and give code ${ref}." No real text is sent.`);
    }
    if (fields.includes('email') && cur.email) notices.push(`Simulated: a notice would be emailed to your old address ${mask.email(cur.email)}. No real email is sent.`);
    await audit(c, req, u.id, 'profile.change', { changes });
    await notify(c, u.id, { kind: 'security', ref: `profile:${newId()}`, title: 'Your contact details changed', body: `Changed: ${fields.join(', ')}. If this wasn't you, call us right away.` });
    const p = (await c.query('SELECT p.*, u.phone_last2 FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1', [u.id])).rows[0];
    return { changed: fields, notices, profile: profileOut(p, { phoneLast2: p.phone_last2 }) };
  }));
  r.add('PUT', '/api/profile/estatements', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if (typeof body.enabled !== 'boolean') throw bad('bad_setting', 'Choose on or off.');
    const p = await profileRow(c, u, true);
    if (p.estatements !== body.enabled) {
      await c.query('UPDATE user_profiles SET estatements = $2, updated_at = now() WHERE user_id = $1', [u.id, body.enabled]);
      await audit(c, req, u.id, 'profile.estatements', { from: p.estatements, to: body.enabled });
    }
    return { estatements: body.enabled };
  }));

  // ----- security center -----
  r.add('GET', '/api/security', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const mfa = (await c.query('SELECT mfa_required FROM users WHERE id = $1', [u.id])).rows[0].mfa_required;
    const sessions = (await c.query(`SELECT token_hash, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = $1 AND expires_at > now()
       AND last_seen_at > now() - make_interval(mins => $2) ORDER BY last_seen_at DESC`, [u.id, IDLE_MINUTES])).rows;
    const evs = (await c.query('SELECT id, at, action, ip, user_agent FROM audit_events WHERE user_id = $1 AND action = ANY($2) ORDER BY id DESC LIMIT 15', [u.id, Object.keys(SIGNIN_ACTIONS)])).rows;
    return { mfaRequired: mfa, canChangeMfa: !isMinor(u), passwordMin: PASSWORD_MIN,
      sessions: sessions.map(s => ({ id: sessionId(s.token_hash), device: device(s.user_agent), startedAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.token_hash === u.tokenHash })),
      signins: evs.map(e => ({ id: String(e.id), at: e.at, action: e.action, label: SIGNIN_ACTIONS[e.action], ip: e.ip, device: device(e.user_agent) })) };
  }));
  r.add('DELETE', '/api/security/sessions/:id', async ({ req, res, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const all = (await c.query('SELECT token_hash FROM sessions WHERE user_id = $1', [u.id])).rows;
    const s = all.find(x => sessionId(x.token_hash) === params.id);
    if (!s) throw new AppError(404, 'not_found', 'That device is already signed out.');
    await c.query('DELETE FROM sessions WHERE token_hash = $1 AND user_id = $2', [s.token_hash, u.id]);
    const current = s.token_hash === u.tokenHash;
    if (current) clearCookie(req, res, SESSION_COOKIE);
    await audit(c, req, u.id, 'session.revoke', { current });
    return { ok: true, current };
  }));
  r.add('PUT', '/api/security/mfa', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    if (typeof body.required !== 'boolean') throw bad('bad_setting', 'Choose on or off.');
    if (isMinor(u)) throw new AppError(403, 'managed', 'Your parent or guardian manages this setting.');
    requireStepUp(u);
    const old = (await c.query('SELECT mfa_required FROM users WHERE id = $1 FOR UPDATE', [u.id])).rows[0].mfa_required;
    if (old !== body.required) {
      await c.query('UPDATE users SET mfa_required = $2 WHERE id = $1', [u.id, body.required]);
      await audit(c, req, u.id, 'security.mfa_change', { from: old, to: body.required });
      await notify(c, u.id, { kind: 'security', ref: `mfa:${newId()}`, title: body.required ? 'One-time codes turned on' : 'One-time codes turned off',
        body: body.required ? 'From now on, signing in asks for a code sent to your phone.' : "Signing in no longer asks for a code. If this wasn't you, change your password." });
    }
    return { mfaRequired: body.required };
  }));
  r.add('POST', '/api/security/password', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    requireStepUp(u);
    const row = (await c.query('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [u.id])).rows[0];
    await guard(c, req, u.id, RULES.password);                                                    // guesses at the current password are limited, like sign-in
    if (!(await checkPassword(String(body.current ?? ''), row.password_hash))) {
      await audit(c, req, u.id, 'password.change_bad_current');
      throw refuse(401, 'bad_password', "That isn't your current password.");
    }
    const problem = passwordProblem(body.next, u.username, String(body.current));
    if (problem) throw bad('weak_password', problem);
    await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(String(body.next))]);
    const ended = (await c.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, u.tokenHash])).rowCount;   // other devices sign in again
    await audit(c, req, u.id, 'password.change', { other_sessions_ended: ended });
    await notify(c, u.id, { kind: 'security', ref: `password:${newId()}`, title: 'Password changed', body: `Your password was changed and ${ended} other ${ended === 1 ? 'device was' : 'devices were'} signed out.` });
    return { ok: true, otherSessionsEnded: ended };
  }));

  // ----- overdraft -----
  r.add('GET', '/api/overdraft', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT a.*, o.role, coalesce(s.opted_in, false) AS opted_in, s.updated_at AS od_updated FROM accounts a
       JOIN account_owners o ON o.account_id = a.id LEFT JOIN overdraft_settings s ON s.account_id = a.id
       WHERE o.user_id = $1 AND a.kind = ANY($2) AND a.status <> 'closed' ORDER BY a.kind, a.opened_at, a.name`, [u.id, OVERDRAFT.kinds])).rows;
    return { accounts: rows.map(a => ({ ...acctBrief(a), optedIn: a.opted_in, updatedAt: a.od_updated, canChange: MOVE_MONEY.includes(a.role) })),
      fee: toStr(OVERDRAFT.feeCents), smallOverdraft: toStr(OVERDRAFT.smallOverdraftCents), maxFeesPerDay: OVERDRAFT.maxFeesPerDay, deadline: OVERDRAFT.deadline };
  }));
  r.add('PUT', '/api/overdraft/:accountId', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const a = await accountFor(c, u.id, params.accountId, VIEW);
    if (!OVERDRAFT.kinds.includes(a.kind)) throw new AppError(404, 'not_found', 'Overdraft settings are for checking accounts.');
    if (!MOVE_MONEY.includes(a.role)) throw new AppError(403, 'managed', a.role === 'minor' ? 'Your parent or guardian manages this setting.' : 'Only an owner can change this setting.');
    if (typeof body.optedIn !== 'boolean') throw bad('bad_setting', 'Choose on or off.');
    const old = (await c.query('SELECT opted_in FROM overdraft_settings WHERE account_id = $1 FOR UPDATE', [a.id])).rows[0]?.opted_in ?? false;
    if (old !== body.optedIn) {
      await c.query(`INSERT INTO overdraft_settings (account_id, opted_in, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (account_id) DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_by = EXCLUDED.updated_by, updated_at = now()`, [a.id, body.optedIn, u.id]);
      await audit(c, req, u.id, 'overdraft.change', { account: a.id, last4: a.number_last4, from: old, to: body.optedIn });
    }
    return { accountId: a.id, optedIn: body.optedIn };
  }));

  // ----- secure messages -----
  r.add('GET', '/api/messages', async ({ req, pool }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const rows = (await c.query(`SELECT t.*, (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.sender = 'bank' AND m.read_at IS NULL) AS unread,
        (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last
       FROM message_threads t WHERE t.user_id = $1 ORDER BY t.updated_at DESC LIMIT 50`, [u.id])).rows;
    return { threads: rows.map(t => ({ id: t.id, subject: t.subject, status: t.status, updatedAt: t.updated_at, unread: t.unread, last: String(t.last ?? '').slice(0, 140) })) };
  }));
  r.add('POST', '/api/messages', async ({ req, pool, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const subject = String(body.subject ?? '').trim();
    if (!subject || subject.length > 120) throw bad('bad_subject', 'Write a subject of up to 120 characters.');
    const text = msgBody(body.body);
    const t = { id: newId() };
    await c.query('INSERT INTO message_threads (id, user_id, subject) VALUES ($1,$2,$3)', [t.id, u.id, subject]);
    await addMessage(c, u, t, text);
    await audit(c, req, u.id, 'message.send', { thread: t.id, new_thread: true });
    return { id: t.id };
  }));
  r.add('GET', '/api/messages/:id', async ({ req, pool, params }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const t = await threadFor(c, u, params.id);
    const msgs = (await c.query('SELECT * FROM messages WHERE thread_id = $1 ORDER BY id', [t.id])).rows;
    await c.query("UPDATE messages SET read_at = now() WHERE thread_id = $1 AND sender = 'bank' AND read_at IS NULL", [t.id]);
    return { id: t.id, subject: t.subject, status: t.status, messages: msgs.map(m => ({ id: String(m.id), sender: m.sender, body: m.body, at: m.created_at })) };
  }));
  r.add('POST', '/api/messages/:id', async ({ req, pool, params, body }) => tx(pool, async c => {
    const u = await requireUser(c, req);
    const t = await threadFor(c, u, params.id);
    await addMessage(c, u, t, msgBody(body.body, 'reply'));
    await audit(c, req, u.id, 'message.send', { thread: t.id });
    return { ok: true };
  }));
}
