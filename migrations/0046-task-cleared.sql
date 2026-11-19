-- "Clear completed" in To Do: the assignee can tidy finished tasks out of
-- their own lists without deleting them — managers' views and task stats
-- still count them. Reopening a task clears the mark.
ALTER TABLE tasks ADD COLUMN cleared_at TEXT;
