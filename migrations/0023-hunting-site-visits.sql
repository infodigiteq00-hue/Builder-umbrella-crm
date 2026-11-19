-- Property hunting: site-visit checklist. `checklist` is a JSON object whose
-- keys are defined ONCE in HUNTING_SITE_VISIT_CHECKLIST (src/index.js) and
-- served to the UI through GET /api/hunting-meta.
-- visited_by_user_id stores the actor id as-is (including the built-in
-- 'super-admin', which has no users row), like the activity tables do.
CREATE TABLE IF NOT EXISTS hunting_site_visits (
  id                 TEXT PRIMARY KEY,
  hunting_target_id  TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  visited_by_user_id TEXT,
  visited_at         TEXT NOT NULL DEFAULT (datetime('now')),
  checklist          TEXT NOT NULL DEFAULT '{}',
  rating             INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  summary            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_site_visits_target ON hunting_site_visits (hunting_target_id, visited_at DESC);
