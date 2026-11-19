-- A property may link to the brochure supplied by its builder (usually a
-- hosted PDF). URL validation is enforced by the Worker before this value is
-- written, so existing rows are unaffected and the column is nullable.

ALTER TABLE properties ADD COLUMN builder_brochure_url TEXT;
