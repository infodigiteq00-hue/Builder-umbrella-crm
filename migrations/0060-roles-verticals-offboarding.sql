-- Wave 3 / A: new employee roles, team verticals and the "employee left" flow.
--
-- 1. users.role gains sales_head, team_leader, inventory_approver,
--    transaction_coordinator, legal and finance (+ users.left_at). SQLite
--    cannot change a CHECK in place, so the users table is rebuilt, keeping
--    every column, row and index.
--
--    CAREFUL: D1 always runs with foreign_keys = ON (PRAGMA foreign_keys=OFF
--    is a no-op inside its transaction, writable_schema is not allowed, and
--    legacy_alter_table still rewrites REFERENCES). `DROP TABLE users` does an
--    implicit DELETE that FIRES every child's ON DELETE action, even with
--    defer_foreign_keys: leads would lose their owner (SET NULL), digests and
--    transfer requests would be deleted (CASCADE), approvals block (RESTRICT).
--    So every child reference is snapshotted first and put back afterwards.
--    Tested against a copy of the local D1 database.
-- 2. teams.vertical: which side of the business a team works on.
-- 3. user_offboarding: one log row per employee who left (who took over and
--    how much was moved). History rows (stage history, activities,
--    created_by) are never rewritten.

PRAGMA defer_foreign_keys = ON;

-- ---- 1a. snapshot every reference to users ----
CREATE TABLE _m0060_refs (tbl TEXT NOT NULL, col TEXT NOT NULL, rid INTEGER NOT NULL, val TEXT);
INSERT INTO _m0060_refs SELECT 'teams', 'manager_user_id', rowid, manager_user_id FROM teams WHERE manager_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'leads', 'assigned_user_id', rowid, assigned_user_id FROM leads WHERE assigned_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'properties', 'created_by_user_id', rowid, created_by_user_id FROM properties WHERE created_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'hunting_targets', 'assigned_user_id', rowid, assigned_user_id FROM hunting_targets WHERE assigned_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'hunting_targets', 'created_by_user_id', rowid, created_by_user_id FROM hunting_targets WHERE created_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'hunting_owners', 'created_by_user_id', rowid, created_by_user_id FROM hunting_owners WHERE created_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'projects', 'created_by_user_id', rowid, created_by_user_id FROM projects WHERE created_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'project_documents', 'created_by_user_id', rowid, created_by_user_id FROM project_documents WHERE created_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'property_keys', 'held_by_user_id', rowid, held_by_user_id FROM property_keys WHERE held_by_user_id IS NOT NULL;
INSERT INTO _m0060_refs SELECT 'property_key_events', 'actor_user_id', rowid, actor_user_id FROM property_key_events WHERE actor_user_id IS NOT NULL;
CREATE TABLE _m0060_digests AS SELECT * FROM digests WHERE user_id IS NOT NULL;
CREATE TABLE _m0060_transfers AS SELECT * FROM lead_transfer_requests;
CREATE TABLE _m0060_approvals AS SELECT * FROM assignment_approvals;
-- recommended_user_id is ON DELETE RESTRICT: park the rows, restore below.
DELETE FROM assignment_approvals;
-- @local-extra-snapshot

-- The lead-routing trigger reads users; it must not exist during the rename.
DROP TRIGGER IF EXISTS assign_new_lead;

-- ---- 1b. rebuild users ----
CREATE TABLE users_next (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN (
                  'agent', 'manager', 'admin', 'super_admin', 'viewer',
                  'sales_head', 'team_leader', 'inventory_approver',
                  'transaction_coordinator', 'legal', 'finance')),
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  accepts_leads INTEGER NOT NULL DEFAULT 1,
  access_token_hash TEXT UNIQUE,
  permission_overrides TEXT NOT NULL DEFAULT '{}',
  availability    TEXT NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available', 'away', 'busy', 'offline')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  left_at       TEXT  -- 0060: set when an admin marks the employee as left
);

INSERT INTO users_next (
  id, name, email, phone, role, team_id, is_active, accepts_leads,
  access_token_hash, permission_overrides, availability, created_at
)
SELECT
  id, name, email, phone, role, team_id, is_active, accepts_leads,
  access_token_hash, permission_overrides, availability, created_at
FROM users;

DROP TABLE users;
ALTER TABLE users_next RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_pool ON users (team_id, is_active, accepts_leads);

