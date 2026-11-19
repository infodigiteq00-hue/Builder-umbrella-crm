-- Builder track record: how many projects the builder has delivered, how it
-- usually fares on possession dates (free text), and years in business.
-- All optional; NULL = not recorded.

ALTER TABLE builders ADD COLUMN projects_delivered INTEGER CHECK (projects_delivered IS NULL OR projects_delivered >= 0);
ALTER TABLE builders ADD COLUMN possession_timeline TEXT;
ALTER TABLE builders ADD COLUMN years_in_business INTEGER CHECK (years_in_business IS NULL OR years_in_business >= 0);
