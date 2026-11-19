-- The notification feed itself is built on the fly from the history tables
-- that already exist (leads, activities, stage moves, assignments, transfers,
-- users, properties, hunting). Only "what has this person already seen"
-- needs storing, for the unread badge.
-- user_id has no FK: the built-in super admin ('super-admin') is not a users row.

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id      TEXT PRIMARY KEY,
  last_read_at TEXT NOT NULL
);
