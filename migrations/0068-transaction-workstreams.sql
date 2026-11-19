-- Post-Sales workstreams (wave 3, H2): NOC tracker + the legal / bank /
-- registration / possession checklist of a transaction.
-- Enum columns are validated in the worker (no CHECK lists, same as 0067), so
-- later waves can add values without a table rebuild.
-- User ids are plain TEXT FKs with SET NULL (the super admin is not a users row).

-- One row per NOC (Society, Builder, MIDC / authority, Bank, Other).
--   noc_type: society | builder | authority | bank | other   (type_label = custom name)
--   status:   not_assessed | not_started | documents_pending | ready_to_submit | submitted |
--             query_raised | resubmission_required | approved | rejected | not_applicable
--   checklist: JSON array [{ "label": "...", "done": true|false }]
--   log:       JSON array [{ "at": ISO, "by": user id|null, "by_name": "...", "text": "..." }]
--   Overdue = target_date < today (IST) and status not approved / not_applicable.
--   last_alerted_on = IST date of the last overdue alert (one alert a day at most).
CREATE TABLE IF NOT EXISTS transaction_nocs (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  noc_type             TEXT NOT NULL DEFAULT 'society',
  type_label           TEXT,
  issuing_party        TEXT,
  coordinator_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  checklist            TEXT NOT NULL DEFAULT '[]',
  applied_on           TEXT,              -- YYYY-MM-DD
  charges              INTEGER,           -- rupees
  payment_note         TEXT,              -- payment proof / receipt reference
  status               TEXT NOT NULL DEFAULT 'not_assessed',
  target_date          TEXT,              -- YYYY-MM-DD
  completed_on         TEXT,              -- YYYY-MM-DD
  log                  TEXT NOT NULL DEFAULT '[]',
  evidence_note        TEXT,              -- final NOC reference / where the copy is
  last_alerted_on      TEXT,
  created_by_user_id   TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_nocs_txn ON transaction_nocs (transaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transaction_nocs_open_target ON transaction_nocs (target_date)
  WHERE status NOT IN ('approved', 'not_applicable');

-- Workstream checklist items. Parallel items are fine; depends_on_task_id is
-- an optional single prerequisite ("Waiting for …" until it is done).
--   workstream: commercial | documents | mou | bank | legal | registration | possession | finance
--   status:     pending | in_progress | blocked | done | not_applicable
CREATE TABLE IF NOT EXISTS transaction_tasks (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  workstream           TEXT NOT NULL DEFAULT 'commercial',
  title                TEXT NOT NULL,
  owner_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date             TEXT,              -- YYYY-MM-DD
  depends_on_task_id   TEXT REFERENCES transaction_tasks(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  blocked_reason       TEXT,
  evidence_note        TEXT,
  template_key         TEXT,              -- set when loaded from a checklist template
  sort_order           INTEGER NOT NULL DEFAULT 0,
  completed_at         TEXT,
  last_alerted_on      TEXT,
  created_by_user_id   TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_txn ON transaction_tasks (transaction_id, workstream, sort_order);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_open_due ON transaction_tasks (due_date)
  WHERE status IN ('pending', 'in_progress', 'blocked');
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_owner ON transaction_tasks (owner_user_id);
