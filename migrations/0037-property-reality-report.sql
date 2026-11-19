-- Reality report: 0–5 ratings entered when a property is added, shown as
-- gauges in the brochure. NULL = not rated.
ALTER TABLE properties ADD COLUMN rating_locality REAL CHECK (rating_locality IS NULL OR rating_locality BETWEEN 0 AND 5);
ALTER TABLE properties ADD COLUMN rating_connectivity REAL CHECK (rating_connectivity IS NULL OR rating_connectivity BETWEEN 0 AND 5);
ALTER TABLE properties ADD COLUMN rating_appreciation REAL CHECK (rating_appreciation IS NULL OR rating_appreciation BETWEEN 0 AND 5);
ALTER TABLE properties ADD COLUMN rating_lifestyle REAL CHECK (rating_lifestyle IS NULL OR rating_lifestyle BETWEEN 0 AND 5);
