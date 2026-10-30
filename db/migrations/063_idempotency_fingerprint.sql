-- A loan application remembers what its first request looked like, so a concurrent different request with the same
-- request id is refused. Separate from 062 because 062 may already have run. Safe to run twice.
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
