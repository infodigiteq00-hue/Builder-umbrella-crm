-- Email + password sign-in replaces the pasted sign-in codes.
--   users.password_hash   "pbkdf2-sha256$100000$<salt hex>$<hash hex>" (never the password itself)
--   app_admin             the super administrator's own login (it is not a staff row, so it never shows in staff lists)
--   auth_sessions         one row per signed-in browser; only the SHA-256 of the token is stored
--   login_attempts        failed-sign-in counter per email, for a short lock-out
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS app_admin (
  id            TEXT PRIMARY KEY DEFAULT 'super-admin',
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT 'Super administrator',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  email        TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT
);
