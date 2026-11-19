-- Pre-launch vs post-launch benefits table on a project: JSON array of
-- { benefit, pre, post } rows (text), entered by staff.
ALTER TABLE projects ADD COLUMN launch_benefits TEXT;
