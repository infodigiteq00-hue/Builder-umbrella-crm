-- Property hunting: the SUPPLY side of the brokerage. One row is one owner /
-- plot / project the hunting team is trying to bring on as new inventory.
-- A target that closes is converted into a real `properties` row through
-- POST /api/hunting-targets/:id/convert (never by editing the stage), and
-- converted_property_id then points at that catalogue entry.

CREATE TABLE IF NOT EXISTS hunting_targets (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  owner_name            TEXT,
  owner_phone           TEXT,
  owner_email           TEXT,
  property_type         TEXT,
  location              TEXT,
  locality              TEXT,
  asking_price          INTEGER,
  notes                 TEXT,
  source                TEXT,
  -- 'listed' and 'dropped' are terminal; everything else is still open.
  stage                 TEXT NOT NULL DEFAULT 'identified'
                        CHECK (stage IN ('identified', 'owner_contacted', 'site_visit_scheduled',
                                         'site_visited', 'documents_requested', 'terms_negotiated',
                                         'listed', 'dropped')),
  next_follow_up_at     TEXT,
  assigned_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id               TEXT REFERENCES teams(id) ON DELETE SET NULL,
  converted_property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  created_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_assignee ON hunting_targets (assigned_user_id, stage);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_team     ON hunting_targets (team_id, stage);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_updated  ON hunting_targets (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_follow_up ON hunting_targets (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

-- Calls, notes, meetings, tasks and emails logged against a hunting target.
-- Mirrors lead_activities.
CREATE TABLE IF NOT EXISTS hunting_target_activities (
  id                TEXT PRIMARY KEY,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  actor_user_id     TEXT,
  type              TEXT NOT NULL CHECK (type IN ('note', 'call', 'meeting', 'task', 'email')),
  subject           TEXT NOT NULL,
  body              TEXT,
  due_at            TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_activities_target ON hunting_target_activities (hunting_target_id, created_at DESC);

-- Every stage move of a hunting target, including the initial
-- NULL -> 'identified' row written on create. Mirrors lead_stage_history.
CREATE TABLE IF NOT EXISTS hunting_target_stage_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  from_stage        TEXT,
  to_stage          TEXT NOT NULL,
  actor_user_id     TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_stage_history_target ON hunting_target_stage_history (hunting_target_id, id DESC);
