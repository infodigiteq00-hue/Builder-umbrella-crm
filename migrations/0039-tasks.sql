-- To-do tasks (Microsoft To Do style). A task belongs to the person who must
-- do it (assigned_to) and remembers who created/assigned it. Managers assign
-- within their team; admins and the super admin assign to anyone.
-- User ids are plain TEXT (no FK) because the super admin is not a users row.
CREATE TABLE IF NOT EXISTS task_lists (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT 'blue',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_lists_owner ON task_lists (owner_user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  notes               TEXT,
  steps               TEXT NOT NULL DEFAULT '[]',          -- JSON [{id,title,done}]
  due_date            TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  repeat              TEXT CHECK (repeat IS NULL OR repeat IN ('daily', 'weekdays', 'weekly', 'monthly')),
  important           INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  my_day_date         TEXT,                                -- local date it was added to My Day
  list_id             TEXT REFERENCES task_lists(id) ON DELETE SET NULL,
  lead_id             TEXT REFERENCES leads(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  completed_at        TEXT,
  completed_by_user_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assigned_to_user_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator  ON tasks (created_by_user_id);
