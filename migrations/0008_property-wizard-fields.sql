-- Apply once to an existing deployed CRM database.
-- Adds the fields needed for a real multi-step "Add Property" wizard
-- (listing intent, full location breakdown, area/bed/bath/balcony/floor,
-- age, and unit-level pricing) without touching anything already there —
-- every column is nullable or defaulted, so existing rows stay valid as-is.

ALTER TABLE properties ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'sell' CHECK (listing_type IN ('sell', 'rent', 'pg'));
ALTER TABLE properties ADD COLUMN category TEXT NOT NULL DEFAULT 'residential' CHECK (category IN ('residential', 'commercial'));
ALTER TABLE properties ADD COLUMN sub_locality TEXT;
ALTER TABLE properties ADD COLUMN society_name TEXT;
ALTER TABLE properties ADD COLUMN house_no TEXT;
ALTER TABLE properties ADD COLUMN carpet_area_sqft INTEGER;
ALTER TABLE properties ADD COLUMN bedroom_count INTEGER;
ALTER TABLE properties ADD COLUMN bathroom_count INTEGER;
ALTER TABLE properties ADD COLUMN balcony_count INTEGER;
ALTER TABLE properties ADD COLUMN total_floors INTEGER;
ALTER TABLE properties ADD COLUMN floor_number INTEGER;
ALTER TABLE properties ADD COLUMN age_of_property TEXT CHECK (age_of_property IN ('0-1', '1-5', '5-10', '10+'));
ALTER TABLE properties ADD COLUMN price_expected INTEGER;
ALTER TABLE properties ADD COLUMN price_per_sqft INTEGER;
ALTER TABLE properties ADD COLUMN price_negotiable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN price_all_inclusive INTEGER NOT NULL DEFAULT 0;
