# USA Banc

A **fictional** digital bank for testing assurance and compliance playbooks. Its feature set is modeled on a full-service US retail bank: checking, savings, transfers, ACH, Zelle-style P2P, wires, bill pay, debit and credit cards, lending with credit decisioning, credit tools, and solo, joint/family and minor accounts.

USA Banc is not a real bank. It is not affiliated with U.S. Bank, U.S. Bancorp or any other financial institution, it uses original branding, and no real money, credit bureau or payment network is involved.

- `docs/RESEARCH.md`: the capability inventory, data model and build order.
- `public/`: the website (public pages, sign-in, and the signed-in banking app under `public/app/`).
- `lib/`: the API (one Node handler, served at `/api/*`), with Postgres migrations in `db/migrations/`.
- `docs/CONTRIBUTING.md`: how to build a feature and the checks to run before a PR.
- Deploys to Vercel on the free Hobby plan with `.\scripts\release.ps1` (PowerShell, from any folder). It uses the Vercel CLI under your personal account, so no Team or paid plan is needed. Live at https://usa-banc.vercel.app once released.

## Status
- [x] Landing page and info pages (USA Banc brand)
- [x] M0 skeleton + audit trail, M1 sign-in with one-time codes (MFA), lockout and step-up
- [x] M3 account servicing: activity search and categories, statements (PDF), alerts, profile, security center, overdraft, secure messages
- [x] M2 onboarding (solo, joint, minor) and M5 family controls, M4 money movement (transfers, ACH, USA Pay, wires, bill pay), M6 cards, M7 loans, M8 credit tools

## Run locally
Needs Node 22+ and a Postgres server.
```
npm ci
npm run serve        # http://127.0.0.1:3000 (site + API)
```
On the first API request the server runs the migrations and loads the demo data.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://payroll@localhost:5433/usabanc` (for `npm run serve`) | The Postgres database the API uses. On Vercel it is required; Neon strings with `sslmode=require` turn on TLS. |
| `PORT` | `3000` | Port for `npm run serve`. |
| `DEMO_REVEAL_CODES` | on | One-time codes are shown on screen as a "simulated text message" (no texts are sent). Set to `0` to hide them. |
| `DEMO_SEED` | on | Loads the demo customers and accounts on first use (safe to run again). Set to `0` to skip it. |
| `TEST_DATABASE_URL` | `postgres://payroll@localhost:5433/usabanc_test` | Used by the tests; each test file gets its own schema. |

### Optional key overrides (local and deploy)
Every one has a built-in demo value, so a deploy without them works (all data is fictional); when
any is missing the server logs one warning line at startup naming it. Set them (locally or in the Vercel project's
environment variables) to real random values to override. Changing one later makes data sealed or derived with the old
value unreadable or different, so pick them before the first deploy.

| Variable | Default | What it does |
|---|---|---|
| `ACCOUNT_ENCRYPTION_KEY` | demo key (`usabanc-demo-account-encryption-key`, hashed to 32 bytes) | AES-256-GCM key for full account numbers (external accounts, payees, wires). 64 hex characters or 32 bytes in base64. A value that is set but the wrong length refuses those features (503) instead of falling back. |
| `CARD_PAN_KEY` | `usabanc-demo-card-vault-key` | HMAC key that derives demo card numbers from their vault tokens. |
| `SSN_PEPPER` | `usabanc-demo-ssn-pepper` | HMAC key for the SSN hash used to spot a second customer with the same SSN. |

Checks: `PW_CHROMIUM=/path/to/chromium npm run check` (lint, API tests, browser tests).

