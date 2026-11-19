-- Properties an agent has actually discussed with a customer, distinct from
-- the single project_name on the lead and from the algorithmic "matching
-- properties" suggestions. Backs the combined multi-property brochure PDF.

CREATE TABLE IF NOT EXISTS lead_discussed_properties (
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lead_id, property_id)
);
