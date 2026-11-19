-- Projects: expected launch month ('YYYY-MM'), optional. Separate from launch_month (0040, EOI only).
ALTER TABLE projects ADD COLUMN expected_launch TEXT CHECK (expected_launch IS NULL OR expected_launch GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]');
