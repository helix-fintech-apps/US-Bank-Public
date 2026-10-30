-- Round-up savings (docs: the Round-Up Savings requirements). Safe to run twice.
-- Debit-card purchases on a checking account are rounded up to the next step; the change collects as pending change and
-- a sweep moves it to a savings account in one ledger entry. Money is bigint cents. No new system accounts.

-- One round-up per checking account, identified by the checking account's id.
CREATE TABLE IF NOT EXISTS round_ups (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),                         -- the owner who enabled it (last enable); audit rows are written for them
  destination_account_id uuid NOT NULL REFERENCES accounts(id),
  step_cents bigint NOT NULL CHECK (step_cents IN (100, 200, 500)),
  threshold_cents bigint NOT NULL CHECK (threshold_cents BETWEEN 100 AND 1000000),
  monthly_cap_cents bigint NOT NULL CHECK (monthly_cap_cents BETWEEN 100 AND 1000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  pending_cents bigint NOT NULL DEFAULT 0 CHECK (pending_cents >= 0),
  pending_since date,                                                  -- bank date pending_cents last grew from zero; NULL while it is 0
  accrued_cents bigint NOT NULL DEFAULT 0 CHECK (accrued_cents >= 0),
  reversed_cents bigint NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0),
  swept_cents bigint NOT NULL DEFAULT 0 CHECK (swept_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((pending_cents = 0) = (pending_since IS NULL)),
  CHECK (accrued_cents - reversed_cents = swept_cents + pending_cents)  -- change is conserved
);

-- One row per purchase that was rounded up (also when its change is 0).
CREATE TABLE IF NOT EXISTS round_up_purchases (
  seq bigserial UNIQUE,                                                -- the order purchases were rounded up in
  authorization_id uuid PRIMARY KEY REFERENCES card_authorizations(id),
  account_id uuid NOT NULL REFERENCES round_ups(account_id),
  purchase_cents bigint NOT NULL CHECK (purchase_cents > 0),
  change_cents bigint NOT NULL CHECK (change_cents >= 0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= purchase_cents),
  reversed_cents bigint NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0 AND reversed_cents <= change_cents),
  accrued_on date NOT NULL
);
CREATE INDEX IF NOT EXISTS round_up_purchases_account ON round_up_purchases(account_id, seq);

-- Posted sweeps only (a deferred sweep records nothing). At most one per round-up per bank date.
CREATE TABLE IF NOT EXISTS round_up_sweeps (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES round_ups(account_id),
  destination_account_id uuid NOT NULL REFERENCES accounts(id),
  sweep_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sweep_date)
);

-- Simulated merchant refunds of debit-card purchases (with or without a round-up).
CREATE TABLE IF NOT EXISTS card_refunds (
  id uuid PRIMARY KEY,
  authorization_id uuid NOT NULL REFERENCES card_authorizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reversed_cents bigint NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_refunds_authorization ON card_refunds(authorization_id);

-- Request ids of enable and refund, per customer: the same id with the same request replays, with a different one is refused.
CREATE TABLE IF NOT EXISTS round_up_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  account_id uuid,                                                     -- enable: the round-up
  refund_id uuid REFERENCES card_refunds(id),                          -- refund: the refund
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
