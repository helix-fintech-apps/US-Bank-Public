# Digital Banking Capability Inventory & Data Model

**Purpose:** Reference spec for building a feature-equivalent **demo** consumer banking app under an
original brand. Modeled on the publicly observable capabilities of U.S. Bank (usbank.com) and its
mobile app. This is a capability inventory + data model for implementation — **not** marketing copy,
and **not** U.S. Bank's trademarked product names. Where a U.S. Bank product name is cited, it is
only to document how the real flow behaves; the demo should use original names.

**Branding note:** Do not reuse "U.S. Bank", "Bank Smartly", "Altitude", "Cash+", "ExtendPay",
"CreditView", or any Visa/Zelle marks as our product names. Pick an original brand (this doc uses
placeholder **"Harbor Bank"** / **"HarborPay"** / **"Harbor Teen"** in examples).

**Figures are illustrative.** Real banks do not publish most limits; they are shown per-account in
the app. Numbers below are realistic defaults for a demo, sourced where possible and otherwise set
to industry-typical values. Treat them as seed/config data, not legal fact.

**Legend for each section:** (a) key screens · (b) core API endpoints · (c) main DB tables/fields ·
(d) limits/rules/edge cases · (e) account-type applicability (solo / family-joint / minor).

Conventions used throughout:
- All money stored as integer **minor units** (cents), `bigint`, plus `currency` (`char(3)`, default `USD`).
- All tables carry `id uuid pk`, `created_at timestamptz`, `updated_at timestamptz` unless noted.
- Soft-delete via `deleted_at timestamptz null` where records must be retained for audit.
- Every state-changing write emits an `audit_event` row (see §6/§7).
- API is REST/JSON over HTTPS; auth via session cookie + CSRF, or bearer token for the app.

---

## 1. Account Types & Onboarding

### Product catalog (deposit)
| Product | Key traits to model |
|---|---|
| **Checking** | Debit card, overdraft settings, unlimited-ish transactions, bill pay eligible. |
| **Savings** | Interest-bearing (variable APY), withdrawal/transfer behavior, savings goals. |
| **Money market** | Higher tiered APY by balance, limited checks/debit. |
| **CD (time deposit)** | Fixed term (e.g. 3/6/12/24/60 mo), fixed APY, maturity date, early-withdrawal penalty, auto-renew flag. |

### Ownership models (the ones that matter for us)
- **Solo / individual** — one adult owner, full control.
- **Joint / family** — 2+ adult co-owners, each with full (or configurable) access; used for the
  teen "joint checking" pattern where a parent is co-owner on a 13–17 teen's account.
- **Minor / custodial**:
  - **UTMA/UGMA custodial** — adult custodian controls until the minor reaches the state age of
    majority (18/21/25 depending on state); assets irrevocably belong to the minor.
  - **Kid/Teen managed account with parental controls** — the pattern U.S. Bank implements via a
    bundled **Greenlight** card for kids (0–12) and a **joint teen checking** for 13–17, with
    parental spend limits, monitoring, card freeze, recurring allowance transfers, and savings
    goals. Chore-based tasks are a Greenlight-app feature, not core bank. [youth-banking]

### Identity / KYC steps (realistic flow)
A real US account-opening (CIP under the Bank Secrecy Act / USA PATRIOT Act) collects and verifies:
1. **Personal info:** legal name, DOB, residential address (no PO box), SSN/ITIN, phone, email,
   citizenship/residency.
2. **Identity verification:** knowledge-based (KBA) or document + selfie; vendor check against
   watchlists (OFAC), fraud/identity DBs, and a soft/no-impact identity pull.
3. **Funding:** initial deposit via linked external account, debit card, or internal transfer.
4. **Disclosures/e-sign:** truth-in-savings, fee schedule, e-consent, account agreement.
5. **Decision:** approved / needs review (manual KYC) / declined.

Minor flows add: **custodian/parent identity + relationship**, minor's DOB (drives majority date),
and often require the adult to already be a customer or to co-sign.

### (a) Screens
- Product chooser → eligibility → applicant info → ID verification → funding → disclosures/e-sign → confirmation.
- "Open a joint account" (add co-owner invite/consent).
- "Open an account for a child" (custodian path; collects minor + guardian).
- Account dashboard tile per opened account.

### (b) API
- `GET /products` (deposit catalog + rates/terms)
- `POST /applications` (start), `PATCH /applications/{id}` (step save)
- `POST /applications/{id}/identity-check`
- `POST /applications/{id}/funding`
- `POST /applications/{id}/submit` → returns `decision`
- `POST /accounts/{id}/owners` (add joint owner, with invite+consent)
- `GET /accounts`, `GET /accounts/{id}`

