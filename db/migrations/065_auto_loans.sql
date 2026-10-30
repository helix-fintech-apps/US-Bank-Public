-- Auto loan workflow (docs: Auto Loan Workflow requirements): applications decided by the loans module's engine,
-- a staff review queue for referred applications, 7-day offers with a cost disclosure, adverse action notices, and
-- funding through the existing loan_disbursement system account (…041, migration 040). No new system accounts.
-- Money is bigint cents; rates are basis points. Safe to run twice.

-- Staff: a user whose staff_role is 'loan_officer'. NULL for customers. No API sets it; the bank provisions staff here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role text CHECK (staff_role IN ('loan_officer'));

CREATE TABLE IF NOT EXISTS auto_loan_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  product_code text NOT NULL REFERENCES loan_products(code) CHECK (product_code IN ('auto_new', 'auto_used')),
  vehicle_year int NOT NULL,
  vehicle_make text NOT NULL,
  vehicle_model text NOT NULL,
  vehicle_id text NOT NULL,                                              -- 17-character VIN
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  down_payment_cents bigint NOT NULL CHECK (down_payment_cents >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  term_months int NOT NULL,
  annual_income_cents bigint NOT NULL,
  housing_cents bigint NOT NULL,
  employment text NOT NULL,
  disbursement_account_id uuid NOT NULL REFERENCES accounts(id),         -- chosen when applying
  submitted_on date NOT NULL,                                            -- bank date, for the 3-a-day limit
  -- the first, automatic outcome (never changes) and the current status. 'expired' is never stored: it is shown
  -- instead of approved / countered / funding_failed once today's bank date is past offer_expires_on.
  decision text NOT NULL CHECK (decision IN ('approved', 'declined', 'referred')),
  status text NOT NULL CHECK (status IN ('referred', 'approved', 'countered', 'declined', 'funded', 'funding_failed')),
  referral_reason text CHECK (referral_reason IN ('counteroffer', 'large_amount')),
  -- what the decision engine (lib/loans-credit/decide.mjs) returned when the application was made
  score int NOT NULL,
  dti_bps int,
  ltv_bps int,
  engine_outcome text NOT NULL CHECK (engine_outcome IN ('approved', 'declined', 'counteroffer')),
  engine_reasons jsonb NOT NULL DEFAULT '[]',
  engine_apr_bps int NOT NULL,
  suggested_offer jsonb,                                                 -- the engine's counteroffer { amountCents, termMonths, aprBps, paymentCents }
  pull_id uuid REFERENCES credit_pulls(id),
  -- the current offer (automatic approval, staff approval or staff counter)
  offer_type text CHECK (offer_type IN ('approved', 'countered')),
  offer_amount_cents bigint,
  offer_term int,
  offer_apr_bps int,
  offer_issued_on date,
  offer_expires_on date,
  -- the adverse action notice (a decline or a counter)
  notice_kind text CHECK (notice_kind IN ('decline', 'counter')),
  notice_issued_on date,
  notice_reasons jsonb,                                                  -- ["low_credit_score", ...] in decision order
  -- funding
  loan_id uuid REFERENCES accounts(id),
  failure_code text CHECK (failure_code IN ('account_not_open')),
  disbursed_to uuid REFERENCES accounts(id),
  origination_entry_id uuid REFERENCES journal_entries(id),
  disbursement_entry_id uuid REFERENCES journal_entries(id),
  accept_key text,                                                       -- the request id that funded it
  accept_fingerprint text,
  -- the apply request id, unique per customer, so a retry returns the first application
  idempotency_key text NOT NULL,
  idempotency_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, idempotency_key),
  CHECK ((status = 'funded') = (loan_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auto_loan_applications_user ON auto_loan_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_loan_applications_vehicle ON auto_loan_applications(vehicle_id);
CREATE INDEX IF NOT EXISTS auto_loan_applications_queue ON auto_loan_applications(created_at) WHERE status = 'referred';

-- Staff review actions, oldest first. offer: { amountCents, termMonths, aprBps } for approve and counter, NULL for decline.
CREATE TABLE IF NOT EXISTS auto_loan_actions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES auto_loan_applications(id),
  action text NOT NULL CHECK (action IN ('approve', 'decline', 'counter')),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]',
  offer jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS auto_loan_actions_application ON auto_loan_actions(application_id, at);
