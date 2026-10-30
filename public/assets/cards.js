// Cards pages: the card picture and a few labels. No network logos: the card carries a "DEMO" mark.
import { esc } from '/assets/client.js';

const KIND = { cash_back: 'k-cash', travel: 'k-travel', secured: 'k-secured', student: 'k-student', debit: 'k-debit' };
export const STATUS = { active: 'Active', locked: 'Locked', closed: 'Closed' };
export const CHANNEL = { in_store: 'In store (chip or swipe)', online: 'Online or by phone', contactless: 'Contactless (tap)', atm: 'ATM withdrawal' };
export const RESULT = { likely: "You're likely to be approved", likely_lower: 'Likely, with a lower limit', secured_instead: 'Secured Card instead', unlikely: 'Not likely right now' };

/** kind: product kind or 'debit'. */
export function cardArt({ kind = 'cash_back', name = '', last4 = '', holder = '', exp = '', status = 'active', small = false }) {
  return `<div class="pcard ${KIND[kind] ?? ''}${small ? ' sm' : ''}" role="img" aria-label="${esc(name)} card ending ${esc(last4)}${status !== 'active' ? ', ' + esc(STATUS[status] ?? status) : ''}">
    <div class="top"><span class="bank">USA <b>Banc</b></span><span class="pname">${esc(name)}</span></div>
    <div class="chip" aria-hidden="true"></div>
    <div class="num" aria-hidden="true">•••• •••• •••• ${esc(last4)}</div>
    <div class="bot"><span><span class="lbl">Card holder</span>${esc(holder)}</span><span><span class="lbl">Valid thru</span>${esc(exp)}</span><span class="mark" aria-hidden="true">DEMO</span></div>
    ${status !== 'active' ? `<div class="veil" aria-hidden="true">${esc(STATUS[status] ?? status)}</div>` : ''}
  </div>`;
}
export const pill = (cls, text) => `<span class="c-pill ${esc(cls)}">${esc(text)}</span>`;
