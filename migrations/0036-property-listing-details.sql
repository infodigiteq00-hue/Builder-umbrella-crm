-- Extra details the add-property wizard asks for depending on the listing:
--   EOI Phase → launch date, land parcel area, commercial advantages
--   Rent      → furnishing
--   Sell      → new or resale (resale also records age_of_property)
-- Configuration, price/rent range and age reuse bedrooms, budget_min/max and
-- age_of_property. Each is NULL when it doesn't apply.
ALTER TABLE properties ADD COLUMN launch_date TEXT
  CHECK (launch_date IS NULL OR launch_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]');
ALTER TABLE properties ADD COLUMN land_parcel_area TEXT;
ALTER TABLE properties ADD COLUMN commercial_advantages TEXT;
ALTER TABLE properties ADD COLUMN furnishing TEXT
  CHECK (furnishing IS NULL OR furnishing IN ('furnished', 'semi_furnished', 'unfurnished'));
ALTER TABLE properties ADD COLUMN sale_type TEXT
  CHECK (sale_type IS NULL OR sale_type IN ('new', 'resale'));
