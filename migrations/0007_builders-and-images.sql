-- Apply once to an existing deployed CRM database.
-- Adds a builders directory (name + every location they have a property in,
-- auto-maintained) and property photo storage (pointers into R2; the bucket
-- itself is provisioned separately — see wrangler.jsonc / README.md).

CREATE TABLE IF NOT EXISTS builders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  locations  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builders_name ON builders (lower(name));

ALTER TABLE properties ADD COLUMN builder_id TEXT REFERENCES builders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_builder ON properties (builder_id);

CREATE TABLE IF NOT EXISTS property_images (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_images_property ON property_images (property_id, sort_order, created_at);

-- Backfill: link existing properties' free-text `developer` names to a real
-- builders row, and seed each builder's locations from what's already there.
INSERT INTO builders (id, name, locations)
SELECT lower(hex(randomblob(16))), developer,
       COALESCE((SELECT location FROM properties p2 WHERE p2.developer = p.developer AND p2.location IS NOT NULL LIMIT 1), '')
FROM (SELECT DISTINCT developer FROM properties WHERE developer IS NOT NULL AND trim(developer) != '') p
WHERE NOT EXISTS (SELECT 1 FROM builders b WHERE lower(b.name) = lower(p.developer));

UPDATE properties SET builder_id = (
  SELECT id FROM builders WHERE lower(builders.name) = lower(properties.developer)
) WHERE developer IS NOT NULL AND trim(developer) != '' AND builder_id IS NULL;
