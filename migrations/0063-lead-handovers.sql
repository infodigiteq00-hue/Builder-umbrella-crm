-- Pre-Sales → client team handovers (wave 3, agent D).
-- A Pre-Sales person qualifies a lead and hands it to a client team. The lead
-- keeps its owner until the receiving team's manager / team leader accepts and
-- picks the relationship manager; a rejection leaves it with the sender.
--   summary: JSON { requirement_confirmed, budget, area, timeline, decision_maker, notes }
--   thread:  JSON [{ kind: 'sent'|'question'|'answer'|'accepted'|'rejected', text, by_user_id, by_name, at }]
--   to_user_id: the person suggested by the sender; on acceptance, the relationship manager.
CREATE TABLE IF NOT EXISTS lead_handovers (
  id                   TEXT PRIMARY KEY,
  lead_id              TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  from_team_id         TEXT REFERENCES teams(id) ON DELETE SET NULL,
  to_team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,
  to_user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  summary              TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'rejected', 'clarification')),
  response_note        TEXT,
  responded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  thread               TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at         TEXT
);
-- A lead can only have one open handover (waiting for a decision or an answer).
CREATE UNIQUE INDEX IF NOT EXISTS idx_handover_one_open ON lead_handovers (lead_id) WHERE status IN ('pending', 'clarification');
CREATE INDEX IF NOT EXISTS idx_handover_to_team ON lead_handovers (to_team_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handover_from_user ON lead_handovers (from_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handover_from_team ON lead_handovers (from_team_id, created_at DESC);
