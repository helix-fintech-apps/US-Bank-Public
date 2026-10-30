-- M2 + M5: opening deposit accounts (solo, joint, minor) with a simulated identity check, and family controls on
-- minors' accounts (spend limits, categories turned off, freeze, allowance, chores, savings goals).
-- Money is bigint cents. The full SSN is never stored: only its last 4 digits and a keyed hash (HMAC) for dedupe.

-- The deposit catalog. Rates, terms and minimums are data (docs/RESEARCH.md §1 "Product catalog"; demo values).
CREATE TABLE products (
  code text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('checking', 'savings', 'money_market', 'cd', 'teen_checking', 'custodial_savings')),
  name text NOT NULL,
  blurb text NOT NULL,
  apy_bp int,                                                          -- basis points; null = no interest
  term_months int,                                                     -- CDs only
  early_withdrawal_days int,                                           -- CDs: penalty in days of interest
  min_open_cents bigint NOT NULL CHECK (min_open_cents > 0),
  ownerships text[] NOT NULL,                                          -- solo, joint, minor
  minor_min_age int, minor_max_age int,                                -- minor products: the child's age range
  sort int NOT NULL
);
INSERT INTO products (code, kind, name, blurb, apy_bp, term_months, early_withdrawal_days, min_open_cents, ownerships, minor_min_age, minor_max_age, sort) VALUES
  ('smart_checking',    'checking',          'Smart Checking',            'Everyday checking with a debit card and bill pay.',           NULL, NULL, NULL,  2500, '{solo,joint}', NULL, NULL, 10),
  ('bright_savings',    'savings',           'Bright Savings',            'Variable-rate savings with savings goals.',                    410,  NULL, NULL,  2500, '{solo,joint}', NULL, NULL, 20),
  ('premier_mm',        'money_market',      'Premier Money Market',      'A higher variable rate for larger balances. Limited checks.',  425,  NULL, NULL, 100000, '{solo,joint}', NULL, NULL, 30),
  ('cd_6',              'cd',                '6-month CD',                'Fixed rate for 6 months.',                                     450,  6,    90,   50000, '{solo}',       NULL, NULL, 40),
  ('cd_12',             'cd',                '12-month CD',               'Fixed rate for 12 months.',                                    430,  12,   180,  50000, '{solo}',       NULL, NULL, 41),
  ('cd_24',             'cd',                '24-month CD',               'Fixed rate for 24 months.',                                    400,  24,   180,  50000, '{solo}',       NULL, NULL, 42),
  ('cd_60',             'cd',                '60-month CD',               'Fixed rate for 60 months.',                                    375,  60,   365,  50000, '{solo}',       NULL, NULL, 43),
  ('teen_checking',     'teen_checking',     'Teen Checking',             'Checking for ages 13 to 17, held jointly with a parent, with parental controls.', NULL, NULL, NULL, 1000, '{minor}', 13, 17, 50),
  ('custodial_savings', 'custodial_savings', 'Custodial Savings (UTMA)',  'Savings a custodian manages for a child under 18. The money belongs to the child.', 410, NULL, NULL, 2500, '{minor}', 0, 17, 60);

-- Extra facts about accounts opened here (kept out of the shared accounts table).
CREATE TABLE account_terms (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  product_code text NOT NULL REFERENCES products(code),
  ownership text NOT NULL CHECK (ownership IN ('solo', 'joint', 'minor')),
  term_months int,
  maturity_date date,
  early_withdrawal_days int,
  opened_by uuid NOT NULL REFERENCES users(id)
);

-- Identity on file after an approved check. One SSN, one customer.
CREATE TABLE customer_identities (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  date_of_birth date NOT NULL,
  address jsonb NOT NULL,
  ssn_last4 text NOT NULL CHECK (ssn_last4 ~ '^[0-9]{4}$'),
  ssn_hash text NOT NULL UNIQUE,                                       -- HMAC-SHA256 of the 9 digits
  verified_at timestamptz NOT NULL DEFAULT now()
);

-- Parent or guardian of a minor (a demo user with a login, or a profile the parent created without one).
CREATE TABLE family_links (
  guardian_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship text NOT NULL CHECK (relationship IN ('parent', 'guardian')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guardian_id, minor_id)
);

CREATE TABLE applications (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  applicant_id uuid NOT NULL REFERENCES users(id),
  product_code text NOT NULL REFERENCES products(code),
  ownership text NOT NULL CHECK (ownership IN ('solo', 'joint', 'minor')),
  co_owner_id uuid REFERENCES users(id),
  minor_id uuid REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('approved', 'review', 'declined')),
  reasons text[] NOT NULL DEFAULT '{}',                                -- plain words, shown to the customer
  legal_name text NOT NULL,
  date_of_birth date NOT NULL,
  address jsonb NOT NULL,
  ssn_last4 text NOT NULL CHECK (ssn_last4 ~ '^[0-9]{4}$'),
  ssn_hash text NOT NULL,
  ofac_hit boolean NOT NULL DEFAULT false,
  funding_account_id uuid REFERENCES accounts(id),
  opening_deposit_cents bigint NOT NULL CHECK (opening_deposit_cents > 0),
  funding_entry_id uuid REFERENCES journal_entries(id),
  account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_applicant ON applications(applicant_id, created_at DESC);

-- E-sign: which document version was accepted, when, from where.
CREATE TABLE disclosure_acceptances (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  application_id uuid REFERENCES applications(id),
  invite_id uuid,
  document_key text NOT NULL,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text
);

-- Joint co-owner invitations: the co-owner accepts (with their own identity check) on their side.
CREATE TABLE joint_invites (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES users(id),
  invitee_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'review')),
  reasons text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (account_id, invitee_id)
);

-- Family controls on a minor's account (docs/RESEARCH.md §1 "Minor parental controls").
CREATE TABLE family_controls (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed', 'view_only')),
  daily_limit_cents bigint NOT NULL CHECK (daily_limit_cents >= 0),
  weekly_limit_cents bigint NOT NULL CHECK (weekly_limit_cents >= daily_limit_cents),
  held_categories text[] NOT NULL DEFAULT '{}',                        -- merchant categories turned off
  card_frozen boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE allowances (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,  -- the minor's account
  from_account_id uuid NOT NULL REFERENCES accounts(id),               -- the parent's account
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  next_run_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE allowance_runs (
  allowance_id uuid NOT NULL REFERENCES allowances(id) ON DELETE CASCADE,
  run_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('paid', 'skipped')),
  reason text,
  entry_id uuid REFERENCES journal_entries(id),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (allowance_id, run_on)
);

CREATE TABLE chores (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  reward_cents bigint NOT NULL CHECK (reward_cents > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'paid', 'canceled')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  paid_at timestamptz,
  entry_id uuid REFERENCES journal_entries(id)
);

-- Money "set aside" for a goal stays in the account (an earmark, not a transfer).
CREATE TABLE savings_goals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_cents bigint NOT NULL CHECK (target_cents > 0),
  saved_cents bigint NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  target_date date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
