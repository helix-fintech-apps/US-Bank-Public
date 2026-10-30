-- Family debit cards: an owner issues a card to a minor on their Teen Checking account (custodian) or to another adult
-- customer on their checking account, sets spend controls on it, and the cardholder makes simulated authorizations that
-- post to the owner's account through card_network_settlement (…34, migration 030). No new system accounts.
-- No card number or security code is ever created or stored: a family card has only its last 4 and expiry.

CREATE TABLE family_cards (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),                       -- the owner's account the card spends from
  issuer_user_id uuid NOT NULL REFERENCES users(id),                      -- the owner
  holder_user_id uuid NOT NULL REFERENCES users(id),                      -- the cardholder (never on the account for an adult)
  holder_kind text NOT NULL CHECK (holder_kind IN ('minor', 'adult')),
  form text NOT NULL CHECK (form IN ('physical', 'virtual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'review', 'declined', 'active', 'frozen', 'canceled')),
  end_reason text CHECK (end_reason IN ('identity', 'rejected', 'canceled', 'replaced')),
  last4 text CHECK (last4 ~ '^[0-9]{4}$'),                                -- set when the card becomes active
  exp_month int CHECK (exp_month BETWEEN 1 AND 12),
  exp_year int,
  -- controls (NULL limit = no card-level limit; the owner's ceiling still applies, lib/routes/family-cards.mjs)
  per_txn_cents bigint CHECK (per_txn_cents >= 1),
  daily_cents bigint CHECK (daily_cents >= 1),
  atm_daily_cents bigint CHECK (atm_daily_cents >= 0),
  online_enabled boolean NOT NULL DEFAULT true,
  category_mode text NOT NULL DEFAULT 'any' CHECK (category_mode IN ('any', 'allow', 'deny')),
  category_list text[] NOT NULL DEFAULT '{}',
  replaces_card_id uuid REFERENCES family_cards(id),
  replaced_by_card_id uuid REFERENCES family_cards(id),
  chain_id uuid NOT NULL,                                                 -- the first card of a replacement chain: daily totals follow it
  idempotency_key text UNIQUE,                                            -- <owner id>:family-cards:<request id>; NULL for a replacement
  request_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  CHECK (holder_user_id <> issuer_user_id),
  CHECK ((category_mode = 'any') <= (cardinality(category_list) = 0))
);
-- One live card per cardholder, account and form.
CREATE UNIQUE INDEX family_cards_one_live ON family_cards(account_id, holder_user_id, form) WHERE status IN ('pending', 'review', 'active', 'frozen');
CREATE INDEX family_cards_issuer ON family_cards(issuer_user_id, created_at DESC);
CREATE INDEX family_cards_holder ON family_cards(holder_user_id, created_at DESC);
CREATE INDEX family_cards_account ON family_cards(account_id) WHERE status IN ('pending', 'review', 'active', 'frozen');

-- Simulated authorizations, approved and declined (a decline keeps its reason code).
CREATE TABLE family_card_authorizations (
  id uuid PRIMARY KEY,
  seq bigserial UNIQUE,                                                   -- newest-first order
  card_id uuid NOT NULL REFERENCES family_cards(id),
  chain_id uuid NOT NULL,
  cardholder_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,                                   -- <cardholder id>:family-cards:auth:<request id>, also the ledger key
  request_fingerprint text NOT NULL,
  merchant text NOT NULL,
  category text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_store', 'online', 'atm')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  decision text NOT NULL CHECK (decision IN ('approved', 'declined')),
  reason_code text,
  entry_id uuid REFERENCES journal_entries(id),
  bank_date date NOT NULL,                                                -- the bank date it counts against (daily totals)
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((decision = 'approved') = (entry_id IS NOT NULL AND reason_code IS NULL))
);
CREATE INDEX family_card_authorizations_card ON family_card_authorizations(card_id, seq DESC);
CREATE INDEX family_card_authorizations_chain ON family_card_authorizations(chain_id, bank_date) WHERE decision = 'approved';
