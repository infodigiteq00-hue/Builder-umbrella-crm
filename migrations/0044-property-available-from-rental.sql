-- Availability date ('YYYY-MM-DD', any listing) and the expected monthly rent
-- a SALE listing can earn (investor view; rent listings keep their rent range).
ALTER TABLE properties ADD COLUMN available_from TEXT CHECK (available_from IS NULL OR available_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]');
ALTER TABLE properties ADD COLUMN expected_rent INTEGER;
