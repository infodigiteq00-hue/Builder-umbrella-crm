-- Property hunting: owner contact book.
-- An owner is a SHARED contact (any hunting reader can see it), unlike a
-- hunting target, which is scoped to its assignee / team. One owner can have
-- many targets (e.g. a builder with several plots).

CREATE TABLE IF NOT EXISTS hunting_owners (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  alt_phone          TEXT,
  email              TEXT,
  owner_type         TEXT NOT NULL DEFAULT 'individual'
                     CHECK (owner_type IN ('individual', 'builder', 'broker', 'other')),
  locality           TEXT,
  notes              TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_owners_updated ON hunting_owners (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hunting_owners_phone   ON hunting_owners (phone);

-- The free-text owner_name / owner_phone / owner_email columns stay: they are
-- the fallback when no owner record is linked.
ALTER TABLE hunting_targets ADD COLUMN owner_id TEXT REFERENCES hunting_owners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hunting_targets_owner ON hunting_targets (owner_id);

-- Backfill: one owner per existing target that has any owner detail. Targets
-- that share the same (trimmed) phone number share ONE owner, keyed on the
-- lowest target id in that group. Safe on an empty table, and safe to re-run
-- (only rows with owner_id IS NULL are touched; INSERT OR IGNORE on the id).
INSERT OR IGNORE INTO hunting_owners (id, name, phone, email, locality, created_by_user_id, created_at, updated_at)
SELECT 'ho_mig_' || t.id,
       COALESCE(NULLIF(trim(t.owner_name), ''), NULLIF(trim(t.owner_phone), ''), lower(trim(t.owner_email))),
       NULLIF(trim(t.owner_phone), ''),
       NULLIF(lower(trim(t.owner_email)), ''),
       NULLIF(trim(t.locality), ''),
       t.created_by_user_id, t.created_at, t.created_at
  FROM hunting_targets t
 WHERE t.owner_id IS NULL
   AND (COALESCE(trim(t.owner_name), '') <> '' OR COALESCE(trim(t.owner_phone), '') <> '' OR COALESCE(trim(t.owner_email), '') <> '')
   AND (COALESCE(trim(t.owner_phone), '') = ''
        OR t.id = (SELECT MIN(t2.id) FROM hunting_targets t2 WHERE trim(t2.owner_phone) = trim(t.owner_phone)));

UPDATE hunting_targets
   SET owner_id = 'ho_mig_' || CASE
         WHEN COALESCE(trim(owner_phone), '') = '' THEN id
         ELSE (SELECT MIN(t2.id) FROM hunting_targets t2 WHERE trim(t2.owner_phone) = trim(hunting_targets.owner_phone))
       END
 WHERE owner_id IS NULL
   AND (COALESCE(trim(owner_name), '') <> '' OR COALESCE(trim(owner_phone), '') <> '' OR COALESCE(trim(owner_email), '') <> '');
