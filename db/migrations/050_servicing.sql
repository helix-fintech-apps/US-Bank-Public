-- M3 account servicing: category overrides, contact details, e-statements, alerts and an in-app inbox,
-- overdraft settings and secure messages. Ledger lines stay append-only: a customer's category change lives here.
-- No new system accounts: servicing moves no money (range ...050-...059 stays reserved).

-- The customer's own category for a ledger line. One per (user, line): joint owners each keep their own.
CREATE TABLE category_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line_id bigint NOT NULL REFERENCES ledger_lines(id),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, line_id)
);

-- Contact details and statement delivery. phone_last2 on users follows the phone kept here.
CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text CHECK (phone ~ '^[0-9]{10}$'),                               -- US number, digits only
  address_line1 text, address_line2 text, city text, state text CHECK (state ~ '^[A-Z]{2}$'), zip text CHECK (zip ~ '^[0-9]{5}$'),
  estatements boolean NOT NULL DEFAULT true,                              -- paper statements are simulated: nothing is mailed
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Alert rules. Evaluated by the server on read (no scheduler); the checked_* marks say what has been looked at.
CREATE TABLE alert_rules (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('low_balance', 'large_purchase', 'deposit', 'new_device')),
  account_id uuid REFERENCES accounts(id),                                -- null: every account the user can see
  threshold_cents bigint CHECK (threshold_cents IS NULL OR threshold_cents > 0),
  email boolean NOT NULL DEFAULT false,                                   -- simulated: "would be emailed to ..."
  active boolean NOT NULL DEFAULT true,
  checked_line_id bigint NOT NULL DEFAULT 0,
  checked_audit_id bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('low_balance', 'large_purchase')) = (threshold_cents IS NOT NULL))
);
CREATE INDEX alert_rules_user ON alert_rules(user_id);

-- The in-app inbox. ref makes evaluation idempotent: one alert per rule per line / sign-in.
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,                                                     -- low_balance, large_purchase, deposit, new_device, security
  ref text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  email_to text,                                                          -- simulated delivery address; nothing is sent
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, ref)
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);

-- Overdraft coverage per checking account. No row: opted out. Settings only; nothing here posts a fee.
CREATE TABLE overdraft_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  opted_in boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Secure messages with the bank. Replies from the bank are simulated.
CREATE TABLE message_threads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_threads_user ON message_threads(user_id, updated_at DESC);
CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('customer', 'bank')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz                                                     -- bank messages: when the customer opened them
);
CREATE INDEX messages_thread ON messages(thread_id, id);
