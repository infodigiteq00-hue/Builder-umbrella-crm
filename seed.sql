-- Demo data. Mirrors the EspoCRM demo so behaviour is directly comparable.
-- Apply with:  npx wrangler d1 execute crm --file=seed.sql --local

INSERT OR IGNORE INTO teams (id, name) VALUES
  ('team_sales',      'Sales Team'),
  ('team_commercial', 'Commercial Team');

INSERT OR IGNORE INTO users (id, name, email, role, team_id, accepts_leads) VALUES
  ('u_priya',  'Priya Sharma', 'priya.sharma@example.com', 'agent',   'team_sales',      1),
  ('u_arjun',  'Arjun Mehta',  'arjun.mehta@example.com',  'agent',   'team_sales',      1),
  -- Manager sits in the team for oversight/reassignment but is excluded from
  -- the auto-assignment pool.
  ('u_neha',   'Neha Kapoor',  'neha.kapoor@example.com',  'manager', 'team_sales',      0),
  ('u_rakesh', 'Rakesh Iyer',  'rakesh.iyer@example.com',  'agent',   'team_commercial', 1);

INSERT OR IGNORE INTO routing_rules (id, name, priority, match_source, match_property_type, team_id, strategy) VALUES
  -- Most specific: commercial/office enquiries go to the commercial desk
  -- regardless of which portal they came from.
  (1, 'Commercial property → Commercial Team', 10, NULL, 'Commercial', 'team_commercial', 'least_loaded'),
  (2, 'Office property → Commercial Team',     10, NULL, 'Office',     'team_commercial', 'least_loaded'),
  -- Catch-all: send the next enquiry to the agent with the fewest active
  -- leads. This is the operational default, not a demonstration setting.
  (3, 'Default → Sales Team',                 100, NULL, NULL,         'team_sales',      'least_loaded');
