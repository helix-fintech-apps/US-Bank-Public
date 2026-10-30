-- M7 + M8: loan products, decision rules (as data), a simulated credit file (score history, inquiries),
-- applications with their decisions, loans and loan payments. Money is bigint cents; rates are basis points
-- (774 = 7.74% APR). Product ranges and rules are demo defaults from docs/RESEARCH.md §4 and §5.
-- Simulated: there is no real credit bureau. Scores and inquiries live only in this database.

-- System accounts for loan money (range ...040-...049, docs/CONTRIBUTING.md):
--   040 interest a borrower pays is the bank's income
--   041 loan principal leaves the bank through here: to the borrower's deposit account, or to a dealer (simulated)
--   042 loan payments that arrive from another bank by ACH autopay (simulated: no real ACH transfer is made)
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000040', 'system', 'Loan interest income', 'loan_interest_income', true),
  ('00000000-0000-4000-8000-000000000041', 'system', 'Loan disbursements', 'loan_disbursement', true),
  ('00000000-0000-4000-8000-000000000042', 'system', 'Loan autopay clearing (ACH)', 'loan_autopay_clearing', true);

CREATE TABLE loan_products (
  code text PRIMARY KEY,                                                -- personal, auto_new, auto_used, auto_refi, home_equity, heloc
  family text NOT NULL CHECK (family IN ('personal', 'auto', 'home')),
  name text NOT NULL,
  blurb text NOT NULL,
  min_amount_cents bigint NOT NULL, max_amount_cents bigint NOT NULL,
  min_term int NOT NULL, max_term int NOT NULL,
  apr_min_bps int NOT NULL, apr_max_bps int NOT NULL,
  collateral text CHECK (collateral IN ('vehicle', 'home')),            -- null: unsecured
  sort int NOT NULL,
  source text NOT NULL                                                  -- where the range comes from
);

-- APR by simulated score band: the highest band whose min_score the applicant's score reaches.
CREATE TABLE loan_rate_bands (
  product_code text NOT NULL REFERENCES loan_products(code),
  min_score int NOT NULL,
  apr_bps int NOT NULL,
  PRIMARY KEY (product_code, min_score)
);

-- Decision rules. Each row is one check; a failing check becomes one adverse-action reason, ranked by `rank`.
-- counter = true: a lower amount or a longer term can cure it, so it can lead to a counteroffer.
CREATE TABLE loan_rules (
  product_code text NOT NULL REFERENCES loan_products(code),
  rule text NOT NULL CHECK (rule IN ('min_score', 'max_dti', 'max_ltv', 'max_cltv')),
  limit_value int NOT NULL,                                              -- a score, or a ratio in basis points (4300 = 43%)
  counter boolean NOT NULL,
  rank int NOT NULL,
  reason text NOT NULL,                                                  -- plain words, as an adverse action notice lists it
  PRIMARY KEY (product_code, rule)
);

-- The simulated credit file. base_score is deterministic per user; factors move it (see lib/loans-credit/credit.mjs).
CREATE TABLE credit_files (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_score int NOT NULL CHECK (base_score BETWEEN 300 AND 850),
  late_payments int NOT NULL DEFAULT 0,                                  -- 30+ days late, last 24 months
  oldest_months int NOT NULL DEFAULT 0,                                  -- age of the oldest account on file
  other_monthly_debt_cents bigint NOT NULL DEFAULT 0,                    -- payments on debts held outside USA Banc
  other_kinds text[] NOT NULL DEFAULT '{}',                              -- revolving / installment / mortgage held elsewhere
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_score_history (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL,                                                   -- first day of the month
  score int NOT NULL CHECK (score BETWEEN 300 AND 850),
  PRIMARY KEY (user_id, month)
);
-- Every credit pull (RESEARCH.md §4 (c) credit_pull). Soft pulls (prequalify, offers) never change the score; hard pulls
-- (applications) count against it for 12 months. bureau is always 'Simulated': no real bureau is ever contacted.
CREATE TABLE credit_pulls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('soft', 'hard')),
  source text NOT NULL CHECK (source IN ('loan', 'card', 'prequalify')),
  bureau text NOT NULL DEFAULT 'Simulated' CHECK (bureau = 'Simulated'),
  score int CHECK (score BETWEEN 300 AND 850),                           -- the simulated score the pull returned
  label text NOT NULL,                                                   -- what the customer sees: "Personal Loan application"
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_pulls_user ON credit_pulls(user_id, at DESC);

