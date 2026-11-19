-- Rentals only: is the property currently occupied by a tenant? 'yes' | 'no' (NULL = not stated).
ALTER TABLE properties ADD COLUMN occupied TEXT CHECK (occupied IS NULL OR occupied IN ('yes', 'no'));
