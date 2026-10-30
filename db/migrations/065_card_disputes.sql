-- Card disputes (docs: the Card Disputes requirements). A customer disputes a posted card purchase; bank staff acknowledge
-- it, may issue a provisional credit, and decide it. Separate from the older card_disputes table used by /api/cards/...:
-- this feature neither reads nor changes those rows. Every statement is safe to run twice.
-- System account range for this feature: …60–…69.

-- Bank staff. Added by inserting a row; there is no endpoint for it. A staff member is also an ordinary customer.
CREATE TABLE IF NOT EXISTS staff_members (
  user_id uuid PRIMARY KEY REFERENCES users(id)
);

-- Provisional credits and their reversals move through this account.
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000060', 'system', 'Card disputes', 'card_disputes', true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS dispute_cases (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,                                               -- tie-break for "newest first" within one instant
  customer_id uuid NOT NULL REFERENCES users(id),
  line_id bigint NOT NULL REFERENCES ledger_lines(id),                  -- the disputed card purchase line (transactionId)
  account_id uuid NOT NULL REFERENCES accounts(id),
  transaction_amount_cents bigint NOT NULL CHECK (transaction_amount_cents > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= transaction_amount_cents),
  reason text NOT NULL CHECK (reason IN ('unauthorized', 'wrong_amount', 'duplicate', 'not_received', 'canceled_recurring')),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'investigating', 'provisional_credit_issued', 'resolved_in_favor', 'resolved_against', 'withdrawn')),
  filed_on date NOT NULL,                                               -- bank dates (Central Time), never current_date
  acknowledge_due_on date NOT NULL,
  provisional_credit_due_on date NOT NULL,
  decision_due_on date NOT NULL,
  acknowledged_on date,
  credited_on date,
  closed_on date,
  decision_reason text,
  decided_by uuid REFERENCES users(id),
  credit_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  reversal_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  idempotency_key text NOT NULL,                                        -- the customer's request id; unique per customer
  fingerprint text NOT NULL,                                            -- what the first request with that id looked like
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (customer_id, idempotency_key),
  CHECK (reversal_entry_id IS NULL OR credit_entry_id IS NOT NULL)      -- a reversal only takes back a credit that exists
);
CREATE INDEX IF NOT EXISTS dispute_cases_customer ON dispute_cases(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dispute_cases_line ON dispute_cases(line_id);
-- One open dispute per transaction (the route also serializes filings per transaction; this is the backstop).
CREATE UNIQUE INDEX IF NOT EXISTS dispute_cases_one_open ON dispute_cases(line_id)
  WHERE status IN ('submitted', 'investigating', 'provisional_credit_issued');

CREATE TABLE IF NOT EXISTS dispute_notes (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS dispute_notes_dispute ON dispute_notes(dispute_id, seq);

-- A record that the customer was told about a step (simulated: nothing is sent).
CREATE TABLE IF NOT EXISTS dispute_notifications (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id),
  user_id uuid NOT NULL REFERENCES users(id),                           -- the dispute's customer, whoever acted
  kind text NOT NULL CHECK (kind IN ('filed', 'acknowledged', 'provisional_credit_issued', 'resolved_in_favor', 'resolved_against', 'withdrawn', 'credit_reversed')),
  message text NOT NULL CHECK (message <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS dispute_notifications_dispute ON dispute_notifications(dispute_id, seq);
