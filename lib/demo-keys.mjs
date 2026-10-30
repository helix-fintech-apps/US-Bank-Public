// Server keys that have built-in demo fallbacks. USA Banc is a fictional bank with made-up data, so a deploy without
// them still works; set them to real random values to override (README "Run locally / Deploy").
export const DEMO_FALLBACKS = {
  ACCOUNT_ENCRYPTION_KEY: 'usabanc-demo-account-encryption-key',   // seals external account, payee and wire account numbers
  CARD_PAN_KEY: 'usabanc-demo-card-vault-key',                     // derives demo card numbers from vault tokens
  SSN_PEPPER: 'usabanc-demo-ssn-pepper'                            // keys the SSN hash used to spot duplicates
};

/**
 * The keys whose demo fallbacks are in use. CARD_PAN_KEY and SSN_PEPPER fall back only when unset and are otherwise used
 * exactly as set, never trimmed (card numbers and SSN hashes already made from them must not change);
 * ACCOUNT_ENCRYPTION_KEY was always read trimmed, and an empty one falls back.
 */
export const usingDemoKeys = (env = process.env) => Object.keys(DEMO_FALLBACKS)
  .filter(k => (k === 'ACCOUNT_ENCRYPTION_KEY' ? !String(env[k] ?? '').trim() : env[k] === undefined));

let warned = false;
/** One warning line per process, at startup, naming the keys that fall back to demo values. */
export function warnDemoKeys(log = console.warn, env = process.env) {
  const missing = usingDemoKeys(env);
  if (warned || !missing.length) return null;
  warned = true;
  const line = `usabanc: ${missing.join(', ')} not set; using built-in demo keys (fictional data only). Set them to override.`;
  log(line);
  return line;
}
