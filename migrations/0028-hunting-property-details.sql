-- Property hunting teams record full property details (the same fields as
-- the client catalogue) BEFORE a property is ready to sell. Those rows live in
-- `properties` too, but with pipeline = 'hunting' so the client team's
-- catalogue, lead matching, brochures and the public property list never see
-- them. "Convert to listing" just flips pipeline to 'catalog'.

ALTER TABLE properties ADD COLUMN pipeline TEXT NOT NULL DEFAULT 'catalog'
  CHECK (pipeline IN ('catalog', 'hunting'));

-- The hunting target a draft belongs to (one set of details per target).
ALTER TABLE hunting_targets ADD COLUMN draft_property_id TEXT
  REFERENCES properties(id) ON DELETE SET NULL;
