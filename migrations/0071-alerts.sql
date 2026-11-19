-- Alerts with importance (normal / medium / high). Raised by the system through
-- raiseAlert()/storeAlert() or sent by hand (POST /api/alerts, permission alert.send).
-- The audience is resolved to concrete people when the alert is created, one
-- alert_reads row per recipient (user_id is TEXT without a foreign key because
-- the built-in super administrator 'super-admin' is not a users row).
CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  importance      TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal', 'medium', 'high')),
  title           TEXT NOT NULL,
  body            TEXT,
  link_kind       TEXT,            -- lead | property | project | transaction | task
  link_id         TEXT,
  sender_user_id  TEXT,            -- NULL = system; 'super-admin' for the super administrator
  audience        TEXT NOT NULL DEFAULT '{}',  -- JSON of what was asked for: {userIds, teamId, roles, everyone}
  repeat_count    INTEGER NOT NULL DEFAULT 1,  -- identical system alerts within an hour are grouped
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts (title, link_kind, link_id, last_at);

CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id         TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  read_at          TEXT,
  acknowledged_at  TEXT,           -- high alerts stay on screen until acknowledged
  PRIMARY KEY (alert_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_reads_user ON alert_reads (user_id, read_at);