-- Credit monitoring alerts (RESEARCH.md §5): a new hard pull, a new account, a paid-off loan, a score change.
-- ref makes each alert once-only: one per pull, per loan, per month of score change.
CREATE TABLE credit_alerts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hard_pull', 'new_account', 'paid_off', 'score_change')),
  ref text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, ref)
);
CREATE INDEX credit_alerts_user ON credit_alerts(user_id, id DESC);

CREATE TABLE loan_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  product_code text NOT NULL REFERENCES loan_products(code),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  term_months int NOT NULL,
  annual_income_cents bigint NOT NULL,
  housing_cents bigint NOT NULL,
  employment text NOT NULL,
  collateral jsonb,                                                      -- vehicle / property value, mortgage balance (cents as strings)
  score int NOT NULL,                                                    -- the hard-check score used for the decision
  dti_bps int,
  ltv_bps int,
  pull_id uuid REFERENCES credit_pulls(id),                              -- the hard pull this decision used
  decision text NOT NULL CHECK (decision IN ('approved', 'counteroffer', 'declined')),
  reasons jsonb NOT NULL DEFAULT '[]',                                   -- ranked adverse-action reasons (declined / counteroffer)
  offer_amount_cents bigint, offer_term int, offer_apr_bps int, offer_payment_cents bigint,
  offer_expires_at timestamptz,
  status text NOT NULL DEFAULT 'decided' CHECK (status IN ('decided', 'accepted')),
  accept_key text UNIQUE,                                                -- the idempotency key that accepted it
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_applications_user ON loan_applications(user_id, created_at DESC);

-- One row per loan account (accounts.kind = 'loan'; its balance is negative = owed).
CREATE TABLE loans (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  application_id uuid UNIQUE REFERENCES loan_applications(id),          -- unique: an offer funds one loan, once
  product_code text NOT NULL REFERENCES loan_products(code),
  principal_cents bigint NOT NULL,
  apr_bps int NOT NULL,
  term_months int NOT NULL,
  payment_cents bigint NOT NULL,
  originated_on date NOT NULL,
  next_due date,
  last_paid_on date,                                                     -- payoff interest accrues from here
  installments_paid int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid_off')),
  paid_off_on date,
  disbursed_to uuid REFERENCES accounts(id),
  collateral_label text
);

