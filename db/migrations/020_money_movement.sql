-- M4 money movement: internal transfers (now, scheduled, recurring), external accounts + ACH, USA Pay (P2P),
-- domestic wires and bill pay, with per-rail limits as data. Money itself only moves through ledger entries;
-- these tables track requests, schedules and statuses. Full account numbers are stored only AES-256-GCM encrypted.

-- The bank's money-movement accounts (UUID range ...20-...29, see docs/CONTRIBUTING.md). Money leaving a customer
-- account waits in an "in transit" account until the simulated network settles it, then moves to network settlement.
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000020', 'system', 'USA Pay unclaimed', 'p2p_unclaimed', true),          -- waits for the recipient to enroll (14 days)
  ('00000000-0000-4000-8000-000000000021', 'system', 'ACH outgoing in transit', 'mm_ach_out', true),
  ('00000000-0000-4000-8000-000000000022', 'system', 'ACH incoming settlement', 'mm_ach_in', true),
  ('00000000-0000-4000-8000-000000000023', 'system', 'Wires outgoing in transit', 'mm_wire_out', true),
  ('00000000-0000-4000-8000-000000000024', 'system', 'Wire fee income', 'mm_wire_fees', true),
  ('00000000-0000-4000-8000-000000000025', 'system', 'Bill pay in transit', 'mm_billpay', true),
  ('00000000-0000-4000-8000-000000000026', 'system', 'USA Pay clearing', 'mm_p2p', true),
  ('00000000-0000-4000-8000-000000000027', 'system', 'Payment network settlement (simulated)', 'mm_network', true);

-- One shared limit profile for every rail (docs/RESEARCH.md §2 "Shared money-movement model"). The row with no user is
-- the bank default; a customer's own row may only lower the daily and 30-day amounts. step_up_cents: at or over this
-- amount a one-time code is needed (0 = always). Money sent to someone else or out of the bank always needs one.
CREATE TABLE limit_profiles (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,                  -- NULL: the bank default for the rail
  rail text NOT NULL CHECK (rail IN ('internal', 'ach', 'p2p', 'wire', 'billpay')),
  per_txn_cents bigint CHECK (per_txn_cents > 0),
  daily_cents bigint NOT NULL CHECK (daily_cents > 0),
  rolling_30d_cents bigint NOT NULL CHECK (rolling_30d_cents >= daily_cents),
  step_up_cents bigint CHECK (step_up_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NULL OR (per_txn_cents IS NULL AND step_up_cents IS NULL))   -- customers change amounts, not rules
);
CREATE UNIQUE INDEX limit_profiles_bank ON limit_profiles(rail) WHERE user_id IS NULL;
CREATE UNIQUE INDEX limit_profiles_user ON limit_profiles(user_id, rail) WHERE user_id IS NOT NULL;

-- Accounts at other banks, linked for ACH. Verified by two simulated micro-deposits (3 tries, 15 days) or by a
-- simulated instant check (a mock sign-in to the other bank).
CREATE TABLE external_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checking', 'savings')),
  routing_number text NOT NULL CHECK (routing_number ~ '^[0-9]{9}$'),
  number_last4 text NOT NULL CHECK (number_last4 ~ '^[0-9]{4}$'),
  number_enc text,                                                      -- AES-256-GCM; NULL only for seeded demo rows made without a key
  institution text,                                                     -- the other bank's name, when known
  method text NOT NULL DEFAULT 'micro_deposits' CHECK (method IN ('micro_deposits', 'instant')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'removed')),
  md1_cents int CHECK (md1_cents BETWEEN 1 AND 99),                     -- the two simulated micro-deposits
  md2_cents int CHECK (md2_cents BETWEEN 1 AND 99),
  tries_left int NOT NULL DEFAULT 3 CHECK (tries_left >= 0),
  created_at timestamptz NOT NULL,
  verified_at timestamptz,
  removed_at timestamptz,
  removed_reason text
);
CREATE INDEX external_accounts_user ON external_accounts(user_id);

CREATE TABLE payees (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  account_last4 text CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_enc text,                                                     -- account number at the biller, AES-256-GCM
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (address IS NOT NULL OR account_enc IS NOT NULL)
);
CREATE INDEX payees_user ON payees(user_id);

