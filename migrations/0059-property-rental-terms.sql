-- Rental-only terms (kept only when listing_type = 'rent'): security deposit and
-- monthly maintenance in rupees, whether maintenance is 'included' in the rent or
-- paid 'extra', and the lock-in period in months.
ALTER TABLE properties ADD COLUMN security_deposit INTEGER;
ALTER TABLE properties ADD COLUMN maintenance_charges INTEGER;
ALTER TABLE properties ADD COLUMN maintenance_included TEXT CHECK (maintenance_included IS NULL OR maintenance_included IN ('included','extra'));
ALTER TABLE properties ADD COLUMN lock_in_months INTEGER;
