-- New role: sales_employee (same permissions as agent: own leads, adds leads/hunting targets, takes part in auto-assignment).
-- SQLite cannot change a CHECK in place, so the users table is rebuilt. Rebuilding is only safe while NO ONE has an
-- account yet: DROP TABLE users fires every child's ON DELETE action (leads would lose owners, digests/transfers would
-- be deleted). The guard below makes this migration fail, changing nothing, if any user row exists.
CREATE TABLE _m0075_guard (n INTEGER CHECK (n = 0));
INSERT INTO _m0075_guard SELECT COUNT(*) FROM users;
DROP TABLE _m0075_guard;

-- The routing trigger reads users; it must not exist during the rename.
DROP TRIGGER IF EXISTS assign_new_lead;

CREATE TABLE users_next (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN (
                  'agent', 'manager', 'admin', 'super_admin', 'viewer',
                  'sales_head', 'team_leader', 'inventory_approver',
                  'transaction_coordinator', 'legal', 'finance',
                  'sales_employee')),
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  accepts_leads INTEGER NOT NULL DEFAULT 1,
  access_token_hash TEXT UNIQUE,
  password_hash TEXT,
  permission_overrides TEXT NOT NULL DEFAULT '{}',
  availability    TEXT NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available', 'away', 'busy', 'offline')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  left_at       TEXT
);
DROP TABLE users;
ALTER TABLE users_next RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_pool ON users (team_id, is_active, accepts_leads);

-- Same body as schema.sql, with sales_employee allowed in the auto-assignment pool.
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
        -- role='agent' is the actual gate, not just accepts_leads: a manager
        -- can sit in a team for oversight without ever being recommended.
        AND u.role IN ('agent', 'sales_employee') AND u.is_active = 1 AND u.accepts_leads = 1
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
      WHERE u.team_id = l.team_id AND u.role IN ('agent', 'sales_employee') AND u.is_active = 1 AND u.accepts_leads = 1
    );

  -- Keep an auditable record of the system's recommendation. This also keeps
  -- round-robin recommendations fair while earlier decisions are pending.
  INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason, note)
  SELECT lead_id, recommended_user_id, recommended_team_id,
         'auto:pending_manager_approval',
         'Suggested automatically; awaiting manager approval.'
    FROM assignment_approvals
   WHERE lead_id = NEW.id AND status = 'pending';

  -- A routed lead remains unassigned until the approval action below. Do not
  -- mark it assigned simply because there is a recommendation.
  UPDATE leads SET status = 'new' WHERE id = NEW.id;

  INSERT INTO assignment_history (lead_id, to_team_id, reason, note)
  SELECT id, team_id,
         CASE WHEN team_id IS NULL THEN 'unrouted' ELSE 'unassigned:no_eligible_user' END,
         CASE WHEN team_id IS NULL THEN 'No active routing rule matched.' ELSE 'No eligible agent is available.' END
    FROM leads
   WHERE id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM assignment_approvals WHERE lead_id = NEW.id);
END;
