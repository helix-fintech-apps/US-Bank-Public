# Building a USA Banc feature

USA Banc is a **fictional demo bank**. Nothing moves real money, and nothing talks to a real bank network, card network or credit bureau. Every simulated part says so on screen. The feature plan is in `docs/RESEARCH.md`.

## How the code is laid out
| Path | What it is |
|---|---|
| `lib/http.mjs` | `AppError`, `refuse` (a refusal that keeps its writes), `router`, cookies, request checks |
| `lib/db.mjs` | `tx(pool, async c => …)`, `migrate`, `createPool` |
| `lib/auth.mjs` | `requireUser(c, req)`, `requireStepUp(user)`, `audit(c, req, userId, action, detail)`, `newId()` |
| `lib/access.mjs` | `accountFor(c, userId, accountId, roles)` with the role lists `VIEW` and `MOVE_MONEY` |
| `lib/ledger.mjs` | `post(c, { key, kind, memo, createdBy, lines })`, `systemAccount(c, code)` |
| `lib/money.mjs` | `parseAmount('12.34') -> 1234n`, `toStr(1234n) -> '12.34'` |
| `lib/bank-date.mjs` | `bankToday()`: the one business "today" (Central Time). Pass it into SQL instead of `current_date` |
| `lib/categories.mjs` | the one category list every feature posts, filters and controls with |
| `lib/dates.mjs` | `readDate` / `isDate`: the one real-date validator (no 2026-02-30, no year 0000) |
| `lib/routes/*.mjs` | API modules, each exporting `register(r)`, all listed in `lib/routes/index.mjs` |
| `lib/seeds/*.mjs` | demo data per feature, listed in `FEATURE_SEEDS` in `lib/seed.mjs` |
| `db/migrations/*.sql` | schema, run once each, in name order |
| `public/app/*` | signed-in pages, built on `/assets/client.js` |
| `tests/api/*.test.mjs` | API tests (`node --test`), each in its own database schema |
| `tests/browser/*.browser.mjs` | browser tests, run by `tests/smoke.mjs` |

## Rules
**Money**
- Amounts are **BigInt cents**. Parse input with `parseAmount`, output with `toStr`, and never use `Number` for money. The browser never does money math; the API returns strings.
- Money moves **only** through `post()` in `lib/ledger.mjs`. Every entry has an idempotency key.
  - The client sends `idempotencyKey` (from `newKey()` in `client.js`).
  - The server uses `` `${user.id}:${feature}:${body.idempotencyKey}` ``, so one user's key can never collide with another's.
  - A retry with the same key returns the first result instead of posting again.
- Money leaving the bank goes through a **system account**: ACH, P2P, wire, card settlement, loan funding, bill pay, fees, interest. Add new ones in your migration with a fixed UUID from your range (below).
- Limits, approvals and holds are **data** (tables or constants with a comment that cites `docs/RESEARCH.md`), checked on the server and covered by tests.

**Access**
- Every handler starts with `requireUser`.
- Every account id from a request goes through `accountFor` with the role list the action needs.
- Someone else's account is a **404**, never a 403.
- Minors (role `minor`) can only do what their custodian's controls allow.

**Risky actions call `requireStepUp(user)` first.** The browser then asks for a code and retries automatically. Risky means:
- sending money to someone else, or out of the bank
- adding a payee or an external account
- changing contact details
- raising a limit
- accepting a loan
- replacing a card

**Audit:** write an `audit()` row for every money movement, every decision (credit, limit, approval) and every settings change. Never put a password, code, token or full account number in it.

**Errors:** use `AppError(status, code, message)` with a plain-words message the customer can act on. Use `refuse(...)` when the refusal's writes must be kept, such as a failed-attempt counter.

**Words:** use "held", never "blocked", and US spelling. Don't present a real company's brand as ours. Our P2P is **USA Pay**, our cards are **Cash+ Card** and so on. Label simulated parts: "Simulated: no real ACH transfer is made".

## Working in parallel without stepping on each other
- **Migrations:** use your feature's number and system-account UUID range:

  | Feature | Migration | System account UUIDs |
  |---|---|---|
  | Accounts & family (M2, M5) | `010_*.sql` | `…000000000010`–`…19` |
  | Money movement (M4) | `020_*.sql` | `…20`–`…29` |
  | Cards (M6) | `030_*.sql` | `…30`–`…39` |
  | Loans & credit (M7, M8) | `040_*.sql` | `…40`–`…49` |
  | Servicing (M3) | `050_*.sql` | `…50`–`…59` |
  | Audit fixes | `060_*.sql`–`069_*.sql` (060, 061 and 062 are taken) | none (they add no system accounts) |
  | Pay it in 4 | `065_pay_in_4.sql` | `…60`–`…69` |

  The next feature that needs a migration takes the next free number after the highest one in `db/migrations/` (today `063`) and, if it adds system accounts, a new UUID range starting at `…60`.

- **Shared lists:** only **append one line** to `lib/routes/index.mjs` (`modules`), `lib/seed.mjs` (`FEATURE_SEEDS`) and `public/assets/client.js` (`NAV`). Put everything else in your own files:
  - `lib/routes/<feature>.mjs`
  - `lib/seeds/<feature>.mjs`
  - `public/app/<feature>.html`
  - `public/assets/<feature>.css`
  - `tests/api/<feature>.test.mjs`
  - `tests/browser/<feature>.browser.mjs`
- Don't change another feature's files. If you need a change in the shared `lib/*.mjs`, keep it small and backward compatible, and say so in the PR.

## Checks before a PR
```
npm ci
PW_CHROMIUM=/opt/pw-browsers/chromium npm run check     # lint + API tests + browser tests
```
`TEST_DATABASE_URL` defaults to `postgres://payroll@localhost:5433/usabanc_test`. Each test file gets its own schema, so parallel runs are safe. Check every new page at 1280px and 390px wide: no sideways page scroll, no console errors.

## PRs
- One feature per branch, one PR, with `Closes #N` for its issue.
- GitHub Actions is paused, so the PR is where the checks you ran are recorded.
