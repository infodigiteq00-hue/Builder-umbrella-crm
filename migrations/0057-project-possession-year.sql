-- 0057: possession year for EOI-phase projects (year only, e.g. 2029).
ALTER TABLE projects ADD COLUMN possession_year INTEGER CHECK (possession_year IS NULL OR (possession_year >= 2000 AND possession_year <= 2100));
