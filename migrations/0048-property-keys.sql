-- Keys of a property: which keys exist (main door, bedroom, balcony, other)
-- and where each set is right now: still with the owner, taken by an
-- employee, or deposited at the office / key box.
CREATE TABLE IF NOT EXISTS property_keys (
  id                 TEXT PRIMARY KEY,
  property_id        TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('main_door', 'bedroom', 'balcony', 'other')),
  copies             INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'owner' CHECK (status IN ('owner', 'employee', 'deposited')),
  held_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  held_by_name       TEXT,   -- name of the employee holding it (kept as text so the super admin can hold keys too)
  taken_at           TEXT,
  deposit_place      TEXT,   -- e.g. "Office key box"
  deposited_by       TEXT,   -- name of who handed it in
  deposited_at       TEXT,
  notes              TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_keys_property ON property_keys (property_id, sort_order, created_at);

-- Custody history: one row per key change, shown in the manager notification feed.
CREATE TABLE IF NOT EXISTS property_key_events (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  key_id         TEXT,
  key_label      TEXT NOT NULL,
  action         TEXT NOT NULL,   -- added | removed | taken | handed | deposited | returned
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_key_events_property ON property_key_events (property_id, created_at);
