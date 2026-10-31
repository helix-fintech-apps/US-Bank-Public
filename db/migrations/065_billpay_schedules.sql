-- Scheduled bill payments with send, hold and deliver-by dates and a 2:00 pm CT cut-off (lib/routes/billpay-schedules.mjs).
-- A schedule (once, weekly, every two weeks, monthly) has at most one open payment at a time. Money moves only through
-- ledger entries when a payment is sent (or a fee is charged); a hold is data here and changes no balance.

-- The insufficient-funds fee after a failed retry (new system-account range ...60, see docs/CONTRIBUTING.md).
INSERT INTO accounts (id, kind, name, system_code, allow_negative) VALUES
  ('00000000-0000-4000-8000-000000000060', 'system', 'Bill pay fee income', 'billpay_fees', true);

CREATE TABLE billpay_schedules (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,                                        -- breaks ties between schedules made at the same instant
  user_id uuid NOT NULL REFERENCES users(id),
  payee_id uuid NOT NULL REFERENCES payees(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 500000), -- each payment from now on; $5,000.00 at most
  frequency text NOT NULL CHECK (frequency IN ('once', 'weekly', 'biweekly', 'monthly')),
  start_date date NOT NULL,
  end_date date,                                                        -- no occurrence is dated later (inclusive)
  count int CHECK (count BETWEEN 1 AND 520),                            -- total occurrences
  memo text CHECK (char_length(memo) BETWEEN 1 AND 140),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'canceled')),
  idempotency_key text NOT NULL UNIQUE,                                 -- `${user}:billpay-schedules:${client key}`
  fingerprint text NOT NULL,                                            -- what the first request looked like (same key, different request: refused)
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (end_date IS NULL OR count IS NULL),
  CHECK (frequency <> 'once' OR (end_date IS NULL AND count IS NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX billpay_schedules_user ON billpay_schedules(user_id, created_at DESC);
CREATE INDEX billpay_schedules_account ON billpay_schedules(from_account_id);

-- One row per occurrence that has been reached. scheduled / retrying are open (and hold their amount from hold_on);
-- sent / failed / canceled are final.
CREATE TABLE billpay_payments (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES billpay_schedules(id),
  sequence int NOT NULL CHECK (sequence >= 1),
  scheduled_for date NOT NULL,                                          -- the occurrence date
  send_on date NOT NULL,                                                -- business day it is sent (a retry: the retry date)
  hold_on date NOT NULL,                                                -- the business day before send_on
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'retrying', 'sent', 'failed', 'canceled')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  sent_on date,
  entry_id uuid REFERENCES journal_entries(id),
  transfer_id uuid REFERENCES transfers(id),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  fee_entry_id uuid REFERENCES journal_entries(id),
  failure_code text CHECK (failure_code IN ('insufficient_funds', 'over_limit', 'account_not_open', 'payee_removed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (schedule_id, sequence),
  CHECK ((status = 'sent') = (entry_id IS NOT NULL AND sent_on IS NOT NULL)),
  CHECK ((status IN ('failed', 'retrying')) = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX billpay_payments_one_open ON billpay_payments(schedule_id) WHERE status IN ('scheduled', 'retrying');
CREATE INDEX billpay_payments_open ON billpay_payments(send_on) WHERE status IN ('scheduled', 'retrying');
