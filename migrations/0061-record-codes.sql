-- Human-readable reference codes: every lead gets `L-00001`, every property
-- `P-00001` (hunting drafts too — a draft keeps its code when it is converted
-- into a catalogue listing, because conversion publishes the same row).
--
-- Codes are handed out by AFTER INSERT triggers backed by the `id_counters`
-- table, so EVERY insert path (portal intake, manual add, catalogue, hunting
-- draft, convert-to-listing, anything added later) gets one with no app code.
-- The trigger runs inside the INSERT statement itself and D1 serialises
-- writes, so two simultaneous inserts can never get the same number. The
-- UNIQUE indexes are the final safety net.

CREATE TABLE IF NOT EXISTS id_counters (
  name TEXT PRIMARY KEY,         -- 'lead' | 'property' (others may add theirs)
  next INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE leads ADD COLUMN lead_code TEXT;
ALTER TABLE properties ADD COLUMN property_code TEXT;

-- Backfill existing rows, oldest first.
UPDATE leads SET lead_code = printf('L-%05d', x.rn)
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS rn FROM leads) AS x
 WHERE x.id = leads.id AND leads.lead_code IS NULL;
UPDATE properties SET property_code = printf('P-%05d', x.rn)
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS rn FROM properties) AS x
 WHERE x.id = properties.id AND properties.property_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_lead_code ON leads (lead_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_property_code ON properties (property_code);

INSERT OR IGNORE INTO id_counters (name, next)
  SELECT 'lead', COALESCE(MAX(CAST(substr(lead_code, 3) AS INTEGER)), 0) + 1 FROM leads;
INSERT OR IGNORE INTO id_counters (name, next)
  SELECT 'property', COALESCE(MAX(CAST(substr(property_code, 3) AS INTEGER)), 0) + 1 FROM properties;

CREATE TRIGGER IF NOT EXISTS assign_lead_code AFTER INSERT ON leads
WHEN NEW.lead_code IS NULL
BEGIN
  UPDATE id_counters SET next = next + 1 WHERE name = 'lead';
  UPDATE leads SET lead_code = printf('L-%05d', (SELECT next - 1 FROM id_counters WHERE name = 'lead'))
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS assign_property_code AFTER INSERT ON properties
WHEN NEW.property_code IS NULL
BEGIN
  UPDATE id_counters SET next = next + 1 WHERE name = 'property';
  UPDATE properties SET property_code = printf('P-%05d', (SELECT next - 1 FROM id_counters WHERE name = 'property'))
   WHERE id = NEW.id;
END;
