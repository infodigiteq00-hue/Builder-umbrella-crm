-- Brochure content for properties: USPs ("Highlights") and key growth drivers,
-- one point per line (same plain-text style as `amenities`). Projects already
-- keep theirs as JSON arrays (0040).
ALTER TABLE properties ADD COLUMN usps TEXT;
ALTER TABLE properties ADD COLUMN key_growth TEXT;
