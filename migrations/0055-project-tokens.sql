-- Project token types (booking / EOI token variants): each project can offer
-- several tokens (Standard, Priority, Premium…) with an amount in rupees,
-- whether it is refundable and the advantages that come with it.
--
-- advantages holds a JSON array of short strings as text.
-- refundable: 1 = refundable, 0 = non-refundable, NULL = not said.

CREATE TABLE IF NOT EXISTS project_tokens (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  refundable  INTEGER CHECK (refundable IS NULL OR refundable IN (0, 1)),
  advantages  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_tokens_project ON project_tokens (project_id, sort_order);
