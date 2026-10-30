// Shared by every signed-in page: API calls, the step-up code prompt, the header and small formatting helpers.
// Pages import what they need:  import { api, shell, money, esc, newKey } from '/assets/client.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "1234.5" / "-12.00" (API strings) -> "$1,234.50" / "-$12.00". String math only; no floats. */
export function money(s) {
  let v = String(s ?? '0'), neg = v.startsWith('-'); if (neg) v = v.slice(1);
  let [i, f = ''] = v.split('.'); f = (f + '00').slice(0, 2);
  i = i.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${i}.${f}`;
}

/** A fresh idempotency key: send the same one when retrying the same request, so money never moves twice. */
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/**
 * Calls the API. Signed-out -> back to log in. A risky action that needs a fresh code -> asks for the code, then retries once.
 * Throws an Error with .code and .status for anything else.
 */
export async function api(method, path, body, { auth = true, retry = true } = {}) {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  const data = await r.json().catch(() => ({}));
  if (auth && r.status === 401 && data.error === 'signed_out') { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash); throw new Error(data.message); }
  if (r.status === 403 && data.error === 'stepup_required' && retry) { await stepUp(); return api(method, path, body, { auth, retry: false }); }
  if (!r.ok) throw Object.assign(new Error(data.message || 'Something went wrong. Please try again.'), { code: data.error, status: r.status, data });
  return data;
}

// ---------- step-up dialog ----------
let pending = null;
export function stepUp() {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const d = document.createElement('dialog'); d.className = 'stepup';
    d.innerHTML = `<form method="dialog" novalidate>
      <h2>Confirm it's you</h2>
      <p class="sub" id="su-sub">Sending a one-time code…</p>
      <label class="lbl" for="su-code">6-digit code</label>
      <input id="su-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}">
      <p class="err" id="su-err" role="alert"></p>
      <div class="row"><button type="button" class="btn" id="su-cancel">Cancel</button><button class="btn pri" id="su-go">Confirm</button></div>
      <p class="demo-code" id="su-demo" hidden></p>
    </form>`;
    document.body.appendChild(d); d.showModal();
    const $ = s => d.querySelector(s);
    const done = (ok, err) => { d.close(); d.remove(); pending = null; ok ? resolve() : reject(err ?? Object.assign(new Error('Cancelled'), { code: 'cancelled' })); };
    $('#su-cancel').onclick = () => done(false);
    d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    api('POST', '/api/stepup', {}, { retry: false }).then(r => {
      $('#su-sub').textContent = `We sent a code to the phone ending in ··${r.phoneLast2 ?? '••'}. It works for 10 minutes.`;
      if (r.demoCode) { $('#su-demo').hidden = false; $('#su-demo').innerHTML = `Simulated text message: your code is <b>${esc(r.demoCode)}</b>`; }
      $('#su-code').focus();
    }).catch(e => { $('#su-err').textContent = e.message; });
    d.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/api/stepup/verify', { code: $('#su-code').value.trim() }, { retry: false }); done(true); }
      catch (err) { $('#su-err').textContent = err.message; }
    };
  });
  return pending;
}

// ---------- header ----------
// Features add their page here: [path, label]. Only pages that exist are listed.
export const NAV = [['/app', 'Accounts']];
NAV.push(['/app/activity', 'Activity'], ['/app/settings', 'Settings']);
NAV.push(['/app/pay', 'Pay & transfer']);
NAV.push(['/app/family', 'Family'], ['/app/open', 'Open an account']);
NAV.push(['/app/loans', 'Loans'], ['/app/credit', 'Credit score']);
NAV.push(['/app/cards', 'Cards']);

// Pages a minor can't use (their APIs answer a minor with 403): hidden from a minor's navigation.
const ADULT_ONLY = new Set(['/app/open', '/app/loans', '/app/credit']);
const MINOR_KEY = 'usab_minor';
function hideAdultOnly(minor) {
  for (const a of document.querySelectorAll('.dash-nav a[data-adult]')) a.hidden = minor;
}

export function shell(active) {
  const top = document.createElement('div');
  top.innerHTML = `<div class="demo-note" role="note">USA Banc is a fictional demo bank. Balances and transactions are made up. No real money moves.</div>
    <header class="dash-top"><div class="wrap">
      <a class="brand" href="/app" aria-label="USA Banc accounts"><img src="/assets/logo.svg" alt="" width="34" height="34"><span>USA <b>Banc</b></span></a>
      <nav class="dash-nav" aria-label="Banking">${NAV.map(([h, t]) => `<a class="navlink" href="${h}"${h === active ? ' aria-current="page"' : ''}${ADULT_ONLY.has(h) ? ' data-adult' : ''}>${esc(t)}</a>`).join('')}</nav>
      <span class="grow"></span>
      <a class="navlink" href="#" id="signout">Log out</a>
    </div></header>`;
  document.body.prepend(...top.children);
  let known = null;
  try { known = sessionStorage.getItem(MINOR_KEY); } catch {}
  if (known === '1') hideAdultOnly(true);                         // no flash of links a minor can't use on later pages
  fetch('/api/me', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).then(me => {
    if (!me?.user) return;
    hideAdultOnly(!!me.user.isMinor);
    try { sessionStorage.setItem(MINOR_KEY, me.user.isMinor ? '1' : '0'); } catch {}
  }).catch(() => {});
  document.getElementById('signout').addEventListener('click', async e => {
    e.preventDefault();
    try { await api('DELETE', '/api/session', {}, { auth: false }); } catch {}
    location.href = '/login';
  });
}
