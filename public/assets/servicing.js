// Shared by the servicing pages: the sub-navigation (with the unread alerts badge), switches and date formatting.
import { api, esc } from '/assets/client.js';

const TABS = [['/app/activity', 'Activity'], ['/app/statements', 'Statements'], ['/app/alerts', 'Alerts'], ['/app/settings', 'Settings']];

/** Pills under the header, so every servicing page is one tap away on a phone too. */
export function subnav(active) {
  const n = document.createElement('nav');
  n.className = 'sv-sub'; n.setAttribute('aria-label', 'Account services');
  n.innerHTML = TABS.map(([h, t]) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${esc(t)}${h === '/app/alerts' ? ' <span class="sv-badge" id="sv-unread" hidden></span>' : ''}</a>`).join('');
  document.querySelector('.dash-main .wrap').prepend(n);
  unread();
}
export async function unread(count) {
  const b = document.getElementById('sv-unread'); if (!b) return;
  try { const n = count ?? (await api('GET', '/api/alerts/unread')).unread; b.textContent = n; b.hidden = !n; b.setAttribute('aria-label', `${n} unread`); } catch {}
}

/** A switch button: aria-checked holds the state. onChange(next) saves; if it fails the switch flips back and errEl says why. */
export function wireSwitch(btn, onChange, errEl) {
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true; btn.setAttribute('aria-checked', String(next));
    if (errEl) errEl.textContent = '';
    try { await onChange(next); } catch (e) { btn.setAttribute('aria-checked', String(!next)); if (errEl && e.code !== 'cancelled') errEl.textContent = e.message; }
    finally { btn.disabled = false; }
  });
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-05' -> 'Oct 5, 2026' (no time zone shift). */
export const day = s => { const [y, m, d] = String(s).split('-'); return `${MON[+m - 1]} ${+d}, ${y}`; };
/** '2026-10' -> 'October 2026' */
export const monthName = s => { const [y, m] = s.split('-'); return `${new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`; };
/** A timestamp in the viewer's time zone. */
export const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
