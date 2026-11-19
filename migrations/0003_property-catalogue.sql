CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  developer TEXT,
  property_type TEXT,
  location TEXT,
  locality TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  bedrooms TEXT,
  availability TEXT NOT NULL DEFAULT 'available',
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_properties_match ON properties(is_active, property_type, location, budget_min, budget_max);
