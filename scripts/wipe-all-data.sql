-- !!! DESTRUCTIVE — empties the CRM: every lead, property, project, builder, staff member, team, task, alert,
-- deal, document row, hunting record and backup record. Kept: branding/settings and the super admin login.
-- Run ONLY after (1) a full backup and (2) migrations are applied, and only if you really want an empty CRM:
--   npx wrangler d1 execute crm --remote --file=scripts/wipe-all-data.sql
-- Files in the photo/document storage bucket (R2) are NOT removed by this.
PRAGMA defer_foreign_keys = ON;
DELETE FROM alert_reads; DELETE FROM alerts;
DELETE FROM document_events; DELETE FROM document_versions; DELETE FROM documents;
DELETE FROM receipts; DELETE FROM invoices; DELETE FROM expenses; DELETE FROM partner_payouts; DELETE FROM brokerage;
DELETE FROM transaction_nocs; DELETE FROM transaction_tasks; DELETE FROM transaction_parties; DELETE FROM transaction_events; DELETE FROM transactions; DELETE FROM bookings;
DELETE FROM site_visits; DELETE FROM lead_shortlist; DELETE FROM lead_handovers; DELETE FROM lead_discussed_properties;
DELETE FROM property_price_history; DELETE FROM property_key_events; DELETE FROM property_keys; DELETE FROM favourites; DELETE FROM property_images;
DELETE FROM hunting_documents; DELETE FROM hunting_site_visits; DELETE FROM hunting_target_activities; DELETE FROM hunting_target_images; DELETE FROM hunting_target_stage_history; DELETE FROM hunting_targets; DELETE FROM hunting_owners;
DELETE FROM lead_transfer_requests; DELETE FROM assignment_approvals; DELETE FROM assignment_history; DELETE FROM lead_activities; DELETE FROM lead_stage_history; DELETE FROM intake_receipts;
DELETE FROM leads;
DELETE FROM project_documents; DELETE FROM project_tokens; DELETE FROM project_configurations; DELETE FROM project_units; DELETE FROM projects;
DELETE FROM properties; DELETE FROM builders;
DELETE FROM tasks; DELETE FROM task_lists; DELETE FROM notification_reads; DELETE FROM ai_usage; DELETE FROM digests; DELETE FROM backups; DELETE FROM user_offboarding; DELETE FROM workspace_assets;
DELETE FROM auth_sessions; DELETE FROM login_attempts;
DELETE FROM routing_rules; UPDATE teams SET manager_user_id = NULL; DELETE FROM users; DELETE FROM teams;
UPDATE id_counters SET next = 1;
