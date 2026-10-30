// The simulated credit file: a deterministic base score per user, moved by factors read from this database
// (real card balances and limits, loans, inquiries). Simulated: no real credit bureau is contacted.
import { createHash } from 'node:crypto';
import { newId } from '../auth.mjs';
import { divRound } from './amortize.mjs';
import { bankToday } from '../bank-date.mjs';

// Factor points (demo model, VantageScore-style 300–850; RESEARCH.md §5 "score + factors + simulator").
export const FACTORS = {
  latePoints: -45, lateCap: -135,                                 // each 30+ day late payment, last 24 months
  util: [[10, 20], [30, 0], [50, -25], [75, -50], [Infinity, -80]],   // [below this %, points]; ok-number: percent bands, not money
  noCard: -10,
  age: [[84, 15], [36, 0], [0, -20]],                             // [at least this many months, points]
  inquiryPoints: -5, inquiryCap: -30,                             // each hard inquiry in the last 12 months
  mix: { 3: 10, 2: 0, 1: -10, 0: -10 }
};
const clamp = s => Math.max(300, Math.min(850, s));
const hashOf = s => createHash('sha256').update(String(s)).digest().readUInt32BE(0);

/** Score + factor list from plain inputs. Pure, so the what-if tool runs the same model. */
export function scoreFrom({ base, late, oldestMonths, hardInquiries, owedCents, limitCents, kinds }) {
  const f = [];
  const latePts = Math.max(FACTORS.lateCap, late * FACTORS.latePoints);
  f.push({ key: 'payment', label: 'Payment history', impact: latePts, rating: late ? 'poor' : 'good',
    detail: late ? `${late} late payment${late > 1 ? 's' : ''} in the last 24 months.` : 'No late payments in the last 24 months.' });
  if (limitCents > 0n) {
    const pct = Number(divRound(owedCents * 100n, limitCents));        // ok-number: a whole percent, not money
    const pts = FACTORS.util.find(([lt]) => pct < lt)[1];
    f.push({ key: 'utilization', label: 'Credit card use', impact: pts, rating: pct < 30 ? 'good' : pct < 50 ? 'fair' : 'poor', percent: pct,
      detail: `You're using ${pct}% of your card limits with us. Under 30% helps; under 10% helps most.` });
  } else f.push({ key: 'utilization', label: 'Credit card use', impact: FACTORS.noCard, rating: 'fair', percent: null, detail: 'No credit card with us has reported a statement yet, so card use can\'t be measured.' });
  const agePts = FACTORS.age.find(([min]) => oldestMonths >= min)[1];
  const yrs = Math.floor(oldestMonths / 12);
  f.push({ key: 'age', label: 'Age of credit', impact: agePts, rating: agePts > 0 ? 'good' : agePts === 0 ? 'fair' : 'poor',
    detail: `Your oldest account is ${yrs ? `${yrs} year${yrs > 1 ? 's' : ''}` : `${oldestMonths} months`} old.` });
  const inqPts = Math.max(FACTORS.inquiryCap, hardInquiries * FACTORS.inquiryPoints);
  f.push({ key: 'inquiries', label: 'Hard inquiries', impact: inqPts, rating: hardInquiries === 0 ? 'good' : hardInquiries < 3 ? 'fair' : 'poor',
    detail: `${hardInquiries} hard ${hardInquiries === 1 ? 'inquiry' : 'inquiries'} in the last 12 months. Prequalifying never counts.` });
  const n = Math.min(3, kinds.size);
  f.push({ key: 'mix', label: 'Credit mix', impact: FACTORS.mix[n], rating: n >= 3 ? 'good' : n === 2 ? 'fair' : 'poor',
    detail: `You have ${n} of 3 kinds of credit (cards, installment loans, mortgage).` });
  return { score: clamp(base + f.reduce((s, x) => s + x.impact, 0)), factors: f };
}

/**
 * The user's file, created on first use from a hash of their username (so it is the same on every run). A demo username
 * with "score" + 3 digits (e.g. casey+score780@...) gets a neutral file that scores exactly that before any card or
 * inquiry: no late payments, 36 months of history, two kinds of credit elsewhere, and +10 for the "no card yet" factor.
 */
