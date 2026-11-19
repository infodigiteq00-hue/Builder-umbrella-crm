-- Property hunting: commission & listing terms agreed with the owner.
ALTER TABLE hunting_targets ADD COLUMN commission_percent REAL
  CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100));
ALTER TABLE hunting_targets ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1));
-- Date only, 'YYYY-MM-DD'.
ALTER TABLE hunting_targets ADD COLUMN listing_valid_until TEXT;
ALTER TABLE hunting_targets ADD COLUMN terms_notes TEXT;
