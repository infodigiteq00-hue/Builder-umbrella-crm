-- 0070 (wave 3, H4): finance for transactions — brokerage, invoices, receipts,
-- expenses and partner payouts. Money is stored in rupees (REAL, rounded to
-- paise by the worker). Financial rows are never hard-deleted: they are
-- cancelled / reversed through their status columns.
-- transaction_id deliberately has no FOREIGN KEY: `transactions` is owned by
-- migration 0067 and the worker validates the id on every write.

CREATE TABLE IF NOT EXISTS brokerage (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL UNIQUE,
  basis               TEXT NOT NULL DEFAULT 'percent',   -- 'percent' (of agreed price) | 'fixed'
  rate                REAL,                              -- % when basis = 'percent'
  fixed_amount        REAL,                              -- ₹ when basis = 'fixed'
  expected_amount     REAL NOT NULL DEFAULT 0,           -- ₹ before GST
  gst_note            TEXT,
  from_party          TEXT NOT NULL DEFAULT 'buyer',     -- 'buyer' | 'seller' | 'builder' | 'both'
  due_date            TEXT,                              -- YYYY-MM-DD
  status              TEXT NOT NULL DEFAULT 'expected',  -- 'expected' | 'cancelled'
  note                TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brokerage_due ON brokerage(due_date);

CREATE TABLE IF NOT EXISTS invoices (
  id                  TEXT PRIMARY KEY,
  invoice_no          TEXT NOT NULL UNIQUE,              -- INV-00001
  transaction_id      TEXT NOT NULL,
  billed_to           TEXT NOT NULL,
  amount              REAL NOT NULL,                     -- ₹ before tax
  tax_amount          REAL NOT NULL DEFAULT 0,
  total_amount        REAL NOT NULL,                     -- amount + tax
  issue_date          TEXT NOT NULL,                     -- YYYY-MM-DD
  due_date            TEXT,
  status              TEXT NOT NULL DEFAULT 'draft',     -- 'draft' | 'sent' | 'partly_paid' | 'paid' | 'cancelled'
  note                TEXT,
  overdue_alerted_at  TEXT,                              -- set once the daily overdue alert went out
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  cancelled_by_user_id TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_txn ON invoices(transaction_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date);

CREATE TABLE IF NOT EXISTS receipts (
  id                  TEXT PRIMARY KEY,
  invoice_id          TEXT NOT NULL REFERENCES invoices(id),
  transaction_id      TEXT NOT NULL,
  amount              REAL NOT NULL,
  received_on         TEXT NOT NULL,                     -- YYYY-MM-DD
  mode                TEXT NOT NULL,                     -- 'cash' | 'cheque' | 'bank_transfer' | 'upi'
  reference           TEXT,
  proof_key           TEXT,                              -- R2 key (env.IMAGES), optional
  proof_content_type  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'reversed'
  reverse_reason      TEXT,
  reversed_at         TEXT,
  reversed_by_user_id TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_invoice ON receipts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_receipts_txn ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(received_on);

CREATE TABLE IF NOT EXISTS expenses (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT,                              -- optional
  category            TEXT NOT NULL,
  amount              REAL NOT NULL,
  spent_on            TEXT NOT NULL,                     -- YYYY-MM-DD
  paid_by             TEXT,
  note                TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'cancelled'
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_txn ON expenses(transaction_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_on);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL,
  partner_name        TEXT NOT NULL,
  partner_type        TEXT NOT NULL DEFAULT 'channel_partner', -- 'channel_partner' | 'sub_broker' | 'employee_incentive'
  share_basis         TEXT NOT NULL DEFAULT 'fixed',     -- 'percent' (of expected brokerage) | 'fixed'
  share_rate          REAL,
  amount              REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'paid' | 'cancelled'
  note                TEXT,
  approved_by_user_id TEXT,
  approved_at         TEXT,
  paid_on             TEXT,
  payment_reference   TEXT,
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payouts_txn ON partner_payouts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON partner_payouts(status);
