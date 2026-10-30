-- Recurring transfers between a customer's own accounts (lib/routes/recurring-transfers.mjs). No system accounts: money
-- moves straight from one customer account to another.

-- One schedule. Occurrence k (from 0) falls on start_date + 7k days (weekly) or on start_date's day of the month k months
-- later, clamped to the month's last day (monthly). next_index / next_on are the next occurrence still to be processed;
-- the API shows next_on only while the schedule is active. runs_posted + runs_failed is the number processed (max_runs).
CREATE TABLE IF NOT EXISTS recurring_transfers (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,                                               -- creation order, for a stable newest-first list
  user_id uuid NOT NULL REFERENCES users(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  start_date date NOT NULL,
  end_date date CHECK (end_date >= start_date),
  max_runs int CHECK (max_runs BETWEEN 1 AND 520),
  memo text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'canceled')),
  next_index int NOT NULL DEFAULT 0,
  next_on date NOT NULL,
  runs_posted int NOT NULL DEFAULT 0,
  runs_failed int NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,                                        -- the client's request id, unique per customer
  fingerprint text NOT NULL,                                            -- what the create request looked like (lib/idempotency.mjs)
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (from_account_id <> to_account_id),
  CHECK (end_date IS NULL OR max_runs IS NULL),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS recurring_transfers_user ON recurring_transfers(user_id, status, next_on);

-- One row per processed occurrence: posted (moved money) or failed (skipped). Never two for the same date.
CREATE TABLE IF NOT EXISTS recurring_transfer_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES recurring_transfers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  scheduled_for date NOT NULL,
  status text NOT NULL CHECK (status IN ('posted', 'failed')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  entry_id uuid REFERENCES journal_entries(id),
  transfer_id uuid REFERENCES transfers(id),                            -- the internal transfer row that uses up the limit
  failure_code text CHECK (failure_code IN ('insufficient_funds', 'over_limit', 'account_not_open')),
  failure_message text,
  executed_at timestamptz NOT NULL,
  UNIQUE (schedule_id, scheduled_for),
  CHECK ((status = 'posted') = (entry_id IS NOT NULL) AND (status = 'failed') = (failure_code IS NOT NULL))
);
CREATE TRIGGER recurring_transfer_runs_no_change BEFORE UPDATE OR DELETE ON recurring_transfer_runs FOR EACH ROW EXECUTE FUNCTION append_only();
