-- Property contacts are now recorded as a Direct contact (at the builder) and
-- an Indirect contact (e.g. a channel partner / broker), each a name + number.
-- The older sourcing manager / site head columns stay for existing rows (and
-- for projects), shown read-only when a property has nothing newer.
ALTER TABLE properties ADD COLUMN direct_contact_name    TEXT;
ALTER TABLE properties ADD COLUMN direct_contact_phone   TEXT;
ALTER TABLE properties ADD COLUMN indirect_contact_name  TEXT;
ALTER TABLE properties ADD COLUMN indirect_contact_phone TEXT;
