-- Automatic routing now recommends an agent and waits for a manager's decision
-- before a lead receives an owner. Direct/manual assignments remain immediate.

CREATE TABLE IF NOT EXISTS assignment_approvals (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  recommended_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recommended_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  routing_strategy    TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'changed', 'cancelled')),
  reviewer_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  final_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_approvals_pending
  ON assignment_approvals (recommended_team_id, status, created_at);

DROP TRIGGER IF EXISTS assign_new_lead;

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