export function fileFor(username) {
  const m = /score(\d{3})/i.exec(String(username));
  if (m) return { base: Math.min(850, Math.max(300, parseInt(m[1], 10) - FACTORS.noCard)), late: 0, oldest: 36, kinds: ['revolving', 'installment'] };
  const h = hashOf(username);
  return { base: 640 + (h % 141), late: (h >>> 8) % 4 === 0 ? 1 : 0, oldest: 24 + ((h >>> 16) % 120), kinds: ['revolving'] };
}
export async function ensureFile(c, user) {
  const have = (await c.query('SELECT * FROM credit_files WHERE user_id = $1', [user.id])).rows[0];
  if (have) return have;
  const h = hashOf(user.username), f = fileFor(user.username);
  await c.query(`INSERT INTO credit_files (user_id, base_score, late_payments, oldest_months, other_kinds) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [user.id, f.base, f.late, f.oldest, f.kinds]);
  const { score } = await liveScore(c, user.id);
  for (let k = 11; k >= 1; k--)
    await c.query(`INSERT INTO credit_score_history (user_id, month, score) VALUES ($1, date_trunc('month', $4::date) - make_interval(months => $2), $3) ON CONFLICT DO NOTHING`,
      [user.id, k, clamp(score - k * 2 + ((h >>> k) % 7) - 3), bankToday()]);
  return (await c.query('SELECT * FROM credit_files WHERE user_id = $1', [user.id])).rows[0];
}

/**
 * Everything the score reads, from this database. A card counts toward card use and credit mix once it has reported, that
 * is, once its first statement closed (as a real issuer reports at statement close). So opening a card never moves the
 * score up on the day of its hard pull: the pull costs its inquiry points, and the new limit shows from the first statement.
 */
export async function inputsFor(c, userId) {
  const file = (await c.query('SELECT * FROM credit_files WHERE user_id = $1', [userId])).rows[0];
  const cards = (await c.query(`SELECT coalesce(sum(greatest(-a.balance_cents, 0)), 0)::bigint owed, coalesce(sum(a.credit_limit_cents), 0)::bigint lim, count(*)::int n
     FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND o.role IN ('owner','joint_owner') AND a.kind = 'credit_card' AND a.status <> 'closed'
       AND EXISTS (SELECT 1 FROM card_statements s WHERE s.account_id = a.id)`, [userId])).rows[0];
  const loans = (await c.query(`SELECT count(*)::int n FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE o.user_id = $1 AND o.role IN ('owner','joint_owner') AND a.kind = 'loan' AND a.status <> 'closed'`, [userId])).rows[0].n;
  const age = (await c.query(`SELECT coalesce(max((extract(year from age(now(), a.opened_at)) * 12 + extract(month from age(now(), a.opened_at)))::int), 0) m
     FROM accounts a JOIN account_owners o ON o.account_id = a.id WHERE o.user_id = $1 AND a.kind <> 'system'`, [userId])).rows[0].m;
  const inq = (await c.query("SELECT count(*)::int n FROM credit_pulls WHERE user_id = $1 AND kind = 'hard' AND at > now() - interval '12 months'", [userId])).rows[0].n;
  const kinds = new Set(file.other_kinds);
  if (cards.n) kinds.add('revolving');
  if (loans) kinds.add('installment');
  return { base: file.base_score, late: file.late_payments, oldestMonths: Math.max(file.oldest_months, age), hardInquiries: inq,
    owedCents: cards.owed, limitCents: cards.lim, kinds, otherMonthlyDebtCents: file.other_monthly_debt_cents };
}

export async function liveScore(c, userId) {
  const inputs = await inputsFor(c, userId);
  return { ...scoreFrom(inputs), inputs };
}

/** What-if: the same model with changed inputs. Nothing is saved. */
export function simulate(inputs, { payDownCents = 0n, newCardLimitCents = 0n, missPayment = false }) {
  const owed = inputs.owedCents - (payDownCents > inputs.owedCents ? inputs.owedCents : payDownCents);
  const kinds = new Set(inputs.kinds); if (newCardLimitCents > 0n) kinds.add('revolving');
  return scoreFrom({ ...inputs, owedCents: owed, limitCents: inputs.limitCents + newCardLimitCents,
    hardInquiries: inputs.hardInquiries + (newCardLimitCents > 0n ? 1 : 0), late: inputs.late + (missPayment ? 1 : 0), kinds });
}

/**
 * Records a pull on the simulated file (a credit_pull row, bureau 'Simulated'). Soft (prequalify): seen only by the
 * customer, never moves the score. Hard (an application): counts against the score for 12 months, and raises a
 * monitoring alert. Card applications (M6) call this with source 'card'.
 */
export async function recordPull(c, userId, { kind, source, label, score = null }) {
  const id = newId();
  await c.query('INSERT INTO credit_pulls (id, user_id, kind, source, label, score) VALUES ($1,$2,$3,$4,$5,$6)', [id, userId, kind, source, label, score]);
  if (kind === 'hard') await creditAlert(c, userId, { kind: 'hard_pull', ref: `pull:${id}`, title: 'New hard inquiry on your file',
    body: `${label}. If you didn't apply, contact us. (Simulated: no real credit bureau.)` });
  return id;
}

/** A credit monitoring alert, once per ref. */
export async function creditAlert(c, userId, { kind, ref, title, body }) {
  await c.query('INSERT INTO credit_alerts (user_id, kind, ref, title, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, ref) DO NOTHING', [userId, kind, ref, title, body]);
}
