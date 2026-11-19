-- Daily follow-up digests (Agent OPS). One row per person per run, plus one
-- company roll-up row per run with user_id NULL. Written by the scheduled()
-- cron job (and POST /api/digest/run); rows older than 30 days are pruned by
-- the same job. `payload` is JSON; `delivered_via` records whether the digest
-- was also emailed. The email provider API key is a Worker secret
-- (RESEND_API_KEY) and is never stored here.
CREATE TABLE IF NOT EXISTS digests (
  id             TEXT PRIMARY KEY,
  run_at         TEXT NOT NULL DEFAULT (datetime('now')),
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  payload        TEXT NOT NULL,
  delivered_via  TEXT NOT NULL DEFAULT 'none' CHECK (delivered_via IN ('none', 'email')),
  delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_digests_user_run ON digests (user_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_digests_run_at   ON digests (run_at);
