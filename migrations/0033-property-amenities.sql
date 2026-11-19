-- Free text for facilities the form has no dedicated field for
-- (clubhouse, gym, pool, power backup, EV charging, ...).
ALTER TABLE properties ADD COLUMN amenities TEXT;
