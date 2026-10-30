// Sanctions screening of a wire's beneficiary name and country against the bank's fixed, fictional list.
// Simulated: the list below is made up for the demo; no real sanctions list or screening service is used.

// Each entry: list id, then its names (primary first, then aliases).
export const SANCTIONS_LIST = [
  ['SL-1001', ['Viktor Rastavan Dolenko']],
  ['SL-1002', ['Marisol Quenteral']],
  ['SL-1003', ['Harbinger Meridian Holdings', 'HMH Trading']],
  ['SL-1004', ['Olwen Tarsk']],
  ['SL-1005', ['José Álvaro Penhaligon']],
  ['SL-1006', ['Bakhtiyar Soomrai Trading Co']],
  ['SL-1007', ['Ilyana Voss-Marchetti']],
  ['SL-1008', ['Kestrel Obsidian Shipping Ltd']]
];

// The only supported countries, and how each is screened.
export const COUNTRIES = {
  US: ['United States', 'none'], CA: ['Canada', 'none'], GB: ['United Kingdom', 'none'], DE: ['Germany', 'none'],
  MX: ['Mexico', 'none'], JP: ['Japan', 'none'], AU: ['Australia', 'none'], XN: ['Norvania', 'none'],
  XV: ['Veldoria', 'sanctioned'], XS: ['Sarkhan', 'sanctioned'], XT: ['Tamarek', 'watch']
};

const IGNORED = new Set(['the', 'of', 'and', 'co', 'ltd', 'llc', 'inc', 'corp']);

/** Steps 1-4: NFD, accents removed, lower case, split on anything other than a-z and 0-9. */
export const rawTokens = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
/** The tokens a name is compared on (step 5: ignored words removed). */
export const tokens = s => rawTokens(s).filter(t => !IGNORED.has(t));

const sorted = ts => [...ts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(' ');
const sameSet = (a, b) => { const x = new Set(a), y = new Set(b); return x.size === y.size && [...x].every(t => y.has(t)); };

/** Edit distance (insert, delete or replace one character, each cost 1). */
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** 'exact_tokens', 'similar' or null for one beneficiary name against one list name. */
export function nameRule(beneficiary, listName) {
  const b = tokens(beneficiary), l = tokens(listName);
  if (b.length && sameSet(b, l)) return 'exact_tokens';
  const x = sorted(b), y = sorted(l), d = editDistance(x, y), L = Math.max(x.length, y.length);
  return d >= 1 && d <= (L < 12 ? 1 : 2) ? 'similar' : null;
}

/** { result, matches }: name matches in list order, then the country match. */
export function screen(name, country) {
  const matches = [];
  for (const [listId, names] of SANCTIONS_LIST) {
    const rules = names.map(n => nameRule(name, n));
    const rule = rules.includes('exact_tokens') ? 'exact_tokens' : rules.includes('similar') ? 'similar' : null;
    if (rule) matches.push({ kind: 'name', rule, listId });
  }
  const how = COUNTRIES[country]?.[1];
  if (how === 'sanctioned') matches.push({ kind: 'country', rule: 'sanctioned_country', listId: country });
  if (how === 'watch') matches.push({ kind: 'country', rule: 'watch_country', listId: country });
  const result = matches.some(m => m.rule === 'exact_tokens' || m.rule === 'sanctioned_country') ? 'hit' : matches.length ? 'potential_match' : 'clear';
  return { result, matches };
}
