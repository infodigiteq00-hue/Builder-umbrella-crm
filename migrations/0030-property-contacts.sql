-- Who to call about a property on the builder's side: the sourcing manager
-- (commercial terms) and the site head (visits, site access).
ALTER TABLE properties ADD COLUMN sourcing_manager_name  TEXT;
ALTER TABLE properties ADD COLUMN sourcing_manager_phone TEXT;
ALTER TABLE properties ADD COLUMN site_head_name         TEXT;
ALTER TABLE properties ADD COLUMN site_head_phone        TEXT;
