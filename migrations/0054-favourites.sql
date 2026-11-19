-- Per-user favourites: a heart on a property or a project (kind 'property' | 'project').
CREATE TABLE IF NOT EXISTS favourites (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('property', 'project')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_favourites_user ON favourites(user_id, kind);