### (c) Tables
- `customer(id, legal_name, dob, ssn_enc, email, phone, address_*, kyc_status, majority_date, is_minor, created_at)`
- `kyc_check(id, customer_id, type, vendor, status, score, raw_result_jsonb, performed_at)`
- `account(id, product_type, ownership_type[solo|joint|custodial], status[open|pending|closed|frozen], opened_at, closed_at, apy_bps, term_months, maturity_date, early_withdrawal_penalty_bps, auto_renew, display_name)`
- `account_owner(id, account_id, customer_id, role[primary|joint|custodian|minor|viewer], permissions_jsonb, added_at, removed_at)`
- `application(id, applicant_customer_id, product_type, ownership_type, state[draft|submitted|review|approved|declined], decision_reason, funding_source_id, submitted_at, decided_at)`
- `disclosure_acceptance(id, customer_id, document_key, version, accepted_at, ip)`

### (d) Limits / rules / edge cases
- Applicant must be 18+ to be a primary/custodian; minor cannot be primary on an adult product.
- SSN uniqueness + duplicate-application throttling; store SSN encrypted (column-level KMS).
- CD: block withdrawals before maturity except with penalty; `maturity_date` triggers renew/close job.
- Joint add requires the invited co-owner's own identity verification + consent acceptance.
- Custodial: writes allowed only by custodian until `majority_date`; then a transition event converts control.

### (e) Account-type applicability
- **Solo:** full catalog.
- **Family/joint:** checking/savings/MMA; each owner gets access per `account_owner.permissions`.
- **Minor:** kid card (view/managed) + teen joint checking + UTMA custodial savings; no credit/lending products; stricter limits (see §1 parental controls and §2 limits).

### Minor parental controls (data model)
- `parental_control(id, account_id, minor_customer_id, guardian_customer_id, mode[view_only|managed], created_at)`
- `spend_rule(id, account_id, kind[per_txn_cap|daily_cap|weekly_cap|category_block|merchant_block|atm_disabled|online_disabled], value_cents, mcc_or_category, active)`
- `allowance(id, account_id, from_account_id, amount_cents, cadence[weekly|biweekly|monthly], next_run_date, active)`
- `chore(id, account_id, title, reward_cents, status[open|submitted|approved|paid], assigned_to, approved_by)` *(optional, app-layer)*
- `savings_goal(id, account_id, name, target_cents, saved_cents, target_date)`
- **View-only vs managed:** `view_only` = guardian sees activity but minor transacts within fixed limits; `managed` = guardian approves/triggers transfers, sets/edits spend rules, can freeze card (→ §3 card controls). Every change to a spend rule or allowance emits an audit event (parent is actor).

---

## 2. Money Movement

Each rail below needs: eligibility, a **limit check**, a **settlement timeline**, a status machine,
and (for risky rails) **step-up auth** (§7). Common status machine:
`created → pending_auth → scheduled → processing → completed | failed | returned | canceled`.

### 2.1 Internal transfers (between own accounts)
- Instant/real-time between accounts at same bank. Savings/MMA may have withdrawal-count limits.
- **(a)** Transfer form (from/to, amount, now/scheduled/recurring), review, confirm.
- **(b)** `POST /transfers/internal`, `GET /transfers`, `DELETE /transfers/{id}` (cancel if scheduled).
- **(c)** `transfer(id, from_account_id, to_account_id, amount_cents, type[internal], status, scheduled_date, recurrence_id, created_by)`
- **(d)** Can't overdraw beyond overdraft setting; savings excessive-withdrawal rule; cannot cancel once processing.
- **(e)** All types; minor only between own/linked family accounts and only if `managed`/within limits.

### 2.2 ACH / external account linking
- **Linking:** (1) **instant verification** via aggregator (Plaid-style) login, or (2) **micro-deposits** —
  two deposits < $1 arrive in 1–2 business days; user enters both amounts to verify; **unverified
  links auto-removed after 15 calendar days**. [KB0223484]
- **Eligible to link:** checking, savings, money market, brokerage. Non-bank accounts need ownership
  verification. [KB0210905]
- **Directions:** inbound (pull to us) and outbound (push to external); scheduled & recurring.
- **(a)** "Link external account" (instant/micro-deposit paths), "Verify micro-deposits",
  external transfer form, scheduled/recurring manager.
- **(b)** `POST /external-accounts` (start link), `POST /external-accounts/{id}/verify`,
  `POST /transfers/ach` (direction, speed=standard|next_day), `GET /external-accounts`.
