-- Idempotency. Safe to run twice.
-- R1: a loan application carries the request id the page sent, unique per customer, so a double submit returns the first
-- application (and does not pull the file a second time). Older rows and callers without an id keep NULL.
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS loan_applications_user_key ON loan_applications(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- R2: what each successful keyed request looked like, so the same request id with a different request is refused.
-- scope_hash = sha256(session, route, request id): the id itself and the session token are not stored.
CREATE TABLE IF NOT EXISTS idempotency_requests (
  scope_hash text PRIMARY KEY,
  fingerprint text NOT NULL,
  route text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_requests_created ON idempotency_requests(created_at);
