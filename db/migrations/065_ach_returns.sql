-- ACH debit returns and returned-item fees. ACH operations staff record incoming debits (an outside company pulling from a
-- customer's account) and post returns of them and of outgoing debits (the customer's ACH pulls, rows in transfers).
-- A return reverses the money; returns of outgoing debits for R01/R02 charge a returned-item fee, capped per customer per
-- bank day; an R01 return may be presented again once. Holds are worked out on read (lib/money-movement/holds.mjs), not stored.
-- Simulated: no real ACH file or network is involved. System account range ...60-...69 (docs/CONTRIBUTING.md).

INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000060', 'system', 'Returned item fee income', 'ach_return_fees', true);

-- Staff roles. No endpoint grants one: administrators (and the tests) insert rows directly.
CREATE TABLE staff_roles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ach_operations')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Debits an outside company pulled from a customer's account, recorded by staff from the (simulated) ACH network.
-- The company's account number is stored only encrypted (AES-256-GCM); screens and the audit trail see the last 4.
CREATE TABLE ach_incoming_debits (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 2 AND 80),
  company_last4 text NOT NULL CHECK (company_last4 ~ '^[0-9]{4}$'),
  company_account_enc text NOT NULL,
  posted_on date NOT NULL,                                              -- bank date it was recorded and posted
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  recorded_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,                                 -- `${staff}:ach-returns:debit:${client key}`
  fingerprint text NOT NULL,                                            -- what the request looked like (same key, different request: refused)
  created_at timestamptz NOT NULL
);
CREATE INDEX ach_incoming_debits_account ON ach_incoming_debits(account_id);

-- A re-presentment of an outgoing debit returned R01 (at most one per item). The new money is its own transfers row.
CREATE TABLE ach_representments (
  item_id uuid PRIMARY KEY REFERENCES transfers(id),                    -- the original pull
  transfer_id uuid NOT NULL UNIQUE REFERENCES transfers(id),            -- presentment 2
  presented_on date NOT NULL,
  presented_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);

-- Returns. One per presentment of an item. item_id is a transfers id (outgoing) or an ach_incoming_debits id (incoming).
CREATE TABLE ach_returns (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,                                               -- order of posting, for ties on created_at
  item_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  presentment int NOT NULL CHECK (presentment IN (1, 2)),
  transfer_id uuid REFERENCES transfers(id),                            -- outgoing: the returned presentment's transfer
  account_id uuid NOT NULL REFERENCES accounts(id),
  customer_id uuid REFERENCES users(id),                                -- outgoing: who requested the pull (the fee cap is theirs)
  reason_code text NOT NULL CHECK (reason_code IN ('R01', 'R02', 'R08', 'R10')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  returned_on date NOT NULL,
  posted_by uuid NOT NULL REFERENCES users(id),
  note text NOT NULL,
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  fee_entry_id uuid REFERENCES journal_entries(id),
  fee_waived_by uuid REFERENCES users(id),
  fee_waiver_reason text,
  fee_waiver_entry_id uuid REFERENCES journal_entries(id),
  fee_waived_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,                                 -- `${staff}:ach-returns:return:${client key}`
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (item_id, presentment),
  CHECK ((direction = 'outgoing') = (transfer_id IS NOT NULL AND customer_id IS NOT NULL)),
  CHECK ((fee_cents > 0) = (fee_entry_id IS NOT NULL)),
  CHECK ((fee_waiver_entry_id IS NULL) = (fee_waived_by IS NULL))
);
CREATE INDEX ach_returns_account ON ach_returns(account_id, created_at DESC);
CREATE INDEX ach_returns_fee_day ON ach_returns(customer_id, returned_on) WHERE fee_cents > 0;

-- Returns posted by staff use more codes than the simulated settlement (R01, R03).
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_return_code_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_return_code_check CHECK (return_code IN ('R01', 'R02', 'R03', 'R08', 'R10'));
