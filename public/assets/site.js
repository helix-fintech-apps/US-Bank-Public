// Shared header behaviour for public pages: mega menus (one open at a time) and the phone menu.
const btns = [...document.querySelectorAll('nav.main button')];
const closeAll = except => btns.forEach(b => { if (b !== except) { b.setAttribute('aria-expanded', 'false'); document.getElementById(b.getAttribute('aria-controls')).hidden = true; } });
btns.forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const open = b.getAttribute('aria-expanded') !== 'true'; closeAll(b); b.setAttribute('aria-expanded', String(open)); document.getElementById(b.getAttribute('aria-controls')).hidden = !open; }));
document.addEventListener('click', e => { if (!e.target.closest('nav.main')) closeAll(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
const menu = document.getElementById('menu'), nav = document.getElementById('nav');
menu.addEventListener('click', () => { const o = nav.classList.toggle('open'); menu.setAttribute('aria-expanded', String(o)); });
