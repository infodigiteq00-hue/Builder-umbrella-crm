-- "This employee gets leads with this budget." A matching rule makes that employee the RECOMMENDED owner of a new
-- lead (it still goes to the manager-approval queue, because a lead must be ranked before it gets an owner).
-- Budget range is half-open: budget_min <= lead budget < budget_max; either side NULL = open-ended.
CREATE TABLE IF NOT EXISTS budget_rules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_min  INTEGER,
  budget_max  INTEGER,
  project     TEXT,                       -- optional: only leads asking about this project
  priority    INTEGER NOT NULL DEFAULT 100,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_budget_rules_user ON budget_rules (user_id);
