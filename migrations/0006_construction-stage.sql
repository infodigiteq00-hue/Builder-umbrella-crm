-- Apply once to an existing deployed CRM database.
-- Adds construction progress to the property catalogue, distinct from
-- `availability` (a sales state: can you still buy a unit here) — a project
-- can be "ready_to_move" and "sold_out" at the same time.

ALTER TABLE properties ADD COLUMN construction_status TEXT NOT NULL DEFAULT 'under_construction'
  CHECK (construction_status IN ('new_launch', 'under_construction', 'nearing_possession', 'ready_to_move'));
