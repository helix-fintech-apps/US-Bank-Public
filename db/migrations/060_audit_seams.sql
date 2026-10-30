-- Fixes from the adversarial audit. Cross-feature, so it runs after every feature's
-- migration. No new system accounts: the rewards clawback moves money through card_rewards (…32), as redemptions do.

-- R2: an email or phone is enrolled in USA Pay only after the code sent to it (simulated) is entered. One live code per
-- user and token; only its SHA-256 hash is stored.
CREATE TABLE p2p_token_verifications (
  id text PRIMARY KEY,                                                  -- random, held by the browser until the code is entered
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,                                                  -- the email (lowercase) or 10-digit phone being proven
  account_id uuid NOT NULL REFERENCES accounts(id),                     -- where USA Pay money will go
  code_hash text NOT NULL,                                              -- sha256(id + ':' + code)
  tries_left int NOT NULL CHECK (tries_left >= 0),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX p2p_token_verifications_user ON p2p_token_verifications(user_id, token);

-- R4: rewards follow a disputed purchase. reverse: taken back when a dispute opens; restore: given back when it is lost;
-- clawback: the part already redeemed, charged back to the card account by a ledger entry, so the balance never goes below 0.
ALTER TABLE card_rewards DROP CONSTRAINT card_rewards_kind_check;
ALTER TABLE card_rewards ADD CONSTRAINT card_rewards_kind_check CHECK (kind IN ('earn', 'redeem', 'reverse', 'restore', 'clawback'));

-- R4: the dispute rule (lib/cards.mjs DISPUTE_RULES) that decided the simulated resolution, shown to the customer.
ALTER TABLE card_disputes ADD COLUMN decided_by text;
