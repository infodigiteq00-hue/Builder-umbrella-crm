-- Rental only: who the owner prefers to rent to ('families' | 'bachelors' | 'anyone').
ALTER TABLE properties ADD COLUMN tenant_preference TEXT CHECK (tenant_preference IS NULL OR tenant_preference IN ('families', 'bachelors', 'anyone'));