- **(c)** `external_account(id, owner_customer_id, institution, routing_number, account_number_enc, type, verification_method, status[pending|verified|removed], micro_deposit_attempts, linked_at, removed_at)`;
  `ach_transfer` extends `transfer` with `direction[inbound|outbound]`, `sec_code`, `trace_number`, `return_code`.
- **(d)** Settlement: standard ACH ~1–3 business days; next-day available; cutoff ~late afternoon,
  weekends/holidays skipped. Micro-deposit retry cap (e.g. 3). Returns (R01 insufficient funds,
  R02 account closed, etc.) reverse the ledger and notify. Per-transfer, daily, and rolling-30-day
  caps shown in-app via "More about transfer limits". [KB0271695] Demo defaults: standard outbound
  $2,500/txn, $10k/day, $25k/30-day.
- **(e)** Solo/joint full. Minor: external linking typically disabled or guardian-only.

### 2.3 Wires (domestic / international)
- Real-time gross settlement; same-day if before cutoff; irrevocable once sent.
- **Cutoffs (model on observed U.S. Bank table):** domestic to same bank **6:00 pm CT**; domestic
  to other FI **4:30 pm CT**; international same-day Mon–Fri **3:00 pm CT** (USD and FX). Future-dated
  digital wires must be approved within 3 business days or by 3 pm CT on the scheduled day, whichever
  is sooner. [KB wire cutoffs]
- **Fees (industry-typical demo values):** outgoing domestic ~$30, outgoing intl ~$50, incoming
  domestic ~$15–$20, incoming intl ~$25; some tiers waived. [bankrate-survey]
- **(a)** Wire recipient setup (domestic vs intl: beneficiary bank, routing/SWIFT/IBAN, intermediary
  bank, purpose), review with fee + FX quote, step-up auth, confirm, receipt.
- **(b)** `POST /wire-recipients`, `POST /wires` (returns fee + FX quote), `POST /wires/{id}/confirm`, `GET /wires`.
- **(c)** `wire_recipient(id, owner_customer_id, name, address, bank_name, routing_or_swift, iban, intermediary_bank, is_international)`;
  `wire(id, from_account_id, recipient_id, amount_cents, fee_cents, fx_rate, fx_amount_cents, type[domestic|international], status, cutoff_met, sent_at)`
- **(d)** Hard cutoff enforcement; **irrevocable** (no cancel after send); mandatory step-up auth;
  OFAC screen on beneficiary for intl; FX quote expiry; large-wire manual review threshold.
- **(e)** Solo/joint only. Minor: not available.

### 2.4 Zelle-style P2P
- Enroll a US mobile number or email tied to a deposit account. Send / request / **split the bill**.
- **(a)** Enroll (claim phone/email token), recipients list, send (email/phone + amount + memo),
  request money, split (pick contacts, auto-divide), activity.
- **(b)** `POST /p2p/enroll`, `POST /p2p/recipients`, `POST /p2p/send`, `POST /p2p/request`,
  `POST /p2p/split`, `GET /p2p/activity`.
- **(c)** `p2p_enrollment(id, customer_id, token_type[email|phone], token, account_id, verified_at)`;
  `p2p_transfer(id, sender_id, recipient_token, amount_cents, memo, direction[send|request], status[pending|completed|declined|expired], settled_at)`;
  `p2p_split(id, originator_id, total_cents, request_ids[])`
- **(d)** Banks **do not publish** exact limits — shown per-account and vary by funding account,
  recipient, and history; **cannot be increased** by the user. [KB0069805] Limits apply to send AND
  request/split. New/unenrolled recipient: funds pending until they enroll, else expire (~14 days).
  Instant to enrolled recipients; **no reversals** (fraud warnings at send). Demo defaults: $1,000/day,
  $5,000 rolling-30-day; lower for new recipients.
- **(e)** Solo/joint. Minor: usually disabled or guardian-approved only.

### 2.5 Bill pay
- Add payees (billers from directory or manual), one-time & recurring payments, **eBills**
  (electronic bill presentment from supported billers), payment via check or electronic.
- **(a)** Payee list/add, pay form (now/scheduled/recurring), eBill inbox + autopay rule, payment history.
- **(b)** `POST /billpay/payees`, `GET /billpay/payees`, `POST /billpay/payments`,
  `POST /billpay/autopay`, `GET /billpay/ebills`.
