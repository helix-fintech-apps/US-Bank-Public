-- Cross-feature consistency. Runs after 060. Every statement is safe to run twice.

-- R2: USA Pay codes are kept (not deleted) when a new one is asked for, so wrong guesses count across codes: each code
-- request is a row, wrong_tries counts the wrong codes entered against it, superseded_at closes an older live code.
ALTER TABLE p2p_token_verifications ADD COLUMN IF NOT EXISTS wrong_tries int NOT NULL DEFAULT 0;
ALTER TABLE p2p_token_verifications ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
CREATE INDEX IF NOT EXISTS p2p_token_verifications_token ON p2p_token_verifications(token, created_at);
CREATE INDEX IF NOT EXISTS p2p_token_verifications_user_at ON p2p_token_verifications(user_id, created_at);

-- R2: an enrollment is verified once its code was entered. Rows made by the old path (no code) stay NULL: they no longer
-- receive USA Pay money or requests, the holder enrolls them again with a code, and a verified owner can take them over.
-- (The demo seed marks its own demo tokens verified: lib/seeds/money-movement.mjs.)
ALTER TABLE p2p_enrollments ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- R5: card interest is charged once for every statement whose due date passed unpaid, however close together statements
-- closed. interest_assessed marks a statement whose interest was decided. Statements the old code already looked at (it
-- checked only the statement just before the one closing, so every statement that has a later one) are marked decided,
-- so a deploy never charges retroactive interest on old statements; the latest statement is decided at the next close.
ALTER TABLE card_statements ADD COLUMN IF NOT EXISTS interest_assessed boolean NOT NULL DEFAULT false;
UPDATE card_statements s SET interest_assessed = true
 WHERE NOT s.interest_assessed AND EXISTS (SELECT 1 FROM card_statements l WHERE l.account_id = s.account_id
   AND (l.period_end, l.created_at) > (s.period_end, s.created_at));

-- R4: when a card was reported lost or stolen, so a dispute rule can tell purchases made before the report from later ones.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS closed_at timestamptz;
UPDATE cards SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL;

-- R16: one lock. Before this PR a Family "freeze card" and a Cards "lock" were separate, so a frozen child's card could
-- still show 'active' (and a card locked on Cards left the family flag off). Sync both ways: a frozen account locks every
-- open card on it, and a locked card on a minor's account sets the family freeze (then locks the account's other cards).
UPDATE cards k SET status = 'locked', updated_at = now()
  FROM family_controls f WHERE f.account_id = k.account_id AND f.card_frozen AND k.status = 'active';
UPDATE family_controls f SET card_frozen = true, updated_at = now()
 WHERE NOT f.card_frozen AND EXISTS (SELECT 1 FROM cards k WHERE k.account_id = f.account_id AND k.status = 'locked');
UPDATE cards k SET status = 'locked', updated_at = now()
  FROM family_controls f WHERE f.account_id = k.account_id AND f.card_frozen AND k.status = 'active';
