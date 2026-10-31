-- Personal loan servicing (/api/loan-servicing): fixed-rate personal loans with a 30/360 schedule, late fees, extra
-- payments and payoff quotes. Separate from the loans module (040): these loans are not rows of `loans`, so /api/loans
-- neither lists nor pays them. Each loan owns one accounts row (kind 'loan', balance = -principal owed); interest and
-- fees are never posted to it. Money is bigint cents, rates are basis points. No system accounts are added: interest
-- goes to loan_interest_income (040) and late fees to fee_income (001).

CREATE TABLE personal_loans (
  id uuid PRIMARY KEY REFERENCES accounts(id),                          -- the loan account's id is the loan id
  seq bigserial UNIQUE,                                                 -- creation order (newest first in the list)
  user_id uuid NOT NULL REFERENCES users(id),                           -- the borrower: the only customer who can see or pay it
  principal_cents bigint NOT NULL CHECK (principal_cents > 0),
  apr_bps int NOT NULL,
  term_months int NOT NULL,
  payment_day int NOT NULL CHECK (payment_day BETWEEN 1 AND 28),
  payment_cents bigint NOT NULL,
  late_fee_cents bigint NOT NULL,
  originated_on date NOT NULL,
  first_due_date date NOT NULL,
  disbursement_account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid_off')),
  -- state (only payments change it)
  principal_balance_cents bigint NOT NULL CHECK (principal_balance_cents >= 0),   -- P
  interest_due_cents bigint NOT NULL DEFAULT 0 CHECK (interest_due_cents >= 0),   -- I
  interest_remainder bigint NOT NULL DEFAULT 0 CHECK (interest_remainder >= 0 AND interest_remainder < 3600000),   -- R, over 3,600,000 of a cent
  accrued_through date NOT NULL,                                                  -- AT
  installments_paid int NOT NULL DEFAULT 0,
  late_installments_paid int NOT NULL DEFAULT 0,                                  -- paid by a scheduled payment more than 10 days after due
  fees_paid_cents bigint NOT NULL DEFAULT 0,
  payments_made int NOT NULL DEFAULT 0,                                           -- a quote is stale once this moves
  paid_off_on date,
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_loans_user ON personal_loans(user_id, status);

CREATE TABLE personal_loan_payments (
  id uuid PRIMARY KEY,
  seq bigserial UNIQUE,
  loan_id uuid NOT NULL REFERENCES personal_loans(id),
  kind text NOT NULL CHECK (kind IN ('scheduled', 'extra', 'payoff')),
  installment_number int,
  CHECK ((kind = 'scheduled') = (installment_number IS NOT NULL)),
  posted_on date NOT NULL,
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  interest_cents bigint NOT NULL CHECK (interest_cents >= 0),
  principal_cents bigint NOT NULL CHECK (principal_cents >= 0),
  CHECK (amount_cents = fee_cents + interest_cents + principal_cents),
  principal_balance_after_cents bigint NOT NULL,
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_loan_payments_loan ON personal_loan_payments(loan_id, seq);

CREATE TABLE personal_loan_quotes (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES personal_loans(id),
  created_on date NOT NULL,
  good_through date NOT NULL,
  principal_cents bigint NOT NULL,
  interest_cents bigint NOT NULL,
  fee_cents bigint NOT NULL,
  amount_cents bigint NOT NULL,
  payments_made int NOT NULL,                                           -- the loan's payments_made when quoted
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_loan_quotes_loan ON personal_loan_quotes(loan_id);

-- Request ids of this feature, one per customer across all its endpoints. Written only when a request succeeds.
-- fingerprint = sha256 of the endpoint, its path ids and the body without the id.
CREATE TABLE personal_loan_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  loan_id uuid NOT NULL REFERENCES personal_loans(id),
  payment_id uuid REFERENCES personal_loan_payments(id),               -- null for taking out the loan
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