- **(c)** `payee(id, owner_customer_id, name, biller_id, account_number_enc, address, is_ebill_enabled)`;
  `bill_payment(id, payee_id, from_account_id, amount_cents, method[electronic|check], status[scheduled|processing|sent|paid|canceled], send_date, deliver_by, recurrence_id)`;
  `ebill(id, payee_id, amount_due_cents, due_date, statement_url, status[new|paid|ignored])`;
  `autopay_rule(id, payee_id, type[full_balance|minimum|fixed], amount_cents, lead_days, active)`
- **(d)** Deliver-by vs send date (electronic ~1–2 bd, check ~5 bd); funds debited on send or deliver
  depending on method; adding a payee = step-up auth; insufficient funds → failed + alert.
- **(e)** Solo/joint. Minor: not available.

### Shared money-movement model
- `recurrence(id, cadence, interval, start_date, end_date, next_run_date, occurrences_remaining, active)`
- `limit_profile(account_id, rail, per_txn_cents, daily_cents, rolling_30d_cents)` + `limit_usage` ledger
  for enforcement. **Every money-movement submit runs a limit check and (for ACH≥threshold, wires,
  new payee/recipient, Zelle to new recipient) a step-up auth challenge** (§7).

---

## 3. Cards

### 3.1 Debit cards
- Issued with checking. Controls: lock/unlock, travel notices, channel toggles (ATM, online,
  international, contactless), per-category limits (reused by minor spend rules §1), replace/reissue,
  PIN, add to mobile wallet.
- **(a)** Card detail, lock toggle, controls/limits, travel notice, replace card, dispute a transaction.
- **(b)** `GET /cards`, `POST /cards/{id}/lock`, `POST /cards/{id}/controls`,
  `POST /cards/{id}/travel-notices`, `POST /cards/{id}/replace`.
- **(c)** `card(id, account_id, holder_customer_id, type[debit|credit], network, pan_last4, pan_token,
  exp_month, exp_year, status[active|locked|canceled|lost|stolen], is_virtual)`;
  `card_control(id, card_id, kind, value, active)`; `travel_notice(id, card_id, countries[], start, end)`
- **(d)** Lock is instant & reversible (blocks new auths, not pending); lost/stolen = permanent cancel + reissue.
- **(e)** Solo/joint (each owner can get a card); **minor cards carry parental spend rules + card freeze**.

### 3.2 Credit cards
**Product lineup types to model** (generic categories — use original names):
cash-back (rotating/choose-your-category), flat-rate travel/points (mid-tier + premium with annual
fee/credits), no-annual-fee everyday, **secured** (deposit $300–$5,000 = credit line & collateral),
student/credit-builder. [nerdwallet-usbank, youth not applicable]

- **Apply:** prequalification (soft pull, no credit impact, returns offers) → full application
  (hard pull) → decision (approved/declined/counteroffer with line & APR) → issuance (instant
  virtual number, physical card mailed).
- **Servicing:** statements, make a payment from a deposit account (**minimum / statement balance /
  current / custom**), autopay, disputes, **virtual card numbers**, rewards tracking/redemption,
  installment plan on a purchase (ExtendPay-style fixed-fee/APR plan). [shield-extendpay]
- **(a)** Card marketplace, prequalify form + offers, application, decision, card home (balance/
  available credit/points), statements list + PDF, make-a-payment, autopay setup, rewards,
  virtual card numbers, dispute wizard, installment-plan offer.
- **(b)** `POST /credit/prequalify`, `POST /credit-applications`, `POST /credit-applications/{id}/submit`,
  `GET /credit-cards/{id}`, `GET /credit-cards/{id}/statements`, `GET /.../statements/{sid}/pdf`,
  `POST /credit-cards/{id}/payments`, `POST /credit-cards/{id}/autopay`,
  `GET /credit-cards/{id}/rewards`, `POST /credit-cards/{id}/virtual-numbers`,
  `POST /credit-cards/{id}/disputes`, `POST /credit-cards/{id}/installment-plan`.
- **(c)** `credit_card_product(id, name, kind, annual_fee_cents, apr_min_bps, apr_max_bps, rewards_structure_jsonb, secured)`;
  `credit_account(id, customer_id, product_id, credit_limit_cents, balance_cents, available_cents,
  apr_bps, statement_day, min_due_cents, due_date, security_deposit_cents)`;
  `credit_statement(id, credit_account_id, period_start, period_end, new_balance_cents, min_due_cents,
  due_date, pdf_url)`; `credit_payment(id, credit_account_id, from_account_id, amount_cents,
  type[minimum|statement|current|custom], status, posted_at)`;
  `autopay(id, credit_account_id, type, from_account_id, active)`;
  `virtual_card_number(id, card_id, pan_token, exp, merchant_lock, spend_cap_cents, status)`;
  `reward_ledger(id, credit_account_id, points, cash_cents, type[earn|redeem], ref)`;
  `card_dispute(id, card_id, transaction_id, reason, amount_cents, status[opened|provisional_credit|resolved|denied], filed_at)`;
  `installment_plan(id, credit_account_id, principal_cents, fee_cents, apr_bps, term_months, monthly_cents, status)`
