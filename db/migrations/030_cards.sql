-- M6 cards: debit cards and controls, the credit card lineup, applications and decisions, statements, payments,
-- autopay, simulated purchases, disputes and rewards. Plan: docs/RESEARCH.md §3.
-- Card numbers are never stored: a card keeps a random vault token and its last 4. The full number is derived from
-- the token with a server key (lib/cards.mjs) and shown only after step-up.

INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000030', 'system', 'Secured card deposits', 'card_secured_deposits', true),
  ('00000000-0000-4000-8000-000000000031', 'system', 'Card interest income', 'card_interest_income', true),
  ('00000000-0000-4000-8000-000000000032', 'system', 'Card rewards', 'card_rewards', true),
  ('00000000-0000-4000-8000-000000000033', 'system', 'Card disputes (provisional credit)', 'card_disputes', true),
  ('00000000-0000-4000-8000-000000000034', 'system', 'Card network settlement (simulated purchases)', 'card_network_settlement', true);

-- Credit limit: a credit_card account can go negative only down to minus its limit. Backward compatible: it only refuses
-- a change that makes the balance lower while it is past the limit, so payments to a card already over its limit (old
-- data) still post, and accounts with no limit are untouched. Bank-initiated charges (interest, a re-billed dispute) may
-- go over, as on real cards: lib/cards.mjs bankCharge() sets usabanc.allow_over_limit for that one posting.
-- lib/ledger.mjs turns the error into a 409 over_limit.
CREATE OR REPLACE FUNCTION enforce_credit_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'credit_card' AND NEW.credit_limit_cents IS NOT NULL AND NEW.balance_cents < -NEW.credit_limit_cents
     AND NEW.balance_cents < OLD.balance_cents AND coalesce(current_setting('usabanc.allow_over_limit', true), '') <> 'on' THEN
    RAISE EXCEPTION 'credit limit exceeded on account %', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'accounts_credit_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_credit_limit BEFORE UPDATE OF balance_cents ON accounts FOR EACH ROW EXECUTE FUNCTION enforce_credit_limit();

-- The credit card lineup, as data (§3.2 product lineup). Demo terms, not real offers.
-- rewards: basis points of the purchase paid back as cash (100 bp = 1%, or 1 point worth 1 cent), per category.
CREATE TABLE card_products (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cash_back', 'travel', 'secured', 'student')),
  tagline text NOT NULL,
  annual_fee_cents bigint NOT NULL DEFAULT 0 CHECK (annual_fee_cents >= 0),
  apr_min_bp int NOT NULL,
  apr_max_bp int NOT NULL CHECK (apr_max_bp >= apr_min_bp),
  intro_offer text NOT NULL,
  rewards jsonb NOT NULL,                                               -- {"base_bp": 200, "categories": {"Travel": 300}}
  rewards_text text NOT NULL,
  min_score int NOT NULL,                                               -- below this an unsecured card is counteroffered as secured
  min_limit_cents bigint NOT NULL,
  max_limit_cents bigint NOT NULL CHECK (max_limit_cents >= min_limit_cents),
  secured boolean NOT NULL DEFAULT false,                               -- the deposit becomes the limit
  sort int NOT NULL
);
INSERT INTO card_products VALUES
  ('cash_plus', 'Cash+ Card', 'cash_back', 'Simple cash back on everything', 0, 1924, 2824,
   '$200 bonus after $1,000 in purchases in the first 90 days (demo terms)', '{"base_bp": 200}', '2% cash back on every purchase', 670, 100000, 1500000, false, 1),
  ('voyager', 'Voyager Travel Card', 'travel', 'Points that go further when you travel', 9500, 2024, 2824,
   '30,000 bonus points after $2,000 in purchases in the first 90 days (demo terms)', '{"base_bp": 100, "categories": {"Travel": 300}}', '3x points on travel, 1x on everything else (1 point = 1¢)', 700, 200000, 2500000, false, 2),
  ('secured', 'Secured Card', 'secured', 'Build credit with a deposit you choose', 0, 2824, 2824,
   'Reviewed for an upgrade to an unsecured card after 7 on-time payments (demo terms)', '{"base_bp": 100}', '1% cash back on every purchase', 0, 30000, 500000, true, 3),
  ('campus', 'Campus Card', 'student', 'A first card for students', 0, 1824, 2724,
   '$50 bonus after your first purchase in the first 90 days (demo terms)', '{"base_bp": 100, "categories": {"Food & Dining": 300}}', '3% cash back on dining, 1% on everything else', 600, 50000, 100000, false, 4);

-- Applications and prequalifications. Every decision keeps its reasons (adverse-action reasons for a decline).
CREATE TABLE credit_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text UNIQUE,                                          -- the same submit twice decides once
  stage text NOT NULL CHECK (stage IN ('prequal', 'application')),
  check_kind text NOT NULL CHECK (check_kind IN ('soft', 'hard')),      -- simulated credit check; only hard checks lower the score
  product_code text REFERENCES card_products(code),                     -- null for a prequalification across the lineup
  score int NOT NULL,                                                   -- simulated score at the time of the check
  income_cents bigint NOT NULL CHECK (income_cents >= 0),               -- yearly
  housing_cents bigint NOT NULL CHECK (housing_cents >= 0),             -- monthly
  requested_limit_cents bigint,
  decision text CHECK (decision IN ('approve', 'decline', 'counteroffer')),
  offer jsonb,                                                          -- {productCode, limitCents, aprBp} or the prequal offers
  reasons jsonb NOT NULL DEFAULT '[]',                                  -- [{code, text}]
  account_id uuid REFERENCES accounts(id),                              -- the card account issued from this application
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_applications_user ON credit_applications(user_id, created_at DESC);

