-- Expected completion for an under-construction property, as 'YYYY-MM'
-- (month + year). NULL for every other construction status.
ALTER TABLE properties ADD COLUMN completion_month TEXT
  CHECK (completion_month IS NULL OR completion_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]');
