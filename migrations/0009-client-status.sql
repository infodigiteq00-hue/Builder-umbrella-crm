-- Apply once to existing CRM databases after 0008. This is nullable so every
-- existing lead remains valid; the manual-lead form validates new values.

ALTER TABLE leads ADD COLUMN client_status TEXT;
