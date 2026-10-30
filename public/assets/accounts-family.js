// Shared by /app/open and /app/family: pills under the header (the header nav is hidden on phones).
import { esc } from '/assets/client.js';

const TABS = [['/app', 'Accounts'], ['/app/family', 'Family'], ['/app/open', 'Open an account']];

export function subnav(active) {
  const n = document.createElement('nav');
  n.className = 'sv-sub'; n.setAttribute('aria-label', 'Accounts and family');
  n.innerHTML = TABS.map(([h, t]) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${esc(t)}</a>`).join('');
  document.querySelector('.dash-main .wrap').prepend(n);
}
