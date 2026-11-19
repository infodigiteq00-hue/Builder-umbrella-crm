-- Per-day meter for the super-admin AI assistant (Gemini), so its cost is
-- visible and a daily request cap can be enforced. `day` is the IST date.
CREATE TABLE IF NOT EXISTS ai_usage (
  day           TEXT PRIMARY KEY,
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0
);
