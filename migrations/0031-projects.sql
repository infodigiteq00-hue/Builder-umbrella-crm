-- A project is one builder development (usually a building) whose units the
-- builder has handed us to sell, while it is still in EOI or under
-- construction. Units are added in bulk: for a building, each flat records
-- its floor. Single ready properties stay in `properties`.

CREATE TABLE IF NOT EXISTS projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  developer              TEXT,
  builder_id             TEXT REFERENCES builders(id) ON DELETE SET NULL,
  kind                   TEXT NOT NULL DEFAULT 'building' CHECK (kind IN ('building', 'other')),
  construction_status    TEXT NOT NULL CHECK (construction_status IN ('eoi_phase', 'under_construction')),
  location               TEXT,
  locality               TEXT,
  total_floors           INTEGER CHECK (total_floors IS NULL OR total_floors > 0),
  possession_by          TEXT,
  description            TEXT,
  sourcing_manager_name  TEXT,
  sourcing_manager_phone TEXT,
  site_head_name         TEXT,
  site_head_phone        TEXT,
  created_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_units (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wing             TEXT,
  floor_number     INTEGER,
  unit_no          TEXT,
  bedroom_count    INTEGER,
  carpet_area_sqft INTEGER,
  price_expected   INTEGER,
  status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'booked', 'sold')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units (project_id, floor_number, unit_no);
