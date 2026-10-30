-- Outbound wires with sanctions screening and dual approval (domestic and international). A wire request waits here
-- (screened, held for compliance review, or waiting for a second approver) until it is released; only then does money
-- move, through one ledger entry and a row in transfers (rail 'wire'). Adds no system accounts: amounts go to
-- mm_wire_out and fees to mm_wire_fees (020). The beneficiary account number is stored only AES-256-GCM encrypted.

-- Compliance staff. No endpoint grants the role: administrators (and tests) insert rows directly.
CREATE TABLE staff_roles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('compliance')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wire_requests (
  id uuid PRIMARY KEY,                                                  -- also the id of its transfers row once released
  seq bigserial NOT NULL UNIQUE,                                        -- tie-break for "newest first" under a frozen clock
  idempotency_key text NOT NULL UNIQUE,                                 -- `${user}:wire-screening:${client key}`
  fingerprint text NOT NULL,                                            -- the request body without its key (lib/idempotency.mjs)
  requested_by uuid NOT NULL REFERENCES users(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL CHECK (type IN ('domestic', 'international')),
  -- awaiting_approval -> released; under_review -> awaiting_approval | released | rejected; either -> canceled; stopped is final
  status text NOT NULL CHECK (status IN ('awaiting_approval', 'under_review', 'stopped', 'released', 'rejected', 'canceled')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  beneficiary_name text NOT NULL,
  beneficiary_bank text NOT NULL,
  bank_identifier text NOT NULL,                                        -- routing number, or upper-case SWIFT code
  account_last4 text NOT NULL,
  account_enc text NOT NULL,                                            -- AES-256-GCM, bound to `${requested_by}:${id}`
  country text NOT NULL,
  purpose text NOT NULL,
  screening_result text NOT NULL CHECK (screening_result IN ('clear', 'hit', 'potential_match')),
  screening_matches jsonb NOT NULL DEFAULT '[]',
  second_approval_required boolean NOT NULL,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  review_decision text CHECK (review_decision IN ('released', 'rejected')),
  review_reason text,
  reviewed_at timestamptz,
  value_date date,
  entry_id uuid REFERENCES journal_entries(id),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((status = 'released') = (entry_id IS NOT NULL))
);
CREATE INDEX wire_requests_account ON wire_requests(from_account_id, status);
CREATE INDEX wire_requests_requester ON wire_requests(requested_by, status);

-- One case for every wire whose screening was a hit or a potential match.
CREATE TABLE compliance_cases (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  wire_id uuid NOT NULL UNIQUE REFERENCES wire_requests(id),
  kind text NOT NULL CHECK (kind IN ('hit', 'potential_match')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  outcome text CHECK (outcome IN ('released', 'rejected', 'canceled', 'confirmed_hit')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  close_reason text,
  CHECK ((status = 'closed') = (outcome IS NOT NULL))
);
CREATE INDEX compliance_cases_status ON compliance_cases(status, opened_at DESC);

-- A wire's history is read from the audit trail by detail->>'wire'.
CREATE INDEX audit_events_wire ON audit_events((detail->>'wire')) WHERE detail ? 'wire';
