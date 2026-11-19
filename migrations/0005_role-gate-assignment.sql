-- Apply once to an existing deployed CRM database.
-- Fixes: a manager/admin/viewer with accepts_leads=1 (set by mistake, or by
-- the pre-fix version of the Team Access UI) was eligible for round-robin/
-- least-loaded auto-assignment. Only 'agent' should ever be eligible.
-- CREATE TRIGGER has no OR REPLACE in SQLite/D1, so the old one must be
-- dropped first — this is why a trigger body change needs a migration file
-- rather than just editing schema.sql (which only applies to a fresh DB).

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

  UPDATE leads SET assigned_user_id = (
    SELECT u.id FROM users u
    WHERE u.team_id = (SELECT team_id FROM leads WHERE id = NEW.id)
      AND u.role = 'agent' AND u.is_active = 1 AND u.accepts_leads = 1
    ORDER BY
      CASE WHEN (
        SELECT strategy FROM routing_rules
        WHERE is_active = 1
          AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
          AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
        ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
      ) = 'least_loaded'
      THEN (SELECT COUNT(*) FROM leads l WHERE l.assigned_user_id = u.id AND l.status IN ('new','assigned','in_process'))
      ELSE COALESCE((SELECT MAX(id) FROM assignment_history WHERE to_user_id = u.id), 0)
      END, u.id LIMIT 1
  ) WHERE id = NEW.id;

  UPDATE leads SET status = CASE WHEN assigned_user_id IS NULL THEN 'new' ELSE 'assigned' END WHERE id = NEW.id;
  INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason)
  SELECT id, assigned_user_id, team_id,
    CASE WHEN team_id IS NULL THEN 'unrouted'
         WHEN assigned_user_id IS NULL THEN 'unassigned:no_eligible_user'
         ELSE 'auto:' || (
           SELECT strategy FROM routing_rules
           WHERE is_active = 1
             AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
             AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
           ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
         ) END
  FROM leads WHERE id = NEW.id;
END;

-- Also clean up any row where this already happened before the fix (e.g. a
-- manager whose accepts_leads got flipped on by the old, unguarded toggle).
UPDATE users SET accepts_leads = 0 WHERE role != 'agent' AND accepts_leads = 1;