-- USA Pay: the email or phone (digits only) that routes money to a user's account.
CREATE TABLE p2p_enrollments (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX p2p_enrollments_user ON p2p_enrollments(user_id);

-- Scheduled (once) and recurring internal transfers and bill payments. Each run makes one row in transfers.
CREATE TABLE scheduled_transfers (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  rail text NOT NULL CHECK (rail IN ('internal', 'billpay')),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  payee_id uuid REFERENCES payees(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  memo text,
  cadence text NOT NULL CHECK (cadence IN ('once', 'weekly', 'monthly')),
  anchor_day int NOT NULL,                                              -- monthly runs keep this day of the month
  next_run date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'canceled')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((rail = 'internal') = (to_account_id IS NOT NULL) AND (rail = 'billpay') = (payee_id IS NOT NULL))
);
CREATE INDEX scheduled_transfers_due ON scheduled_transfers(user_id, status, next_run);

-- Every money movement request on every rail, with its status. The ledger entry ids point at the money.
CREATE TABLE transfers (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),                           -- who sent or requested it
  rail text NOT NULL CHECK (rail IN ('internal', 'ach', 'p2p', 'wire', 'billpay')),
  direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
  from_account_id uuid REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  external_account_id uuid REFERENCES external_accounts(id),
  payee_id uuid REFERENCES payees(id),
  schedule_id uuid REFERENCES scheduled_transfers(id),
  p2p_token text,                                                       -- USA Pay recipient (email or phone digits)
  to_user_id uuid REFERENCES users(id),                                 -- USA Pay recipient once known
  counterparty text,                                                    -- what the customer sees: "Jordan", "Lakeside CU ··6789"
  counterparty_routing text,                                            -- wires
  counterparty_last4 text,
  counterparty_enc text,                                                -- wires: beneficiary account number, AES-256-GCM
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  memo text,
  -- internal: completed. ACH: pending -> processing (after its cut-off) -> settled | returned; canceled while pending.
  -- wire: scheduled (after the cut-off; can be canceled) -> sent (irrevocable). Bill pay: sent -> paid.
  -- USA Pay: completed, or pending (recipient not enrolled) -> completed | expired. A scheduled run that can't go: failed.
  status text NOT NULL CHECK (status IN ('completed', 'pending', 'processing', 'scheduled', 'settled', 'returned', 'sent', 'paid', 'expired', 'canceled', 'failed')),
  return_code text CHECK (return_code IN ('R01', 'R03')),
  note text,                                                            -- why it failed or was returned, in plain words
  process_on date,                                                      -- business day it's processed (after a cut-off: the next one)
  settles_on date,                                                      -- ACH settlement / bill delivery estimate / P2P expiry date
  settled_at timestamptz,                                               -- when it reached its final state
  simulated boolean NOT NULL DEFAULT false,                             -- finished early with "Simulate settlement"
  booked_on date NOT NULL,                                              -- CT date it counts against the limits
  idempotency_key text NOT NULL UNIQUE,                                 -- `${user}:money-movement:${client key}`
  entry_id uuid REFERENCES journal_entries(id),
  reversal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX transfers_user ON transfers(user_id, created_at DESC);
CREATE INDEX transfers_usage ON transfers(user_id, rail, booked_on);
CREATE INDEX transfers_token ON transfers(p2p_token) WHERE status = 'pending';

-- USA Pay requests (also one per person in a split bill).
CREATE TABLE p2p_requests (
  id uuid PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES users(id),
  deposit_account_id uuid NOT NULL REFERENCES accounts(id),             -- where the money goes when paid
  to_token text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  memo text,
  split_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'declined', 'canceled')),
  transfer_id uuid REFERENCES transfers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX p2p_requests_token ON p2p_requests(to_token, status);

-- What each transfer used of its limits. Append-only: money that comes back (returned, refunded, canceled) adds a
-- negative row dated to the original day, so the daily and 30-day windows give that room back.
CREATE TABLE limit_usage (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  rail text NOT NULL CHECK (rail IN ('internal', 'ach', 'p2p', 'wire', 'billpay')),
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),               -- + used, - given back
  booked_on date NOT NULL,                                              -- the CT day the transfer counts against
  reason text NOT NULL CHECK (reason IN ('used', 'returned', 'expired', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, reason)
);
CREATE INDEX limit_usage_window ON limit_usage(user_id, rail, booked_on);
CREATE TRIGGER limit_usage_no_change BEFORE UPDATE OR DELETE ON limit_usage FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER limit_usage_no_truncate BEFORE TRUNCATE ON limit_usage FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Bank default limits (demo values). docs/RESEARCH.md §2.2: standard ACH $2,500 per transfer, $10,000/day, $25,000
-- per rolling 30 days. §2.4: USA Pay $1,000/day, $5,000 per rolling 30 days. RESEARCH.md gives no figures for wires,
-- bill pay or internal transfers; those are industry-typical demo values. Step-up (§2 shared model): every wire, USA Pay
-- send and bill payment (money to someone else), ACH pulls from $1,000 (pushes out always), and transfers between your
-- own accounts from $5,000.
INSERT INTO limit_profiles (id, rail, per_txn_cents, daily_cents, rolling_30d_cents, step_up_cents) VALUES
  (gen_random_uuid(), 'internal', NULL,   2500000, 10000000, 500000),
  (gen_random_uuid(), 'ach',      250000, 1000000,  2500000, 100000),
  (gen_random_uuid(), 'p2p',      NULL,    100000,   500000,      0),
  (gen_random_uuid(), 'wire',     NULL,   2500000,  5000000,      0),
  (gen_random_uuid(), 'billpay',  NULL,   1000000,  2500000,      0);