- **(d)** Prequalify = soft pull (no impact) & non-binding; full app = hard pull; decisioning on
  score/income/DTI; secured line = deposit; payment types compute from statement; autopay guards
  against NSF; disputes may post provisional credit then resolve; virtual numbers can be merchant-
  locked/capped; installment plan: eligible on purchase balances, in good standing, offer limited
  (e.g. once/calendar year). [shield-extendpay]
- **(e)** **Solo/joint adults only.** Minor: no credit products (can be an authorized user on an
  adult card in some banks, but out of scope for the demo).

---

## 4. Lending

Products: **personal loan, auto loan, home equity loan, HELOC (line of credit), mortgage, personal
line of credit.** Shared application + decisioning engine; differ by collateral, terms, and disbursement.

### Flow (shared)
`prequalify (soft pull, no impact) → full application (hard pull) → decision [approved | declined |
counteroffer] → accept terms / e-sign → disbursement → repayment (amortized)`.

- **Prequalify needs:** identity, requested amount/purpose, stated income, soft credit pull →
  estimated rate/term/payment; **no credit impact**. [usbank-heloc prequal]
- **Full application needs:** verified income (docs/employment), DTI, for secured: collateral
  details (property for HE/HELOC/mortgage; VIN/value for auto) + appraisal/valuation + title/lien;
  **hard credit pull**.
- **Decisioning:** score + DTI + LTV (secured) + income → approve/decline/counteroffer (different
  amount, rate, or term).

### Product specifics to model (demo defaults, sourced ranges)
| Product | Amount | Term | Rate (illustrative) | Collateral | Disbursement |
|---|---|---|---|---|---|
| Personal loan | $1,000+ (non-client cap ~$25k) | 12–84 mo (≤60 non-client) | ~7.7%–25% APR fixed, no fees | none | lump sum to deposit acct |
| Personal line of credit | revolving | revolving | variable | none | draws |
| Auto loan | by vehicle value | 12–72 mo | risk-based | vehicle (lien) | to dealer/seller |
| Home equity loan | $15k–$750k ($1M CA) | fixed term | ~6%–13% APR | home (2nd lien) | lump sum |
| HELOC | $15k–$750k ($100k NY cap) | draw + repay period | variable ~6%–13% | home | revolving draws |
| Mortgage | large | 15/20/30 yr | market | home (1st lien) | to escrow/seller |

Sources: [usbank-personal-loan], [usbank-heloc], [finder-heloc]. No closing costs/app fees on HE/HELOC
noted; personal loans marketed fee-free. Home-equity availability is **geographically limited**
(some states unavailable → offer cash-out refi instead).

- **(a)** Loan marketplace, prequalify form + estimate, full application (multi-step: income,
  collateral, review), decision screen (approved/counteroffer/declined), accept & e-sign,
  disbursement status, loan dashboard (balance, next payment, amortization schedule), make-a-payment,
  payoff quote, HELOC draw screen.
- **(b)** `POST /lending/prequalify`, `POST /loan-applications`, `PATCH /loan-applications/{id}`,
  `POST /loan-applications/{id}/submit` → decision, `POST /loan-applications/{id}/accept`,
  `GET /loans/{id}`, `GET /loans/{id}/schedule`, `POST /loans/{id}/payments`,
  `POST /loans/{id}/draw` (HELOC/LOC), `GET /loans/{id}/payoff-quote`.
- **(c)** `loan_product(id, kind, min_amount_cents, max_amount_cents, min_term, max_term, apr_min_bps,
  apr_max_bps, secured, revolving)`;
  `loan_application(id, customer_id, product_id, requested_amount_cents, purpose, stated_income_cents,
  dti_bps, collateral_jsonb, state[prequal|draft|submitted|review|approved|counteroffer|declined|accepted],
  offered_amount_cents, offered_apr_bps, offered_term, decision_reason, hard_pull_id)`;
  `loan(id, application_id, customer_id, principal_cents, balance_cents, apr_bps, term_months,
  origination_date, maturity_date, status[active|paid_off|delinquent|charged_off], disbursement_account_id)`;
  `amortization_entry(id, loan_id, n, due_date, principal_cents, interest_cents, balance_cents, status)`;
  `loan_payment(id, loan_id, from_account_id, amount_cents, principal_cents, interest_cents, posted_at)`;
  `credit_pull(id, customer_id, type[soft|hard], bureau, score, pulled_at, application_id)`
