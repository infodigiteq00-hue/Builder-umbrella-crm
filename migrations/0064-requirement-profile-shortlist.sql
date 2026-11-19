-- 0064 (wave 3, E): client requirement profile, options shared (shortlist),
-- property price & availability history.

-- Full requirement profile as JSON text (intent, criteria, finance, preferences,
-- decision context, communication). budget_min/max, property_type, location and
-- client_status on the lead are kept in sync with it.
ALTER TABLE leads ADD COLUMN requirement_profile TEXT;

-- Every property / project shown to a client, with the price quoted and the client's answer.
CREATE TABLE IF NOT EXISTS lead_shortlist (
  id                 TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id        TEXT REFERENCES properties(id) ON DELETE CASCADE,
  project_id         TEXT REFERENCES projects(id) ON DELETE CASCADE,
  price_shared       INTEGER,
  shared_at          TEXT NOT NULL DEFAULT (datetime('now')),
  shared_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  response           TEXT NOT NULL DEFAULT 'no_reply'
                     CHECK (response IN ('interested', 'not_interested', 'visit_wanted', 'no_reply')),
  note               TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_shortlist_lead ON lead_shortlist (lead_id, shared_at);
CREATE INDEX IF NOT EXISTS idx_lead_shortlist_property ON lead_shortlist (property_id) WHERE property_id IS NOT NULL;

-- One row per change of a catalogue property's price, availability or inventory status.
CREATE TABLE IF NOT EXISTS property_price_history (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  field               TEXT NOT NULL CHECK (field IN ('price', 'availability', 'status')),
  old_value           TEXT,
  new_value           TEXT,
  changed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_price_history_property ON property_price_history (property_id, changed_at);