CREATE TABLE loan_payments (
  id uuid PRIMARY KEY,
  loan_account_id uuid NOT NULL REFERENCES loans(account_id),
  from_account_id uuid REFERENCES accounts(id),                          -- null for seeded payments that came in by ACH
  kind text NOT NULL CHECK (kind IN ('scheduled', 'extra', 'payoff')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  principal_cents bigint NOT NULL CHECK (principal_cents >= 0),
  interest_cents bigint NOT NULL CHECK (interest_cents >= 0),
  CHECK (amount_cents = principal_cents + interest_cents),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  idempotency_key text NOT NULL UNIQUE,
  posted_on date NOT NULL DEFAULT current_date,
  created_by uuid REFERENCES users(id)
);
CREATE INDEX loan_payments_loan ON loan_payments(loan_account_id, posted_on DESC);

-- ---------- data: products (RESEARCH.md §4 "Product specifics to model") ----------
INSERT INTO loan_products VALUES
  ('personal', 'personal', 'Personal Loan', 'Fixed rate, no fees. Lump sum to your checking or savings.', 100000, 2500000, 12, 84, 774, 2499, NULL, 1,
   'RESEARCH.md §4: $1,000+ (cap ~$25k), 12–84 months, ~7.7%–25% APR fixed'),
  ('auto_new', 'auto', 'New Auto Loan', 'For a new vehicle. Borrow up to 125% of its value.', 500000, 10000000, 12, 72, 549, 1399, 'vehicle', 2,
   'RESEARCH.md §4: auto by vehicle value, 12–72 months, risk-based rate (demo default)'),
  ('auto_used', 'auto', 'Used Auto Loan', 'For a used vehicle. Borrow up to 120% of its value.', 500000, 10000000, 12, 72, 649, 1499, 'vehicle', 3,
   'RESEARCH.md §4: auto by vehicle value, 12–72 months, risk-based rate (demo default)'),
  ('auto_refi', 'auto', 'Auto Refinance', 'Move a car loan from another lender. Up to 110% of value.', 500000, 10000000, 24, 72, 649, 1499, 'vehicle', 4,
   'RESEARCH.md §4: auto by vehicle value, 12–72 months, risk-based rate (demo default)'),
  ('home_equity', 'home', 'Home Equity Loan', 'Fixed-rate lump sum against your home. CLTV up to 85%.', 1500000, 75000000, 60, 240, 699, 1299, 'home', 5,
   'RESEARCH.md §4: $15k–$750k, fixed term, ~6%–13% APR'),
  ('heloc', 'home', 'Home Equity Line of Credit', 'A line against your home. Demo: one draw at opening, repaid monthly. CLTV up to 85%.', 1500000, 75000000, 60, 240, 724, 1299, 'home', 6,
   'RESEARCH.md §4: $15k–$750k, variable ~6%–13% (demo holds the offered rate)');

-- APR by score band (illustrative, inside each product's sourced range)
INSERT INTO loan_rate_bands VALUES
  ('personal', 760, 774), ('personal', 720, 999), ('personal', 680, 1399), ('personal', 640, 1899), ('personal', 600, 2499),
  ('auto_new', 760, 549), ('auto_new', 720, 649), ('auto_new', 680, 799), ('auto_new', 640, 1049), ('auto_new', 580, 1399),
  ('auto_used', 760, 649), ('auto_used', 720, 749), ('auto_used', 680, 899), ('auto_used', 640, 1149), ('auto_used', 580, 1499),
  ('auto_refi', 760, 649), ('auto_refi', 720, 749), ('auto_refi', 680, 899), ('auto_refi', 640, 1149), ('auto_refi', 580, 1499),
  ('home_equity', 760, 699), ('home_equity', 720, 749), ('home_equity', 680, 849), ('home_equity', 640, 1299),
  ('heloc', 760, 724), ('heloc', 720, 799), ('heloc', 680, 924), ('heloc', 660, 1299);

-- Rules: RESEARCH.md §4 "Decisioning: score + DTI + LTV (secured) + income". Thresholds are industry-typical demo
-- defaults (43% DTI is the classic qualified-mortgage line; 85% CLTV is a common home-equity cap).
INSERT INTO loan_rules VALUES
  ('personal', 'min_score', 600, false, 1, 'Credit score is below our minimum for this loan'),
  ('personal', 'max_dti', 4300, true, 2, 'Debt payments are too high compared with income'),
  ('auto_new', 'min_score', 580, false, 1, 'Credit score is below our minimum for this loan'),
  ('auto_new', 'max_dti', 4500, true, 3, 'Debt payments are too high compared with income'),
  ('auto_new', 'max_ltv', 12500, true, 2, 'Loan amount is too high compared with the vehicle''s value'),
  ('auto_used', 'min_score', 580, false, 1, 'Credit score is below our minimum for this loan'),
  ('auto_used', 'max_dti', 4500, true, 3, 'Debt payments are too high compared with income'),
  ('auto_used', 'max_ltv', 12000, true, 2, 'Loan amount is too high compared with the vehicle''s value'),
  ('auto_refi', 'min_score', 580, false, 1, 'Credit score is below our minimum for this loan'),
  ('auto_refi', 'max_dti', 4500, true, 3, 'Debt payments are too high compared with income'),
  ('auto_refi', 'max_ltv', 11000, true, 2, 'Loan amount is too high compared with the vehicle''s value'),
  ('home_equity', 'min_score', 640, false, 1, 'Credit score is below our minimum for this loan'),
  ('home_equity', 'max_dti', 4300, true, 3, 'Debt payments are too high compared with income'),
  ('home_equity', 'max_cltv', 8500, true, 2, 'Total borrowing against the home is too high compared with its value'),
  ('heloc', 'min_score', 660, false, 1, 'Credit score is below our minimum for this loan'),
  ('heloc', 'max_dti', 4300, true, 3, 'Debt payments are too high compared with income'),
  ('heloc', 'max_cltv', 8500, true, 2, 'Total borrowing against the home is too high compared with its value');