-- ---- 1c. put every reference back ----
UPDATE teams SET manager_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'teams' AND col = 'manager_user_id' AND rid = teams.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'teams' AND col = 'manager_user_id');
UPDATE leads SET assigned_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'leads' AND col = 'assigned_user_id' AND rid = leads.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'leads' AND col = 'assigned_user_id');
UPDATE properties SET created_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'properties' AND col = 'created_by_user_id' AND rid = properties.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'properties' AND col = 'created_by_user_id');
UPDATE hunting_targets SET assigned_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'hunting_targets' AND col = 'assigned_user_id' AND rid = hunting_targets.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'hunting_targets' AND col = 'assigned_user_id');
UPDATE hunting_targets SET created_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'hunting_targets' AND col = 'created_by_user_id' AND rid = hunting_targets.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'hunting_targets' AND col = 'created_by_user_id');
UPDATE hunting_owners SET created_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'hunting_owners' AND col = 'created_by_user_id' AND rid = hunting_owners.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'hunting_owners' AND col = 'created_by_user_id');
UPDATE projects SET created_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'projects' AND col = 'created_by_user_id' AND rid = projects.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'projects' AND col = 'created_by_user_id');
UPDATE project_documents SET created_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'project_documents' AND col = 'created_by_user_id' AND rid = project_documents.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'project_documents' AND col = 'created_by_user_id');
UPDATE property_keys SET held_by_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'property_keys' AND col = 'held_by_user_id' AND rid = property_keys.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'property_keys' AND col = 'held_by_user_id');
UPDATE property_key_events SET actor_user_id = (SELECT val FROM _m0060_refs WHERE tbl = 'property_key_events' AND col = 'actor_user_id' AND rid = property_key_events.rowid) WHERE rowid IN (SELECT rid FROM _m0060_refs WHERE tbl = 'property_key_events' AND col = 'actor_user_id');
INSERT INTO digests SELECT * FROM _m0060_digests;
INSERT INTO lead_transfer_requests SELECT * FROM _m0060_transfers;
INSERT INTO assignment_approvals SELECT * FROM _m0060_approvals;
-- @local-extra-restore
DROP TABLE _m0060_refs;
DROP TABLE _m0060_digests;
DROP TABLE _m0060_transfers;
DROP TABLE _m0060_approvals;

-- Same body as migrations/0012 (unchanged).
CREATE TRIGGER assign_new_lead AFTER INSERT ON leads
WHEN NEW.assigned_user_id IS NULL AND NEW.team_id IS NULL
BEGIN
  UPDATE leads SET team_id = (
    SELECT team_id FROM routing_rules
    WHERE is_active = 1
      AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
      AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
    ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id
    LIMIT 1
  ) WHERE id = NEW.id;

  INSERT INTO assignment_approvals (
    id, lead_id, recommended_user_id, recommended_team_id, routing_strategy
  )
  SELECT
    lower(hex(randomblob(16))),
    l.id,
    (
      SELECT u.id FROM users u
      WHERE u.team_id = l.team_id
        AND u.role = 'agent' AND u.is_active = 1 AND u.accepts_leads = 1
      ORDER BY
        CASE WHEN (
          SELECT strategy FROM routing_rules
          WHERE is_active = 1
            AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
            AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
          ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
        ) = 'least_loaded'
        THEN
          (SELECT COUNT(*) FROM leads open_leads WHERE open_leads.assigned_user_id = u.id AND open_leads.status IN ('new','assigned','in_process'))
          + (SELECT COUNT(*) FROM assignment_approvals pending WHERE pending.recommended_user_id = u.id AND pending.status = 'pending')
        ELSE COALESCE((SELECT MAX(id) FROM assignment_history WHERE to_user_id = u.id), 0)
        END,
        u.id
      LIMIT 1
    ),
    l.team_id,
    (
      SELECT strategy FROM routing_rules
      WHERE is_active = 1
        AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
        AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
      ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
    )
  FROM leads l
  WHERE l.id = NEW.id
    AND l.team_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.team_id = l.team_id AND u.role = 'agent' AND u.is_active = 1 AND u.accepts_leads = 1
    );

  INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason, note)
  SELECT lead_id, recommended_user_id, recommended_team_id,
         'auto:pending_manager_approval',
         'Suggested automatically; awaiting manager approval.'
    FROM assignment_approvals
   WHERE lead_id = NEW.id AND status = 'pending';

  UPDATE leads SET status = 'new' WHERE id = NEW.id;

  INSERT INTO assignment_history (lead_id, to_team_id, reason, note)
  SELECT id, team_id,
         CASE WHEN team_id IS NULL THEN 'unrouted' ELSE 'unassigned:no_eligible_user' END,
         CASE WHEN team_id IS NULL THEN 'No active routing rule matched.' ELSE 'No eligible agent is available.' END
    FROM leads
   WHERE id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM assignment_approvals WHERE lead_id = NEW.id);
END;

-- ---- 2. team verticals ----
ALTER TABLE teams ADD COLUMN vertical TEXT NOT NULL DEFAULT 'client'
  CHECK (vertical IN ('presales', 'client', 'hunting', 'postsales'));

-- ---- 3. offboarding log ----
CREATE TABLE IF NOT EXISTS user_offboarding (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,              -- who left (no FK: history)
  user_name              TEXT,
  reassigned_to_user_id  TEXT,
  reassigned_to_name     TEXT,
  counts                 TEXT NOT NULL DEFAULT '{}', -- JSON {leads, tasks, hunting, visits, transactions}
  actor_user_id          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  restored_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_offboarding_user ON user_offboarding (user_id, created_at DESC);
