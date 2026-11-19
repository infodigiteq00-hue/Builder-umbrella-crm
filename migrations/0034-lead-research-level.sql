-- How much market research the customer has done, ranked by whoever first
-- speaks to them: 'advanced' (has explored the market), 'exploring' (is
-- exploring the market) or 'initial' (has done no research).
-- NULL = not ranked yet. Portal/webhook/website leads arrive NULL; a lead must
-- be ranked before it can be given an owner (approval or manual assign).
ALTER TABLE leads ADD COLUMN research_level TEXT
  CHECK (research_level IS NULL OR research_level IN ('advanced', 'exploring', 'initial'));
