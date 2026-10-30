-- Pay it in 4: one purchase split into four 0% installments, 14 days apart (lib/routes/pay-in-4.mjs).
-- Money is bigint cents. The plan's ledger entries move money only between the customer's accounts and the system
-- accounts below; installment amounts and late fees live on the installment rows until they are paid.

-- System accounts (range …60–…69).
--   pay4_receivable: what customers still owe on their plans (debited when a plan starts, credited as it is paid or refunded)
--   pay4_merchant:   the simulated merchant side: the bank pays the merchant for a stated purchase, and merchant refunds come in here
--   pay4_late_fees:  late fee income
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000060', 'system', 'Pay it in 4 receivable', 'pay4_receivable', true),
  ('00000000-0000-4000-8000-000000000061', 'system', 'Pay it in 4 merchant settlement (simulated)', 'pay4_merchant', true),
  ('00000000-0000-4000-8000-000000000062', 'system', 'Pay it in 4 late fee income', 'pay4_late_fees', true);

CREATE TABLE pay_in_4_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'defaulted', 'completed', 'canceled')),
  merchant text NOT NULL,
  source text NOT NULL CHECK (source IN ('ledger_line', 'stated')),
  line_id bigint REFERENCES ledger_lines(id),                           -- the purchase (ledger_line plans only)
  purchase_account_id uuid REFERENCES accounts(id),                     -- the account the purchase was on (ledger_line plans only)
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  autopay_account_id uuid NOT NULL REFERENCES accounts(id),
  refunded_cents bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,                                        -- the accept request id, unique per customer
  fingerprint text NOT NULL,                                            -- what the accept request looked like (same id, different request: refused)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (refunded_cents >= 0 AND refunded_cents <= total_cents),
  CHECK ((source = 'ledger_line') = (line_id IS NOT NULL) AND (line_id IS NULL) = (purchase_account_id IS NULL))
);
CREATE INDEX pay_in_4_plans_user ON pay_in_4_plans(user_id, created_at DESC);
-- A purchase is in at most one plan that is not canceled.
CREATE UNIQUE INDEX pay_in_4_plans_line ON pay_in_4_plans(line_id) WHERE line_id IS NOT NULL AND status <> 'canceled';

CREATE TABLE pay_in_4_installments (
  plan_id uuid NOT NULL REFERENCES pay_in_4_plans(id),
  number int NOT NULL CHECK (number BETWEEN 1 AND 4),
  due_date date NOT NULL,
  original_amount_cents bigint NOT NULL CHECK (original_amount_cents > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= original_amount_cents),   -- after refunds
  late_fee_cents bigint NOT NULL DEFAULT 0 CHECK (late_fee_cents >= 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'paid', 'missed', 'canceled')),
  paid_on date,
  entry_id uuid REFERENCES journal_entries(id),
  PRIMARY KEY (plan_id, number),
  CHECK ((status = 'paid') = (entry_id IS NOT NULL AND paid_on IS NOT NULL))
);

-- One row per try to collect an installment.
CREATE TABLE pay_in_4_attempts (
  id bigserial PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES pay_in_4_plans(id),
  installment int NOT NULL CHECK (installment BETWEEN 1 AND 4),
  attempted_on date NOT NULL,
  amount_cents bigint NOT NULL,                                         -- installment amount plus the late fee tried
  status text NOT NULL CHECK (status IN ('posted', 'failed')),
  failure_code text CHECK (failure_code IN ('insufficient_funds', 'account_not_open')),
  entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'posted') = (entry_id IS NOT NULL) AND (status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX pay_in_4_attempts_plan ON pay_in_4_attempts(plan_id, id);

-- Merchant refunds of a plan's purchase. The request id is unique per customer.
CREATE TABLE pay_in_4_refunds (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES pay_in_4_plans(id),
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  applied_cents bigint NOT NULL CHECK (applied_cents >= 0),
  credited_cents bigint NOT NULL CHECK (credited_cents >= 0),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (applied_cents + credited_cents = amount_cents)
);