-- Card terms for a credit_card account (the account row holds the limit and balance).
CREATE TABLE credit_accounts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  product_code text NOT NULL REFERENCES card_products(code),
  apr_bp int NOT NULL,
  security_deposit_cents bigint NOT NULL DEFAULT 0,
  application_id uuid REFERENCES credit_applications(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Plastic and virtual cards: a debit card on a checking or teen account, or the card on a credit_card account.
CREATE TABLE cards (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  holder_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('debit', 'credit')),
  last4 text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  pan_token text NOT NULL UNIQUE,                                       -- vault token, not the number
  exp_month int NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year int NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'closed')),
  closed_reason text CHECK (closed_reason IN ('lost', 'stolen', 'damaged')),
  replaces_card_id uuid REFERENCES cards(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cards_one_open ON cards(account_id, holder_user_id) WHERE status <> 'closed';

-- Channel controls (§3.1: channel toggles; the same rows are a parent's spend rules on a teen card, §1).
-- No row means the default in lib/cards.mjs CHANNELS. daily_limit_cents: the most approved per day on that channel.
CREATE TABLE card_controls (
  card_id uuid NOT NULL REFERENCES cards(id),
  channel text NOT NULL CHECK (channel IN ('in_store', 'online', 'contactless', 'atm', 'international')),
  enabled boolean NOT NULL DEFAULT true,
  daily_limit_cents bigint CHECK (daily_limit_cents > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, channel)
);

CREATE TABLE card_travel_notices (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES cards(id),
  destination text NOT NULL,
  start_on date NOT NULL,
  end_on date NOT NULL CHECK (end_on >= start_on),
  created_by uuid REFERENCES users(id),
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Simulated card authorizations, approved and declined (a decline keeps its reason).
CREATE TABLE card_authorizations (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES cards(id),
  idempotency_key text NOT NULL UNIQUE,
  merchant text NOT NULL,
  category text,
  channel text NOT NULL DEFAULT 'in_store' CHECK (channel IN ('in_store', 'online', 'contactless', 'atm')),
  international boolean NOT NULL DEFAULT false,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  result text NOT NULL CHECK (result IN ('approved', 'declined')),
  reason text,                                                          -- card_locked, card_closed, channel_off, international_off, channel_limit, over_limit, insufficient_funds, or a family control code (lib/controls.mjs)
  entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_authorizations_card ON card_authorizations(card_id, created_at DESC);

CREATE TABLE card_statements (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  new_balance_cents bigint NOT NULL CHECK (new_balance_cents >= 0),     -- owed at the end of the period
  interest_cents bigint NOT NULL DEFAULT 0 CHECK (interest_cents >= 0),
  min_due_cents bigint NOT NULL CHECK (min_due_cents >= 0),
  due_date date NOT NULL,
  last_line_id bigint NOT NULL DEFAULT 0,                               -- the statement covers the account's lines up to this one
  created_at timestamptz NOT NULL DEFAULT now(),                        -- payments after this count against it
  UNIQUE (account_id, period_end)
);

CREATE TABLE card_payments (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  type text NOT NULL CHECK (type IN ('minimum', 'statement', 'current', 'custom', 'fixed')),
  autopay boolean NOT NULL DEFAULT false,
  statement_id uuid REFERENCES card_statements(id),
  entry_id uuid NOT NULL UNIQUE REFERENCES journal_entries(id),
  created_by uuid REFERENCES users(id),
  posted_on date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_payments_account ON card_payments(account_id, posted_on);

CREATE TABLE card_autopay (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL CHECK (type IN ('minimum', 'statement', 'fixed')),
  fixed_cents bigint CHECK (fixed_cents > 0),
  active boolean NOT NULL DEFAULT true,
  last_statement_id uuid REFERENCES card_statements(id),                -- the statement autopay last ran for
  last_result text,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'fixed' OR fixed_cents IS NOT NULL)
);

-- A dispute posts a provisional credit; a lost dispute re-bills with a new entry (lines are never edited).
CREATE TABLE card_disputes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  line_id bigint NOT NULL UNIQUE REFERENCES ledger_lines(id),           -- one dispute per transaction
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (reason IN ('unrecognized', 'not_received', 'not_as_described', 'duplicate', 'wrong_amount', 'canceled')),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_won', 'resolved_lost')),
  idempotency_key text NOT NULL UNIQUE,
  provisional_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  resolution_entry_id uuid REFERENCES journal_entries(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Rewards earned (+) and redeemed (-), in cents. Redemptions move money through the ledger from card_rewards.
CREATE TABLE card_rewards (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  cents bigint NOT NULL CHECK (cents <> 0),
  kind text NOT NULL CHECK (kind IN ('earn', 'redeem')),
  ref text NOT NULL UNIQUE,                                             -- what it was for (an authorization, a seeded line, a redemption entry)
  description text NOT NULL,
  entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_rewards_account ON card_rewards(account_id);
CREATE TRIGGER card_rewards_no_change BEFORE UPDATE OR DELETE ON card_rewards FOR EACH ROW EXECUTE FUNCTION append_only();
