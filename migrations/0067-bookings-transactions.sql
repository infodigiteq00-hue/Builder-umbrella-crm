-- Post-Sales core (wave 3, H1): token / booking, transactions, parties and the
-- transaction history log.
--
-- A booking is the token money a client pays to block a unit. It is NOT a
-- closure: the deal is only done when its transaction reaches 'closed'.
--   recipient: builder | owner | atlantic
--   status:    recorded | transaction_created | refunded | cancelled
-- Enum columns are validated in the worker (no CHECK lists), so later waves can
-- add values without a table rebuild.
CREATE TABLE IF NOT EXISTS bookings (
  id                    TEXT PRIMARY KEY,
  lead_id               TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id           TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
  unit_label            TEXT,            -- e.g. "Flat 1203, Tower B"
  amount                INTEGER NOT NULL,  -- rupees
  paid_on               TEXT,            -- YYYY-MM-DD
  payer_name            TEXT,
  recipient             TEXT,
  payment_reference     TEXT,            -- UTR / cheque no.
  refund_terms          TEXT,            -- refund / forfeiture terms
  receipt_r2_key        TEXT,            -- receipt photo in R2 (env.IMAGES)
  receipt_content_type  TEXT,
  note                  TEXT,
  status                TEXT NOT NULL DEFAULT 'recorded',
  status_note           TEXT,
  created_by_user_id    TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings (lead_id, created_at);

-- One deal from token to possession. txn_code like T-00001.
--   txn_type: resale | builder_sale | rental | commercial
--   stage:    token_received | documents | agreement | registration | possession | closed | cancelled
--   status:   open | closed | cancelled (follows the stage)
-- Milestones keep a target and an actual date each (YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS transactions (
  id                            TEXT PRIMARY KEY,
  txn_code                      TEXT NOT NULL,
  lead_id                       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  property_id                   TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id                    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  booking_id                    TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  unit_label                    TEXT,
  txn_type                      TEXT NOT NULL DEFAULT 'resale',
  stage                         TEXT NOT NULL DEFAULT 'token_received',
  status                        TEXT NOT NULL DEFAULT 'open',
  agreed_price                  INTEGER,
  payment_schedule_note         TEXT,
  brokerage_note                TEXT,
  relationship_manager_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  coordinator_user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_mou_on                 TEXT,
  actual_mou_on                 TEXT,
  target_documents_on           TEXT,
  actual_documents_on           TEXT,
  target_agreement_on           TEXT,
  actual_agreement_on           TEXT,
  target_registration_on        TEXT,
  actual_registration_on        TEXT,
  target_possession_on          TEXT,
  actual_possession_on          TEXT,
  cancel_reason                 TEXT,
  stage_changed_at              TEXT,
  created_by_user_id            TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_code ON transactions (txn_code);
CREATE INDEX IF NOT EXISTS idx_transactions_lead ON transactions (lead_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stage ON transactions (stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_transactions_coordinator ON transactions (coordinator_user_id);

-- Everyone on the paperwork: several buyers, sellers, co-owners, legal heirs…
--   role: buyer | seller | co_owner | legal_heir | poa_holder | other
CREATE TABLE IF NOT EXISTS transaction_parties (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  note            TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_parties_txn ON transaction_parties (transaction_id, sort_order);

-- History shown in the transaction window: who changed what, when.
--   kind: created | stage | update | milestone | party
CREATE TABLE IF NOT EXISTS transaction_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  from_value      TEXT,
  to_value        TEXT,
  note            TEXT,
  actor_user_id   TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_events_txn ON transaction_events (transaction_id, id DESC);
