-- Recurring transfers between a customer's own accounts (weekly or monthly), with one run record per processed occurrence.
-- A schedule keeps the index of its next occurrence (counted from start_date, occurrence 0) and that occurrence's date while
-- it is active; next_run is NULL in every other status. Money moves only through the ledger; a run record points at its entry.
CREATE TABLE IF NOT EXISTS recurring_transfers (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,                                               -- creation order, breaks ties between equal created_at
  user_id uuid NOT NULL REFERENCES users(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  start_date date NOT NULL,
  end_date date CHECK (end_date >= start_date),
  max_runs int CHECK (max_runs BETWEEN 1 AND 520),
  memo text CHECK (char_length(memo) BETWEEN 1 AND 140),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'canceled')),
  next_index int NOT NULL DEFAULT 0 CHECK (next_index >= 0),           -- the next occurrence to process (or to look from, on resume)
  next_run date,                                                        -- that occurrence's date while active
  runs_posted int NOT NULL DEFAULT 0 CHECK (runs_posted >= 0),
  runs_failed int NOT NULL DEFAULT 0 CHECK (runs_failed >= 0),
  idempotency_key text NOT NULL,
  idempotency_fingerprint text NOT NULL,                                -- the same id with a different request is refused
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (from_account_id <> to_account_id),
  CHECK (end_date IS NULL OR max_runs IS NULL),
  CHECK ((status = 'active') = (next_run IS NOT NULL)),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS recurring_transfers_user ON recurring_transfers(user_id, created_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS recurring_transfers_due ON recurring_transfers(user_id, next_run) WHERE status = 'active';

-- One row per processed occurrence: posted (with its ledger entry) or failed (with why). Never changed afterwards.
CREATE TABLE IF NOT EXISTS recurring_transfer_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES recurring_transfers(id),
  occurrence int NOT NULL CHECK (occurrence >= 0),
  scheduled_for date NOT NULL,
  status text NOT NULL CHECK (status IN ('posted', 'failed')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  entry_id uuid REFERENCES journal_entries(id),
  failure_code text CHECK (failure_code IN ('insufficient_funds', 'over_limit', 'account_not_open')),
  failure_message text,
  executed_at timestamptz NOT NULL,
  CHECK ((status = 'posted') = (entry_id IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL AND failure_message IS NOT NULL)),
  UNIQUE (schedule_id, scheduled_for),                                  -- each occurrence is processed at most once
  UNIQUE (schedule_id, occurrence)
);
DROP TRIGGER IF EXISTS recurring_transfer_runs_no_change ON recurring_transfer_runs;
CREATE TRIGGER recurring_transfer_runs_no_change BEFORE UPDATE OR DELETE ON recurring_transfer_runs FOR EACH ROW EXECUTE FUNCTION append_only();

-- A posted occurrence uses up the customer's 'internal' limits like a one-off transfer between their own accounts.
-- limit_usage rows so far always pointed at a transfers row; they may now point at a recurring run instead (exactly one of
-- the two). Existing rows and queries are unchanged.
ALTER TABLE limit_usage ALTER COLUMN transfer_id DROP NOT NULL;
ALTER TABLE limit_usage ADD COLUMN IF NOT EXISTS recurring_run_id uuid REFERENCES recurring_transfer_runs(id);
ALTER TABLE limit_usage DROP CONSTRAINT IF EXISTS limit_usage_one_source;
ALTER TABLE limit_usage ADD CONSTRAINT limit_usage_one_source CHECK (num_nonnulls(transfer_id, recurring_run_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS limit_usage_recurring_run ON limit_usage(recurring_run_id, reason) WHERE recurring_run_id IS NOT NULL;