- **(d)** Prequalify never hard-pulls; full app hard-pulls once; counteroffer requires re-accept;
  secured loans gated on LTV + lien/title; HELOC enforces draw period vs repay period & available
  credit; amortization generated on origination; early payoff quote includes accrued interest;
  geographic eligibility gate on HE products.
- **(e)** **Solo/joint adults.** Joint applications = co-borrower (both pulled, both liable). Minor: none.

---

## 5. Credit Tools

- **Free credit score + monitoring:** VantageScore from a bureau (TransUnion) via a dashboard;
  score history, factors, alerts (on DB match), **score simulator**; educational only, not used for
  the bank's own decisions. [usbank-creditview]
- **Credit report view:** summarized tradelines/inquiries (demo: synthetic).
- **Prequalified offers:** personalized card/loan offers from soft data; "see if you prequalify"
  (no impact) → routes into §3/§4 apply flows.
- **(a)** Credit score home (gauge + trend), factors breakdown, alerts list + prefs, score simulator,
  prequalified-offers list.
- **(b)** `GET /credit-tools/score`, `GET /credit-tools/history`, `GET /credit-tools/factors`,
  `GET /credit-tools/alerts`, `POST /credit-tools/simulate`, `GET /credit-tools/offers`.
- **(c)** `credit_score(id, customer_id, bureau, model[VantageScore], score, pulled_at)`;
  `credit_factor(id, customer_id, factor, impact, detail)`;
  `credit_alert(id, customer_id, type, message, created_at, read_at)`;
  `prequalified_offer(id, customer_id, product_ref, terms_jsonb, expires_at, status)`
- **(d)** Monitoring score ≠ decisioning score; alerts require identity/DB match; offers expire &
  are non-binding; all soft-pull (no credit impact).
- **(e)** Solo/joint adults. Minor: not shown.

---

## 6. Account Servicing / Dashboard

- **Balances & accounts overview**; per-account **transaction history** with search, date/amount/
  type filters, and **auto-categorization** (MCC → category) + manual recategorize + tags.
- **Statements (PDF)** monthly per account.
- **Alerts & notifications:** balance thresholds, large transactions, deposits, payment due,
  login/security; channels email/SMS/push; per-alert prefs.
- **Spending insights:** category breakdown, trends, budgets.
- **External account aggregation:** read-only linked accounts for a full-picture view (separate from
  §2.2 transfer linking, though can share the link).
- **Profile/security:** contact info, password, MFA methods, trusted devices, trusted contacts,
  statement delivery prefs.
- **Overdraft settings:** opt-in/out of coverage, overdraft protection transfer (link savings),
  and **overdraft-fee-forgiveness** (deposit-by-deadline to waive; configurable alert prefs). [usbank-overdraft]
- **Disputes/claims:** transaction dispute status (ties to §3 card disputes).
- **Secure messaging/support:** threaded messages, attachments, document upload.
- **Joint-owner access & permissions:** each co-owner's role/permissions; invite/remove co-owner; view audit.

- **(a)** Dashboard, account detail + transaction list (search/filter), statements, alerts center +
  prefs, insights/budgets, linked-accounts aggregation, profile & security, overdraft settings,
  disputes list, secure-message inbox, manage-owners.
- **(b)** `GET /dashboard`, `GET /accounts/{id}/transactions?q&from&to&min&max&category`,
  `PATCH /transactions/{id}` (recategorize/tag), `GET /accounts/{id}/statements`,
  `GET /statements/{id}/pdf`, `GET/PUT /alerts`, `GET /insights`, `GET /linked-accounts`,
  `GET/PUT /profile`, `GET/PUT /overdraft-settings`, `GET /disputes`,
  `GET/POST /messages`, `GET /accounts/{id}/owners`.
- **(c)** `transaction(id, account_id, posted_at, amount_cents, direction[debit|credit], type,
  merchant, mcc, category, tags[], status[pending|posted], running_balance_cents, source_ref)`;
  `statement(id, account_id, period_start, period_end, pdf_url, generated_at)`;
  `alert_pref(id, customer_id, alert_type, channels[], threshold_cents, active)`;
  `notification(id, customer_id, type, body, channel, sent_at, read_at)`;
  `budget(id, customer_id, category, monthly_cap_cents)`;
  `linked_aggregated_account(id, customer_id, institution, type, balance_cents, last_synced_at)`;
  `overdraft_setting(id, account_id, opted_in, protection_source_account_id, forgiveness_enabled)`;
  `message_thread(id, customer_id, subject, status)`, `message(id, thread_id, sender, body, attachments[], sent_at)`;
  `audit_event(id, actor_customer_id, account_id, action, target_type, target_id, before_jsonb, after_jsonb, ip, device_id, created_at)`.
