-- Document control (wave 3, H3): versioned files attached to a transaction,
-- NOC, lead, property or project, with a review flow and a download log.
-- Files live in R2 (env.IMAGES) under the `docs/` prefix and are only served
-- through the authenticated /api/documents/:id/versions/:v/download endpoint.
-- The project brochure feature (project_documents) is separate and untouched.

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  entity_type        TEXT NOT NULL CHECK (entity_type IN ('transaction', 'noc', 'lead', 'property', 'project')),
  entity_id          TEXT NOT NULL,
  doc_type           TEXT NOT NULL DEFAULT 'Other',
  title              TEXT NOT NULL,
  visibility         TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'legal', 'client')),
  review_status      TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected', 'signed')),
  current_version    INTEGER NOT NULL DEFAULT 1,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents (review_status, updated_at);

-- Every upload is a new row; files are never overwritten.
CREATE TABLE IF NOT EXISTS document_versions (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  r2_key             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  size               INTEGER NOT NULL,
  mime               TEXT NOT NULL,
  uploaded_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TEXT NOT NULL DEFAULT (datetime('now')),
  note               TEXT,
  UNIQUE (document_id, version)
);

-- History: uploads, review steps (with comments) and every download (who/when).
CREATE TABLE IF NOT EXISTS document_events (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,   -- created | new_version | submitted | approved | rejected | signed | edited | downloaded
  version            INTEGER,
  from_status        TEXT,
  to_status          TEXT,
  comment            TEXT,
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name          TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_document_events_doc ON document_events (document_id, created_at);
