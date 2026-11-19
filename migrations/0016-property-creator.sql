-- Lets an employee manage photos only for the property they originally added.
-- Existing catalogue rows stay unowned and remain administrator-managed.
ALTER TABLE properties ADD COLUMN created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_properties_created_by_user
  ON properties (created_by_user_id);