- **(d)** Pending vs posted; categorization override persists; statement generated on cycle close;
  overdraft forgiveness shows min deposit + deadline and sends reminders [usbank-overdraft]; joint
  owners see shared account activity but only their own profile; all servicing writes audited.
- **(e)** Solo: own view. Family/joint: shared account views, per-owner permissions, co-owner mgmt.
  Minor: guardian sees full servicing; minor gets restricted/managed view, no owner-management, no
  external aggregation.

---

## 7. Auth & Security

Patterns a real bank uses:
- **Login:** username/email + password (hashed w/ Argon2id/bcrypt); lockout + throttling.
- **MFA / OTP:** SMS/email OTP, authenticator TOTP, and/or passkey (WebAuthn); enroll ≥1 at signup.
- **Device trust:** remember trusted device (bound token + fingerprint); new device → MFA + optional
  email notice.
- **Step-up auth for risky actions:** re-challenge (OTP/passkey/password) before: adding an external
  account/payee/wire recipient, moving money above a threshold (ACH/wire/Zelle), sending any wire,
  changing contact info (email/phone/address), changing password/MFA, adding a card to a wallet,
  adding a joint owner.
- **Session management:** short idle timeout (e.g. 10–15 min) with warning, absolute session cap,
  server-side session store + revocation, CSRF protection, re-auth on sensitive pages.

- **(a)** Login, MFA enroll, OTP challenge, passkey register, device management, step-up modal,
  session-timeout warning, security center (password/MFA/devices/trusted contacts).
- **(b)** `POST /auth/login`, `POST /auth/mfa/challenge`, `POST /auth/mfa/verify`,
  `POST /auth/passkey/register`, `GET/DELETE /auth/devices`, `POST /auth/step-up`,
  `POST /auth/logout`, `POST /auth/refresh`.
- **(c)** `user_credential(id, customer_id, username, password_hash, status)`;
  `mfa_method(id, customer_id, type[sms|email|totp|passkey], secret_enc_or_pubkey, verified, is_default)`;
  `trusted_device(id, customer_id, fingerprint, label, last_seen, trusted_until)`;
  `session(id, customer_id, device_id, created_at, last_active_at, expires_at, revoked_at, ip)`;
  `step_up_challenge(id, session_id, action, target_ref, method, status[issued|passed|failed], expires_at)`;
  `login_attempt(id, username, ip, success, at)`; `trusted_contact(id, customer_id, name, phone, email)`.
- **(d)** OTP expiry (5 min) + attempt cap; lockout after N fails; step-up token single-use & action-
  scoped; device-trust expiry; contact-info change triggers notification to old + new; sessions
  revocable from device list; sensitive reads/writes re-check step-up.
- **(e)** All account types. Minor: guardian authenticates for managed actions; minor login (if any)
  is scoped to view/limited spend; step-up on guardian side for control changes.

---

## Recommended Build Order (Milestone Plan)

Target stack: **Postgres/Neon** backend, real web UI (e.g. Next.js/React or similar), **real login**
(sessions + MFA). Prioritize capabilities that best exercise **compliance/assurance playbooks**:
money movement with limits & approvals, lending decisioning, minor-account controls, and a complete
audit trail. Each milestone is independently demoable.

- **M0 — Skeleton & platform (foundation).** Repo, Neon Postgres, migrations, app shell, CI, seed
  scripts. Core tables: `customer`, `account`, `account_owner`, `audit_event`. Money as integer
  cents. **Audit event emitter wired from day one** — every state change writes `audit_event`.
  Deliverable: empty authenticated shell + schema.

- **M1 — Auth & security (gate for everything).** Login, password hashing, session store + idle/
  absolute timeout, MFA/OTP enroll + challenge, device trust, and the **step-up auth framework**
  (action-scoped, single-use). This is the backbone for approvals later. (§7)

- **M2 — Accounts & onboarding.** Deposit product catalog, solo onboarding with a mock KYC step
  (approve/review/decline), account dashboard, balances. Seed realistic accounts. (§1 solo)

- **M3 — Account servicing & dashboard.** Transactions (with search/filter/categorization),
  statements (PDF), alerts/notifications, profile & security center, overdraft settings. Makes the
  app feel real and gives the audit trail something to record. (§6)

