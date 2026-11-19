-- Ties an explicit manager to a team, so "My team" can show who runs each
-- team instead of just listing members that share a team_id. Nullable —
-- existing teams stay valid with no manager assigned until someone sets one.

ALTER TABLE teams ADD COLUMN manager_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_teams_manager ON teams (manager_user_id);
