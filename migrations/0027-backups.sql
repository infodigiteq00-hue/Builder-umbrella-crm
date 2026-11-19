-- Nightly JSON backups of every app table (Agent OPS). The dump itself lives
-- in R2 under backups/crm-YYYY-MM-DD.json.gz; this table records each run.
-- A failed run is kept with status 'error' so the failure is visible.
CREATE TABLE IF NOT EXISTS backups (
  id           TEXT PRIMARY KEY,
  r2_key       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  bytes        INTEGER,
  table_counts TEXT,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_r2_key  ON backups (r2_key);
