-- Record the number of towers in a society/project. It is optional because
-- independent houses, plots, and older catalogue entries do not have one.

ALTER TABLE properties ADD COLUMN tower_count INTEGER CHECK (tower_count IS NULL OR tower_count > 0);
