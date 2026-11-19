-- Property hunting: document tracker. One row per (target, doc_type); a
-- missing row means 'pending'. updated_by_user_id stores the actor id as-is
-- (including 'super-admin'), like the activity tables do.
CREATE TABLE IF NOT EXISTS hunting_documents (
  hunting_target_id  TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  doc_type           TEXT NOT NULL CHECK (doc_type IN ('title_deed', 'rera', 'noc', 'encumbrance', 'tax_receipts', 'approved_plan', 'other')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'verified', 'not_applicable')),
  note               TEXT,
  updated_by_user_id TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hunting_target_id, doc_type)
);

-- Property hunting: site photos. Same columns as property_images. On convert
-- each photo's R2 object is COPIED to a new key under properties/, so deleting
-- either side never breaks the other.
CREATE TABLE IF NOT EXISTS hunting_target_images (
  id                TEXT PRIMARY KEY,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  r2_key            TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  title             TEXT,
  category          TEXT NOT NULL DEFAULT 'property' CHECK (category IN ('building', 'property')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_target_images_target ON hunting_target_images (hunting_target_id, sort_order, created_at);
