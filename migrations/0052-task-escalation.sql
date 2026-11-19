-- Delayed-task escalation (To Do). A task is "delayed" when it is open and its
-- due date is before today (IST). The first time that is noticed the assignee's
-- head (team manager, else an admin) is told once: escalated_at +
-- escalated_to_user_id. If it is still open after 3 days late the head's head
-- (admin) is told too: escalated2_*. A head can also nudge the assignee
-- (nudged_at / nudged_by_user_id). Changing the due date, reassigning or
-- reopening a task clears all of these so a new delay can escalate again.
-- User ids are plain TEXT (the super admin is not a users row).
ALTER TABLE tasks ADD COLUMN escalated_at TEXT;
ALTER TABLE tasks ADD COLUMN escalated_to_user_id TEXT;
ALTER TABLE tasks ADD COLUMN escalated2_at TEXT;
ALTER TABLE tasks ADD COLUMN escalated2_to_user_id TEXT;
ALTER TABLE tasks ADD COLUMN nudged_at TEXT;
ALTER TABLE tasks ADD COLUMN nudged_by_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_open_due ON tasks (due_date) WHERE completed_at IS NULL;
