-- Wave 3 / C: lead sub-statuses and a required reason for closing a lead.
--
-- The 11 stages stay exactly as they are (reports depend on them). Each stage
-- gets a short list of "details" (sub_status), validated by the server
-- against LEAD_SUB_STATUSES in src/index.js, so no CHECK here.
--
-- Moving a lead to 'lost' requires lost_reason (LOST_REASONS in src/index.js).
-- Junk leads are closed as 'lost' with a reason in the 'invalid' group
-- (invalid_number, duplicate, junk) rather than a new stage, so every existing
-- won/lost report keeps working; sub_status on a lost lead is then 'invalid'
-- or 'dropped'. 'other' needs lost_note. Reopening a lead clears all three.
--
-- lead_stage_history records the detail / reason chosen with each stage move,
-- so the change is timestamped and attributed like the move itself.
ALTER TABLE leads ADD COLUMN sub_status TEXT;
ALTER TABLE leads ADD COLUMN lost_reason TEXT;
ALTER TABLE leads ADD COLUMN lost_note TEXT;
ALTER TABLE lead_stage_history ADD COLUMN sub_status TEXT;
ALTER TABLE lead_stage_history ADD COLUMN lost_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason ON leads (lost_reason) WHERE lost_reason IS NOT NULL;
