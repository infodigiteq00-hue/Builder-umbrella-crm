-- Brochures and other documents (PDF, Word, PowerPoint, Excel, images)
-- attached to a builder project. The file itself lives in R2 (env.IMAGES)
-- under project-docs/<project_id>/<id>; this row keeps its metadata.
CREATE TABLE IF NOT EXISTS project_documents (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  r2_key             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents (project_id, created_at);
