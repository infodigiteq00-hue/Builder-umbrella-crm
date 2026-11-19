-- Expands the construction-stage check constraint to support early sales
-- stages. SQLite cannot alter a CHECK constraint in place, so rebuild the
-- properties table and its dependent image metadata together. Rebuilding the
-- child table first prevents ON DELETE CASCADE from discarding image rows.

CREATE TABLE properties_next (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  developer     TEXT,
  builder_id    TEXT REFERENCES builders(id) ON DELETE SET NULL,
  property_type TEXT,
  listing_type  TEXT NOT NULL DEFAULT 'sell' CHECK (listing_type IN ('sell', 'rent', 'pg')),
  category      TEXT NOT NULL DEFAULT 'residential' CHECK (category IN ('residential', 'commercial')),
  location      TEXT,
  locality      TEXT,
  sub_locality  TEXT,
  society_name  TEXT,
  house_no      TEXT,
  carpet_area_sqft INTEGER,
  bedroom_count    INTEGER,
  bathroom_count   INTEGER,
  balcony_count    INTEGER,
  total_floors     INTEGER,
  floor_number     INTEGER,
  age_of_property  TEXT CHECK (age_of_property IN ('0-1', '1-5', '5-10', '10+')),
  price_expected     INTEGER,
  price_per_sqft     INTEGER,
  price_negotiable   INTEGER NOT NULL DEFAULT 0,
  price_all_inclusive INTEGER NOT NULL DEFAULT 0,
  budget_min    INTEGER,
  budget_max    INTEGER,
  bedrooms      TEXT,
  availability  TEXT NOT NULL DEFAULT 'available'
                CHECK (availability IN ('available', 'sold_out', 'coming_soon', 'inactive')),
  construction_status TEXT NOT NULL DEFAULT 'under_construction'
                CHECK (construction_status IN ('prelaunch', 'eoi_phase', 'new_launch', 'under_construction', 'nearing_possession', 'ready_to_move')),
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE property_images_next (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties_next(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  title        TEXT,
  category     TEXT NOT NULL DEFAULT 'property' CHECK (category IN ('building', 'property')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO properties_next (
  id, name, developer, builder_id, property_type, listing_type, category,
  location, locality, sub_locality, society_name, house_no, carpet_area_sqft,
  bedroom_count, bathroom_count, balcony_count, total_floors, floor_number,
  age_of_property, price_expected, price_per_sqft, price_negotiable,
  price_all_inclusive, budget_min, budget_max, bedrooms, availability,
  construction_status, description, is_active, created_at, updated_at
)
SELECT
  id, name, developer, builder_id, property_type, listing_type, category,
  location, locality, sub_locality, society_name, house_no, carpet_area_sqft,
  bedroom_count, bathroom_count, balcony_count, total_floors, floor_number,
  age_of_property, price_expected, price_per_sqft, price_negotiable,
  price_all_inclusive, budget_min, budget_max, bedrooms, availability,
  construction_status, description, is_active, created_at, updated_at
FROM properties;

INSERT INTO property_images_next (
  id, property_id, r2_key, content_type, size_bytes, title, category, sort_order, created_at
)
SELECT
  id, property_id, r2_key, content_type, size_bytes, title, category, sort_order, created_at
FROM property_images;

DROP TABLE property_images;
DROP TABLE properties;
ALTER TABLE properties_next RENAME TO properties;
ALTER TABLE property_images_next RENAME TO property_images;
CREATE INDEX IF NOT EXISTS idx_properties_builder ON properties(builder_id);
CREATE INDEX IF NOT EXISTS idx_properties_match ON properties(is_active, property_type, location, budget_min, budget_max);
CREATE INDEX IF NOT EXISTS idx_property_images_property ON property_images(property_id, sort_order, created_at);
