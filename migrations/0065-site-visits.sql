-- 0065 (wave 3, F): client site visits — scheduled from the lead window,
-- confirmed with the client, then recorded (attended / no-show + feedback).
CREATE TABLE IF NOT EXISTS site_visits (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id         TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  employee_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,   -- who takes the client
  scheduled_at        TEXT NOT NULL,                                  -- UTC 'YYYY-MM-DD HH:MM:SS'
  confirmation        TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation IN ('pending', 'confirmed', 'cancelled')),
  attendance          TEXT NOT NULL DEFAULT 'scheduled' CHECK (attendance IN ('scheduled', 'completed', 'no_show')),
  liked               INTEGER CHECK (liked IS NULL OR liked IN (0, 1)), -- client liked it?
  feedback            TEXT,                                           -- feedback notes
  objections          TEXT,
  next_step           TEXT,
  next_step_at        TEXT,
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_visits_lead ON site_visits (lead_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_when ON site_visits (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_employee ON site_visits (employee_user_id, scheduled_at);
