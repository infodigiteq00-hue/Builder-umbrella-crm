-- Projects get the details a builder brief carries: more stages (nearing
-- possession, ready to move), separate kinds (flats / plots / villas & row
-- houses), EOI launch month + sample flat, land parcel and towers, flats per
-- floor, luxury vs affordable, amenity spaces, key growth points, USPs and
-- RERA. SQLite cannot alter a CHECK constraint in place, so rebuild projects
-- and its dependent units table, preserving every record.
--
-- List columns (amenity_spaces, key_growth, usps) hold JSON arrays as text.

CREATE TABLE projects_next (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  developer              TEXT,
  builder_id             TEXT REFERENCES builders(id) ON DELETE SET NULL,
  kind                   TEXT NOT NULL DEFAULT 'building' CHECK (kind IN ('building', 'plots', 'villas', 'other')),
  construction_status    TEXT NOT NULL CHECK (construction_status IN ('eoi_phase', 'under_construction', 'nearing_possession', 'ready_to_move')),
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
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  launch_month           TEXT CHECK (launch_month IS NULL OR launch_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  sample_flat_ready      INTEGER CHECK (sample_flat_ready IS NULL OR sample_flat_ready IN (0, 1)),
  land_parcel_area       TEXT,
  tower_count            INTEGER CHECK (tower_count IS NULL OR tower_count > 0),
  flats_per_floor        INTEGER CHECK (flats_per_floor IS NULL OR flats_per_floor > 0),
  segment                TEXT CHECK (segment IS NULL OR segment IN ('luxury', 'affordable')),
  amenity_spaces         TEXT,
  key_growth             TEXT,
  usps                   TEXT,
  rera_registered        INTEGER CHECK (rera_registered IS NULL OR rera_registered IN (0, 1)),
  rera_number            TEXT
);

CREATE TABLE project_units_next (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects_next(id) ON DELETE CASCADE,
  wing             TEXT,
  floor_number     INTEGER,
  unit_no          TEXT,
  bedroom_count    INTEGER,
  carpet_area_sqft INTEGER,
  price_expected   INTEGER,
  status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'booked', 'sold')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO projects_next (
  id, name, developer, builder_id, kind, construction_status, location, locality, total_floors, possession_by, description,
  sourcing_manager_name, sourcing_manager_phone, site_head_name, site_head_phone, created_by_user_id, created_at, updated_at
)
SELECT
  id, name, developer, builder_id, kind, construction_status, location, locality, total_floors, possession_by, description,
  sourcing_manager_name, sourcing_manager_phone, site_head_name, site_head_phone, created_by_user_id, created_at, updated_at
FROM projects;

INSERT INTO project_units_next (
  id, project_id, wing, floor_number, unit_no, bedroom_count, carpet_area_sqft, price_expected, status, created_at
)
SELECT
  id, project_id, wing, floor_number, unit_no, bedroom_count, carpet_area_sqft, price_expected, status, created_at
FROM project_units;

DROP TABLE project_units;
DROP TABLE projects;
ALTER TABLE projects_next RENAME TO projects;
ALTER TABLE project_units_next RENAME TO project_units;
CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units (project_id, floor_number, unit_no);
