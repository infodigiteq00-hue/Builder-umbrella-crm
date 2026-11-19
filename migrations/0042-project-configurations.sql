-- Project configurations: the flat types a project offers (1 RK … 5+ BHK),
-- each with one or more categories / plans (Type A, Corner…) carrying carpet
-- area, balconies, price and the payment plans on offer.
--
-- payment_plans holds a JSON array of 'construction_linked' |
-- 'one_time_down_payment' | 'bullet' as text.

CREATE TABLE IF NOT EXISTS project_configurations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bhk              TEXT NOT NULL,
  variant_name     TEXT,
  carpet_area_sqft INTEGER,
  balcony_count    INTEGER,
  price            INTEGER,
  payment_plans    TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_configurations_project ON project_configurations (project_id, sort_order);
