-- Overdraft protection: a savings or money-market backup account linked to a checking account, and a courtesy line.
-- Money only moves through ledger entries (kinds od_sweep, od_line_draw, od_repayment); these tables hold the link,
-- what is owed on the courtesy line, every protection event, and the request ids of link and repay.

-- The courtesy line and its fee income (UUID range ...60-...69, see docs/CONTRIBUTING.md).
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000060', 'system', 'Courtesy overdraft lines', 'od_courtesy_line', true),
  ('00000000-0000-4000-8000-000000000061', 'system', 'Overdraft protection fee income', 'od_fees', true);

-- At most one protection per checking account. `id` tells one link from a later link of the same account.
CREATE TABLE overdraft_protections (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  id uuid NOT NULL UNIQUE,
  backup_account_id uuid NOT NULL REFERENCES accounts(id),
  courtesy_limit_cents bigint NOT NULL DEFAULT 0 CHECK (courtesy_limit_cents BETWEEN 0 AND 100000 AND courtesy_limit_cents % 1000 = 0),
  line_used_cents bigint NOT NULL DEFAULT 0 CHECK (line_used_cents >= 0),
  fees_owed_cents bigint NOT NULL DEFAULT 0 CHECK (fees_owed_cents >= 0),
  linked_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX overdraft_protections_backup ON overdraft_protections(backup_account_id);

-- Every protection transfer (sweep), courtesy line use (line_draw) and repayment of a checking account. Kept after unlinking.
CREATE TABLE overdraft_protection_events (
  seq bigserial UNIQUE,                                                   -- the order they happened in
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('sweep', 'line_draw', 'repayment')),
  account_id uuid NOT NULL REFERENCES accounts(id),
  on_date date NOT NULL,                                                  -- bank date
  created_at timestamptz NOT NULL,
  actor_id uuid REFERENCES users(id),
  rail text NOT NULL CHECK (rail IN ('card', 'internal', 'billpay', 'ach', 'wire', 'manual')),
  shortfall_cents bigint,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  fees_repaid_cents bigint NOT NULL DEFAULT 0 CHECK (fees_repaid_cents >= 0),
  principal_repaid_cents bigint NOT NULL DEFAULT 0 CHECK (principal_repaid_cents >= 0),
  backup_account_id uuid REFERENCES accounts(id),
  entry_id uuid NOT NULL REFERENCES journal_entries(id)
);
CREATE INDEX overdraft_protection_events_account ON overdraft_protection_events(account_id, on_date);

-- Request ids of link and repay, per user: the same id with the same request returns the first result.
CREATE TABLE overdraft_protection_requests (
  key text PRIMARY KEY,                                                   -- <userId>:overdraft-protection:<action>:<idempotencyKey>
  fingerprint text NOT NULL,
  protection_id uuid,                                                     -- link: the protection it created
  account_id uuid NOT NULL REFERENCES accounts(id),
  event_id uuid REFERENCES overdraft_protection_events(id),               -- repay: the repayment it made
  created_at timestamptz NOT NULL DEFAULT now()
);