- **M4 — Money movement with limits & approvals (highest compliance value).** Internal transfers,
  then ACH external linking (micro-deposit + mock instant) and ACH transfers, then Zelle-style P2P,
  then wires, then bill pay. Build the shared **`limit_profile` + limit-usage ledger** and wire
  **step-up auth** into risky submits (new payee/recipient, over-threshold, all wires). Status
  machines + settlement simulation. This milestone is the core playbook surface (limits, approvals,
  irrevocability, returns). (§2)

- **M5 — Minor / family accounts & parental controls.** Joint/co-owner model + permissions, custodial
  accounts, teen managed account, spend rules, allowance (recurring transfer), card freeze, savings
  goals, view-only vs managed. Exercises permission/segregation-of-duties and guardian-approval
  playbooks. (§1 minor, §3 minor card controls)

- **M6 — Cards.** Debit card controls (lock/unlock, travel, channel limits reused by minor rules),
  then credit cards: prequalify (soft) → apply (hard) → decision → issuance → statements → payments
  (min/statement/custom) → autopay → disputes → virtual numbers → rewards. (§3)

- **M7 — Lending & decisioning.** Shared prequalify/apply/decision engine (approve/decline/
  counteroffer), hard/soft `credit_pull`, amortization generation, disbursement, repayment; personal
  loan first, then auto/HE/HELOC/mortgage variants. Prime surface for **decisioning-audit** playbooks.
  (§4)

- **M8 — Credit tools.** Monitoring score + history + factors + simulator + alerts, prequalified
  offers routing into M6/M7. (§5)

- **M9 — Hardening & assurance.** Secure messaging/support, full audit-log viewer/export, admin/ops
  console, reconciliation jobs, alert-rules coverage, and end-to-end tests over limits, approvals,
  decisioning and audit completeness.

**Why this order:** M0–M1 establish the audit trail and approval framework that compliance playbooks
depend on; M4 (money movement with limits & step-up approvals) and M7 (lending decisioning) are the
two richest assurance surfaces and come as early as their dependencies allow; M5 (minor controls)
exercises permission/segregation logic. Audit events accrue from M0 so every later milestone is
testable against the trail.

---

## Sources
- U.S. Bank youth/minor banking (Greenlight, joint teen checking, age tiers): https://www.usbank.com/bank-accounts/youth-banking.html ; https://www.usbank.com/bank-accounts/how-to-open-a-bank-account-for-a-minor.html
- Zelle limits (not publicly fixed; where to view; applies to send/request/split): https://www.usbank.com/customer-service/knowledge-base/KB0069805.html
- External account linking / micro-deposits / 15-day removal: https://usbank.com/customer-service/knowledge-base/KB0223484.html ; eligibility https://www.usbank.com/customer-service/knowledge-base/KB0210905.html ; transfer-limit viewing https://www.usbank.com/customer-service/knowledge-base/KB0271695.html
- Wire cutoffs (domestic/intl): https://www.usbank.com/customer-service/knowledge-base/KB0200911.html ; fee survey context https://www.instarem.com/wire-transfer/us-bank/ ; https://wise.com/us/blog/international-transfer-us-bank-us
- Credit card lineup (cash-back, travel, secured, business): https://www.nerdwallet.com/best/credit-cards/us-bank-cards ; https://www.cardratings.com/credit-cards/issuer/us-bank
- Secured cards launch/structure: https://www.pymnts.com/ (US Bank secured cards, Oct 2021)
- ExtendPay installment plan terms: https://www.usbank.com/credit-cards/shield-visa-credit-card.html
- Personal loans (amounts/terms/APR): https://www.usbank.com (personal loan page, Feb 2026) ; https://www.moneylion.com/learn/us-bank-personal-loans ; https://www.nerdwallet.com/blog/loans/us-bank-premier-personal-loan-review/
- HELOC / home equity (amounts/APR/prequal/geo limits): https://www.usbank.com/home-loans/home-equity/home-equity-line-of-credit.html ; https://www.finder.com/home-equity/us-bank-heloc-review
- Free credit score / CreditView (VantageScore, TransUnion, simulator, educational only): https://www.usbank.com (CreditView Dashboard)
- Overdraft fee forgiveness: https://www.usbank.com/bank-accounts/checking-accounts/checking-customer-resources/overdraft-fee-forgiven

*Note: real banks do not publish most transaction limits; figures marked "demo defaults" are
industry-typical seed values, not U.S. Bank's actual numbers. Verify any production figure against
the live source.*
