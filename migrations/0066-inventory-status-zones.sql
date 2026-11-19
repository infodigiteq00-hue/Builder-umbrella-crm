-- 0066 (wave 3, agent G): inventory status flow, team assignment, zones.
--
-- properties.inventory_status: where a property is in its life.
--   draft                → the hunting team is still recording it (pipeline 'hunting')
--   pending_verification → converted to a listing, waiting for a manager to give it to a client team
--   active               → assigned to a client team; shows in matching / Find properties
--   on_hold, negotiation → still visible to matching, with a warning
--   sold, leased         → kept for history, hidden from matching
-- properties.assigned_team_id: the client team that sells / rents it out.
-- properties.zone, projects.zone: West / East / North / South Pune.
ALTER TABLE properties ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'active'
  CHECK (inventory_status IN ('draft', 'pending_verification', 'active', 'on_hold', 'negotiation', 'sold', 'leased'));
ALTER TABLE properties ADD COLUMN assigned_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN zone TEXT CHECK (zone IS NULL OR zone IN ('west_pune', 'east_pune', 'north_pune', 'south_pune'));
ALTER TABLE projects ADD COLUMN zone TEXT CHECK (zone IS NULL OR zone IN ('west_pune', 'east_pune', 'north_pune', 'south_pune'));

-- Backfill: hunting drafts are drafts; switched-off catalogue entries are on hold; the rest stay active.
UPDATE properties SET inventory_status = 'draft' WHERE pipeline = 'hunting';
UPDATE properties SET inventory_status = 'on_hold' WHERE pipeline = 'catalog' AND is_active = 0;

CREATE INDEX IF NOT EXISTS idx_properties_inventory ON properties (inventory_status, assigned_team_id);
CREATE INDEX IF NOT EXISTS idx_properties_zone ON properties (zone);
