-- Brochure-specific metadata is additive. Existing images stay visible but
-- are omitted from a client brochure until an editor gives them a caption.

ALTER TABLE property_images ADD COLUMN title TEXT;
ALTER TABLE property_images ADD COLUMN category TEXT NOT NULL DEFAULT 'property';

CREATE TABLE IF NOT EXISTS workspace_assets (
  key          TEXT PRIMARY KEY,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
