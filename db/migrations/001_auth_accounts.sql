-- M1 foundation: sign-in, sessions, one-time codes, accounts with owners (solo, joint, minor), a double-entry
-- ledger, idempotency keys and an append-only audit trail.
-- Money is bigint cents. Secrets are never stored in the clear: passwords are scrypt hashes; session tokens,
-- challenge ids and one-time codes are stored only as SHA-256 hashes.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username = lower(username)),   -- sign-in name (an email for demo users)
  display_name text NOT NULL,
  password_hash text NOT NULL,                                          -- scrypt$salt$hash
  mfa_required boolean NOT NULL DEFAULT true,                           -- ask for a one-time code after the password
  phone_last2 text CHECK (phone_last2 ~ '^[0-9]{2}$'),
  date_of_birth date,                                                   -- minors are under 18
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,                                          -- sha256 of the cookie value
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),                      -- idle limit is measured from here
  expires_at timestamptz NOT NULL,                                      -- absolute limit
  stepup_at timestamptz,                                                -- last time a one-time code was entered (risky actions need a recent one)
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A one-time code is owed: after a right password (purpose 'login') or before a risky action (purpose 'stepup').
CREATE TABLE challenges (
  id_hash text PRIMARY KEY,                                             -- sha256 of the challenge id held by the browser
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('login', 'stepup')),
  code_hash text NOT NULL,                                              -- sha256(challenge id + code)
  tries_left int NOT NULL DEFAULT 5 CHECK (tries_left >= 0),
  sends int NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Customer accounts and the bank's own system accounts (clearing, interest, fees ...).
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('checking', 'savings', 'money_market', 'cd', 'credit_card', 'loan', 'teen_checking', 'custodial_savings', 'system')),
  name text NOT NULL,
  number_last4 text CHECK (number_last4 ~ '^[0-9]{4}$'),
  system_code text UNIQUE,                                              -- system accounts only, e.g. 'ach_clearing'
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('pending', 'open', 'frozen', 'closed')),
  -- The ledger keeps balance_cents exact (see the post_line trigger). Deposit accounts: money the customer has.
  -- Credit cards and loans: money the customer owes, stored as a negative balance.
  balance_cents bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,                        -- true for cards, loans and system accounts
  credit_limit_cents bigint,
  apy_bp int,
  payment_due date,
  opened_at timestamptz NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance_cents >= 0),
  CHECK ((kind = 'system') = (system_code IS NOT NULL))
);

-- Who can see and use an account. Solo: one owner. Joint: two or more owners.
-- Minor: the minor (role 'minor') plus a parent or guardian (role 'custodian') who manages it.
CREATE TABLE account_owners (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'joint_owner', 'custodian', 'minor', 'viewer')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_owners_user ON account_owners(user_id);

-- Double-entry ledger. A journal entry's lines always sum to zero; lines are never changed or deleted.
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,                                 -- the same request twice posts once
  kind text NOT NULL,                                                   -- seed, transfer, ach_out, card_payment, loan_disbursement ...
  memo text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_lines (
  id bigserial PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),               -- + money into the account, - money out
  description text NOT NULL,                                            -- what the customer sees on the statement line
  posted_on date NOT NULL DEFAULT current_date,
  category text                                                         -- e.g. Groceries, Transfers (for insights)
);
CREATE INDEX ledger_lines_account ON ledger_lines(account_id, posted_on DESC, id DESC);
CREATE INDEX ledger_lines_entry ON ledger_lines(entry_id);

-- Keep balance_cents exact as lines are posted. The account's own CHECK refuses an overdraft in the same statement.
CREATE OR REPLACE FUNCTION post_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance_cents = balance_cents + NEW.amount_cents WHERE id = NEW.account_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_lines_post AFTER INSERT ON ledger_lines FOR EACH ROW EXECUTE FUNCTION post_line();

-- Every journal entry must balance by the end of its transaction.
CREATE OR REPLACE FUNCTION entry_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint;
BEGIN
  SELECT coalesce(sum(amount_cents), 0) INTO s FROM ledger_lines WHERE entry_id = NEW.entry_id;
  IF s <> 0 THEN RAISE EXCEPTION 'journal entry % does not balance (sum %)', NEW.entry_id, s; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION entry_balances();

CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_lines_no_change BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER journal_entries_no_change BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION append_only();
-- TRUNCATE skips row triggers, so guard it per statement too
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Who did what, from where. Never holds a password, token, code or full account number.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  action text NOT NULL,                                                 -- login.ok, login.bad_password, login.locked, code.bad, logout, transfer.create ...
  ip text,
  user_agent text,
  detail jsonb
);
CREATE INDEX audit_events_user ON audit_events(user_id, at DESC);
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- The bank's own accounts that customer money moves through.
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000001', 'system', 'Bank equity (opening balances)', 'equity', true),
  ('00000000-0000-4000-8000-000000000002', 'system', 'ACH clearing', 'ach_clearing', true),
  ('00000000-0000-4000-8000-000000000003', 'system', 'P2P clearing', 'p2p_clearing', true),
  ('00000000-0000-4000-8000-000000000004', 'system', 'Wire clearing', 'wire_clearing', true),
  ('00000000-0000-4000-8000-000000000005', 'system', 'Card settlement', 'card_settlement', true),
  ('00000000-0000-4000-8000-000000000006', 'system', 'Loan funding', 'loan_funding', true),
  ('00000000-0000-4000-8000-000000000007', 'system', 'Interest expense', 'interest_expense', true),
  ('00000000-0000-4000-8000-000000000008', 'system', 'Fee income', 'fee_income', true),
  ('00000000-0000-4000-8000-000000000009', 'system', 'Bill pay clearing', 'billpay_clearing', true);
