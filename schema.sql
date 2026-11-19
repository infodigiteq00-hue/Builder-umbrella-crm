-- Real-Estate Lead CRM — Cloudflare D1 schema.
-- Apply with:  npx wrangler d1 execute crm --file=schema.sql --local   (or --remote)

PRAGMA foreign_keys = ON;


CREATE TABLE IF NOT EXISTS teams (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  manager_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  tagline          TEXT, -- short line shown under the team name
  -- 0060: which side of the business the team works on.
  vertical         TEXT NOT NULL DEFAULT 'client' CHECK (vertical IN ('presales', 'client', 'hunting', 'postsales'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN (
                  'agent', 'manager', 'admin', 'super_admin', 'viewer',
                  'sales_head', 'team_leader', 'inventory_approver',      -- 0060
                  'transaction_coordinator', 'legal', 'finance',
                  'sales_employee')),   -- 0075
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- A manager belongs to a team for visibility and reassignment rights but is
  -- normally NOT in the auto-assignment pool. Kept as its own column rather
  -- than inferred from `role`, so a single agent can be paused (holiday, ramp
  -- up, performance) without changing what they're allowed to do.
  accepts_leads INTEGER NOT NULL DEFAULT 1,
  -- An employee's individual bearer token is stored only as a SHA-256 hash.
  -- The clear token is returned once when a super-admin creates or rotates it.
  access_token_hash TEXT UNIQUE,
  password_hash TEXT,  -- 0072: "pbkdf2-sha256$100000$salt$hash"; sign-in is email + password
  permission_overrides TEXT NOT NULL DEFAULT '{}',
  availability    TEXT NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available', 'away', 'busy', 'offline')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  left_at       TEXT  -- 0060: set when an admin marks the employee as left
);

-- 0060: one row per employee who left — who took over and how much moved.
CREATE TABLE IF NOT EXISTS user_offboarding (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,              -- who left (no FK: history)
  user_name              TEXT,
  reassigned_to_user_id  TEXT,
  reassigned_to_name     TEXT,
  counts                 TEXT NOT NULL DEFAULT '{}', -- JSON {leads, tasks, hunting, visits, transactions, ...}
  actor_user_id          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  restored_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_offboarding_user ON user_offboarding (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_pool ON users (team_id, is_active, accepts_leads);
CREATE INDEX IF NOT EXISTS idx_teams_manager ON teams (manager_user_id);

CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  lead_code         TEXT,                    -- 'L-00001', set by trigger assign_lead_code (0061)

  -- Portal identity
  source            TEXT NOT NULL,           -- '99acres' | 'magicbricks' | ...
  original_lead_id  TEXT,                    -- the portal's own ID
  portal_created_at TEXT,                    -- timestamp the PORTAL reports
                                             -- (distinct from our created_at)
  -- Customer
  customer_name     TEXT,
  phone             TEXT,
  email             TEXT,

  -- Property interest
  project_name      TEXT,
  property_type     TEXT,
  location          TEXT,
  budget_min        INTEGER,
  budget_max        INTEGER,

  -- CRM state
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'assigned', 'in_process', 'converted', 'dead')),
  stage             TEXT NOT NULL DEFAULT 'new'
                    CHECK (stage IN ('new', 'contact_attempted', 'contacted', 'qualified',
                                     'site_visit_scheduled', 'site_visited', 'proposal',
                                     'negotiation', 'won', 'lost', 'nurture')),
  -- 0062: detail within the stage (LEAD_SUB_STATUSES in src/index.js) and,
  -- for 'lost', the required reason (LOST_REASONS; 'other' needs lost_note).
  sub_status        TEXT,
  lost_reason       TEXT,
  lost_note         TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- What kind of home the client is looking to buy. Kept distinct from a
  -- property's own construction state: a client can be interested in resale
  -- listings while the catalogue also contains new launches.
  client_status     TEXT CHECK (client_status IN ('prelaunch', 'eoi_phase', 'ready_to_move', 'resale', 'under_construction', 'nearing_possession')),
  -- Market research level (migration 0034). NULL = not ranked yet: portal and
  -- website leads arrive NULL; a lead must be ranked before it gets an owner.
  research_level    TEXT CHECK (research_level IS NULL OR research_level IN ('advanced', 'exploring', 'initial')),
  next_follow_up_at TEXT,
  assigned_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,

  -- The complete original payload, always. Portals add fields without warning
  -- and support questions are unanswerable once the original is gone.
  raw_payload       TEXT,
  -- 0064: full client requirement profile (JSON text); budget/type/location/client_status kept in sync
  requirement_profile TEXT,
  -- 0073: website two-step form answers
  purpose           TEXT,
  current_home      TEXT,
  whatsapp_opt_in   INTEGER CHECK (whatsapp_opt_in IS NULL OR whatsapp_opt_in IN (0, 1)),

  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Portals retry webhooks on timeout/5xx. Without this, one slow response
-- silently becomes two identical leads and two agents call the same customer.
-- Partial index so leads lacking a portal ID (manual entry) aren't constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_dedup
  ON leads (source, original_lead_id)
  WHERE original_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_load    ON leads (assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

-- Every assignment and transfer, forever. This is the audit trail; the `leads`
-- table only ever holds the CURRENT owner.
CREATE TABLE IF NOT EXISTS assignment_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id  TEXT,
  to_user_id    TEXT,
  from_team_id  TEXT,
  to_team_id    TEXT,
  -- 'auto:round_robin' | 'auto:least_loaded' | 'manual' | 'transfer'
  reason        TEXT NOT NULL,
  actor_user_id TEXT,                        -- NULL = the system did it
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_lead ON assignment_history (lead_id, created_at DESC);
-- Round-robin reads this to find who has waited longest for a lead.
CREATE INDEX IF NOT EXISTS idx_history_recipient ON assignment_history (to_user_id, id DESC);

-- A transfer only changes the owner after the proposed recipient accepts it.
CREATE TABLE IF NOT EXISTS lead_transfer_requests (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  responded_note  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_recipient ON lead_transfer_requests (to_user_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_one_pending
  ON lead_transfer_requests (lead_id) WHERE status = 'pending';

-- 0063: Pre-Sales → client team handovers. The lead keeps its owner until the
-- receiving team accepts and picks the relationship manager.
--   summary: JSON { requirement_confirmed, budget, area, timeline, decision_maker, notes }
--   thread:  JSON [{ kind: 'sent'|'question'|'answer'|'accepted'|'rejected', text, by_user_id, by_name, at }]
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_handover_one_open ON lead_handovers (lead_id) WHERE status IN ('pending', 'clarification');
CREATE INDEX IF NOT EXISTS idx_handover_to_team ON lead_handovers (to_team_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handover_from_user ON lead_handovers (from_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handover_from_team ON lead_handovers (from_team_id, created_at DESC);

-- Calls, notes, meetings and tasks cover the operational CRM work attached to
-- a lead. A task may carry a due date and be marked completed independently.
CREATE TABLE IF NOT EXISTS lead_activities (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_user_id   TEXT,
  type            TEXT NOT NULL CHECK (type IN ('note', 'call', 'meeting', 'task', 'email')),
  subject         TEXT NOT NULL,
  body            TEXT,
  due_at          TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON lead_activities (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage      TEXT,
  to_stage        TEXT NOT NULL,
  actor_user_id   TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sub_status      TEXT,                    -- 0062: detail chosen with this move
  lost_reason     TEXT                     -- 0062: reason, when to_stage = 'lost'
);
CREATE INDEX IF NOT EXISTS idx_stage_history_lead ON lead_stage_history (lead_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_leads_lost_reason ON leads (lost_reason) WHERE lost_reason IS NOT NULL;

-- Properties an agent has actually discussed with a customer, distinct from
-- the single project_name on the lead and from the algorithmic "matching
-- properties" suggestions. Backs the combined multi-property brochure PDF.
CREATE TABLE IF NOT EXISTS lead_discussed_properties (
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lead_id, property_id)
);

-- A builder/developer as its own record, not just a free-text name repeated
-- on every property. `locations` is a deduped, comma-separated list of every
-- area this builder has a property in — maintained automatically whenever a
-- property is added under them (see resolveBuilder() in src/index.js), and
-- editable directly for a builder you want to record before their first
-- property exists here.
CREATE TABLE IF NOT EXISTS builders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  locations  TEXT NOT NULL DEFAULT '',
  logo_r2_key TEXT,
  -- Track record (0045): all optional, NULL = not recorded.
  projects_delivered  INTEGER CHECK (projects_delivered IS NULL OR projects_delivered >= 0),
  possession_timeline TEXT,
  years_in_business   INTEGER CHECK (years_in_business IS NULL OR years_in_business >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builders_name ON builders (lower(name));

-- Active property inventory. Catalogue matches are suggestions for a lead;
-- they never overwrite the buyer's stated requirement.
CREATE TABLE IF NOT EXISTS properties (
  id            TEXT PRIMARY KEY,
  property_code TEXT,           -- 'P-00001', set by trigger assign_property_code (0061)
  name          TEXT NOT NULL,
  developer     TEXT,
  builder_id    TEXT REFERENCES builders(id) ON DELETE SET NULL,
  property_type TEXT,
  -- 'sell'/'rent'/'pg' and 'residential'/'commercial' are the two top-level
  -- choices that determine which sub-type pills make sense; property_type
  -- itself stays free text (the specific pill picked, e.g. "Flat/Apartment")
  -- so existing matching logic (canonicalPropertyType) keeps working unchanged.
  listing_type  TEXT NOT NULL DEFAULT 'sell' CHECK (listing_type IN ('sell', 'rent', 'pg')),
  category      TEXT NOT NULL DEFAULT 'residential' CHECK (category IN ('residential', 'commercial')),
  location      TEXT,
  locality      TEXT,
  sub_locality  TEXT,
  society_name  TEXT,
  tower_count   INTEGER CHECK (tower_count IS NULL OR tower_count > 0),
  house_no      TEXT,
  carpet_area_sqft INTEGER,
  bedroom_count    INTEGER,
  bathroom_count   INTEGER,
  balcony_count    INTEGER,
  total_floors     INTEGER,
  floor_number     INTEGER,
  age_of_property  TEXT CHECK (age_of_property IN ('0-1', '1-5', '5-10', '10+')),
  -- budget_min/max is the RANGE used for matching leads against a project.
  -- price_expected is a specific unit's asking price, for when this listing
  -- is one exact flat rather than a whole project with many configurations —
  -- both can be set; neither is required to set the other.
  price_expected     INTEGER,
  price_per_sqft     INTEGER,
  price_negotiable   INTEGER NOT NULL DEFAULT 0,
  price_all_inclusive INTEGER NOT NULL DEFAULT 0,
  budget_min    INTEGER,
  budget_max    INTEGER,
  bedrooms      TEXT,
  -- Whether this property is currently available for enquiries. Construction
  -- progress is recorded separately below, so this stays a clear Yes/No.
  availability  TEXT NOT NULL DEFAULT 'yes'
                CHECK (availability IN ('yes', 'no')),
  construction_status TEXT NOT NULL DEFAULT 'under_construction'
                CHECK (construction_status IN ('prelaunch', 'eoi_phase', 'new_launch', 'under_construction', 'nearing_possession', 'ready_to_move')),
  description   TEXT,
  -- A builder-hosted PDF or web brochure for this specific property. The
  -- Worker accepts only http(s) links before storing it.
  builder_brochure_url TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- Employees may manage the images for properties they have added, while
  -- catalogue administrators retain access to every entry.
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 'hunting' = full details recorded by the property hunting team for a
  -- property not yet ready to sell. Hidden from the client catalogue, lead
  -- matching, brochures and the public list; converting flips it to 'catalog'.
  pipeline      TEXT NOT NULL DEFAULT 'catalog' CHECK (pipeline IN ('catalog', 'hunting')),
  -- Who to call on the builder's side: sourcing manager (terms) and site head (visits).
  sourcing_manager_name  TEXT,
  sourcing_manager_phone TEXT,
  site_head_name         TEXT,
  site_head_phone        TEXT,
  -- Current property contacts (wizard step 1): Direct and Indirect, name + number.
  -- The sourcing manager / site head columns above are kept for older rows.
  direct_contact_name    TEXT,
  direct_contact_phone   TEXT,
  indirect_contact_name  TEXT,
  indirect_contact_phone TEXT,
  -- Facilities with no dedicated field (clubhouse, gym, pool, power backup…).
  amenities              TEXT,
  -- Expected completion 'YYYY-MM', only while under construction.
  completion_month       TEXT CHECK (completion_month IS NULL OR completion_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  -- EOI Phase only: launch date 'YYYY-MM-DD', land parcel (e.g. '5 acres'), commercial advantages.
  launch_date            TEXT CHECK (launch_date IS NULL OR launch_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  land_parcel_area       TEXT,
  commercial_advantages  TEXT,
  -- Rent only.
  furnishing             TEXT CHECK (furnishing IS NULL OR furnishing IN ('furnished', 'semi_furnished', 'unfurnished')),
  -- Sell only; resale also records age_of_property.
  sale_type              TEXT CHECK (sale_type IS NULL OR sale_type IN ('new', 'resale')),
  -- Available from 'YYYY-MM-DD' (any listing, optional).
  available_from         TEXT CHECK (available_from IS NULL OR available_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  -- Sell only: expected monthly rent in ₹ the property can earn (investor view).
  expected_rent          INTEGER,
  -- Rent only: security deposit and monthly maintenance in ₹, whether maintenance is 'included' or 'extra', lock-in in months (0059).
  security_deposit       INTEGER,
  maintenance_charges    INTEGER,
  maintenance_included   TEXT CHECK (maintenance_included IS NULL OR maintenance_included IN ('included', 'extra')),
  lock_in_months         INTEGER,
  -- Rent only: currently occupied by a tenant, 'yes' | 'no' (0049).
  occupied               TEXT CHECK (occupied IS NULL OR occupied IN ('yes', 'no')),
  -- Rent only: pets allowed, 'yes' | 'no' (0051).
  pet_friendly           TEXT CHECK (pet_friendly IS NULL OR pet_friendly IN ('yes', 'no')),
  -- Plots only (0058): area as typed + unit (sqft|sqyd|guntha|acre), dimensions ('30x60'), facing, road width (ft),
  -- corner / boundary wall / clear title ('yes'|'no'), land use (na|agricultural|residential|commercial|industrial).
  plot_area              TEXT,
  plot_area_unit         TEXT,
  plot_dimensions        TEXT,
  plot_facing            TEXT,
  plot_road_width        TEXT,
  plot_corner            TEXT,
  plot_boundary_wall     TEXT,
  plot_land_use          TEXT,
  plot_clear_title       TEXT,
  -- Brochure content, one point per line (like amenities): USPs and key growth drivers (0047).
  usps                   TEXT,
  key_growth             TEXT,
  -- Rent only: preferred tenants (0050).
  tenant_preference      TEXT CHECK (tenant_preference IS NULL OR tenant_preference IN ('families', 'bachelors', 'anyone')),
  -- 0066: inventory status flow (draft → pending_verification → active → on_hold / negotiation → sold / leased),
  -- the client team it is assigned to (assigning makes it active), and the Pune zone.
  inventory_status       TEXT NOT NULL DEFAULT 'active'
                         CHECK (inventory_status IN ('draft', 'pending_verification', 'active', 'on_hold', 'negotiation', 'sold', 'leased')),
  assigned_team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  zone                   TEXT CHECK (zone IS NULL OR zone IN ('west_pune', 'east_pune', 'north_pune', 'south_pune')),
  -- Reality report ratings, 0–5 (NULL = not rated); shown in the brochure.
  rating_locality        REAL CHECK (rating_locality IS NULL OR rating_locality BETWEEN 0 AND 5),
  rating_connectivity    REAL CHECK (rating_connectivity IS NULL OR rating_connectivity BETWEEN 0 AND 5),
  rating_appreciation    REAL CHECK (rating_appreciation IS NULL OR rating_appreciation BETWEEN 0 AND 5),
  rating_lifestyle       REAL CHECK (rating_lifestyle IS NULL OR rating_lifestyle BETWEEN 0 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_properties_builder ON properties (builder_id);
CREATE INDEX IF NOT EXISTS idx_properties_inventory ON properties (inventory_status, assigned_team_id); -- 0066
CREATE INDEX IF NOT EXISTS idx_properties_zone ON properties (zone); -- 0066

-- Photos live in R2 (binding IMAGES); this row is just the pointer + metadata
-- needed to serve and manage them. ON DELETE CASCADE means removing a
-- property drops its image rows too — the R2 objects themselves are cleaned
-- up in application code (handleDeleteProperty, if/when that exists) since
-- SQLite triggers can't reach out to R2.
CREATE TABLE IF NOT EXISTS property_images (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  title        TEXT,
  category     TEXT NOT NULL DEFAULT 'property' CHECK (category IN ('building', 'property')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_images_property ON property_images (property_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_properties_match ON properties (is_active, property_type, location, budget_min, budget_max);

-- Property hunting: the SUPPLY side of the brokerage. One row is one owner /
-- plot / project the hunting team is trying to bring on as new inventory.
-- A target that closes is converted into a real `properties` row through
-- POST /api/hunting-targets/:id/convert (never by editing the stage), and
-- converted_property_id then points at that catalogue entry.

CREATE TABLE IF NOT EXISTS hunting_targets (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  owner_name            TEXT,
  owner_phone           TEXT,
  owner_email           TEXT,
  property_type         TEXT,
  location              TEXT,
  locality              TEXT,
  asking_price          INTEGER,
  notes                 TEXT,
  source                TEXT,
  -- 'listed' and 'dropped' are terminal; everything else is still open.
  stage                 TEXT NOT NULL DEFAULT 'identified'
                        CHECK (stage IN ('identified', 'owner_contacted', 'site_visit_scheduled',
                                         'site_visited', 'documents_requested', 'terms_negotiated',
                                         'listed', 'dropped')),
  next_follow_up_at     TEXT,
  assigned_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id               TEXT REFERENCES teams(id) ON DELETE SET NULL,
  converted_property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  -- Full property details (a pipeline='hunting' properties row), if recorded.
  draft_property_id     TEXT REFERENCES properties(id) ON DELETE SET NULL,
  created_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- 0021: linked owner record (owner_name/phone/email above are the free-text fallback).
  owner_id              TEXT REFERENCES hunting_owners(id) ON DELETE SET NULL,
  -- 0022: commission & listing terms.
  commission_percent    REAL CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)),
  exclusive             INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1)),
  listing_valid_until   TEXT,
  terms_notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_owner    ON hunting_targets (owner_id);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_assignee ON hunting_targets (assigned_user_id, stage);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_team     ON hunting_targets (team_id, stage);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_updated  ON hunting_targets (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hunting_targets_follow_up ON hunting_targets (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

-- Calls, notes, meetings, tasks and emails logged against a hunting target.
-- Mirrors lead_activities.
CREATE TABLE IF NOT EXISTS hunting_target_activities (
  id                TEXT PRIMARY KEY,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  actor_user_id     TEXT,
  type              TEXT NOT NULL CHECK (type IN ('note', 'call', 'meeting', 'task', 'email')),
  subject           TEXT NOT NULL,
  body              TEXT,
  due_at            TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_activities_target ON hunting_target_activities (hunting_target_id, created_at DESC);

-- Every stage move of a hunting target, including the initial
-- NULL -> 'identified' row written on create. Mirrors lead_stage_history.
CREATE TABLE IF NOT EXISTS hunting_target_stage_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  from_stage        TEXT,
  to_stage          TEXT NOT NULL,
  actor_user_id     TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_stage_history_target ON hunting_target_stage_history (hunting_target_id, id DESC);

-- ---- Property hunting, wave 2 (migrations 0021–0024) ----

-- 0021: owner contact book. Shared contacts (any hunting reader can see
-- them); a target links to one through hunting_targets.owner_id.
CREATE TABLE IF NOT EXISTS hunting_owners (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  alt_phone          TEXT,
  email              TEXT,
  owner_type         TEXT NOT NULL DEFAULT 'individual'
                     CHECK (owner_type IN ('individual', 'builder', 'broker', 'other')),
  locality           TEXT,
  notes              TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_owners_updated ON hunting_owners (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hunting_owners_phone   ON hunting_owners (phone);

-- 0023: site-visit checklist (keys defined in HUNTING_SITE_VISIT_CHECKLIST).
CREATE TABLE IF NOT EXISTS hunting_site_visits (
  id                 TEXT PRIMARY KEY,
  hunting_target_id  TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  visited_by_user_id TEXT,
  visited_at         TEXT NOT NULL DEFAULT (datetime('now')),
  checklist          TEXT NOT NULL DEFAULT '{}',
  rating             INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  summary            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_site_visits_target ON hunting_site_visits (hunting_target_id, visited_at DESC);

-- 0024: document tracker, one row per (target, doc_type); missing = pending.
CREATE TABLE IF NOT EXISTS hunting_documents (
  hunting_target_id  TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  doc_type           TEXT NOT NULL CHECK (doc_type IN ('title_deed', 'rera', 'noc', 'encumbrance', 'tax_receipts', 'approved_plan', 'other')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'verified', 'not_applicable')),
  note               TEXT,
  updated_by_user_id TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hunting_target_id, doc_type)
);

-- 0024: site photos (same columns as property_images). Copied to a new R2 key
-- on convert, never shared with the catalogue property.
CREATE TABLE IF NOT EXISTS hunting_target_images (
  id                TEXT PRIMARY KEY,
  hunting_target_id TEXT NOT NULL REFERENCES hunting_targets(id) ON DELETE CASCADE,
  r2_key            TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  title             TEXT,
  category          TEXT NOT NULL DEFAULT 'property' CHECK (category IN ('building', 'property')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hunting_target_images_target ON hunting_target_images (hunting_target_id, sort_order, created_at);
-- ---- end Property hunting, wave 2 ----

-- Small, editable workspace identity shown throughout the browser UI.
CREATE TABLE IF NOT EXISTS workspace_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_assets (
  key          TEXT PRIMARY KEY,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Source-based and property-type-based routing in one table. A rule with NULL
-- in a match column means "any". The most specific matching rule wins, so a
-- catch-all and a narrow override coexist without ordering headaches.
CREATE TABLE IF NOT EXISTS routing_rules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 100,  -- lower runs first on ties
  match_source        TEXT,
  match_property_type TEXT,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  strategy            TEXT NOT NULL DEFAULT 'round_robin'
                      CHECK (strategy IN ('round_robin', 'least_loaded')),
  is_active           INTEGER NOT NULL DEFAULT 1
);

-- Retry claims and assignment are committed in the same D1 transaction.
CREATE TABLE IF NOT EXISTS intake_receipts (
  receipt TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_receipts_expiry ON intake_receipts(expires_at);

-- Auto-routing recommends the best eligible agent, but a manager decides who
-- actually receives the lead. The recommendation is kept separately from the
-- lead owner so a pending suggestion can never expose the lead to an agent or
-- make it look assigned before the manager has approved it.
CREATE TABLE IF NOT EXISTS assignment_approvals (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  recommended_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recommended_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  routing_strategy    TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'changed', 'cancelled')),
  reviewer_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  final_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_approvals_pending
  ON assignment_approvals (recommended_team_id, status, created_at);

-- Human-readable codes (migration 0061): L-00001 / P-00001, handed out by
-- AFTER INSERT triggers so every insert path gets one atomically.
CREATE TABLE IF NOT EXISTS id_counters (
  name TEXT PRIMARY KEY,         -- 'lead' | 'property'
  next INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO id_counters (name, next) VALUES ('lead', 1), ('property', 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_lead_code ON leads (lead_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_property_code ON properties (property_code);
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

CREATE TRIGGER IF NOT EXISTS assign_new_lead AFTER INSERT ON leads
WHEN NEW.assigned_user_id IS NULL AND NEW.team_id IS NULL
BEGIN
  UPDATE leads SET team_id = (
    SELECT team_id FROM routing_rules
    WHERE is_active = 1
      AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
      AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
    ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id
    LIMIT 1
  ) WHERE id = NEW.id;

  INSERT INTO assignment_approvals (
    id, lead_id, recommended_user_id, recommended_team_id, routing_strategy
  )
  SELECT
    lower(hex(randomblob(16))),
    l.id,
    (
      SELECT u.id FROM users u
      WHERE u.team_id = l.team_id
        -- role='agent' is the actual gate, not just accepts_leads: a manager
        -- can sit in a team for oversight without ever being recommended.
        AND u.role IN ('agent', 'sales_employee') AND u.is_active = 1 AND u.accepts_leads = 1
      ORDER BY
        CASE WHEN (
          SELECT strategy FROM routing_rules
          WHERE is_active = 1
            AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
            AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
          ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
        ) = 'least_loaded'
        THEN
          (SELECT COUNT(*) FROM leads open_leads WHERE open_leads.assigned_user_id = u.id AND open_leads.status IN ('new','assigned','in_process'))
          + (SELECT COUNT(*) FROM assignment_approvals pending WHERE pending.recommended_user_id = u.id AND pending.status = 'pending')
        ELSE COALESCE((SELECT MAX(id) FROM assignment_history WHERE to_user_id = u.id), 0)
        END,
        u.id
      LIMIT 1
    ),
    l.team_id,
    (
      SELECT strategy FROM routing_rules
      WHERE is_active = 1
        AND (match_source IS NULL OR lower(match_source) = lower(NEW.source))
        AND (match_property_type IS NULL OR lower(match_property_type) = lower(COALESCE(NEW.property_type, '')))
      ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC, priority, id LIMIT 1
    )
  FROM leads l
  WHERE l.id = NEW.id
    AND l.team_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.team_id = l.team_id AND u.role IN ('agent', 'sales_employee') AND u.is_active = 1 AND u.accepts_leads = 1
    );

  -- Keep an auditable record of the system's recommendation. This also keeps
  -- round-robin recommendations fair while earlier decisions are pending.
  INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason, note)
  SELECT lead_id, recommended_user_id, recommended_team_id,
         'auto:pending_manager_approval',
         'Suggested automatically; awaiting manager approval.'
    FROM assignment_approvals
   WHERE lead_id = NEW.id AND status = 'pending';

  -- A routed lead remains unassigned until the approval action below. Do not
  -- mark it assigned simply because there is a recommendation.
  UPDATE leads SET status = 'new' WHERE id = NEW.id;

  INSERT INTO assignment_history (lead_id, to_team_id, reason, note)
  SELECT id, team_id,
         CASE WHEN team_id IS NULL THEN 'unrouted' ELSE 'unassigned:no_eligible_user' END,
         CASE WHEN team_id IS NULL THEN 'No active routing rule matched.' ELSE 'No eligible agent is available.' END
    FROM leads
   WHERE id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM assignment_approvals WHERE lead_id = NEW.id);
END;

-- ---- Background jobs: digests + backups (Agent OPS, migrations 0026–0027) ----

-- Daily follow-up digests. One row per person per run, plus one company
-- roll-up row per run with user_id NULL. Pruned to 30 days by the job itself.
-- The email provider API key is a Worker secret, never stored here.
CREATE TABLE IF NOT EXISTS digests (
  id             TEXT PRIMARY KEY,
  run_at         TEXT NOT NULL DEFAULT (datetime('now')),
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  payload        TEXT NOT NULL,
  delivered_via  TEXT NOT NULL DEFAULT 'none' CHECK (delivered_via IN ('none', 'email')),
  delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_digests_user_run ON digests (user_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_digests_run_at   ON digests (run_at);

-- Nightly JSON backups. The dump lives in R2 (backups/crm-YYYY-MM-DD.json.gz);
-- this table records each run, including failures (status 'error').
CREATE TABLE IF NOT EXISTS backups (
  id           TEXT PRIMARY KEY,
  r2_key       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  bytes        INTEGER,
  table_counts TEXT,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_r2_key  ON backups (r2_key);
-- ---- end Agent OPS ----

-- The notification feed is built on the fly from the history tables above.
-- Only "what has this person already seen" is stored, for the unread badge.
-- user_id has no FK: the built-in super admin ('super-admin') is not a users row.
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id      TEXT PRIMARY KEY,
  last_read_at TEXT NOT NULL
);

-- A project is one builder development (usually a building) whose units the
-- builder has handed us to sell, while it is still in EOI or under
-- construction. Units are added in bulk: for a building, each flat records
-- its floor. Single ready properties stay in `properties`.

CREATE TABLE IF NOT EXISTS projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  developer              TEXT,
  builder_id             TEXT REFERENCES builders(id) ON DELETE SET NULL,
  kind                   TEXT NOT NULL DEFAULT 'building' CHECK (kind IN ('building', 'plots', 'villas', 'other')),
  construction_status    TEXT NOT NULL CHECK (construction_status IN ('eoi_phase', 'under_construction', 'nearing_possession', 'ready_to_move')),
  location               TEXT,
  locality               TEXT,
  total_floors           INTEGER CHECK (total_floors IS NULL OR total_floors > 0),
  possession_by          TEXT,
  description            TEXT,
  sourcing_manager_name  TEXT,
  sourcing_manager_phone TEXT,
  site_head_name         TEXT,
  site_head_phone        TEXT,
  created_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  -- 0040: builder-brief details. amenity_spaces / key_growth / usps are JSON arrays.
  launch_month           TEXT CHECK (launch_month IS NULL OR launch_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  sample_flat_ready      INTEGER CHECK (sample_flat_ready IS NULL OR sample_flat_ready IN (0, 1)),
  land_parcel_area       TEXT,
  tower_count            INTEGER CHECK (tower_count IS NULL OR tower_count > 0),
  flats_per_floor        INTEGER CHECK (flats_per_floor IS NULL OR flats_per_floor > 0),
  segment                TEXT CHECK (segment IS NULL OR segment IN ('luxury', 'affordable')),
  amenity_spaces         TEXT,
  key_growth             TEXT,
  usps                   TEXT,
  rera_registered        INTEGER CHECK (rera_registered IS NULL OR rera_registered IN (0, 1)),
  rera_number            TEXT,
  -- 0053: expected launch month ('YYYY-MM'), optional (any stage before completion)
  expected_launch        TEXT CHECK (expected_launch IS NULL OR expected_launch GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  -- 0056: pre- vs post-launch benefits table — JSON array of { benefit, pre, post }
  launch_benefits        TEXT,
  -- 0066: Pune zone (West / East / North / South), optional.
  zone                   TEXT CHECK (zone IS NULL OR zone IN ('west_pune', 'east_pune', 'north_pune', 'south_pune')),
  -- 0057: EOI phase only — year buyers get possession (year only)
  possession_year        INTEGER CHECK (possession_year IS NULL OR (possession_year >= 2000 AND possession_year <= 2100))
);

CREATE TABLE IF NOT EXISTS project_units (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wing             TEXT,
  floor_number     INTEGER,
  unit_no          TEXT,
  bedroom_count    INTEGER,
  carpet_area_sqft INTEGER,
  price_expected   INTEGER,
  status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'booked', 'sold')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units (project_id, floor_number, unit_no);

-- Configurations a project offers (migration 0042): one row per BHK category /
-- plan. payment_plans is a JSON array of 'construction_linked' |
-- 'one_time_down_payment' | 'bullet' as text.
CREATE TABLE IF NOT EXISTS project_configurations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bhk              TEXT NOT NULL,
  variant_name     TEXT,
  carpet_area_sqft INTEGER,
  balcony_count    INTEGER,
  price            INTEGER,
  payment_plans    TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_configurations_project ON project_configurations (project_id, sort_order);

-- Token types a project offers (migration 0055): booking / EOI token variants
-- with amount (rupees), refundable (1/0/NULL) and advantages (JSON array text).
CREATE TABLE IF NOT EXISTS project_tokens (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  refundable  INTEGER CHECK (refundable IS NULL OR refundable IN (0, 1)),
  advantages  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_tokens_project ON project_tokens (project_id, sort_order);

-- Brochures / documents attached to a project (migration 0041). The file
-- lives in R2 (env.IMAGES) under project-docs/<project_id>/<id>.
CREATE TABLE IF NOT EXISTS project_documents (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  r2_key             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents (project_id, created_at);

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

-- To-do tasks (Microsoft To Do style). A task belongs to the person who must
-- do it (assigned_to) and remembers who created/assigned it. Managers assign
-- within their team; admins and the super admin assign to anyone.
-- User ids are plain TEXT (no FK) because the super admin is not a users row.
CREATE TABLE IF NOT EXISTS task_lists (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT 'blue',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_lists_owner ON task_lists (owner_user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  notes               TEXT,
  steps               TEXT NOT NULL DEFAULT '[]',          -- JSON [{id,title,done}]
  due_date            TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  repeat              TEXT CHECK (repeat IS NULL OR repeat IN ('daily', 'weekdays', 'weekly', 'monthly')),
  important           INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  my_day_date         TEXT,                                -- local date it was added to My Day
  list_id             TEXT REFERENCES task_lists(id) ON DELETE SET NULL,
  lead_id             TEXT REFERENCES leads(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  completed_at        TEXT,
  completed_by_user_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  cleared_at          TEXT, -- 0046: assignee hid it via "Clear completed"
  escalated_at        TEXT, -- 0052: head told this task is delayed (once)
  escalated_to_user_id TEXT,
  escalated2_at       TEXT, -- 0052: second level (admin) after 3 days late
  escalated2_to_user_id TEXT,
  nudged_at           TEXT, -- 0052: head sent the assignee a reminder
  nudged_by_user_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_open_due ON tasks (due_date) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assigned_to_user_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator  ON tasks (created_by_user_id);

-- 0054: per-user favourites (heart on a property or project)
CREATE TABLE IF NOT EXISTS favourites (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('property', 'project')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_favourites_user ON favourites(user_id, kind);

-- 0048: keys of a property + custody history
CREATE TABLE IF NOT EXISTS property_keys (
  id                 TEXT PRIMARY KEY,
  property_id        TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('main_door', 'bedroom', 'balcony', 'other')),
  copies             INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'owner' CHECK (status IN ('owner', 'employee', 'deposited')),
  held_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  held_by_name       TEXT,   -- name of the employee holding it (kept as text so the super admin can hold keys too)
  taken_at           TEXT,
  deposit_place      TEXT,   -- e.g. "Office key box"
  deposited_by       TEXT,   -- name of who handed it in
  deposited_at       TEXT,
  notes              TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_keys_property ON property_keys (property_id, sort_order, created_at);

-- Custody history: one row per key change, shown in the manager notification feed.
CREATE TABLE IF NOT EXISTS property_key_events (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  key_id         TEXT,
  key_label      TEXT NOT NULL,
  action         TEXT NOT NULL,   -- added | removed | taken | handed | deposited | returned
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_key_events_property ON property_key_events (property_id, created_at);

-- ---- Document control (wave 3, H3 — migration 0069) ----
-- Versioned files on a transaction / NOC / lead / property / project, with a
-- review flow and a download log. Files: R2 env.IMAGES under `docs/`, served
-- only through the authenticated download endpoint. (project_documents above
-- is the separate brochure feature.)
CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  entity_type        TEXT NOT NULL CHECK (entity_type IN ('transaction', 'noc', 'lead', 'property', 'project')),
  entity_id          TEXT NOT NULL,
  doc_type           TEXT NOT NULL DEFAULT 'Other',
  title              TEXT NOT NULL,
  visibility         TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'legal', 'client')),
  review_status      TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected', 'signed')),
  current_version    INTEGER NOT NULL DEFAULT 1,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents (review_status, updated_at);

CREATE TABLE IF NOT EXISTS document_versions (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  r2_key             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  size               INTEGER NOT NULL,
  mime               TEXT NOT NULL,
  uploaded_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TEXT NOT NULL DEFAULT (datetime('now')),
  note               TEXT,
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS document_events (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,   -- created | new_version | submitted | approved | rejected | signed | edited | downloaded
  version            INTEGER,
  from_status        TEXT,
  to_status          TEXT,
  comment            TEXT,
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name          TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_document_events_doc ON document_events (document_id, created_at);
-- ---- end document control ----

-- ---- 0064 (wave 3, E): options shared with a client + property price history ----
CREATE TABLE IF NOT EXISTS lead_shortlist (
  id                 TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id        TEXT REFERENCES properties(id) ON DELETE CASCADE,
  project_id         TEXT REFERENCES projects(id) ON DELETE CASCADE,
  price_shared       INTEGER,
  shared_at          TEXT NOT NULL DEFAULT (datetime('now')),
  shared_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  response           TEXT NOT NULL DEFAULT 'no_reply'
                     CHECK (response IN ('interested', 'not_interested', 'visit_wanted', 'no_reply')),
  note               TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_shortlist_lead ON lead_shortlist (lead_id, shared_at);
CREATE INDEX IF NOT EXISTS idx_lead_shortlist_property ON lead_shortlist (property_id) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS property_price_history (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  field               TEXT NOT NULL CHECK (field IN ('price', 'availability', 'status')),
  old_value           TEXT,
  new_value           TEXT,
  changed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_price_history_property ON property_price_history (property_id, changed_at);

-- ---- Finance for transactions (0070, wave 3 H4) ----
-- Money in rupees (REAL, rounded to paise by the worker). Rows are never
-- hard-deleted: cancelled / reversed via status. transaction_id has no FK on
-- purpose (transactions is owned by 0067; the worker validates the id).
CREATE TABLE IF NOT EXISTS brokerage (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL UNIQUE,
  basis               TEXT NOT NULL DEFAULT 'percent',   -- 'percent' (of agreed price) | 'fixed'
  rate                REAL,
  fixed_amount        REAL,
  expected_amount     REAL NOT NULL DEFAULT 0,           -- ₹ before GST
  gst_note            TEXT,
  from_party          TEXT NOT NULL DEFAULT 'buyer',     -- 'buyer' | 'seller' | 'builder' | 'both'
  due_date            TEXT,
  status              TEXT NOT NULL DEFAULT 'expected',  -- 'expected' | 'cancelled'
  note                TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brokerage_due ON brokerage(due_date);

CREATE TABLE IF NOT EXISTS invoices (
  id                  TEXT PRIMARY KEY,
  invoice_no          TEXT NOT NULL UNIQUE,              -- INV-00001
  transaction_id      TEXT NOT NULL,
  billed_to           TEXT NOT NULL,
  amount              REAL NOT NULL,                     -- before tax
  tax_amount          REAL NOT NULL DEFAULT 0,
  total_amount        REAL NOT NULL,
  issue_date          TEXT NOT NULL,
  due_date            TEXT,
  status              TEXT NOT NULL DEFAULT 'draft',     -- 'draft' | 'sent' | 'partly_paid' | 'paid' | 'cancelled'
  note                TEXT,
  overdue_alerted_at  TEXT,
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  cancelled_by_user_id TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_txn ON invoices(transaction_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date);

CREATE TABLE IF NOT EXISTS receipts (
  id                  TEXT PRIMARY KEY,
  invoice_id          TEXT NOT NULL REFERENCES invoices(id),
  transaction_id      TEXT NOT NULL,
  amount              REAL NOT NULL,
  received_on         TEXT NOT NULL,
  mode                TEXT NOT NULL,                     -- 'cash' | 'cheque' | 'bank_transfer' | 'upi'
  reference           TEXT,
  proof_key           TEXT,                              -- R2 key, optional
  proof_content_type  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'reversed'
  reverse_reason      TEXT,
  reversed_at         TEXT,
  reversed_by_user_id TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_invoice ON receipts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_receipts_txn ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(received_on);

CREATE TABLE IF NOT EXISTS expenses (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT,
  category            TEXT NOT NULL,
  amount              REAL NOT NULL,
  spent_on            TEXT NOT NULL,
  paid_by             TEXT,
  note                TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'cancelled'
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_txn ON expenses(transaction_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_on);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL,
  partner_name        TEXT NOT NULL,
  partner_type        TEXT NOT NULL DEFAULT 'channel_partner', -- 'channel_partner' | 'sub_broker' | 'employee_incentive'
  share_basis         TEXT NOT NULL DEFAULT 'fixed',     -- 'percent' (of expected brokerage) | 'fixed'
  share_rate          REAL,
  amount              REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'paid' | 'cancelled'
  note                TEXT,
  approved_by_user_id TEXT,
  approved_at         TEXT,
  paid_on             TEXT,
  payment_reference   TEXT,
  cancel_reason       TEXT,
  cancelled_at        TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payouts_txn ON partner_payouts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON partner_payouts(status);
-- ---- end finance (0070) ----

-- ---- 0065 (wave 3, F): client site visits ----
CREATE TABLE IF NOT EXISTS site_visits (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id         TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  employee_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at        TEXT NOT NULL,
  confirmation        TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation IN ('pending', 'confirmed', 'cancelled')),
  attendance          TEXT NOT NULL DEFAULT 'scheduled' CHECK (attendance IN ('scheduled', 'completed', 'no_show')),
  liked               INTEGER CHECK (liked IS NULL OR liked IN (0, 1)),
  feedback            TEXT,
  objections          TEXT,
  next_step           TEXT,
  next_step_at        TEXT,
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_visits_lead ON site_visits (lead_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_when ON site_visits (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_employee ON site_visits (employee_user_id, scheduled_at);
-- ---- end 0065 ----

-- ---- 0067 bookings / transactions (wave3 H1) ----
-- Post-Sales core (wave 3, H1): token / booking, transactions, parties and the
-- transaction history log.
--
-- A booking is the token money a client pays to block a unit. It is NOT a
-- closure: the deal is only done when its transaction reaches 'closed'.
--   recipient: builder | owner | atlantic
--   status:    recorded | transaction_created | refunded | cancelled
-- Enum columns are validated in the worker (no CHECK lists), so later waves can
-- add values without a table rebuild.
CREATE TABLE IF NOT EXISTS bookings (
  id                    TEXT PRIMARY KEY,
  lead_id               TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id           TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
  unit_label            TEXT,            -- e.g. "Flat 1203, Tower B"
  amount                INTEGER NOT NULL,  -- rupees
  paid_on               TEXT,            -- YYYY-MM-DD
  payer_name            TEXT,
  recipient             TEXT,
  payment_reference     TEXT,            -- UTR / cheque no.
  refund_terms          TEXT,            -- refund / forfeiture terms
  receipt_r2_key        TEXT,            -- receipt photo in R2 (env.IMAGES)
  receipt_content_type  TEXT,
  note                  TEXT,
  status                TEXT NOT NULL DEFAULT 'recorded',
  status_note           TEXT,
  created_by_user_id    TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings (lead_id, created_at);

-- One deal from token to possession. txn_code like T-00001.
--   txn_type: resale | builder_sale | rental | commercial
--   stage:    token_received | documents | agreement | registration | possession | closed | cancelled
--   status:   open | closed | cancelled (follows the stage)
-- Milestones keep a target and an actual date each (YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS transactions (
  id                            TEXT PRIMARY KEY,
  txn_code                      TEXT NOT NULL,
  lead_id                       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  property_id                   TEXT REFERENCES properties(id) ON DELETE SET NULL,
  project_id                    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  booking_id                    TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  unit_label                    TEXT,
  txn_type                      TEXT NOT NULL DEFAULT 'resale',
  stage                         TEXT NOT NULL DEFAULT 'token_received',
  status                        TEXT NOT NULL DEFAULT 'open',
  agreed_price                  INTEGER,
  payment_schedule_note         TEXT,
  brokerage_note                TEXT,
  relationship_manager_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  coordinator_user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_mou_on                 TEXT,
  actual_mou_on                 TEXT,
  target_documents_on           TEXT,
  actual_documents_on           TEXT,
  target_agreement_on           TEXT,
  actual_agreement_on           TEXT,
  target_registration_on        TEXT,
  actual_registration_on        TEXT,
  target_possession_on          TEXT,
  actual_possession_on          TEXT,
  cancel_reason                 TEXT,
  stage_changed_at              TEXT,
  created_by_user_id            TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_code ON transactions (txn_code);
CREATE INDEX IF NOT EXISTS idx_transactions_lead ON transactions (lead_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stage ON transactions (stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_transactions_coordinator ON transactions (coordinator_user_id);

-- Everyone on the paperwork: several buyers, sellers, co-owners, legal heirs…
--   role: buyer | seller | co_owner | legal_heir | poa_holder | other
CREATE TABLE IF NOT EXISTS transaction_parties (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  note            TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_parties_txn ON transaction_parties (transaction_id, sort_order);

-- History shown in the transaction window: who changed what, when.
--   kind: created | stage | update | milestone | party
CREATE TABLE IF NOT EXISTS transaction_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  from_value      TEXT,
  to_value        TEXT,
  note            TEXT,
  actor_user_id   TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_events_txn ON transaction_events (transaction_id, id DESC);

-- ---- Post-Sales workstreams: NOCs + checklist (wave 3, H2 — migration 0068) ----
-- Enums validated in the worker (src/transaction_workstreams.js), no CHECK lists.
--   noc_type: society | builder | authority | bank | other
--   NOC status: not_assessed | not_started | documents_pending | ready_to_submit | submitted |
--               query_raised | resubmission_required | approved | rejected | not_applicable
--   checklist / log: JSON arrays. last_alerted_on = IST date of last overdue alert.
CREATE TABLE IF NOT EXISTS transaction_nocs (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  noc_type             TEXT NOT NULL DEFAULT 'society',
  type_label           TEXT,
  issuing_party        TEXT,
  coordinator_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  checklist            TEXT NOT NULL DEFAULT '[]',
  applied_on           TEXT,
  charges              INTEGER,
  payment_note         TEXT,
  status               TEXT NOT NULL DEFAULT 'not_assessed',
  target_date          TEXT,
  completed_on         TEXT,
  log                  TEXT NOT NULL DEFAULT '[]',
  evidence_note        TEXT,
  last_alerted_on      TEXT,
  created_by_user_id   TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_nocs_txn ON transaction_nocs (transaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transaction_nocs_open_target ON transaction_nocs (target_date)
  WHERE status NOT IN ('approved', 'not_applicable');
--   workstream: commercial | documents | mou | bank | legal | registration | possession | finance
--   task status: pending | in_progress | blocked | done | not_applicable
CREATE TABLE IF NOT EXISTS transaction_tasks (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  workstream           TEXT NOT NULL DEFAULT 'commercial',
  title                TEXT NOT NULL,
  owner_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date             TEXT,
  depends_on_task_id   TEXT REFERENCES transaction_tasks(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  blocked_reason       TEXT,
  evidence_note        TEXT,
  template_key         TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  completed_at         TEXT,
  last_alerted_on      TEXT,
  created_by_user_id   TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_txn ON transaction_tasks (transaction_id, workstream, sort_order);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_open_due ON transaction_tasks (due_date)
  WHERE status IN ('pending', 'in_progress', 'blocked');
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_owner ON transaction_tasks (owner_user_id);
-- ---- end Post-Sales workstreams ----

-- ---- alerts (wave3, migration 0071) ----
-- Alerts with importance (normal / medium / high). Raised by the system through
-- raiseAlert()/storeAlert() or sent by hand (POST /api/alerts, permission alert.send).
-- The audience is resolved to concrete people when the alert is created, one
-- alert_reads row per recipient (user_id is TEXT without a foreign key because
-- the built-in super administrator 'super-admin' is not a users row).
CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  importance      TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal', 'medium', 'high')),
  title           TEXT NOT NULL,
  body            TEXT,
  link_kind       TEXT,            -- lead | property | project | transaction | task
  link_id         TEXT,
  sender_user_id  TEXT,            -- NULL = system; 'super-admin' for the super administrator
  audience        TEXT NOT NULL DEFAULT '{}',  -- JSON of what was asked for: {userIds, teamId, roles, everyone}
  repeat_count    INTEGER NOT NULL DEFAULT 1,  -- identical system alerts within an hour are grouped
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts (title, link_kind, link_id, last_at);

CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id         TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  read_at          TEXT,
  acknowledged_at  TEXT,           -- high alerts stay on screen until acknowledged
  PRIMARY KEY (alert_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_reads_user ON alert_reads (user_id, read_at);

-- ---- password sign-in (migration 0072) ----
-- Email + password replaces the pasted sign-in codes. Only hashes are stored.
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

CREATE INDEX IF NOT EXISTS idx_properties_created_by_user
  ON properties (created_by_user_id);

-- 0074: budget rules ("this employee gets leads with this budget")
CREATE TABLE IF NOT EXISTS budget_rules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_min  INTEGER,
  budget_max  INTEGER,
  project     TEXT,
  priority    INTEGER NOT NULL DEFAULT 100,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_budget_rules_user ON budget_rules (user_id);
