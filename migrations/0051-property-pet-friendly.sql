-- Rental listings only: whether pets are allowed ('yes' | 'no'; NULL = not set).
ALTER TABLE properties ADD COLUMN pet_friendly TEXT CHECK (pet_friendly IS NULL OR pet_friendly IN ('yes', 'no'));
