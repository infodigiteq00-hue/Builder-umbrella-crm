-- Apply once to an existing deployed CRM database.
-- This migration is additive: it keeps the existing portal leads, users,
-- assignment history and routing trigger in place.

ALTER TABLE users ADD COLUMN access_token_hash TEXT;
ALTER TABLE users ADD COLUMN permission_overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN availability TEXT NOT NULL DEFAULT 'available';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_access_token ON users(access_token_hash) WHERE access_token_hash IS NOT NULL;

ALTER TABLE leads ADD COLUMN stage TEXT NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE leads ADD COLUMN next_follow_up_at TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_transfer_requests (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  responded_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_recipient ON lead_transfer_requests(to_user_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_one_pending ON lead_transfer_requests(lead_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('note', 'call', 'meeting', 'task', 'email')),
  subject TEXT NOT NULL,
  body TEXT,
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON lead_activities(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_user_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_history_lead ON lead_stage_history(lead_id, id DESC);
