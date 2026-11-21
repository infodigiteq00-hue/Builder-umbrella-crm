-- Archive: a lead the team no longer wants in its lists but does not want to lose. NULL = active.
ALTER TABLE leads ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads (archived_at);
