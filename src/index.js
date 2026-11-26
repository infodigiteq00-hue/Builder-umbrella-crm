import { handleListTasks, handleCreateTask, handleUpdateTask, handleDeleteTask, handleClearCompletedTasks, handleTaskListWrite, handleTaskStats, handleTaskSummary, escalateDelayedTasks, delayedTasksForDigest } from './tasks.js';
import { handleAssistantChat, handleAssistantTranscribe, handleAssistantStatus } from './assistant.js';
import { setTaskAlertHook } from './tasks.js'; // alerts (wave3)
import { routeTransactionWorkstreams, alertOverdueWorkstreams } from './transaction_workstreams.js'; // NOCs + workstreams (wave3, H2)
import { routeTransactions } from './transactions.js'; // token / bookings + transactions core (wave3, H1)
/**
 * Real-Estate Lead CRM — Cloudflare Worker.
 *
 * Runs at the edge with no server to manage: portals POST leads straight here,
 * the payload is normalised inline, an assignment rule picks an owner, and the
 * whole thing lands in D1 in one transaction.
 *
 * Routes
 *   GET  /api/health                 — liveness, no auth
 *   POST /api/intake/:source         — portal webhook       (X-Intake-Token)
 *   GET  /api/dashboard              — "Today" stats + call list
 *   GET  /api/portal-links           — live 99acres/MagicBricks intake URLs (super_admin)
 *   GET  /api/leads                  — list leads
 *   GET  /api/analytics/leads        — aggregated counts for the insights dashboard
 *   GET  /api/analytics/supply-gap   — areas with buyer demand but little stock (NOT role-scoped)
 *   GET  /api/analytics/sources      — per-source funnel + conversion (role-scoped)
 *   GET  /api/analytics/lost-reasons — lost leads by reason (role-scoped)
 *        (all three take ?from=&to= and ?converted=1|0 — won-stage leads only / excluded)
 *   GET  /api/reports/employee/:id   — one employee's full-year appraisal report
 *   GET  /api/notifications          — manager/admin activity feed (filters, sort, unread count)
 *   POST /api/notifications/read     — mark the feed read up to now
 *   GET/POST /api/projects           — builder projects (EOI → ready to move in) with bulk-added units + BHK configurations
 *   POST /api/projects/:id/units     — add more units; PATCH/DELETE /api/projects/:id/units/:uid
 *   POST /api/projects/:id/documents — upload a brochure/document (multipart, field "file"); DELETE …/documents/:docId
 *   GET  /api/projects/:id/documents/:docId — open/download one (public, no auth — see handleServeProjectDocument)
 *   GET  /api/leads/:id              — lead + full history
 *   POST /api/leads/:id/assign       — reassign / transfer
 *   GET  /api/assignment-approvals   — pending automatic-routing decisions
 *   POST /api/assignment-approvals/:id/decide — manager approval / override
 *   GET  /api/users                  — users + live load
 *   GET/POST /api/teams              — list teams / create a custom team
 *   PATCH /api/teams/:id             — set or clear a team's manager
 *   GET  /api/rules                  — routing rules
 *   GET  /api/builders               — builder directory + locations
 *   POST /api/properties/:id/images  — upload a photo (multipart/form-data, field "file")
 *   GET  /api/images/:id             — serve a photo (public, no auth — see handleServeImage)
 *   GET/POST /api/hunting-targets    — list / add property-hunting targets (supply side)
 *   GET  /api/hunting-summary        — hunting pipeline counts (total, open, by stage, follow-ups due)
 *   GET  /api/hunting-properties     — the properties the hunting team has sourced (drafts + ones already listed), scoped like targets
 *   GET/PATCH /api/hunting-targets/:id — target + activities + stage history / edit, move stage, reassign
 *   POST /api/hunting-targets/:id/activities — log a call / note / meeting / task / email
 *   POST /api/hunting-targets/:id/convert    — turn a target into a catalogue property (stage → listed)
 *   GET/POST /api/hunting-owners             — owner contact book (shared contacts) / add an owner
 *   GET/PATCH /api/hunting-owners/:id        — owner + their (scoped) targets / edit
 *   GET  /api/hunting-meta                   — site-visit checklist, document types, owner types
 *   POST /api/hunting-targets/:id/site-visits — log a site visit (auto-advances early stages)
 *   PUT  /api/hunting-targets/:id/documents/:doc_type — set one document's status
 *   POST /api/hunting-targets/:id/images     — upload a site photo; DELETE …/images/:imageId
 *   GET  /api/hunting-images/:id             — serve a site photo (public, no auth — see handleServeHuntingImage)
 * All routes above /api/intake (except /api/images/:id, /api/hunting-images/:id and GET
 * /api/projects/:id/documents/:docId) require
 * Authorization: Bearer <session token> (from POST /api/auth/login with an email + password)
 */

const OPEN_STATUSES = ['new', 'assigned', 'in_process'];
const LEAD_STATUSES = ['new', 'assigned', 'in_process', 'converted', 'dead'];
const CLIENT_STATUSES = ['prelaunch', 'eoi_phase', 'ready_to_move', 'resale', 'under_construction', 'nearing_possession'];
// These are the sources an employee can select while entering a lead by hand.
// Portal webhooks remain free to identify their own source in handleIntake().
const MANUAL_LEAD_SOURCES = ['manual', 'referral', '99acres', 'magicbricks', 'meta_ads', 'other'];
const STAGES = ['new', 'contact_attempted', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visited', 'proposal', 'negotiation', 'won', 'lost', 'nurture'];
// ---- lead sub-status + lost reason (wave3 C, migration 0062) ----
// A short "detail" inside each stage. 'lost' has no pickable detail: its
// sub_status is derived from the lost reason's group ('invalid' = junk lead,
// 'dropped' = a real lead that didn't go ahead). Mirrored in public/index.html.
const LEAD_SUB_STATUSES = {
  new: ['unassigned', 'assigned', 'first_call_pending'],
  contact_attempted: ['no_answer', 'busy', 'switched_off', 'call_back_later'],
  contacted: ['connected', 'callback_requested', 'qualification_pending'],
  qualified: ['qualified', 'handover_requested'],
  site_visit_scheduled: ['visit_pending_confirmation', 'visit_confirmed', 'visit_rescheduled'],
  site_visited: ['visit_done', 'revisit_planned', 'feedback_pending'],
  proposal: ['offer_shared', 'awaiting_reply'],
  negotiation: ['price_discussion', 'token_pending', 'final_approval'],
  won: ['booked', 'won'],
  lost: ['invalid', 'dropped'],
  nurture: ['buying_later', 'arranging_funds', 'just_browsing'],
};
const LOST_REASONS = {
  invalid_number: 'invalid', duplicate: 'invalid', junk: 'invalid',
  not_interested: 'dropped', no_requirement: 'dropped', budget_mismatch: 'dropped',
  bought_elsewhere: 'dropped', unreachable: 'dropped', other: 'dropped',
};
const LOST_REASON_MESSAGE = 'Please choose why this lead is being closed — e.g. Not interested, Invalid number or Duplicate.';
// ---- end lead sub-status ----
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// How much market research the customer has done. NULL on a lead = not ranked
// yet (portal/website leads); a lead must be ranked before it gets an owner.
const RESEARCH_LEVELS = ['advanced', 'exploring', 'initial'];
const RESEARCH_LEVEL_MESSAGE = 'research_level is required: advanced (has explored the market), exploring (is exploring the market) or initial (has done no research).';
const CONSTRUCTION_STATUSES = ['prelaunch', 'eoi_phase', 'new_launch', 'under_construction', 'nearing_possession', 'ready_to_move'];
const PRE_COMPLETION_CONSTRUCTION_STATUSES = new Set(['prelaunch', 'eoi_phase', 'new_launch', 'under_construction', 'nearing_possession']);
const LISTING_TYPES = ['sell', 'rent', 'pg'];
const PROPERTY_CATEGORIES = ['residential', 'commercial'];
const PROPERTY_AGES = ['0-1', '1-5', '5-10', '10+'];

/** Positive integer from a wizard field, or null — never NaN into a bind(). */
function parseCount(value) {
  const n = parseInt(String(value ?? '').replace(/[\s,]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const DEFAULT_WORKSPACE_SETTINGS = {
  business_name: 'Atlantic Properties',
  workspace_name: 'Atlantic Properties',
  auto_assign_approval: 'off', // 'on' = a manager approves each automatic assignment; 'off' = the suggested person gets the lead straight away
  welcome_text: 'Keep every customer enquiry, property and follow-up in one clear place.',
  brochure_contact_name: '',
  brochure_contact_person: '',
  brochure_contact_phone: '9175080121',
  brochure_contact_whatsapp: '',
  brochure_contact_email: '',
  brochure_contact_website: '',
  brochure_contact_address: '',
  brochure_contact_rera: '',
  // Daily follow-up digest (Agent OPS). API key lives in the RESEND_API_KEY secret.
  digest_enabled: 'false',
  digest_email_provider: 'resend',
  digest_from_email: '',
  brochure_watermark_enabled: 'true',
  brochure_watermark_opacity: '0.08',
  brochure_watermark_position: 'center',
  brochure_logo_url: '/atlantic-properties-logo.png',
};
// Roles that work leads as employees: eligible for auto-assignment and budget rules.
const AGENT_ROLES = ['agent', 'sales_employee'];
const isAgentRole = (role) => AGENT_ROLES.includes(role);
const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin: ['lead.read_all', 'lead.create', 'lead.update_all', 'lead.assign_direct', 'activity.write', 'transfer.respond', 'team.read', 'routing.manage', 'lead.delete', 'catalog.manage',
    'hunting.read_all', 'hunting.create', 'hunting.update_all', 'hunting.assign',
    // wave 3 (0060)
    'handover.submit', 'handover.respond', 'inventory.assign', 'visit.write', 'transaction.read', 'transaction.write',
    'document.write', 'document.read_restricted', 'document.approve', 'finance.read', 'finance.write', 'alert.send', 'user.offboard'],
  // ---- wave 3 roles (0060) ----
  // Sales Head: the whole sales department — leads, clients, matching,
  // performance, targets and escalations.
  sales_head: ['lead.read_all', 'lead.create', 'lead.update_all', 'lead.assign_direct', 'activity.write', 'transfer.respond', 'team.read',
    'hunting.read_all', 'hunting.create', 'hunting.update_all', 'hunting.assign',
    'handover.submit', 'handover.respond', 'visit.write', 'transaction.read', 'document.write', 'finance.read', 'alert.send'],
  manager: ['lead.read_team', 'lead.create', 'lead.update_team', 'lead.assign_direct', 'activity.write', 'transfer.respond', 'team.read',
    'hunting.read_team', 'hunting.create', 'hunting.update_team', 'hunting.assign',
    'handover.submit', 'handover.respond', 'inventory.assign', 'visit.write', 'transaction.read', 'alert.send'],
  // Team Leader: own team's queues; reassigns only inside their own team.
  team_leader: ['lead.read_team', 'lead.create', 'lead.update_team', 'lead.assign_direct', 'activity.write', 'transfer.request', 'transfer.respond', 'team.read',
    'hunting.read_team', 'hunting.create', 'hunting.update_team',
    'handover.submit', 'handover.respond', 'visit.write', 'transaction.read', 'alert.send'],
  // Inventory Approver: properties, which team sells them, price/status.
  inventory_approver: ['team.read', 'catalog.create', 'catalog.manage', 'inventory.assign', 'hunting.read_all', 'document.write'],
  // Transaction Coordinator: deals after booking — NOCs, legal/bank tasks, documents.
  transaction_coordinator: ['lead.read_own', 'activity.write', 'team.read', 'handover.respond',
    'transaction.read', 'transaction.write', 'document.write', 'document.read_restricted'],
  // Legal: only the legal files of transactions; reviews and approves them.
  legal: ['team.read', 'transaction.read', 'document.write', 'document.read_restricted', 'document.approve'],
  // Finance: brokerage, invoices, receipts, expenses and payouts.
  finance: ['team.read', 'transaction.read', 'finance.read', 'finance.write', 'document.write'],
  // ---- end wave 3 roles ----
  // Employees can add their own walk-in leads but not catalogue entries:
  // new properties (and the builders named on them) come in only through
  // Property hunting — record the details there, then "Convert to listing".
  agent: ['lead.read_own', 'lead.create', 'lead.update_own', 'activity.write', 'transfer.request', 'transfer.respond', 'team.read',
    'hunting.read_own', 'hunting.create', 'hunting.update_own', 'handover.submit', 'visit.write'],
  viewer: ['lead.read_all', 'team.read', 'hunting.read_all', 'transaction.read'],
};
ROLE_PERMISSIONS.sales_employee = ROLE_PERMISSIONS.agent.filter((p) => p !== 'lead.create'); // like Employee, but cannot add leads by hand
// Roles that lead a team (team-scoped reassignment, team rollups).
const TEAM_HEAD_ROLES = ['manager', 'team_leader'];
const TEAM_VERTICALS = ['presales', 'client', 'hunting', 'postsales']; // teams.vertical (0060)

// Property hunting (supply side). 'listed' and 'dropped' are terminal; a
// target reaches 'listed' only through the convert endpoint.
const HUNTING_STAGES = ['identified', 'owner_contacted', 'site_visit_scheduled', 'site_visited', 'documents_requested', 'terms_negotiated', 'listed', 'dropped'];
const HUNTING_CLOSED_STAGES = ['listed', 'dropped'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (message, status = 400, extra = {}) => json({ error: message, ...extra }, status);

/**
 * Compare secrets without leaking length/prefix through timing. Workers has no
 * crypto.timingSafeEqual, so this is the hand-rolled equivalent.
 */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function parseOverrides(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function has(actor, permission) {
  if (actor.role === 'super_admin') return true;
  const override = parseOverrides(actor.permission_overrides);
  if (Array.isArray(override.deny) && override.deny.includes(permission)) return false;
  return (Array.isArray(override.allow) && override.allow.includes(permission)) ||
    (ROLE_PERMISSIONS[actor.role] || []).includes(permission);
}

function canCreateCatalog(actor) {
  return has(actor, 'catalog.create') || has(actor, 'catalog.manage');
}

/** Employees may manage photos only for catalogue entries they created. */
function canManagePropertyImages(actor, property) {
  return has(actor, 'catalog.manage') ||
    (has(actor, 'catalog.create') && property?.created_by_user_id === actor.id);
}

// ---- email + password sign-in ----
// People sign in with an email and a password. A successful sign-in creates a session: a random token goes to the
// browser, only its SHA-256 is kept (auth_sessions). Every request carries that token as "Authorization: Bearer …".
// The super administrator is its own account (app_admin, not a staff row) and keeps the special actor id 'super-admin'.
const SESSION_DAYS = 14;
const LOGIN_MAX_FAILS = 5;       // wrong passwords allowed…
const LOGIN_WINDOW_MIN = 15;     // …within this window, then…
const LOGIN_LOCK_MIN = 15;       // …sign-in for that email is paused this long
const PASSWORD_MIN = 8;
const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  return secretsMatch(await pbkdf2(String(password), fromHex(parts[2]), iterations), parts[3]);
}
// A fixed fake hash so an unknown email takes as long to answer as a wrong password.
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$00000000000000000000000000000000$${'0'.repeat(64)}`;
const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < PASSWORD_MIN ? `Use a password of at least ${PASSWORD_MIN} characters.` : pw.length > 200 ? 'That password is too long.' : null);
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sqlPlusMinutes = (m) => new Date(Date.now() + m * 60000).toISOString().replace('T', ' ').slice(0, 19);

async function authenticate(request, env) {
  const value = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!value) return null;
  const hash = await sha256(value);
  const sess = await env.DB.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?1').bind(hash).first();
  if (!sess) return null;
  if (sess.expires_at <= sqlNow()) { await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(hash).run(); return null; }
  let actor;
  if (sess.user_id === 'super-admin') {
    const admin = await env.DB.prepare('SELECT name, email FROM app_admin WHERE id = ?1').bind('super-admin').first();
    if (!admin) return null;
    actor = { id: 'super-admin', name: admin.name || 'Super administrator', email: admin.email, role: 'super_admin', permission_overrides: '{}', is_active: 1 };
  } else {
    actor = await env.DB.prepare('SELECT * FROM users WHERE id = ?1 AND is_active = 1').bind(sess.user_id).first();
    if (!actor) return null;
  }
  actor.session_hash = hash;
  // Touch at most once a few minutes so a busy screen does not write on every request.
  if (!actor.last_touch) env.DB.prepare("UPDATE auth_sessions SET last_seen_at = ?2 WHERE token_hash = ?1 AND (last_seen_at IS NULL OR last_seen_at < ?3)").bind(hash, sqlNow(), sqlPlusMinutes(-5)).run().catch(() => {});
  return actor;
}

/** Creates the super administrator's login the first time it is needed, from SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD_HASH (a hash, never the password). */
async function ensureSuperAdmin(env) {
  const row = await env.DB.prepare('SELECT id FROM app_admin LIMIT 1').first();
  if (row || !env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD_HASH) return;
  await env.DB.prepare('INSERT OR IGNORE INTO app_admin (id, email, name, password_hash) VALUES (\'super-admin\', ?1, \'Super administrator\', ?2)')
    .bind(String(env.SUPER_ADMIN_EMAIL).trim().toLowerCase(), String(env.SUPER_ADMIN_PASSWORD_HASH)).run();
}

async function startSession(env, userId) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?1').bind(sqlNow()),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(await sha256(token), userId, sqlPlusMinutes(SESSION_DAYS * 24 * 60)),
  ]);
  return token;
}

async function handleLogin(request, env) {
  const body = await bodyJson(request);
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 200);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) return fail('Enter your email and password.', 422);
  await ensureSuperAdmin(env);
  const attempt = await env.DB.prepare('SELECT fails, window_start, locked_until FROM login_attempts WHERE email = ?1').bind(email).first();
  if (attempt?.locked_until && attempt.locked_until > sqlNow()) return fail('Too many wrong passwords. Wait a few minutes and try again.', 429);

  let account = null; // { userId, hash }
  const admin = await env.DB.prepare('SELECT id, password_hash FROM app_admin WHERE email = ?1').bind(email).first();
  if (admin) account = { userId: 'super-admin', hash: admin.password_hash };
  else {
    const u = await env.DB.prepare('SELECT id, password_hash FROM users WHERE lower(email) = ?1 AND is_active = 1').bind(email).first();
    if (u?.password_hash) account = { userId: u.id, hash: u.password_hash };
  }
  const ok = await verifyPassword(password, account?.hash || DUMMY_HASH) && !!account;
  if (!ok) {
    const fresh = !attempt || attempt.window_start < sqlPlusMinutes(-LOGIN_WINDOW_MIN);
    const fails = fresh ? 1 : attempt.fails + 1;
    await env.DB.prepare(`INSERT INTO login_attempts (email, fails, window_start, locked_until) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(email) DO UPDATE SET fails = ?2, window_start = ?3, locked_until = ?4`)
      .bind(email, fails, fresh ? sqlNow() : attempt.window_start, fails >= LOGIN_MAX_FAILS ? sqlPlusMinutes(LOGIN_LOCK_MIN) : null).run();
    return fail('That email and password do not match.', 401);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ?1').bind(email).run();
  const token = await startSession(env, account.userId);
  return json({ ok: true, token });
}

async function handleLogout(env, actor) {
  if (actor.session_hash) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(actor.session_hash).run();
  return json({ ok: true });
}

/** Changes the signed-in person's own password. Other devices are signed out; this one stays. */
async function handleChangePassword(request, env, actor) {
  const body = await bodyJson(request);
  const problem = passwordProblem(body?.new_password);
  if (problem) return fail(problem, 422);
  const row = actor.id === 'super-admin'
    ? await env.DB.prepare('SELECT password_hash FROM app_admin WHERE id = ?1').bind('super-admin').first()
    : await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(actor.id).first();
  if (!await verifyPassword(String(body?.current_password || ''), row?.password_hash || DUMMY_HASH) || !row?.password_hash) return fail('Your current password is not right.', 422);
  const hash = await hashPassword(body.new_password);
  await env.DB.batch([
    actor.id === 'super-admin'
      ? env.DB.prepare("UPDATE app_admin SET password_hash = ?1, updated_at = datetime('now') WHERE id = 'super-admin'").bind(hash)
      : env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(hash, actor.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND token_hash != ?2').bind(actor.id, actor.session_hash || ''),
  ]);
  return json({ ok: true, message: 'Password changed. Other devices were signed out.' });
}

/** An administrator sets a new password for someone (they are signed out everywhere). */
async function handleSetUserPassword(request, env, userId, actor) {
  if (!has(actor, 'user.manage')) return fail('Only a super administrator can set a password for someone else.', 403);
  const body = await bodyJson(request);
  const problem = passwordProblem(body?.password);
  if (problem) return fail(problem, 422);
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first();
  if (!user) return fail('Employee not found.', 404);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(await hashPassword(body.password), userId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(userId),
  ]);
  return json({ ok: true, message: 'New password set. They are signed out on every device.' });
}

function canReadLead(actor, lead) {
  return has(actor, 'lead.read_all') ||
    (has(actor, 'lead.read_own') && lead.assigned_user_id === actor.id) ||
    (has(actor, 'lead.read_team') && actor.team_id && lead.team_id === actor.team_id);
}

function canUpdateLead(actor, lead) {
  return has(actor, 'lead.update_all') ||
    (has(actor, 'lead.update_own') && lead.assigned_user_id === actor.id) ||
    (has(actor, 'lead.update_team') && actor.team_id && lead.team_id === actor.team_id);
}

function canReadHuntingTarget(actor, target) {
  return has(actor, 'hunting.read_all') ||
    (has(actor, 'hunting.read_own') && target.assigned_user_id === actor.id) ||
    (has(actor, 'hunting.read_team') && actor.team_id && target.team_id === actor.team_id);
}

function canUpdateHuntingTarget(actor, target) {
  return has(actor, 'hunting.update_all') ||
    (has(actor, 'hunting.update_own') && target.assigned_user_id === actor.id) ||
    (has(actor, 'hunting.update_team') && actor.team_id && target.team_id === actor.team_id);
}

/** Managers approve only recommendations for their own team; administrators
 * and the super administrator can cover every team. */
function canReviewAutoAssignment(actor, approval) {
  return has(actor, 'lead.assign_direct') && (
    has(actor, 'lead.read_all') ||
    (has(actor, 'lead.read_team') && actor.team_id && actor.team_id === approval.recommended_team_id)
  );
}

// ---------------------------------------------------------------------------
// Payload normalisation
//
// This is the piece that would otherwise be a separate always-on "adapter"
// service. Portals send wildly different key names and neither publishes a
// stable public schema, so accept every spelling we've seen and keep the
// original payload verbatim for anything we failed to map.
// ---------------------------------------------------------------------------

/** First non-empty value among the given keys, case-insensitively. */
function pick(obj, ...keys) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  for (const key of keys) {
    const v = lower[key.toLowerCase()];
    if (['string', 'number'].includes(typeof v) && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Budgets arrive as "6500000", "65 Lakh", "1.2 Cr", "65,00,000" or a range.
 * Indian portals overwhelmingly use lakh/crore, so parse those explicitly
 * rather than silently storing a number that is 100x wrong.
 */
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);

  const raw = String(value).toLowerCase().replace(/,/g, '').trim();
  const num = parseFloat(raw.match(/[\d.]+/)?.[0] ?? '');
  if (!Number.isFinite(num)) return null;

  // No LEADING \b: digits and letters are both "word" characters, so a very
  // common real-world format like "45L" or "1.4Cr" (no space before the
  // unit) has no boundary between the number and the unit letter and would
  // never match if one were required here. The TRAILING \b still guards
  // against matching inside an unrelated longer word.
  if (/(cr|crore)\b/.test(raw)) return Math.round(num * 10_000_000);
  if (/(l|lac|lakh|lakhs)\b/.test(raw)) return Math.round(num * 100_000);
  if (/k\b/.test(raw)) return Math.round(num * 1_000);
  return Math.round(num);
}

function canonicalPropertyType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/\bplots?\b|\bland\b/.test(text)) return 'plot'; // "Plot/Land", "Commercial Land", "Villa plot" are all plots
  if (/apartment|flat|condo/.test(text)) return 'apartment';
  if (/villa|bungalow|row.?house/.test(text)) return 'villa';
  if (/plot|land|site\b/.test(text)) return 'plot';
  if (/office|workspace/.test(text)) return 'office';
  if (/commercial|retail|shop|showroom/.test(text)) return 'commercial';
  return text.replace(/s$/, '');
}

function propertyTypeTerms(value) {
  const type = canonicalPropertyType(value);
  return {
    apartment: ['apartment', 'flat', 'condo'],
    villa: ['villa', 'bungalow', 'row house'],
    plot: ['plot', 'land', 'site'],
    office: ['office', 'workspace'],
    commercial: ['commercial', 'retail', 'shop', 'showroom'],
  }[type] || (type ? [type] : []);
}

// ---------------------------------------------------------------------------
// Lead analytics — canonicalisation helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalise a lead's free-text `property_type` for the analytics
 * dashboard's "type of lead" breakdown. This is deliberately a SEPARATE
 * grouping from canonicalPropertyType() above: that one is for matching a
 * lead's interest against the property catalogue and intentionally folds
 * "Shop" into the same "commercial" bucket as offices/showrooms, with no
 * concept of BHK count. The dashboard needs both of those called out on
 * their own — "Shop" and "2/3 BHK" were the concrete examples asked for —
 * so this keeps its own display-oriented mapping rather than overloading
 * the matching one.
 */
function canonicalLeadPropertyType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'Unspecified';
  const bhk = text.match(/(\d+)\s*-?\s*bhk/);
  if (bhk) return `${bhk[1]} BHK`;
  if (/shop|showroom|retail\b/.test(text)) return 'Shop';
  if (/office|workspace/.test(text)) return 'Office';
  if (/villa|bungalow|row.?house/.test(text)) return 'Villa';
  if (/plot|land|site\b/.test(text)) return 'Plot / Land';
  if (/apartment|flat|condo/.test(text)) return 'Apartment';
  if (/commercial/.test(text)) return 'Commercial';
  // Title-case whatever is left instead of dumping it into an opaque
  // "other" bucket the reader can't act on — portal free text is varied
  // but usually already a short, presentable phrase (e.g. "Studio").
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Best-available proxy for "is this a rental enquiry?" — leads have no
 * rent/sale flag of their own (that only lives on properties.listing_type,
 * and a lead may not even be matched to a property yet). Every pick() key
 * in normaliseLead() and every seeded raw_payload blob were checked and
 * none carries a purpose/listing-type field from any portal observed so
 * far. property_type is the only per-lead free-text field describing
 * intent, so treat "rent"/"rental"/"lease"/"PG" appearing there (word-
 * bounded, so "apartment" can't match "rent") as a rental enquiry. This is
 * an inferred judgment call, not a documented field — revisit if intake
 * ever gains a real purpose/listing_type field.
 */
function isRentalLeadType(rawPropertyType) {
  return /\b(rent|rental|lease|pg)\b/i.test(String(rawPropertyType || ''));
}

// Budget bucket edges (in rupees) for the analytics dashboard. Kept in one
// place so the SQL CASE expression in handleLeadAnalytics and the label map
// below can't drift apart — if you change a boundary here, update the SQL.
const ANALYTICS_BUDGET_BUCKETS = [
  { key: 'lt_25l', label: 'Under 25L' },
  { key: '25_50l', label: '25L – 50L' },
  { key: '50_75l', label: '50L – 75L' },
  { key: '75l_1cr', label: '75L – 1Cr' },
  { key: '1_1.5cr', label: '1Cr – 1.5Cr' },
  { key: '1.5_2cr', label: '1.5Cr – 2Cr' },
  { key: '2cr_plus', label: '2Cr and above' },
  { key: 'unknown', label: 'Not specified' },
];

/** "65-85 Lakh" / "6500000 to 8500000" → {min, max}. */
function parseBudget(payload) {
  const min = parseMoney(pick(payload, 'budget_min', 'budgetMin', 'min_budget', 'minBudget', 'price_min', 'priceMin'));
  const max = parseMoney(pick(payload, 'budget_max', 'budgetMax', 'max_budget', 'maxBudget', 'price_max', 'priceMax'));
  if (min !== null || max !== null) return { min, max };

  const single = pick(payload, 'budget', 'price', 'budget_range', 'budgetRange', 'priceRange');
  if (single === null) return { min: null, max: null };

  const parts = String(single).split(/\s*(?:-|–|to)\s*/i).filter(Boolean);
  if (parts.length >= 2) {
    // "65 - 85 Lakh": the unit trails the second number, so re-attach it to
    // the first, otherwise 65 parses as 65 rupees.
    const unit = String(single).match(/(cr|crore|lac|lakhs?|k)\b/i)?.[0] ?? '';
    const lo = parseMoney(/[a-z]/i.test(parts[0]) ? parts[0] : `${parts[0]} ${unit}`);
    const hi = parseMoney(parts[1]);
    return { min: lo, max: hi };
  }
  const only = parseMoney(single);
  return { min: only, max: only };
}

function normaliseLead(payload, source, codeMap = {}) {
  const first = pick(payload, 'first_name', 'firstName', 'fname');
  const last = pick(payload, 'last_name', 'lastName', 'lname');
  const name =
    pick(payload, 'name', 'full_name', 'fullName', 'customer_name', 'customerName', 'sender_name', 'senderName', 'contact_name') ??
    [first, last].filter(Boolean).join(' ') ??
    null;

  const budget = parseBudget(payload);

  return {
    source,
    original_lead_id: pick(payload, 'lead_id', 'leadId', 'enquiry_id', 'enquiryId', 'query_id', 'queryId', 'id'),
    portal_created_at: pick(payload, 'created_at', 'createdAt', 'lead_date', 'leadDate', 'enquiry_date', 'date', 'timestamp'),
    customer_name: name || null,
    phone: pick(payload, 'phone', 'mobile', 'phone_number', 'phoneNumber', 'mobile_number', 'mobileNumber', 'contact', 'sender_phone', 'senderPhone'),
    email: pick(payload, 'email', 'email_id', 'emailId', 'email_address', 'emailAddress', 'sender_email', 'senderEmail'),
    project_name: pick(payload, 'project', 'project_name', 'projectName', 'property_name', 'propertyName', 'listing_title', 'listingTitle', 'title'),
    property_type: pick(payload, 'property_type', 'propertyType', 'prop_type', 'propType', 'type', 'category') ?? codeMap[pick(payload, 'Property_Code', 'propertyCode')] ?? null,
    location: pick(payload, 'city', 'location', 'locality', 'area', 'address', 'region'),
    budget_min: budget.min,
    budget_max: budget.max,
  };
}

/**
 * Read the lead payload regardless of how the portal chose to send it.
 *
 * These portal dashboards typically give you one text box for a URL and no
 * control over method, content-type or headers. Observed in the wild:
 * MagicBricks delivers leads as URL query parameters, 99acres posts a body.
 * So accept all three transports and merge them — query string first, body
 * wins on conflict.
 */
async function readPayload(request) {
  const url = new URL(request.url);
  const payload = {};

  for (const [k, v] of url.searchParams) {
    if (k !== 'token') payload[k] = v; // never treat the secret as lead data
  }

  if (request.method === 'GET') return payload;

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new SyntaxError('Payload exceeds 64 KiB'); }
      chunks.push(value);
    }
  }
  const raw = await new Blob(chunks).text();
  if (!raw.trim()) return payload;

  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(raw); // caller turns a throw into a 400
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError('JSON body must be an object.');
    }
    return { ...payload, ...parsed };
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { ...payload, ...Object.fromEntries(new URLSearchParams(raw)) };
  }

  // Unlabelled or wrongly-labelled body — common from portal senders. Try JSON,
  // then form encoding, before giving up.
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ...payload, ...parsed };
    }
  } catch {
    /* fall through to form parsing */
  }
  return { ...payload, ...Object.fromEntries(new URLSearchParams(raw)) };
}

async function handleIntake(request, env, source) {
  const expected = env[`INTAKE_TOKEN_${source.toUpperCase().replace(/[^A-Z0-9]/g, '')}`];
  if (!expected) return fail(`No intake token configured for source '${source}'.`, 404);

  // Header is preferred, but portals that only accept a bare URL can't set
  // one — so ?token= is supported as an equal alternative. It is a shared
  // secret in a URL either way; rotate it with `wrangler secret put` if the
  // portal-side config ever leaks.
  const provided =
    request.headers.get('x-intake-token') ?? new URL(request.url).searchParams.get('token') ?? '';
  if (!secretsMatch(provided, expected)) {
    return fail('Invalid or missing intake token (X-Intake-Token header or ?token=).', 401);
  }

  let payload;
  try {
    payload = await readPayload(request);
  } catch {
    return fail('Could not parse request body as JSON or form data.', 400);
  }

  if (Object.keys(payload).length === 0) {
    return fail('No lead data found in query string or body.', 400);
  }

  for (const name of Object.keys(payload)) {
    if (['token', 'authorization', 'apikey'].includes(name.toLowerCase().replace(/[^a-z]/g, ''))) delete payload[name];
  }
  const lead = normaliseLead(payload, source, env.PROPERTY_CODE_MAP ?? {});

  // A lead with no way to contact the customer is not a lead. Reject loudly so
  // the integration gets fixed rather than accumulating unusable rows.
  if (!lead.phone && !lead.email) {
    return fail('Lead must contain at least a phone number or an email address.', 422, {
      hint: 'Checked keys: phone/mobile/phone_number/contact and email/email_id/email_address.',
      received_keys: Object.keys(payload),
    });
  }

  // Exact-fingerprint dedup below only catches a BYTE-IDENTICAL retry. Portals
  // that send no lead ID (99acres, per its documented payload) aren't
  // guaranteed to retry with an identical body — a re-stamped timestamp or an
  // edited Remarks field produces a different fingerprint and would otherwise
  // sail through as a "new" lead, handing the same customer to two agents.
  // This time-window fallback catches that: same source + same contact within
  // a short window is treated as a retry regardless of what else changed.
  if (!lead.original_lead_id) {
    const contact = lead.phone ?? lead.email;
    const column = lead.phone ? 'phone' : 'email';
    const recent = await env.DB.prepare(
      `SELECT id FROM leads
        WHERE source = ?1
          AND ${column} = ?2
          AND COALESCE(project_name, '') = COALESCE(?3, '')
          AND created_at > datetime('now', '-10 minutes')
        LIMIT 1`
    )
      .bind(lead.source, contact, lead.project_name)
      .first();

    if (recent) {
      return json({
        ok: true,
        duplicate: true,
        lead_id: recent.id,
        message: 'Matching lead received in the last 10 minutes; treated as a retry.',
      });
    }
  }

  const canonical = JSON.stringify(Object.keys(payload).sort().map(key => [key, payload[key]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source + ':' + canonical));
  const receipt = lead.original_lead_id
    ? source + ':id:' + lead.original_lead_id
    : source + ':payload:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();

  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM intake_receipts WHERE receipt = ?1 AND expires_at < unixepoch()').bind(receipt),
      env.DB.prepare('INSERT INTO intake_receipts (receipt, lead_id, expires_at) VALUES (?1, ?2, ?3)')
        .bind(receipt, id, lead.original_lead_id ? null : Math.floor(Date.now() / 1000) + 86400),
      env.DB.prepare(
        `INSERT INTO leads (
           id, source, original_lead_id, portal_created_at,
           customer_name, phone, email,
           project_name, property_type, location, budget_min, budget_max,
           status, assigned_user_id, team_id, raw_payload
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
      ).bind(
        id, lead.source, lead.original_lead_id, lead.portal_created_at,
        lead.customer_name, lead.phone, lead.email,
        lead.project_name, lead.property_type, lead.location, lead.budget_min, lead.budget_max,
        'new', null, null, JSON.stringify(payload)
      ),
    ]);
  } catch (e) {
    // The dedup index firing means the portal re-delivered a lead we already
    // have. That is success from its point of view — return 200 so it stops
    // retrying, but say plainly that nothing new was created.
    if (String(e?.message ?? e).includes('UNIQUE constraint failed')) {
      const existing = await env.DB.prepare('SELECT lead_id FROM intake_receipts WHERE receipt = ?1').bind(receipt).first();
      return json({ ok: true, duplicate: true, lead_id: existing?.lead_id, message: 'Lead already recorded; ignored.' });
    }
    throw e;
  }

  await applyBudgetRule(env, id).catch((e) => console.error('budget rule failed', e));
  await autoApprovePending(env, id).catch((e) => console.error('auto-assign failed', e));
  const saved = await env.DB.prepare('SELECT assigned_user_id, team_id FROM leads WHERE id = ?1').bind(id).first();
  return json({ ok: true, lead_id: id, ...saved });
}

// ---- Manager approval for automatic assignment can be switched off (Auto-assign page, setting auto_assign_approval) ----
// When it is off, a suggested person is given the lead straight away: the pending approval is closed as approved by the system.
async function approvalRequired(env) {
  const row = await env.DB.prepare("SELECT value FROM workspace_settings WHERE key = 'auto_assign_approval'").first().catch(() => null);
  return (row?.value ?? DEFAULT_WORKSPACE_SETTINGS.auto_assign_approval) === 'on';
}
async function autoApprovePending(env, leadId = null) {
  if (await approvalRequired(env)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.lead_id, a.recommended_user_id, u.team_id AS user_team_id
       FROM assignment_approvals a JOIN users u ON u.id = a.recommended_user_id AND u.is_active = 1
       JOIN leads l ON l.id = a.lead_id AND l.assigned_user_id IS NULL
      WHERE a.status = 'pending' ${leadId ? 'AND a.lead_id = ?1' : ''} LIMIT 500`
  ).bind(...(leadId ? [leadId] : [])).all();
  let done = 0;
  for (const a of results ?? []) {
    const closed = await env.DB.prepare("UPDATE assignment_approvals SET status = 'approved', final_user_id = ?2, note = 'Automatic: manager approval is switched off', reviewed_at = datetime('now') WHERE id = ?1 AND status = 'pending'").bind(a.id, a.recommended_user_id).run();
    if (!closed.meta.changes) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET assigned_user_id = ?2, team_id = COALESCE(?3, team_id), status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END WHERE id = ?1 AND assigned_user_id IS NULL").bind(a.lead_id, a.recommended_user_id, a.user_team_id),
      env.DB.prepare("INSERT INTO assignment_history (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, note) VALUES (?1, NULL, ?2, ?3, ?3, 'auto:assigned', 'Assigned automatically (manager approval is switched off).')").bind(a.lead_id, a.recommended_user_id, a.user_team_id),
    ]);
    done++;
  }
  return done;
}

// ---- Budget rules: "this employee gets leads with this budget" ----
// Runs after a lead is created and after a website step-2 update brings its budget. It only ever suggests: the named
// employee becomes the recommended owner in the manager-approval queue. It never touches a lead that already has an
// owner, or whose approval a manager has already decided.
// The lead's lower bound; a lead with only an upper limit ("Under Rs 2 Cr") counts as starting at 0; no budget at all = null.
const leadBudgetFloor = (l) => (l.budget_min ?? (l.budget_max !== null && l.budget_max !== undefined ? 0 : null));
async function applyBudgetRule(env, leadId) {
  const lead = await env.DB.prepare('SELECT id, source, project_name, budget_min, budget_max, assigned_user_id, team_id FROM leads WHERE id = ?1').bind(leadId).first();
  if (!lead || lead.assigned_user_id) return null;
  const floor = leadBudgetFloor(lead);
  // A lead with no budget only matches an "any budget" rule (both limits empty, project set).
  const { results } = await env.DB.prepare(
    `SELECT r.*, u.team_id AS user_team_id, u.name AS user_name FROM budget_rules r JOIN users u ON u.id = r.user_id
      WHERE r.is_active = 1 AND u.is_active = 1 AND u.accepts_leads = 1 AND u.role IN ('agent', 'sales_employee') AND u.team_id IS NOT NULL
      ORDER BY r.priority, r.created_at`
  ).all();
  const proj = String(lead.project_name || '').trim().toLowerCase();
  const anyBudget = (r) => r.budget_min === null && r.budget_max === null;
  // specific budget ranges first; "any budget" rules last, so they only catch what no range claimed
  const ordered = [...(results ?? [])].sort((x, y) => Number(anyBudget(x)) - Number(anyBudget(y)));
  const rule = ordered.find((r) =>
    (floor === null ? anyBudget(r) : ((r.budget_min === null || floor >= r.budget_min) && (r.budget_max === null || floor < r.budget_max))) &&
    (!r.project || r.project.trim().toLowerCase() === proj));
  if (!rule) return null;
  const approval = await env.DB.prepare('SELECT id, status, recommended_user_id FROM assignment_approvals WHERE lead_id = ?1').bind(leadId).first();
  if (approval && approval.status !== 'pending') return null; // a manager already decided
  const note = 'Budget rule: ' + rule.user_name;
  if (approval) {
    if (approval.recommended_user_id === rule.user_id) return rule.user_id;
    await env.DB.batch([
      env.DB.prepare("UPDATE assignment_approvals SET recommended_user_id = ?2, recommended_team_id = ?3, routing_strategy = 'budget_rule' WHERE id = ?1 AND status = 'pending'").bind(approval.id, rule.user_id, rule.user_team_id),
      env.DB.prepare('UPDATE leads SET team_id = ?2 WHERE id = ?1 AND assigned_user_id IS NULL').bind(leadId, rule.user_team_id),
      env.DB.prepare("INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason, note) VALUES (?1, ?2, ?3, 'auto:budget_rule', ?4)").bind(leadId, rule.user_id, rule.user_team_id, note + ' (suggested; awaiting manager approval)'),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('UPDATE leads SET team_id = ?2 WHERE id = ?1 AND assigned_user_id IS NULL').bind(leadId, rule.user_team_id),
      env.DB.prepare("INSERT INTO assignment_approvals (id, lead_id, recommended_user_id, recommended_team_id, routing_strategy) VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'budget_rule')").bind(leadId, rule.user_id, rule.user_team_id),
      env.DB.prepare("INSERT INTO assignment_history (lead_id, to_user_id, to_team_id, reason, note) VALUES (?1, ?2, ?3, 'auto:pending_manager_approval', ?4)").bind(leadId, rule.user_id, rule.user_team_id, note + ' (suggested; awaiting manager approval)'),
    ]);
  }
  return rule.user_id;
}

const BUDGET_RULE_SELECT = `SELECT r.*, u.name AS user_name, u.team_id AS user_team_id, t.name AS team_name
  FROM budget_rules r JOIN users u ON u.id = r.user_id LEFT JOIN teams t ON t.id = u.team_id`;
async function handleListBudgetRules(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view routing rules.', 403);
  const { results } = await env.DB.prepare(`${BUDGET_RULE_SELECT} ORDER BY r.priority, r.created_at`).all();
  return json({ rules: results ?? [] });
}
async function budgetRuleFields(request, env) {
  const body = await bodyJson(request);
  if (!body) return { error: fail('JSON object required.', 400) };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const min = num(body.budget_min), max = num(body.budget_max);
  if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0))) return { error: fail('Budget amounts must be positive numbers (in rupees).', 422) };
  const projectGiven = typeof body.project === 'string' && body.project.trim();
  if (min === null && max === null && !projectGiven) return { error: fail('Enter a budget from, a budget to, or both. (Leave both empty only when you pick a project: it then means any budget.)', 422) };
  if (min !== null && max !== null && max <= min) return { error: fail('"To" must be higher than "from".', 422) };
  const user = await env.DB.prepare('SELECT id, name, role, team_id, is_active FROM users WHERE id = ?1').bind(String(body.user_id || '')).first();
  if (!user || !user.is_active) return { error: fail('Choose an active employee.', 422) };
  if (!isAgentRole(user.role)) return { error: fail(`${user.name} is not an Employee or Sales Employee account, so they cannot be recommended for new leads.`, 422) };
  if (!user.team_id) return { error: fail(`${user.name} is not in a team yet. Put them in a team first (People page), then add the rule.`, 422) };
  const project = typeof body.project === 'string' ? body.project.trim().slice(0, 200) || null : null;
  const priority = Number.isInteger(body.priority) ? body.priority : 100;
  return { fields: { user_id: user.id, budget_min: min === null ? null : Math.round(min), budget_max: max === null ? null : Math.round(max), project, priority } };
}
async function handleCreateBudgetRule(request, env, actor) {
  if (!has(actor, 'routing.manage')) return fail('Only administrators can change who gets which leads.', 403);
  const r = await budgetRuleFields(request, env);
  if (r.error) return r.error;
  const f = r.fields, id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO budget_rules (id, user_id, budget_min, budget_max, project, priority) VALUES (?1,?2,?3,?4,?5,?6)').bind(id, f.user_id, f.budget_min, f.budget_max, f.project, f.priority).run();
  return json({ ok: true, rule: await env.DB.prepare(`${BUDGET_RULE_SELECT} WHERE r.id = ?1`).bind(id).first() }, 201);
}
async function handleUpdateBudgetRule(request, env, id, actor) {
  if (!has(actor, 'routing.manage')) return fail('Only administrators can change who gets which leads.', 403);
  const existing = await env.DB.prepare('SELECT * FROM budget_rules WHERE id = ?1').bind(id).first();
  if (!existing) return fail('Rule not found.', 404);
  const body = await bodyJson(request);
  if (body && Object.keys(body).length === 1 && 'is_active' in body) {
    await env.DB.prepare('UPDATE budget_rules SET is_active = ?2 WHERE id = ?1').bind(id, body.is_active ? 1 : 0).run();
  } else {
    const r = await budgetRuleFields(new Request('https://x.local/', { method: 'POST', body: JSON.stringify(body || {}) }), env);
    if (r.error) return r.error;
    const f = r.fields;
    await env.DB.prepare('UPDATE budget_rules SET user_id=?2, budget_min=?3, budget_max=?4, project=?5, priority=?6 WHERE id=?1').bind(id, f.user_id, f.budget_min, f.budget_max, f.project, f.priority).run();
  }
  return json({ ok: true, rule: await env.DB.prepare(`${BUDGET_RULE_SELECT} WHERE r.id = ?1`).bind(id).first() });
}
async function handleDeleteBudgetRule(env, id, actor) {
  if (!has(actor, 'routing.manage')) return fail('Only administrators can change who gets which leads.', 403);
  const res = await env.DB.prepare('DELETE FROM budget_rules WHERE id = ?1').bind(id).run();
  return res.meta.changes ? json({ ok: true }) : fail('Rule not found.', 404);
}

async function handlePublicEnquiry(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Please complete the form and try again.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Please complete the form and try again.', 400);
  // Invisible to real visitors. Bots that fill every field are discarded before
  // a lead is created; contact-and-project retry protection then covers normal
  // browser re-submits.
  if (body.website) return json({ ok: true, message: 'Thank you.' });
  if (!env.INTAKE_TOKEN_METAADS) return fail('The campaign form is not configured yet.', 503);

  let property = null;
  if (body.property_id) property = await env.DB.prepare("SELECT * FROM properties WHERE id=?1 AND is_active=1 AND pipeline='catalog'").bind(String(body.property_id)).first();
  const payload = {
    name: body.name,
    phone: body.phone,
    email: body.email,
    project_name: property?.name ?? body.project_name,
    property_type: property?.property_type ?? body.property_type,
    location: property?.location ?? body.location,
    budget_min: body.budget_min,
    budget_max: body.budget_max,
    campaign: body.campaign || 'website-form',
  };
  // Optional extras from the landing-page forms. They are stored with the lead (raw_payload) and also written to
  // the lead's timeline as one readable "Website enquiry" note, so the team sees them without opening anything else.
  const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null : null;
  const extras = {
    requirement: clip(body.requirement, 200), timeline: clip(body.timeline, 120), site_visit: clip(body.site_visit, 120),
    budget_text: clip(body.budget_text, 120), form: clip(body.form, 120), page: clip(body.page, 500),
    message: clip(body.message, 400), received_at: clip(body.received_at, 40),
    purpose: clip(body.purpose, 60), current_home: clip(body.current_home, 80),
  };
  for (const [k, v] of Object.entries(extras)) if (v) payload[k] = v;
  // WhatsApp consent: only an explicit true counts. Anything else on a website enquiry is stored as "not opted in".
  const optIn = body.whatsapp_opt_in === true || body.whatsapp_opt_in === 1 || /^(true|yes|1)$/i.test(String(body.whatsapp_opt_in ?? ''));
  const optInGiven = body.whatsapp_opt_in !== undefined && body.whatsapp_opt_in !== null && body.whatsapp_opt_in !== '';
  payload.whatsapp_opt_in = optIn;
  if (!payload.property_type && extras.requirement) payload.property_type = extras.requirement;
  // Back-filling old sheet rows: keep their original date and make a re-run harmless (the same import_id is never added twice).
  if (extras.received_at) payload.created_at = extras.received_at;
  const importId = clip(body.import_id, 80);
  if (importId) payload.lead_id = 'import:' + importId;
  // The website's own id for this lead: step 1 creates the lead, step 2 (same lead_id) fills in the rest of the SAME lead.
  const webId = clip(body.lead_id, 80);
  if (webId) payload.lead_id = 'web:' + webId;

  const noteParts = () => [
    extras.form && `Form: ${extras.form}`, payload.project_name && `Project: ${payload.project_name}`,
    extras.requirement && `Looking for: ${extras.requirement}`, extras.budget_text && `Budget: ${extras.budget_text}`,
    extras.purpose && `Purpose: ${extras.purpose}`, extras.current_home && `Current home: ${extras.current_home}`,
    payload.location && !property && `Lives in: ${payload.location}`,
    extras.timeline && `Timeline: ${extras.timeline}`, extras.site_visit && `Site visit: ${extras.site_visit}`,
    extras.message && `Message: ${extras.message}`, extras.page && `Page: ${extras.page}`,
    extras.received_at && `Originally received: ${extras.received_at} (imported)`,
  ].filter(Boolean);
  const addNote = (leadId, prefix, parts) => env.DB.prepare("INSERT INTO lead_activities (id,lead_id,actor_user_id,type,subject) VALUES (?1,?2,NULL,'note',?3)")
    .bind(crypto.randomUUID(), leadId, (prefix + parts.join(' · ')).slice(0, 900)).run().catch((e) => console.error('enquiry note failed', e));
  const thanks = 'Thank you. Our team will contact you soon.';

  // Step 2 (or any repeat of the same website lead_id): update the existing lead instead of creating another.
  if (webId) {
    const existing = await env.DB.prepare("SELECT id, raw_payload FROM leads WHERE source='meta_ads' AND original_lead_id=?1").bind('web:' + webId).first();
    if (existing) {
      const sets = [], binds = [existing.id];
      const set = (col, val) => { binds.push(val); sets.push(`${col}=?${binds.length}`); };
      const bMin = parseMoney(body.budget_min), bMax = parseMoney(body.budget_max);
      if (clip(body.name, 120)) set('customer_name', clip(body.name, 120));
      if (clip(body.email, 200)) set('email', clip(body.email, 200));
      if (payload.property_type) set('property_type', String(payload.property_type));
      if (payload.location) set('location', String(payload.location));
      if (bMin !== null || bMax !== null) { set('budget_min', bMin); set('budget_max', bMax); }
      if (extras.purpose) set('purpose', extras.purpose);
      if (extras.current_home) set('current_home', extras.current_home);
      if (optInGiven) set('whatsapp_opt_in', optIn ? 1 : 0);
      let merged = {};
      try { merged = JSON.parse(existing.raw_payload || '{}') || {}; } catch { /* keep empty */ }
      for (const [k, v] of Object.entries(payload)) if (v !== null && v !== undefined && v !== '' && !['lead_id', 'name', 'phone'].includes(k)) merged[k] = v;
      if (!optInGiven) merged.whatsapp_opt_in = merged.whatsapp_opt_in ?? false;
      set('raw_payload', JSON.stringify(merged));
      await env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?1`).bind(...binds).run();
      await applyBudgetRule(env, existing.id).catch((e) => console.error('budget rule failed', e));
      await autoApprovePending(env, existing.id).catch((e) => console.error('auto-assign failed', e));
      const parts = noteParts().filter((p) => !p.startsWith('Form:') && !p.startsWith('Page:'));
      if (optInGiven) parts.push(`WhatsApp opt-in: ${optIn ? 'yes' : 'no'}`);
      if (parts.length) await addNote(existing.id, 'Website enquiry updated — ', parts);
      return json({ ok: true, lead_id: existing.id, duplicate: false, updated: true, message: thanks });
    }
  }

  const internal = new Request('https://internal.local/api/intake/meta_ads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intake-token': env.INTAKE_TOKEN_METAADS },
    body: JSON.stringify(payload),
  });
  const result = await handleIntake(internal, env, 'meta_ads');
  if (!result.ok) return result;
  const data = await result.json();
  if (data.lead_id && !data.duplicate) {
    await env.DB.prepare('UPDATE leads SET purpose=?2, current_home=?3, whatsapp_opt_in=?4 WHERE id=?1')
      .bind(data.lead_id, extras.purpose, extras.current_home, optIn ? 1 : 0).run().catch((e) => console.error('enquiry extras failed', e));
    const parts = noteParts();
    if (optIn) parts.push('WhatsApp opt-in: yes');
    if (parts.length > 1) await addNote(data.lead_id, 'Website enquiry — ', parts);
  }
  return json({ ok: true, lead_id: data.lead_id, duplicate: data.duplicate || false, message: thanks });
}

async function handlePublicProperties(env) {
  const { results } = await env.DB.prepare(
    `SELECT id,name,developer,property_type,location,locality,budget_min,budget_max,bedrooms,availability
       FROM properties WHERE is_active=1 AND availability = 'yes' AND pipeline = 'catalog' AND inventory_status = 'active' ORDER BY name LIMIT 200`
  ).all();
  return json({ properties: results ?? [] });
}

const LEAD_SORTS = {
  newest: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  // Soonest callback first; leads with no follow-up set go last.
  follow_up: 'l.next_follow_up_at IS NULL, l.next_follow_up_at ASC, l.created_at DESC',
  // Requirements view. Budget ranks by the midpoint of min/max, or whichever
  // side exists; leads with no budget at all go last either way.
  budget_high: `(l.budget_min IS NULL AND l.budget_max IS NULL), COALESCE((l.budget_min + l.budget_max) / 2.0, l.budget_max, l.budget_min) DESC, l.created_at DESC`,
  budget_low: `(l.budget_min IS NULL AND l.budget_max IS NULL), COALESCE((l.budget_min + l.budget_max) / 2.0, l.budget_max, l.budget_min) ASC, l.created_at DESC`,
  area: `NULLIF(trim(COALESCE(l.location,'')),'') IS NULL, lower(trim(l.location)) ASC, l.created_at DESC`,
  // Leads sort selector (#18): A–Z (unnamed last) and "recently updated" = the
  // latest stage change or logged activity, falling back to when it came in.
  name: `NULLIF(trim(COALESCE(l.customer_name,'')),'') IS NULL, lower(trim(l.customer_name)) ASC, l.created_at DESC`,
  updated: `MAX(COALESCE((SELECT MAX(h.created_at) FROM lead_stage_history h WHERE h.lead_id = l.id), l.created_at), COALESCE((SELECT MAX(a.created_at) FROM lead_activities a WHERE a.lead_id = l.id), l.created_at)) DESC, l.created_at DESC`,
};

// ---- Leads lens tiles (#18) ----
// One-click "quick views" on the Leads page. Each lens is a SQL condition over
// `leads l`; the same conditions drive both the list (`?lens=`) and the tile
// counts (`GET /api/leads/summary`), so a tile's number always matches its list.
// "Today" means the business day in India (IST), like the dashboard.
const LEAD_LENS_OPEN = `l.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')}) AND l.archived_at IS NULL`;
const LEAD_LENS_DAY = `date(l.next_follow_up_at, '+330 minutes')`;
const LEAD_LENS_TODAY = `date('now', '+330 minutes')`;
const LEAD_LENSES = {
  new: `l.stage = 'new' AND ${LEAD_LENS_OPEN}`,
  tried_calling: `l.stage = 'contact_attempted' AND ${LEAD_LENS_OPEN}`,
  interested: `l.stage = 'qualified' AND ${LEAD_LENS_OPEN}`,
  hot: `l.research_level = 'advanced' AND ${LEAD_LENS_OPEN}`,
  due_today: `${LEAD_LENS_OPEN} AND l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} = ${LEAD_LENS_TODAY}`,
  overdue: `${LEAD_LENS_OPEN} AND l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} < ${LEAD_LENS_TODAY}`,
  unassigned: `l.assigned_user_id IS NULL AND ${LEAD_LENS_OPEN}`,
  site_visit: `l.stage IN ('site_visit_scheduled', 'site_visited')`,
  negotiation: `l.stage IN ('proposal', 'negotiation')`,
  won: `l.stage = 'won'`,
  lost: `l.stage = 'lost'`,
  archived: `l.archived_at IS NOT NULL`,
};
// Archived leads only show under their own tile; every other tile and the list leave them out.
for (const k of Object.keys(LEAD_LENSES)) if (k !== 'archived') LEAD_LENSES[k] = `l.archived_at IS NULL AND (${LEAD_LENSES[k]})`;

/** GET /api/leads/summary — live tile counts, scoped exactly like the lead list (own / team / all). */
async function handleLeadSummary(request, env, actor) {
  const binds = [];
  let scope = '';
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) { binds.push(actor.id); scope = 'WHERE l.assigned_user_id = ?1'; }
    else if (has(actor, 'lead.read_team') && actor.team_id) { binds.push(actor.team_id); scope = 'WHERE l.team_id = ?1'; }
    else return fail('You do not have permission to view leads.', 403);
  }
  const cols = Object.entries(LEAD_LENSES).map(([key, cond]) => `COALESCE(SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0) AS ${key}`);
  const row = await env.DB.prepare(`SELECT COUNT(CASE WHEN l.archived_at IS NULL THEN 1 END) AS "all", ${cols.join(', ')} FROM leads l ${scope}`).bind(...binds).first();
  return json({ counts: row ?? {} });
}

/** GET /api/leads/projects — the project names leads asked about, with counts; scoped like the lead list. Feeds the Project filter dropdown. */
async function handleLeadProjects(request, env, actor) {
  const binds = [];
  let scope = '';
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) { binds.push(actor.id); scope = 'AND l.assigned_user_id = ?1'; }
    else if (has(actor, 'lead.read_team') && actor.team_id) { binds.push(actor.team_id); scope = 'AND l.team_id = ?1'; }
    else return fail('You do not have permission to view leads.', 403);
  }
  const { results } = await env.DB.prepare(
    `SELECT trim(l.project_name) AS name, COUNT(*) AS n FROM leads l
      WHERE NULLIF(trim(COALESCE(l.project_name,'')),'') IS NOT NULL AND l.archived_at IS NULL ${scope}
      GROUP BY lower(trim(l.project_name)) ORDER BY n DESC, name LIMIT 200`
  ).bind(...binds).all();
  return json({ projects: results ?? [] });
}

/** Hook for extra lead filters (each filter adds its own block here). Return a Response to reject, or null. */
function leadExtraFilters(url, filters, binds) {
  // ---- lens tile (#18): ?lens=hot|new|due_today|... ----
  const lens = url.searchParams.get('lens');
  if (lens) {
    if (!LEAD_LENSES[lens]) return fail(`lens must be one of: ${Object.keys(LEAD_LENSES).join(', ')}.`, 422);
    filters.push(`(${LEAD_LENSES[lens]})`);
  }
  // ---- lead filter panel (#19) ----
  const csv = (key, check) => {
    const raw = url.searchParams.get(key);
    if (!raw) return { list: [] };
    const list = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
    if (list.length > 40 || list.some((v) => v.length > 80 || !check(v))) return { error: fail(`${key} has a value that is not allowed.`, 422) };
    return { list };
  };
  const inList = (col, list) => {
    const marks = list.map((v) => { binds.push(v); return `?${binds.length}`; });
    return `${col} IN (${marks.join(',')})`;
  };
  const idLike = (v) => /^[\w.-]+$/.test(v);

  const stages = csv('stages', (v) => STAGES.includes(v));
  if (stages.error) return stages.error;
  if (stages.list.length) filters.push(inList('l.stage', stages.list));

  // wave3 C: why a lead was closed (`?lost_reasons=duplicate,other`; 'invalid'/'dropped' = whole group).
  const lostReasons = csv('lost_reasons', (v) => !!LOST_REASONS[v] || v === 'invalid' || v === 'dropped');
  if (lostReasons.error) return lostReasons.error;
  if (lostReasons.list.length) {
    const reasons = [...new Set(lostReasons.list.flatMap((v) => LOST_REASONS[v] ? [v] : Object.keys(LOST_REASONS).filter((k) => LOST_REASONS[k] === v)))];
    filters.push(`l.stage = 'lost' AND ${inList('l.lost_reason', reasons)}`);
  }

  const sources = csv('sources', idLike);
  if (sources.error) return sources.error;
  if (sources.list.length) filters.push(inList('l.source', sources.list));

  if (url.searchParams.get('unassigned') === '1') {
    filters.push('l.assigned_user_id IS NULL');
  } else {
    const users = csv('assigned_users', idLike);
    if (users.error) return users.error;
    if (users.list.length) filters.push(inList('l.assigned_user_id', users.list));
  }

  // When the client wants it (`unspecified` = not said). Several can be picked.
  const timelines = csv('client_statuses', (v) => v === 'unspecified' || CLIENT_STATUSES.includes(v));
  if (timelines.error) return timelines.error;
  if (timelines.list.length) {
    const real = timelines.list.filter((v) => v !== 'unspecified');
    const parts = [];
    if (real.length) parts.push(inList('l.client_status', real));
    if (real.length !== timelines.list.length) parts.push("NULLIF(trim(COALESCE(l.client_status,'')),'') IS NULL");
    filters.push(`(${parts.join(' OR ')})`);
  }

  // Several property types, OR-ed; each one is matched like the single `type` filter.
  const types = csv('types', () => true);
  if (types.error) return types.error;
  if (types.list.length) {
    const parts = [];
    for (const t of types.list) {
      const lower = t.toLowerCase();
      const bhk = lower.match(/(\d+)\s*-?\s*bhk/);
      if (bhk) { binds.push(`%${bhk[1]}bhk%`); parts.push(`replace(replace(lower(COALESCE(l.property_type,'')),' ',''),'-','') LIKE ?${binds.length}`); }
      else if (lower === 'unspecified') parts.push("NULLIF(trim(COALESCE(l.property_type,'')),'') IS NULL");
      else for (const term of new Set([lower, ...propertyTypeTerms(t)])) { binds.push(`%${term}%`); parts.push(`lower(COALESCE(l.property_type,'')) LIKE ?${binds.length}`); }
    }
    filters.push(`(${parts.join(' OR ')})`);
  }

  // Project / property they asked about.
  const interest = url.searchParams.get('project')?.trim();
  if (interest) {
    if (interest.length > 100) return fail('project is too long.', 422);
    binds.push(`%${interest}%`);
    filters.push(`lower(COALESCE(l.project_name,'')) LIKE lower(?${binds.length})`);
  }

  // Next call window. Days are India days (IST), like the Today view.
  const followUp = url.searchParams.get('follow_up');
  if (followUp) {
    const day = `date(l.next_follow_up_at, '+330 minutes')`;
    const today = `date('now', '+330 minutes')`;
    const open = `l.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;
    if (followUp === 'today') filters.push(`l.next_follow_up_at IS NOT NULL AND ${day} = ${today}`);
    else if (followUp === 'overdue') filters.push(`${open} AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < datetime('now')`);
    else if (followUp === 'this_week') filters.push(`l.next_follow_up_at IS NOT NULL AND ${day} BETWEEN ${today} AND date('now', '+330 minutes', '+6 days')`);
    else if (followUp === 'none') filters.push('l.next_follow_up_at IS NULL');
    else return fail('follow_up must be one of: today, overdue, this_week, none.', 422);
  }

  if (url.searchParams.get('has_phone') === '1') filters.push("NULLIF(trim(COALESCE(l.phone,'')),'') IS NOT NULL");
  if (url.searchParams.get('has_email') === '1') filters.push("NULLIF(trim(COALESCE(l.email,'')),'') IS NOT NULL");
  // ---- end lead filter panel ----
  return null;
}

// ---- record codes (wave3 B) ----
// Leads and properties carry a human-readable code (L-00001 / P-00001) set by
// DB triggers (migration 0061). A search box query that looks like a code —
// "L-00012", "l-12", "L12" or a bare "12" — is normalised to the exact code.
function recordCodeQuery(q, prefix) {
  const m = String(q || '').trim().match(new RegExp(`^(?:${prefix}\\s*-?\\s*)?0*(\\d{1,7})$`, 'i'));
  return m && Number(m[1]) > 0 ? `${prefix}-${m[1].padStart(5, '0')}` : null;
}
// ---- end record codes ----

async function handleListLeads(request, env, actor) {
  const url = new URL(request.url);
  // The Requirements view sorts/groups the whole matching set client-side, so
  // it alone may ask for up to 500 rows; every other caller keeps the 200 cap.
  const maxLimit = url.searchParams.get('view') === 'requirements' ? 500 : 200;
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, maxLimit));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

  const filters = [];
  const binds = [];
  if (url.searchParams.get('lens') !== 'archived') filters.push('l.archived_at IS NULL'); // archived leads only show under the Archived tile
  for (const key of ['status', 'stage', 'source', 'assigned_user_id', 'team_id', 'property_type']) {
    const value = url.searchParams.get(key);
    if (value) {
      binds.push(value);
      filters.push(`l.${key} = ?${binds.length}`);
    }
  }
  // "Live leads" — still being worked, not won or lost. Kept as its own flag
  // rather than overloading `status` since it's a set membership, not an
  // exact match.
  // Search box: name / email / project / area, or the last 10 digits of a
  // phone number however it was typed (+91, spaces, dashes).
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    binds.push(`%${q}%`);
    const like = `?${binds.length}`;
    const clauses = ['customer_name', 'email', 'project_name', 'location'].map((c) => `lower(COALESCE(l.${c},'')) LIKE lower(${like})`);
    if (digits.length >= 4) { binds.push(`%${digits.slice(-10)}%`); clauses.push(`${huntingPhoneKeySql('l.phone')} LIKE ?${binds.length}`); }
    const code = recordCodeQuery(q, 'L'); // wave3 B: "L-00012", "l-12", "12"
    if (code) { binds.push(code); clauses.push(`l.lead_code = ?${binds.length}`); }
    filters.push(`(${clauses.join(' OR ')})`);
  }
  // Date range on when the enquiry arrived, in India time (IST) like the Today view.
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    const v = url.searchParams.get(key);
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail('from/to must be dates in YYYY-MM-DD format.', 422);
    binds.push(v);
    filters.push(`date(l.created_at, '+330 minutes') ${op} ?${binds.length}`);
  }
  if (url.searchParams.get('live') === '1') {
    filters.push(`l.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`);
  }
  // Requirements filters. `type` is a contains-match widened with the
  // catalogue synonyms (e.g. "Villa" also finds "Bungalow"); a BHK type
  // ignores spacing/dashes so "2 BHK" finds "2BHK" and "2-bhk" too.
  const type = url.searchParams.get('type')?.trim();
  if (type) {
    const bhk = type.toLowerCase().match(/(\d+)\s*-?\s*bhk/);
    if (bhk) {
      binds.push(`%${bhk[1]}bhk%`);
      filters.push(`replace(replace(lower(COALESCE(l.property_type,'')),' ',''),'-','') LIKE ?${binds.length}`);
    } else if (type.toLowerCase() === 'unspecified') {
      filters.push(`NULLIF(trim(COALESCE(l.property_type,'')),'') IS NULL`);
    } else {
      const terms = [...new Set([type.toLowerCase(), ...propertyTypeTerms(type)])];
      filters.push(`(${terms.map((t) => { binds.push(`%${t}%`); return `lower(COALESCE(l.property_type,'')) LIKE ?${binds.length}`; }).join(' OR ')})`);
    }
  }
  const area = url.searchParams.get('area')?.trim();
  if (area) {
    binds.push(`%${area}%`);
    filters.push(`lower(COALESCE(l.location,'')) LIKE lower(?${binds.length})`);
  }
  const clientStatus = url.searchParams.get('client_status');
  if (clientStatus) {
    binds.push(clientStatus);
    filters.push(`l.client_status = ?${binds.length}`);
  }
  // Market research level; `unranked` = not ranked yet (NULL).
  const researchLevel = url.searchParams.get('research_level');
  if (researchLevel === 'unranked') {
    filters.push('l.research_level IS NULL');
  } else if (researchLevel) {
    if (!RESEARCH_LEVELS.includes(researchLevel)) return fail(`research_level must be one of: ${RESEARCH_LEVELS.join(', ')}, unranked.`, 422);
    binds.push(researchLevel);
    filters.push(`l.research_level = ?${binds.length}`);
  }
  // Budget overlap: the lead's budget range must overlap the asked range. Ranges that only touch at one number do
  // NOT overlap (50 L – 1 Cr is not in 1 Cr – 5 Cr), unless one side is a single figure (min = max) or the asked range
  // is a single figure. A lead with only an upper limit counts from 0, one with only a lower limit has no upper end.
  // A lead with no budget never matches once any budget bound is set.
  const budgetBounds = {};
  for (const key of ['budget_min', 'budget_max']) {
    const raw = url.searchParams.get(key)?.trim();
    if (!raw) continue;
    const n = parseMoney(raw);
    if (n == null) return fail(`${key} must be an amount like 6500000, 65 L or 1.2 Cr.`, 422);
    budgetBounds[key] = n;
  }
  if (budgetBounds.budget_min != null || budgetBounds.budget_max != null) {
    const lo = 'CASE WHEN l.budget_min IS NULL THEN 0 ELSE l.budget_min END';
    const hi = 'COALESCE(l.budget_max, 9007199254740991)';
    const point = 'l.budget_min IS NOT NULL AND l.budget_min = l.budget_max';
    const askedPoint = budgetBounds.budget_min != null && budgetBounds.budget_min === budgetBounds.budget_max;
    filters.push('COALESCE(l.budget_min, l.budget_max) IS NOT NULL');
    if (budgetBounds.budget_max != null) {
      binds.push(budgetBounds.budget_max);
      filters.push(askedPoint ? `${lo} <= ?${binds.length}` : `(${lo} < ?${binds.length} OR (${lo} = ?${binds.length} AND ${point}))`);
    }
    if (budgetBounds.budget_min != null) {
      binds.push(budgetBounds.budget_min);
      filters.push(askedPoint ? `${hi} >= ?${binds.length}` : `(${hi} > ?${binds.length} OR (${hi} = ?${binds.length} AND ${point}))`);
    }
  }
  const extraLeadFilter = leadExtraFilters(url, filters, binds);
  if (extraLeadFilter) return extraLeadFilter;
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) {
      binds.push(actor.id);
      filters.push(`l.assigned_user_id = ?${binds.length}`);
    } else if (has(actor, 'lead.read_team') && actor.team_id) {
      binds.push(actor.team_id);
      filters.push(`l.team_id = ?${binds.length}`);
    } else return fail('You do not have permission to view leads.', 403);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT l.*, u.name AS assigned_user_name, t.name AS team_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_user_id
       LEFT JOIN teams t ON t.id = l.team_id
       ${where}
       ORDER BY ${LEAD_SORTS[url.searchParams.get('sort')] || LEAD_SORTS.newest}
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  )
    .bind(...binds, limit, offset)
    .all();

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${where}`)
    .bind(...binds)
    .first('n');

  const leads = (results ?? []).map((l) => ({ ...l, type_group: canonicalLeadPropertyType(l.property_type) }));
  return json({ total, limit, offset, leads });
}

/**
 * Aggregated counts for the analytics/insights dashboard, scoped to a
 * created_at date range and to whatever leads the caller is allowed to see.
 * Every breakdown is computed with GROUP BY in D1 and only the resulting
 * (bucket, count) pairs cross the wire — never the underlying leads — so
 * this stays cheap regardless of how many leads are in range.
 */
async function handleLeadAnalytics(request, env, actor) {
  const url = new URL(request.url);
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const isDateOrEmpty = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDateOrEmpty(fromRaw) || !isDateOrEmpty(toRaw)) return fail('from/to must be dates in YYYY-MM-DD format.', 422);

  const filters = [];
  const binds = [];
  filters.push('l.archived_at IS NULL');
  if (fromRaw) { binds.push(fromRaw); filters.push(`date(l.created_at) >= ?${binds.length}`); }
  if (toRaw) { binds.push(toRaw); filters.push(`date(l.created_at) <= ?${binds.length}`); }
  const convertedFilter = analyticsConverted(url);
  if (convertedFilter.sql) filters.push(convertedFilter.sql);

  // Same scoping rule as handleListLeads: an agent only ever sees their own
  // pipeline and a manager only their team's, so the dashboard can't reveal
  // counts drawn from leads that actor could not open individually.
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) {
      binds.push(actor.id);
      filters.push(`l.assigned_user_id = ?${binds.length}`);
    } else if (has(actor, 'lead.read_team') && actor.team_id) {
      binds.push(actor.team_id);
      filters.push(`l.team_id = ?${binds.length}`);
    } else return fail('You do not have permission to view analytics.', 403);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${where}`).bind(...binds).first('n');

  // Budget: bucket the midpoint of (budget_min, budget_max), or whichever of
  // the two is present, into fixed rupee bands. Boundaries must match
  // ANALYTICS_BUDGET_BUCKETS above.
  const { results: budgetRows } = await env.DB.prepare(
    `SELECT
       CASE
         WHEN v IS NULL THEN 'unknown'
         WHEN v < 2500000 THEN 'lt_25l'
         WHEN v < 5000000 THEN '25_50l'
         WHEN v < 7500000 THEN '50_75l'
         WHEN v < 10000000 THEN '75l_1cr'
         WHEN v < 15000000 THEN '1_1.5cr'
         WHEN v < 20000000 THEN '1.5_2cr'
         ELSE '2cr_plus'
       END AS bucket,
       COUNT(*) AS n
     FROM (
       SELECT
         CASE
           WHEN l.budget_min IS NOT NULL AND l.budget_max IS NOT NULL THEN (l.budget_min + l.budget_max) / 2.0
           WHEN l.budget_min IS NOT NULL THEN l.budget_min
           WHEN l.budget_max IS NOT NULL THEN l.budget_max
           ELSE NULL
         END AS v
       FROM leads l ${where}
     )
     GROUP BY bucket`
  ).bind(...binds).all();
  const budgetCounts = Object.fromEntries((budgetRows ?? []).map((r) => [r.bucket, r.n]));
  const budget = ANALYTICS_BUDGET_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: budgetCounts[b.key] || 0 }));

  // Type of lead: group by the raw free-text property_type first (bounded —
  // there are only ever a handful of distinct strings), then fold those into
  // display buckets (and the rental proxy) in JS. This still only ever
  // ships one row per distinct raw string, not one per lead.
  const { results: typeRows } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(l.property_type), ''), '') AS raw_type, COUNT(*) AS n
       FROM leads l ${where}
      GROUP BY raw_type`
  ).bind(...binds).all();
  const typeCounts = new Map();
  let rentalCount = 0;
  for (const row of typeRows ?? []) {
    const label = canonicalLeadPropertyType(row.raw_type);
    typeCounts.set(label, (typeCounts.get(label) || 0) + row.n);
    if (isRentalLeadType(row.raw_type)) rentalCount += row.n;
  }
  const propertyType = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // Area: group by location, keep the top handful, fold the long tail into
  // "Other" so the chart stays readable regardless of how many distinct
  // localities have been entered.
  const { results: areaRows } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(l.location), ''), 'Unspecified') AS area, COUNT(*) AS n
       FROM leads l ${where}
      GROUP BY area
      ORDER BY n DESC`
  ).bind(...binds).all();
  const AREA_TOP_N = 7;
  const sortedAreas = areaRows ?? [];
  const area = sortedAreas.slice(0, AREA_TOP_N).map((r) => ({ area: r.area, count: r.n }));
  const otherAreaCount = sortedAreas.slice(AREA_TOP_N).reduce((sum, r) => sum + r.n, 0);
  if (otherAreaCount > 0) area.push({ area: 'Other', count: otherAreaCount });

  // Construction status: leads.client_status is already exactly the enum
  // the dashboard needs (prelaunch/eoi_phase/ready_to_move/resale/
  // under_construction/nearing_possession) — group by it directly. Grouping
  // is done on the COALESCE expression itself, not the "status" alias:
  // leads already has its own `status` column (new/assigned/...), and
  // SQLite resolves a bare GROUP BY name against a real FROM-clause column
  // before an output alias, so `GROUP BY status` would silently group by
  // pipeline status instead of client_status.
  const { results: statusRows } = await env.DB.prepare(
    `SELECT COALESCE(l.client_status, 'unspecified') AS status, COUNT(*) AS n
       FROM leads l ${where}
      GROUP BY COALESCE(l.client_status, 'unspecified')`
  ).bind(...binds).all();
  const clientStatus = (statusRows ?? []).map((r) => ({ status: r.status, count: r.n }));

  // Market research level, NULL folded into 'unranked'. Grouped on the
  // expression for the same alias-vs-column reason as client_status above.
  const { results: researchRows } = await env.DB.prepare(
    `SELECT COALESCE(l.research_level, 'unranked') AS level, COUNT(*) AS n
       FROM leads l ${where}
      GROUP BY COALESCE(l.research_level, 'unranked')`
  ).bind(...binds).all();
  const researchCounts = Object.fromEntries((researchRows ?? []).map((r) => [r.level, r.n]));
  const researchLevel = [...RESEARCH_LEVELS, 'unranked'].map((level) => ({ level, count: researchCounts[level] || 0 }));

  return json({
    total,
    range: { from: fromRaw || null, to: toRaw || null },
    converted: convertedFilter.value,
    budget,
    property_type: propertyType,
    rental: { count: rentalCount, total },
    area,
    client_status: clientStatus,
    research_level: researchLevel,
  });
}

// ---- Insights: supply gap + lead source ROI (Agent INSIGHTS) ----

/** Validated optional ?from=&to= (YYYY-MM-DD), or an error Response. */
function analyticsRange(url) {
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const ok = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!ok(from) || !ok(to)) return { error: fail('from/to must be dates in YYYY-MM-DD format.', 422) };
  return { from, to };
}

/**
 * Optional ?converted= filter shared by the lead-based Insights endpoints.
 * "Converted" means the deal was won: stage 'won' is the source of truth
 * (status 'converted' is always kept in step with it — see the stage/status
 * sync in the stage-move and create handlers). Anything other than 1/0 is
 * treated as "all leads". Returns the SQL condition on alias `l` (no binds)
 * and the normalised value echoed back to the client.
 */
function analyticsConverted(url) {
  const v = url.searchParams.get('converted');
  if (v === '1') return { sql: `l.stage = 'won'`, value: 'converted' };
  if (v === '0') return { sql: `l.stage <> 'won'`, value: 'not_converted' };
  return { sql: null, value: 'all' };
}

/**
 * SQL expression that turns a free-text area column into a matching key:
 * tabs → spaces, runs of up to 8 spaces collapsed to one (three '  '→' '
 * passes), trimmed, lower-cased. areaKey() below is the JS twin, used only
 * to merge rows that already came back keyed this way.
 */
const areaKeySql = (col) =>
  `LOWER(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(${col}, char(9), ' '), '  ', ' '), '  ', ' '), '  ', ' ')))`;
const areaKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Where buyers are asking but we have little to sell — a to-do list for the
 * property-hunting team.
 *
 * Deliberately NOT role-scoped, unlike handleLeadAnalytics: it returns only
 * per-area counts and an average budget (no lead identities), and a hunting
 * agent needs company-wide demand to know where to source stock. Any lead- or
 * hunting-read permission is enough to call it.
 *
 * Area matching (all case-insensitive, trimmed, inner whitespace collapsed —
 * see areaKeySql):
 *   - leads: leads.location (leads have no locality column). Blank = skipped.
 *   - properties (is_active=1 AND availability='yes'): a property counts for
 *     an area if EITHER its locality OR its location matches, once per area
 *     (UNION dedups id+key), so "Thane West / Ghodbunder Road" supplies both.
 *   - hunting_targets (stage not listed/dropped): same either-field rule.
 * Display name = the most common trimmed spelling among the matching leads.
 * gap_score = open_leads / (supply_properties + open_targets + 1), 1 decimal.
 */
async function handleSupplyGap(request, env, actor) {
  const allowed = ['lead.read_own', 'lead.read_team', 'lead.read_all', 'hunting.read_own', 'hunting.read_team', 'hunting.read_all'];
  if (!allowed.some((p) => has(actor, p))) return fail('You do not have permission to view analytics.', 403);
  const gapUrl = new URL(request.url);
  const range = analyticsRange(gapUrl);
  if (range.error) return range.error;
  const convertedFilter = analyticsConverted(gapUrl);

  const filters = [`TRIM(COALESCE(l.location, '')) <> ''`];
  const binds = [];
  filters.push('l.archived_at IS NULL');
  if (range.from) { binds.push(range.from); filters.push(`date(l.created_at) >= ?${binds.length}`); }
  if (range.to) { binds.push(range.to); filters.push(`date(l.created_at) <= ?${binds.length}`); }
  if (convertedFilter.sql) filters.push(convertedFilter.sql);
  const openList = OPEN_STATUSES.map((s) => `'${s}'`).join(',');
  const closedTargets = HUNTING_CLOSED_STAGES.map((s) => `'${s}'`).join(',');
  // One row per (area key, id) from either column, then counted per key.
  const eitherFieldCounts = (table, where) =>
    `SELECT area_key, COUNT(*) AS n FROM (
       SELECT id, ${areaKeySql('locality')} AS area_key FROM ${table} WHERE ${where} AND TRIM(COALESCE(locality, '')) <> ''
       UNION
       SELECT id, ${areaKeySql('location')} AS area_key FROM ${table} WHERE ${where} AND TRIM(COALESCE(location, '')) <> ''
     ) GROUP BY area_key`;

  // Grouping on the expressions, never on a bare alias that shadows a real
  // column (see the client_status note in handleLeadAnalytics).
  const [leadRows, propertyRows, targetRows] = await Promise.all([
    env.DB.prepare(
      `SELECT ${areaKeySql('l.location')} AS area_key, TRIM(l.location) AS area_label, COUNT(*) AS demand_n,
              SUM(CASE WHEN l.status IN (${openList}) THEN 1 ELSE 0 END) AS open_n,
              SUM(CASE WHEN l.budget_min IS NOT NULL AND l.budget_max IS NOT NULL THEN (l.budget_min + l.budget_max) / 2.0
                       ELSE COALESCE(l.budget_min, l.budget_max) END) AS budget_sum,
              COUNT(COALESCE(l.budget_min, l.budget_max)) AS budget_n
         FROM leads l WHERE ${filters.join(' AND ')}
        GROUP BY ${areaKeySql('l.location')}, TRIM(l.location)`
    ).bind(...binds).all(),
    env.DB.prepare(eitherFieldCounts('properties', `is_active = 1 AND availability = 'yes' AND pipeline = 'catalog'`)).all(),
    // Defensive: an empty or not-yet-migrated hunting_targets table just
    // means "no open targets anywhere", never a failed dashboard.
    env.DB.prepare(eitherFieldCounts('hunting_targets', `stage NOT IN (${closedTargets})`)).all()
      .catch(() => ({ results: [] })),
  ]);

  const areas = new Map();
  for (const r of leadRows.results ?? []) {
    const key = areaKey(r.area_key);
    if (!key) continue;
    const a = areas.get(key) || { key, label: r.area_label, labelCount: 0, demand: 0, open: 0, budgetSum: 0, budgetN: 0 };
    if (r.demand_n > a.labelCount) { a.label = r.area_label; a.labelCount = r.demand_n; }
    a.demand += r.demand_n; a.open += r.open_n || 0;
    a.budgetSum += r.budget_sum || 0; a.budgetN += r.budget_n || 0;
    areas.set(key, a);
  }
  const countsByKey = (rows) => {
    const m = new Map();
    for (const r of rows ?? []) { const k = areaKey(r.area_key); if (k) m.set(k, (m.get(k) || 0) + r.n); }
    return m;
  };
  const supply = countsByKey(propertyRows.results);
  const targets = countsByKey(targetRows.results);

  const result = [...areas.values()]
    .filter((a) => a.demand > 0)
    .map((a) => {
      const supplyN = supply.get(a.key) || 0;
      const targetN = targets.get(a.key) || 0;
      return {
        area: a.label,
        demand_leads: a.demand,
        open_leads: a.open,
        avg_budget: a.budgetN ? Math.round(a.budgetSum / a.budgetN) : null,
        supply_properties: supplyN,
        open_targets: targetN,
        gap_score: Math.round((a.open / (supplyN + targetN + 1)) * 10) / 10,
      };
    })
    .sort((x, y) => y.gap_score - x.gap_score || y.demand_leads - x.demand_leads)
    .slice(0, 25);

  return json({ range: { from: range.from, to: range.to }, converted: convertedFilter.value, areas: result });
}

/**
 * Lead-source ROI: per portal, how far its leads get down the funnel.
 * Role-scoped exactly like handleLeadAnalytics (this IS lead performance).
 *   contacted   = current stage is anything past 'new'
 *   site_visits = current stage is a visit stage, OR the lead ever moved into
 *                 one (lead_stage_history), so leads that moved on still count
 *   won/lost    = current stage
 */
async function handleSourceAnalytics(request, env, actor) {
  const srcUrl = new URL(request.url);
  const range = analyticsRange(srcUrl);
  if (range.error) return range.error;
  const convertedFilter = analyticsConverted(srcUrl);
  const filters = [];
  const binds = [];
  filters.push('l.archived_at IS NULL');
  if (range.from) { binds.push(range.from); filters.push(`date(l.created_at) >= ?${binds.length}`); }
  if (range.to) { binds.push(range.to); filters.push(`date(l.created_at) <= ?${binds.length}`); }
  if (convertedFilter.sql) filters.push(convertedFilter.sql);
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) {
      binds.push(actor.id);
      filters.push(`l.assigned_user_id = ?${binds.length}`);
    } else if (has(actor, 'lead.read_team') && actor.team_id) {
      binds.push(actor.team_id);
      filters.push(`l.team_id = ?${binds.length}`);
    } else return fail('You do not have permission to view analytics.', 403);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT l.source AS source, COUNT(*) AS lead_n,
            SUM(CASE WHEN l.stage <> 'new' THEN 1 ELSE 0 END) AS contacted_n,
            SUM(CASE WHEN l.stage IN ('site_visit_scheduled', 'site_visited')
                       OR EXISTS (SELECT 1 FROM lead_stage_history h
                                   WHERE h.lead_id = l.id AND h.to_stage IN ('site_visit_scheduled', 'site_visited'))
                     THEN 1 ELSE 0 END) AS visit_n,
            SUM(CASE WHEN l.stage = 'won' THEN 1 ELSE 0 END) AS won_n,
            SUM(CASE WHEN l.stage = 'lost' THEN 1 ELSE 0 END) AS lost_n,
            COALESCE(SUM(CASE WHEN l.stage = 'won' THEN l.budget_max END), 0) AS won_budget
       FROM leads l ${where}
      GROUP BY l.source
      ORDER BY COUNT(*) DESC, l.source`
  ).bind(...binds).all();

  return json({
    range: { from: range.from, to: range.to },
    converted: convertedFilter.value,
    sources: (results ?? []).map((r) => ({
      source: r.source,
      leads: r.lead_n,
      contacted: r.contacted_n,
      site_visits: r.visit_n,
      won: r.won_n,
      lost: r.lost_n,
      conversion_rate: r.lead_n ? Math.round((r.won_n / r.lead_n) * 1000) / 10 : 0,
      won_budget_total: r.won_budget,
    })),
  });
}

// ---- end Insights (Agent INSIGHTS) ----

// ---- lost reasons analytics (wave3 C) ----
/** GET /api/analytics/lost-reasons — lost leads by reason. Same range (lead
 *  arrival date), converted filter and role scoping as the other Insights. */
async function handleLostReasonAnalytics(request, env, actor) {
  const url = new URL(request.url);
  const range = analyticsRange(url);
  if (range.error) return range.error;
  const convertedFilter = analyticsConverted(url);
  const filters = ["l.stage = 'lost'"];
  const binds = [];
  filters.push('l.archived_at IS NULL');
  if (range.from) { binds.push(range.from); filters.push(`date(l.created_at) >= ?${binds.length}`); }
  if (range.to) { binds.push(range.to); filters.push(`date(l.created_at) <= ?${binds.length}`); }
  if (convertedFilter.sql) filters.push(convertedFilter.sql);
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) { binds.push(actor.id); filters.push(`l.assigned_user_id = ?${binds.length}`); }
    else if (has(actor, 'lead.read_team') && actor.team_id) { binds.push(actor.team_id); filters.push(`l.team_id = ?${binds.length}`); }
    else return fail('You do not have permission to view analytics.', 403);
  }
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(l.lost_reason, 'unspecified') AS reason, COUNT(*) AS n FROM leads l WHERE ${filters.join(' AND ')} GROUP BY 1 ORDER BY n DESC`
  ).bind(...binds).all();
  const reasons = (results ?? []).map((r) => ({ reason: r.reason, group: LOST_REASONS[r.reason] || null, count: r.n }));
  return json({
    range: { from: range.from, to: range.to },
    converted: convertedFilter.value,
    total: reasons.reduce((s, r) => s + r.count, 0),
    invalid: reasons.filter((r) => r.group === 'invalid').reduce((s, r) => s + r.count, 0),
    reasons,
  });
}
// ---- end lost reasons analytics ----

/** A full-year performance record for one employee — everything an appraisal
 * conversation needs in one place. Every count is keyed off who actually DID
 * the work (actor_user_id on stage moves and activities), not who currently
 * owns the lead, so a deal an employee closed before it was later handed off
 * still counts toward the year they closed it. */
async function handleEmployeeAppraisal(request, env, userId, actor) {
  if (!has(actor, 'lead.read_team') && !has(actor, 'lead.read_all')) {
    return fail('You do not have permission to view appraisal reports.', 403);
  }
  const target = await env.DB.prepare(
    `SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?1`
  ).bind(userId).first();
  if (!target) return fail('Employee not found.', 404);
  if (!has(actor, 'lead.read_all') && target.team_id !== actor.team_id) {
    return fail('You can only view appraisal reports for your own team.', 403);
  }

  const url = new URL(request.url);
  const year = Math.max(2000, Math.min(2100, parseInt(url.searchParams.get('year'), 10) || new Date().getUTCFullYear()));
  // Period: a month, a quarter or a whole year. Boundaries are India-time days
  // (IST = UTC+5:30) converted to the UTC strings everything is stored in.
  const period = ['month', 'quarter', 'year'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'year';
  const pick = (key, max) => Math.max(1, Math.min(max, parseInt(url.searchParams.get(key), 10) || 1));
  const startMonth = period === 'month' ? pick('month', 12) : period === 'quarter' ? (pick('quarter', 4) - 1) * 3 + 1 : 1;
  const months = period === 'month' ? 1 : period === 'quarter' ? 3 : 12;
  const IST_MS = 330 * 60 * 1000;
  const utcSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const from = utcSql(Date.UTC(year, startMonth - 1, 1) - IST_MS);
  const to = utcSql(Date.UTC(year, startMonth - 1 + months, 1) - IST_MS - 1000);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const periodLabel = period === 'month' ? `${MONTHS[startMonth - 1]} ${year}` : period === 'quarter' ? `Q${(startMonth + 2) / 3} ${year}` : String(year);
  const lastDay = new Date(Date.UTC(year, startMonth - 1 + months, 0)).getUTCDate();
  const rangeLabel = `1 ${MONTHS[startMonth - 1]} – ${lastDay} ${MONTHS[startMonth + months - 2]} ${year}`;
  // Trend buckets: weeks of the month for a monthly report, months otherwise.
  const bucketSql = period === 'month'
    ? `(CAST(strftime('%d', created_at, '+330 minutes') AS INTEGER) - 1) / 7 + 1`
    : `CAST(strftime('%m', created_at, '+330 minutes') AS INTEGER)`;
  const buckets = period === 'month'
    ? Array.from({ length: Math.ceil(lastDay / 7) }, (_, i) => ({ key: i + 1, label: `Week ${i + 1} (${i * 7 + 1 === Math.min(lastDay, i * 7 + 7) ? i * 7 + 1 : `${i * 7 + 1}–${Math.min(lastDay, i * 7 + 7)}`} ${MONTHS[startMonth - 1]})` }))
    : Array.from({ length: months }, (_, i) => ({ key: startMonth + i, label: MONTHS[startMonth + i - 1] }));
  const openStatusList = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

  const [received, stageActionRows, activityTotal, activityByType, monthlyRows, transfersOut, transfersIn, currentBook, wonDeals] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM assignment_history WHERE to_user_id=?1 AND created_at BETWEEN ?2 AND ?3`).bind(userId, from, to).first(),
    env.DB.prepare(`SELECT to_stage AS stage, COUNT(*) AS n FROM lead_stage_history WHERE actor_user_id=?1 AND created_at BETWEEN ?2 AND ?3 GROUP BY to_stage`).bind(userId, from, to).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM lead_activities WHERE actor_user_id=?1 AND created_at BETWEEN ?2 AND ?3`).bind(userId, from, to).first(),
    env.DB.prepare(`SELECT type, COUNT(*) AS n FROM lead_activities WHERE actor_user_id=?1 AND created_at BETWEEN ?2 AND ?3 GROUP BY type`).bind(userId, from, to).all(),
    env.DB.prepare(`SELECT ${bucketSql} AS bucket, COUNT(*) AS n FROM lead_activities WHERE actor_user_id=?1 AND created_at BETWEEN ?2 AND ?3 GROUP BY ${bucketSql}`).bind(userId, from, to).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM lead_transfer_requests WHERE from_user_id=?1 AND created_at BETWEEN ?2 AND ?3`).bind(userId, from, to).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM lead_transfer_requests WHERE to_user_id=?1 AND status='accepted' AND created_at BETWEEN ?2 AND ?3`).bind(userId, from, to).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE assigned_user_id=?1 AND status IN (${openStatusList})`).bind(userId).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(l.budget_max), 0) AS total_budget
         FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id
        WHERE h.actor_user_id=?1 AND h.to_stage='won' AND h.created_at BETWEEN ?2 AND ?3`
    ).bind(userId, from, to).first(),
  ]);

  const stageActions = Object.fromEntries((stageActionRows.results ?? []).map((r) => [r.stage, r.n]));

  return json({
    employee: {
      id: target.id, name: target.name, role: target.role, team_name: target.team_name || null,
      email: target.email, phone: target.phone, is_active: !!target.is_active, joined_at: target.created_at,
    },
    year,
    period: { type: period, label: periodLabel, range: rangeLabel, from, to },
    leads_received: received.n,
    current_open_leads: currentBook.n,
    deals_won: { count: wonDeals.n, total_budget: wonDeals.total_budget },
    deals_lost: stageActions.lost || 0,
    site_visits_scheduled: stageActions.site_visit_scheduled || 0,
    site_visits_completed: stageActions.site_visited || 0,
    stage_actions: (stageActionRows.results ?? []).map((r) => ({ stage: r.stage, count: r.n })),
    activities_total: activityTotal.n,
    activities_by_type: (activityByType.results ?? []).map((r) => ({ type: r.type, count: r.n })),
    trend: buckets.map((b) => ({ label: b.label, count: (monthlyRows.results ?? []).find((r) => r.bucket === b.key)?.n || 0 })),
    transfers_requested: transfersOut.n,
    transfers_accepted: transfersIn.n,
  });
}

// ---- Notifications feed (managers & admins) ----
//
// No event table: every notification is a row some feature already writes
// (a lead arriving, a call logged, a stage move, an assignment, a transfer, a
// new employee or property, hunting progress). Unioning them here means every
// feature shows up automatically and nothing can drift out of sync.
// Columns: at, type, actor_id, subject (who/what), extra (stage / assignee /
// activity type), detail (free text), ref_kind + ref_id (what to open), team_id.

const NOTIFICATION_GROUPS = {
  leads: ['lead_new'],
  calls: ['lead_activity'],
  stages: ['lead_stage'],
  assignments: ['lead_assigned', 'transfer'],
  team: ['user_new'],
  properties: ['property_new'],
  hunting: ['hunt_stage', 'hunt_activity'],
  tasks: ['task_delayed'],
  keys: ['property_key'],
};

// D1 allows at most 5 terms per compound SELECT, so the sources are nested
// in groups of 4 (each group is a single term of the outer UNION).
const NOTIFICATION_SOURCES = [
  `SELECT l.created_at AS at, 'lead_new' AS type, NULL AS actor_id, COALESCE(l.customer_name, 'Unnamed enquiry') AS subject,
          l.source AS extra, COALESCE(l.project_name, l.property_type, l.location) AS detail, 'lead' AS ref_kind, l.id AS ref_id, l.team_id AS team_id
     FROM leads l`,
  `SELECT a.created_at, 'lead_activity', a.actor_user_id, COALESCE(l.customer_name, 'Unnamed enquiry'), a.type, a.subject, 'lead', l.id, l.team_id
     FROM lead_activities a JOIN leads l ON l.id = a.lead_id`,
  `SELECT s.created_at, 'lead_stage', s.actor_user_id, COALESCE(l.customer_name, 'Unnamed enquiry'), s.to_stage, s.note, 'lead', l.id, l.team_id
     FROM lead_stage_history s JOIN leads l ON l.id = s.lead_id`,
  `SELECT h.created_at, 'lead_assigned', h.actor_user_id, COALESCE(l.customer_name, 'Unnamed enquiry'), tu.name, h.reason, 'lead', l.id, COALESCE(h.to_team_id, l.team_id)
     FROM assignment_history h JOIN leads l ON l.id = h.lead_id LEFT JOIN users tu ON tu.id = h.to_user_id`,
  `SELECT r.created_at, 'transfer', r.from_user_id, COALESCE(l.customer_name, 'Unnamed enquiry'), tu.name, r.status || COALESCE(' · ' || r.note, ''), 'lead', l.id, l.team_id
     FROM lead_transfer_requests r JOIN leads l ON l.id = r.lead_id LEFT JOIN users tu ON tu.id = r.to_user_id`,
  `SELECT u.created_at, 'user_new', NULL, u.name, u.role, NULL, 'user', u.id, u.team_id
     FROM users u`,
  `SELECT p.created_at, 'property_new', p.created_by_user_id, p.name, NULL, COALESCE(p.locality, p.location), 'property', p.id, NULL
     FROM properties p WHERE p.pipeline = 'catalog'`,
  `SELECT s.created_at, 'hunt_stage', s.actor_user_id, t.name, s.to_stage, s.note, 'hunting_target', t.id, t.team_id
     FROM hunting_target_stage_history s JOIN hunting_targets t ON t.id = s.hunting_target_id`,
  `SELECT a.created_at, 'hunt_activity', a.actor_user_id, t.name, a.type, a.subject, 'hunting_target', t.id, t.team_id
     FROM hunting_target_activities a JOIN hunting_targets t ON t.id = a.hunting_target_id`,
  // Delayed To Do tasks (src/tasks.js workflow). team_id = the head's team so only that team's
  // manager sees it (admins see all); '__esc' hides it from every other manager.
  `SELECT t.escalated_at, 'task_delayed', NULL, t.title,
          COALESCE(ua.name, 'Someone') || '|' || MAX(1, CAST(julianday(date(t.escalated_at, '+330 minutes')) - julianday(t.due_date) AS INTEGER)) || '|1',
          'Open the task to send a reminder or hand it to someone else.', 'task', t.id, COALESCE(hd.team_id, '__esc')
     FROM tasks t LEFT JOIN users ua ON ua.id = t.assigned_to_user_id LEFT JOIN users hd ON hd.id = t.escalated_to_user_id
    WHERE t.escalated_at IS NOT NULL AND t.due_date IS NOT NULL`,
  `SELECT t.escalated2_at, 'task_delayed', NULL, t.title,
          COALESCE(ua.name, 'Someone') || '|' || MAX(1, CAST(julianday(date(t.escalated2_at, '+330 minutes')) - julianday(t.due_date) AS INTEGER)) || '|2',
          'Still not done after 3 days. The first manager was told earlier.', 'task', t.id, '__esc'
     FROM tasks t LEFT JOIN users ua ON ua.id = t.assigned_to_user_id
    WHERE t.escalated2_at IS NOT NULL AND t.due_date IS NOT NULL`,
  `SELECT e.created_at, 'property_key', e.actor_user_id, p.name, e.action, e.detail, 'property', p.id, NULL
     FROM property_key_events e JOIN properties p ON p.id = e.property_id WHERE p.pipeline = 'catalog'`,
];
const NOTIFICATION_EVENTS_SQL = Array.from({ length: Math.ceil(NOTIFICATION_SOURCES.length / 4) },
  (_, i) => `SELECT * FROM (${NOTIFICATION_SOURCES.slice(i * 4, i * 4 + 4).join(' UNION ALL ')})`).join(' UNION ALL ');

/** Managers see their own team plus company-wide events (no team, e.g. a new
 * property or an unrouted enquiry); administrators see everything. */
function notificationScope(actor, bind) {
  if (has(actor, 'lead.read_all')) return null;
  return `(e.team_id IS NULL OR e.team_id = ${bind(actor.team_id || '__none__')})`;
}

/**
 * Raise an in-app alert (owned by the notifications feature). Other features call this for
 * events people must not miss, e.g. a handover rejected, an NOC overdue, a price change on a
 * shortlisted property. Never throws.
 *   importance: 'normal' | 'medium' | 'high'   (high = must-see alert)
 *   to: { userIds?: string[], teamId?: string, roles?: string[] }  (empty = admins)
 *   title, body?, link?: { kind: 'lead'|'property'|'project'|'transaction'|'task', id }
 */
async function raiseAlert(env, { importance = 'normal', to = {}, title, body = null, link = null } = {}) {
  try {
    if (typeof storeAlert === 'function') await storeAlert(env, { importance, to, title, body, link }); // storeAlert: notifications feature
  } catch (e) { console.error('raiseAlert failed', e); }
}

// ---- alerts with importance (wave3) ----
// Tables alerts + alert_reads (migration 0071). The audience is resolved to
// concrete people when the alert is created; the built-in super administrator
// ('super-admin', not a users row) is treated as an admin. Identical system
// alerts (same title + importance + link) within an hour are grouped into one
// row (repeat_count) so a noisy event can't flood anyone.
const ALERT_IMPORTANCE = ['normal', 'medium', 'high'];
const ALERT_LINK_KINDS = ['lead', 'property', 'project', 'transaction', 'task'];
const ALERT_BROAD_ROLES = ['super_admin', 'admin', 'sales_head'];
const ALERT_SUPER_ID = 'super-admin';
setTaskAlertHook(raiseAlert); // delayed-task escalation (src/tasks.js) raises alerts through this

const alertIdList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))].slice(0, 500) : []);
async function alertIdsIn(env, sql, values) {
  const out = [];
  for (let i = 0; i < values.length; i += 90) {
    const part = values.slice(i, i + 90);
    const rows = (await env.DB.prepare(sql.replace('(?)', `(${part.map((_, j) => `?${j + 1}`).join(',')})`)).bind(...part).all()).results || [];
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/** { everyone?, userIds?, teamId?, roles? } -> distinct recipient ids. Empty = admins. */
async function resolveAlertAudience(env, to = {}) {
  const ids = new Set();
  const userIds = alertIdList(to.userIds);
  const roles = alertIdList(to.roles);
  const teamId = typeof to.teamId === 'string' && to.teamId.trim() ? to.teamId.trim() : null;
  const admins = async () => {
    ids.add(ALERT_SUPER_ID);
    ((await env.DB.prepare(`SELECT id FROM users WHERE is_active = 1 AND role IN ('admin', 'super_admin')`).all()).results || []).forEach((r) => ids.add(r.id));
  };
  if (to.everyone === true) {
    ids.add(ALERT_SUPER_ID);
    ((await env.DB.prepare('SELECT id FROM users WHERE is_active = 1').all()).results || []).forEach((r) => ids.add(r.id));
  }
  if (userIds.length) {
    if (userIds.includes(ALERT_SUPER_ID)) ids.add(ALERT_SUPER_ID);
    (await alertIdsIn(env, 'SELECT id FROM users WHERE is_active = 1 AND id IN (?)', userIds)).forEach((id) => ids.add(id));
  }
  if (teamId) {
    ((await env.DB.prepare(
      `SELECT id FROM users WHERE team_id = ?1 AND is_active = 1
       UNION SELECT u.id FROM teams t JOIN users u ON u.id = t.manager_user_id AND u.is_active = 1 WHERE t.id = ?1`
    ).bind(teamId).all()).results || []).forEach((r) => ids.add(r.id));
  }
  if (roles.length) {
    if (roles.includes('admin') || roles.includes('super_admin')) ids.add(ALERT_SUPER_ID);
    (await alertIdsIn(env, 'SELECT id FROM users WHERE is_active = 1 AND role IN (?)', roles)).forEach((id) => ids.add(id));
  }
  if (to.everyone !== true && !userIds.length && !teamId && !roles.length) await admins();
  return [...ids];
}

/** Stores an alert (called by raiseAlert, and by POST /api/alerts with senderId).
 *  Returns { id, recipients, grouped } or null. */
async function storeAlert(env, { importance = 'normal', to = {}, title, body = null, link = null, senderId = null, exclude = null } = {}) {
  const cleanTitle = String(title ?? '').trim().slice(0, 200);
  if (!cleanTitle) return null;
  const level = ALERT_IMPORTANCE.includes(importance) ? importance : 'normal';
  const text = body == null || body === '' ? null : String(body).trim().slice(0, 2000) || null;
  const linkKind = link && ALERT_LINK_KINDS.includes(link.kind) && link.id ? link.kind : null;
  const linkId = linkKind ? String(link.id) : null;
  let recipients = (await resolveAlertAudience(env, to)).filter((id) => id !== exclude);
  if (!recipients.length && !senderId) recipients = await resolveAlertAudience(env, {}); // nobody left to tell -> admins
  if (!recipients.length) return null;
  const addRecipients = (alertId) => {
    const ins = env.DB.prepare('INSERT OR IGNORE INTO alert_reads (alert_id, user_id) VALUES (?1, ?2)');
    return env.DB.batch(recipients.map((uid) => ins.bind(alertId, uid)));
  };
  if (!senderId) {
    const prev = await env.DB.prepare(
      `SELECT id FROM alerts WHERE sender_user_id IS NULL AND title = ?1 AND importance = ?2
          AND COALESCE(link_kind, '') = ?3 AND COALESCE(link_id, '') = ?4 AND last_at > datetime('now', '-1 hour')
        ORDER BY last_at DESC LIMIT 1`
    ).bind(cleanTitle, level, linkKind || '', linkId || '').first();
    if (prev) {
      await env.DB.prepare(`UPDATE alerts SET repeat_count = repeat_count + 1, last_at = datetime('now'), body = COALESCE(?2, body) WHERE id = ?1`).bind(prev.id, text).run();
      await addRecipients(prev.id);
      return { id: prev.id, recipients: recipients.length, grouped: true };
    }
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO alerts (id, importance, title, body, link_kind, link_id, sender_user_id, audience) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, level, cleanTitle, text, linkKind, linkId, senderId, JSON.stringify(to || {})).run();
  await addRecipients(id);
  return { id, recipients: recipients.length, grouped: false };
}

/** Friendly names for linked records: { 'lead:<id>': { name, code } }. Missing tables/columns are skipped. */
async function alertLinkLabels(env, rows) {
  const out = {};
  const sources = {
    lead: ['SELECT id, customer_name AS name, lead_code AS code FROM leads WHERE id IN (?)', 'SELECT id, customer_name AS name FROM leads WHERE id IN (?)'],
    property: ['SELECT id, name, property_code AS code FROM properties WHERE id IN (?)', 'SELECT id, name FROM properties WHERE id IN (?)'],
    project: ['SELECT id, name FROM projects WHERE id IN (?)'],
    transaction: ['SELECT id, txn_code AS code, txn_code AS name FROM transactions WHERE id IN (?)'],
    task: ['SELECT id, title AS name FROM tasks WHERE id IN (?)'],
  };
  for (const [kind, sqls] of Object.entries(sources)) {
    const ids = [...new Set(rows.filter((r) => r.link_kind === kind).map((r) => r.link_id))].slice(0, 90);
    if (!ids.length) continue;
    for (const sql of sqls) {
      try {
        const res = (await env.DB.prepare(sql.replace('(?)', `(${ids.map((_, j) => `?${j + 1}`).join(',')})`)).bind(...ids).all()).results || [];
        res.forEach((r) => { out[kind + ':' + r.id] = { name: r.name || null, code: r.code || null }; });
        break;
      } catch { /* column/table not there yet: try the simpler query */ }
    }
  }
  return out;
}

async function handleListAlerts(request, env, actor) {
  const limit = Math.max(1, Math.min(parseInt(new URL(request.url).searchParams.get('limit') ?? '40', 10) || 40, 100));
  const select = `SELECT a.id, a.importance, a.title, a.body, a.link_kind, a.link_id, a.sender_user_id, a.repeat_count, a.created_at, a.last_at,
         r.read_at, r.acknowledged_at,
         CASE WHEN a.sender_user_id = 'super-admin' THEN 'Super administrator' ELSE su.name END AS sender_name
    FROM alert_reads r JOIN alerts a ON a.id = r.alert_id LEFT JOIN users su ON su.id = a.sender_user_id`;
  const [list, pending, counts] = await Promise.all([
    env.DB.prepare(`${select} WHERE r.user_id = ?1 AND (r.read_at IS NULL OR a.last_at > datetime('now', '-30 days'))
      ORDER BY (r.read_at IS NULL) DESC, a.last_at DESC LIMIT ${limit}`).bind(actor.id).all(),
    env.DB.prepare(`${select} WHERE r.user_id = ?1 AND a.importance = 'high' AND r.acknowledged_at IS NULL ORDER BY a.last_at ASC LIMIT 20`).bind(actor.id).all(),
    env.DB.prepare(`SELECT COUNT(*) AS unread, SUM(CASE WHEN a.importance = 'high' THEN 1 ELSE 0 END) AS unread_high
      FROM alert_reads r JOIN alerts a ON a.id = r.alert_id WHERE r.user_id = ?1 AND r.read_at IS NULL`).bind(actor.id).first(),
  ]);
  const alerts = list.results || [];
  const high = pending.results || [];
  const labels = await alertLinkLabels(env, [...alerts, ...high]);
  const withLabel = (a) => ({ ...a, link_label: a.link_kind ? labels[a.link_kind + ':' + a.link_id] || null : null });
  return json({ alerts: alerts.map(withLabel), pending_high: high.map(withLabel), unread_count: counts?.unread || 0, unread_high: counts?.unread_high || 0 });
}

async function handleAlertMark(env, actor, alertId, action) {
  const sql = action === 'ack'
    ? `UPDATE alert_reads SET acknowledged_at = COALESCE(acknowledged_at, datetime('now')), read_at = COALESCE(read_at, datetime('now')) WHERE alert_id = ?1 AND user_id = ?2`
    : `UPDATE alert_reads SET read_at = COALESCE(read_at, datetime('now')),
         acknowledged_at = CASE WHEN (SELECT importance FROM alerts WHERE id = ?1) = 'high' THEN acknowledged_at ELSE COALESCE(acknowledged_at, datetime('now')) END
       WHERE alert_id = ?1 AND user_id = ?2`;
  const res = await env.DB.prepare(sql).bind(alertId, actor.id).run();
  if (!res.meta?.changes) return fail('Alert not found.', 404);
  return json({ ok: true });
}

/** Opening the bell marks every normal / medium alert read; high alerts wait for "Got it". */
async function handleAlertReadAll(env, actor) {
  await env.DB.prepare(
    `UPDATE alert_reads SET read_at = datetime('now') WHERE user_id = ?1 AND read_at IS NULL
        AND alert_id IN (SELECT id FROM alerts WHERE importance <> 'high')`
  ).bind(actor.id).run();
  return json({ ok: true });
}

/** Teams this person leads: their own team plus any team they manage. */
async function alertSenderTeams(env, actor) {
  const ids = new Set(actor.team_id ? [actor.team_id] : []);
  if (actor.id !== ALERT_SUPER_ID) {
    ((await env.DB.prepare('SELECT id FROM teams WHERE manager_user_id = ?1').bind(actor.id).all()).results || []).forEach((r) => ids.add(r.id));
  }
  return ids;
}

async function handleSendAlert(request, env, actor) {
  if (!has(actor, 'alert.send')) return fail('You do not have permission to send alerts.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const importance = body.importance;
  if (!['medium', 'high'].includes(importance)) return fail('Choose how important it is: medium or high.', 422);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return fail('Add a short title.', 422);
  if (title.length > 200) return fail('Keep the title under 200 characters.', 422);
  const message = typeof body.message === 'string' ? body.message.trim() : typeof body.body === 'string' ? body.body.trim() : '';
  if (message.length > 2000) return fail('Keep the message under 2000 characters.', 422);

  const raw = body.to && typeof body.to === 'object' ? body.to : {};
  const to = {};
  if (raw.everyone === true) to.everyone = true;
  if (typeof raw.teamId === 'string' && raw.teamId.trim()) to.teamId = raw.teamId.trim();
  const userIds = alertIdList(raw.userIds);
  if (userIds.length) to.userIds = userIds;
  const roles = alertIdList(raw.roles).filter((r) => Object.hasOwn(ROLE_PERMISSIONS, r));
  if (roles.length) to.roles = roles;
  if (!to.everyone && !to.teamId && !to.userIds && !to.roles) return fail('Choose who should get this alert.', 422);

  if (!ALERT_BROAD_ROLES.includes(actor.role)) {
    // Managers / team leaders: only their own team or people in it.
    if (to.everyone || to.roles) return fail('You can send alerts only to your own team or people in it.', 403);
    const mine = await alertSenderTeams(env, actor);
    if (to.teamId && !mine.has(to.teamId)) return fail('You can send alerts only to your own team.', 403);
    if (to.userIds) {
      if (!mine.size) return fail('You can send alerts only to people in your team.', 403);
      const teamList = [...mine];
      const rows = await alertIdsIn(env, `SELECT id FROM users WHERE id IN (?) AND team_id IN (${teamList.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`, to.userIds);
      if (rows.length !== to.userIds.length) return fail('You can send alerts only to people in your team.', 403);
    }
  } else if (to.teamId && !(await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?1').bind(to.teamId).first())) {
    return fail('That team was not found.', 422);
  }

  let link = null;
  if (body.link && typeof body.link === 'object' && typeof body.link.code === 'string' && body.link.code.trim()) {
    const kind = body.link.kind;
    const code = body.link.code.trim();
    const table = { lead: ['leads', 'lead_code', 'lead'], property: ['properties', 'property_code', 'property'] }[kind];
    if (!table) return fail('A link can point to a lead or a property.', 422);
    let row = null;
    try { row = await env.DB.prepare(`SELECT id FROM ${table[0]} WHERE upper(${table[1]}) = upper(?1) OR id = ?1 LIMIT 1`).bind(code).first(); }
    catch { row = await env.DB.prepare(`SELECT id FROM ${table[0]} WHERE id = ?1`).bind(code).first(); }
    if (!row) return fail(`No ${table[2]} found with code ${code}.`, 422);
    link = { kind, id: row.id };
  }

  const saved = await storeAlert(env, { importance, to, title, body: message || null, link, senderId: actor.id, exclude: actor.id });
  if (!saved) return fail('Nobody to send this to — the people you picked are inactive (or it is only you).', 422);
  return json({ ok: true, id: saved.id, recipients: saved.recipients }, 201);
}

async function handleListNotifications(request, env, actor) {
  if (!has(actor, 'lead.assign_direct')) return fail('Only managers and administrators can see the notification feed.', 403);
  const url = new URL(request.url);
  const binds = [];
  const bind = (v) => { binds.push(v); return `?${binds.length}`; };
  const filters = [];
  const scope = notificationScope(actor, bind);
  if (scope) filters.push(scope);
  const scopeOnly = [...filters];
  const scopeBinds = [...binds];

  const groups = (url.searchParams.get('types') || '').split(',').map((g) => g.trim()).filter((g) => NOTIFICATION_GROUPS[g]);
  if (groups.length) filters.push(`e.type IN (${groups.flatMap((g) => NOTIFICATION_GROUPS[g]).map((t) => `'${t}'`).join(',')})`);
  const person = url.searchParams.get('actor_id');
  if (person) filters.push(`e.actor_id = ${bind(person)}`);
  const team = url.searchParams.get('team_id');
  if (team) filters.push(`e.team_id = ${bind(team)}`);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (from && !isDate(from) || to && !isDate(to)) return fail('from/to must be dates in YYYY-MM-DD format.', 422);
  if (from) filters.push(`date(e.at) >= ${bind(from)}`);
  if (to) filters.push(`date(e.at) <= ${bind(to)}`);
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    const like = bind(`%${q}%`);
    filters.push(`(lower(COALESCE(e.subject,'') || ' ' || COALESCE(e.extra,'') || ' ' || COALESCE(e.detail,'') || ' ' || COALESCE(au.name,'')) LIKE lower(${like}))`);
  }
  const order = url.searchParams.get('sort') === 'oldest' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const read = await env.DB.prepare('SELECT last_read_at FROM notification_reads WHERE user_id = ?1').bind(actor.id).first();
  const lastReadAt = read?.last_read_at || '1970-01-01 00:00:00';
  const unreadWhere = [...scopeOnly, `e.at > ?${scopeBinds.length + 1}`, `COALESCE(e.actor_id, '') != ?${scopeBinds.length + 2}`];

  const [rows, total, unread] = await Promise.all([
    env.DB.prepare(
      `SELECT e.*, COALESCE(au.name, CASE WHEN e.actor_id = 'super-admin' THEN 'Super administrator' END) AS actor_name
         FROM (${NOTIFICATION_EVENTS_SQL}) e LEFT JOIN users au ON au.id = e.actor_id
         ${where} ORDER BY e.at ${order} LIMIT ${limit} OFFSET ${offset}`
    ).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${NOTIFICATION_EVENTS_SQL}) e LEFT JOIN users au ON au.id = e.actor_id ${where}`).bind(...binds).first('n'),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${NOTIFICATION_EVENTS_SQL}) e WHERE ${unreadWhere.join(' AND ')}`).bind(...scopeBinds, lastReadAt, actor.id).first('n'),
  ]);
  return json({ notifications: rows.results ?? [], total, unread_count: unread, last_read_at: read?.last_read_at || null });
}

async function handleMarkNotificationsRead(env, actor) {
  if (!has(actor, 'lead.assign_direct')) return fail('Only managers and administrators can see the notification feed.', 403);
  await env.DB.prepare(
    `INSERT INTO notification_reads (user_id, last_read_at) VALUES (?1, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_read_at = excluded.last_read_at`
  ).bind(actor.id).run();
  return json({ ok: true });
}

async function handleCreateManualLead(request, env, actor) {
  if (!has(actor, 'lead.create')) return fail('You do not have permission to add leads manually.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!customerName) return fail('Customer name is required.', 422);
  if (!phone && !email) return fail('Provide a phone number or email address.', 422);

  const source = typeof body.source === 'string' && body.source.trim()
    ? body.source.trim().toLowerCase()
    : 'manual';
  if (!MANUAL_LEAD_SOURCES.includes(source)) return fail('Choose a valid lead source.', 422);

  const requestedStatus = typeof body.status === 'string' && body.status.trim()
    ? body.status.trim()
    : null;
  if (requestedStatus && !LEAD_STATUSES.includes(requestedStatus)) return fail('Choose a valid lead status.', 422);

  const clientStatus = typeof body.client_status === 'string' && body.client_status.trim()
    ? body.client_status.trim()
    : null;
  if (clientStatus && !CLIENT_STATUSES.includes(clientStatus)) return fail('Choose a valid client status.', 422);

  // Whoever enters a lead by hand has spoken to the customer, so the market
  // research level is mandatory here (portal/website intake leaves it NULL).
  const researchLevel = typeof body.research_level === 'string' ? body.research_level.trim() : '';
  if (!RESEARCH_LEVELS.includes(researchLevel)) return fail(RESEARCH_LEVEL_MESSAGE, 422);

  const assignedUserId = typeof body.assigned_user_id === 'string' && body.assigned_user_id.trim()
    ? body.assigned_user_id.trim()
    : null;
  let assignedUser = null;
  if (assignedUserId) {
    if (!has(actor, 'lead.assign_direct')) return fail('You do not have permission to choose the lead owner.', 403);
    assignedUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(assignedUserId).first();
    if (!assignedUser?.is_active || assignedUser.role === 'viewer') return fail('Choose an active employee who can work this lead.', 422);
    // A manager can create a lead only for their own team. This mirrors the
    // team boundary already enforced when that manager later reassigns a lead.
    if (TEAM_HEAD_ROLES.includes(actor.role) && assignedUser.team_id !== actor.team_id) {
      return fail('Managers can choose an employee from their own team only.', 403);
    }
  } else if (!has(actor, 'lead.assign_direct')) {
    // A walk-in an employee enters is their own lead to work. This is not an
    // auto-routing decision, so it does not need a manager's approval.
    assignedUser = actor;
  }

  const id = crypto.randomUUID();
  const budgetMin = parseMoney(body.budget_min);
  const budgetMax = parseMoney(body.budget_max);
  const status = requestedStatus || (assignedUser ? 'assigned' : 'new');
  const stage = status === 'converted' ? 'won' : status === 'dead' ? 'lost' : 'new';
  const statements = [
    env.DB.prepare(`INSERT INTO leads (
      id,source,customer_name,phone,email,project_name,property_type,location,budget_min,budget_max,
      priority,status,stage,client_status,assigned_user_id,team_id,raw_payload,research_level
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`).bind(
      id, source, customerName, phone || null, email || null,
      typeof body.project_name === 'string' ? body.project_name.trim() || null : null,
      typeof body.property_type === 'string' ? body.property_type.trim() || null : null,
      typeof body.location === 'string' ? body.location.trim() || null : null,
      budgetMin, budgetMax, PRIORITIES.includes(body.priority) ? body.priority : 'normal',
      status, stage, clientStatus, assignedUser?.id || null, assignedUser?.team_id || null,
      JSON.stringify({ ...body, entry: 'manual' }), researchLevel
    ),
  ];

  if (assignedUser) {
    statements.push(env.DB.prepare(
      `INSERT INTO assignment_history (lead_id,to_user_id,to_team_id,reason,actor_user_id)
       VALUES (?1,?2,?3,'manual',?4)`
    ).bind(id, assignedUser.id, assignedUser.team_id || null, actor.id));
  }

  // The auto-assignment trigger correctly chooses an owner first. A manually
  // selected status is then restored after that trigger has set its default
  // of new/assigned, so the value chosen in the form is the stored value.
  if (requestedStatus) {
    statements.push(env.DB.prepare('UPDATE leads SET status = ?2, stage = ?3 WHERE id = ?1')
      .bind(id, requestedStatus, stage));
  }

  await env.DB.batch(statements);
  return handleGetLead(env, id, actor);
}

async function handleListProperties(request, env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view the property catalogue.', 403);
  const url = new URL(request.url);
  const filters = ['p.is_active = 1', "p.pipeline = 'catalog'"];
  const binds = [];
  const bind = value => { binds.push(value); return `?${binds.length}`; };
  const query = url.searchParams.get('query')?.trim();
  const type = url.searchParams.get('property_type')?.trim();
  const location = url.searchParams.get('location')?.trim();
  const budgetMin = parseMoney(url.searchParams.get('budget_min'));
  const budgetMax = parseMoney(url.searchParams.get('budget_max'));
  const constructionStatus = url.searchParams.get('construction_status')?.trim();
  if (constructionStatus && CONSTRUCTION_STATUSES.includes(constructionStatus)) filters.push(`p.construction_status = ${bind(constructionStatus)}`);
  const queryCode = recordCodeQuery(query, 'P'); // wave3 B: find by "P-00012" / "p-12" / "12"
  if (query) { const a=bind(`%${query}%`), b=bind(`%${query}%`), c=bind(`%${query}%`); filters.push(`(lower(p.name) LIKE lower(${a}) OR lower(COALESCE(p.developer,'')) LIKE lower(${b}) OR lower(COALESCE(p.location,'')) LIKE lower(${c})${queryCode ? ` OR p.property_code = ${bind(queryCode)}` : ''})`); }
  if (type) {
    const alternatives = propertyTypeTerms(type);
    const clauses = alternatives.map(term => `lower(COALESCE(p.property_type,'')) LIKE lower(${bind(`%${term}%`)})`);
    filters.push(`(${clauses.join(' OR ')})`);
  }
  if (location) { const a=bind(`%${location}%`), b=bind(`%${location}%`); filters.push(`(lower(p.location) LIKE lower(${a}) OR lower(COALESCE(p.locality,'')) LIKE lower(${b}))`); }
  if (budgetMin !== null) filters.push(`(p.budget_max IS NULL OR p.budget_max >= ${bind(budgetMin)})`);
  if (budgetMax !== null) filters.push(`(p.budget_min IS NULL OR p.budget_min <= ${bind(budgetMax)})`);
  inventoryListFilters(url, filters, bind, type || location || budgetMin !== null || budgetMax !== null); // inventory status + zone (0066)
  const { results } = await env.DB.prepare(
    `SELECT p.*, b.logo_r2_key AS builder_logo_r2_key,
            (SELECT COUNT(*) FROM favourites f WHERE f.user_id = ${bind(actor.id)} AND f.kind = 'property' AND f.item_id = p.id) AS is_favourite,
            ${KEY_SUMMARY_SQL},
            (SELECT name FROM teams WHERE id = p.assigned_team_id) AS assigned_team_name,
            (SELECT json_group_array(json_object('id', id, 'url', '/api/images/' || id,
                                                  'title', title, 'category', category, 'sort_order', sort_order))
               FROM (SELECT id, title, category, sort_order FROM property_images
                     WHERE property_id = p.id ORDER BY sort_order ASC, created_at ASC)) AS images_json
       FROM properties p LEFT JOIN builders b ON b.id = p.builder_id WHERE ${filters.join(' AND ')} ORDER BY p.name LIMIT 100`
  ).bind(...binds).all();
  const wantedType = canonicalPropertyType(type);
  const wantedLocation = location?.toLowerCase();
  const properties = (results ?? []).map(({ images_json, builder_logo_r2_key, ...property }) => {
    property.builder_logo_url = builder_logo_r2_key ? `/api/builders/${property.builder_id}/logo` : null;
    let score = 0;
    const reasons = [];
    if (wantedType && canonicalPropertyType(property.property_type) === wantedType) { score += 50; reasons.push('property type'); }
    const propertyLocation = `${property.location || ''} ${property.locality || ''}`.toLowerCase();
    if (wantedLocation && propertyLocation.includes(wantedLocation)) { score += 30; reasons.push('location'); }
    const pMin = property.budget_min, pMax = property.budget_max;
    if ((budgetMin !== null || budgetMax !== null) && (pMax === null || pMax === undefined || pMax >= (budgetMin ?? 0)) && (pMin === null || pMin === undefined || pMin <= (budgetMax ?? Number.MAX_SAFE_INTEGER))) { score += 20; reasons.push('budget'); }
    if (query && `${property.name} ${property.developer || ''}`.toLowerCase().includes(query.toLowerCase())) { score += 15; reasons.push('project name'); }
    if (queryCode && property.property_code === queryCode) { score += 100; reasons.push('reference code'); }
    return { ...property, images: JSON.parse(images_json || '[]'), match_score: score, match_reasons: reasons };
  }).sort((a, b) => b.match_score - a.match_score || a.name.localeCompare(b.name));
  properties.forEach(keySummaryFields);
  return json({ properties });
}

/**
 * The hunting team's "Properties" page: every property a target in their scope
 * carries — the draft being sourced (pipeline 'hunting', only they see it) or,
 * once converted, the published listing. Same visibility rule as targets
 * (own / team / all), dropped targets left out. Drafts show the target's site
 * photos; listings show their catalogue photos.
 */
async function handleListHuntingProperties(env, actor) {
  const binds = [];
  const bind = (value) => { binds.push(value); return `?${binds.length}`; };
  const scope = huntingScopeClause(actor, bind);
  if (scope === null) return fail('You do not have permission to view hunting properties.', 403);
  const where = ['p.is_active = 1', "t.stage != 'dropped'", scope].filter(Boolean).join(' AND ');
  const { results } = await env.DB.prepare(
    `SELECT p.*, b.logo_r2_key AS builder_logo_r2_key,
            (SELECT COUNT(*) FROM favourites f WHERE f.user_id = ${bind(actor.id)} AND f.kind = 'property' AND f.item_id = p.id) AS is_favourite,
            t.id AS hunting_target_id, t.stage AS hunting_stage, t.converted_property_id AS hunting_converted_id,
            COALESCE(o.name, t.owner_name) AS hunting_owner_name,
            ${KEY_SUMMARY_SQL},
            CASE WHEN t.converted_property_id IS NULL THEN
              (SELECT json_group_array(json_object('id', id, 'url', '/api/hunting-images/' || id, 'title', title, 'category', category, 'sort_order', sort_order))
                 FROM (SELECT id, title, category, sort_order FROM hunting_target_images WHERE hunting_target_id = t.id ORDER BY sort_order, created_at))
            ELSE
              (SELECT json_group_array(json_object('id', id, 'url', '/api/images/' || id, 'title', title, 'category', category, 'sort_order', sort_order))
                 FROM (SELECT id, title, category, sort_order FROM property_images WHERE property_id = p.id ORDER BY sort_order ASC, created_at ASC))
            END AS images_json
       FROM hunting_targets t
       JOIN properties p ON p.id = COALESCE(t.converted_property_id, t.draft_property_id)
       LEFT JOIN builders b ON b.id = p.builder_id
       LEFT JOIN hunting_owners o ON o.id = t.owner_id
      WHERE ${where}
      ORDER BY p.updated_at DESC, p.name LIMIT 300`
  ).bind(...binds).all();
  const properties = (results ?? []).map(({ images_json, builder_logo_r2_key, hunting_converted_id, ...property }) => ({
    ...property,
    builder_logo_url: builder_logo_r2_key ? `/api/builders/${property.builder_id}/logo` : null,
    hunt_status: hunting_converted_id ? 'listed' : 'sourcing',
    images: JSON.parse(images_json || '[]'),
  }));
  properties.forEach(keySummaryFields);
  return json({ properties });
}

// ---- Keys of a property ----
// Which keys exist (main door, bedroom, balcony, other) and where each set is
// right now: with the owner, taken by an employee, or deposited at the office.
// Anyone who can see the property may change who holds a key; adding, editing
// and removing the keys themselves is for catalogue managers and, for a
// property the hunting team is sourcing, the people who can update its target.

const KEY_KINDS = ['main_door', 'bedroom', 'balcony', 'other'];
const KEY_KIND_LABEL = { main_door: 'Main door', bedroom: 'Bedroom', balcony: 'Balcony', other: 'Key' };
const KEY_MAX_PER_PROPERTY = 30;

/** Compact per-property summary for the property cards, computed in the list
 * query itself (one subquery, no N+1). Alias the properties table as `p`. */
const KEY_SUMMARY_SQL = `(SELECT json_object('rows', COUNT(*), 'copies', COALESCE(SUM(k.copies), 0),
            'owner', COALESCE(SUM(k.status = 'owner'), 0), 'employee', COALESCE(SUM(k.status = 'employee'), 0),
            'deposited', COALESCE(SUM(k.status = 'deposited'), 0),
            'holders', (SELECT group_concat(held_by_name, ', ')
                          FROM (SELECT DISTINCT held_by_name FROM property_keys
                                 WHERE property_id = p.id AND status = 'employee' AND held_by_name IS NOT NULL)))
       FROM property_keys k WHERE k.property_id = p.id) AS key_summary_json`;

/** Turn `key_summary_json` on a list row into `key_summary` (null when no keys are recorded). */
function keySummaryFields(property) {
  let summary = null;
  try { summary = property.key_summary_json ? JSON.parse(property.key_summary_json) : null; } catch { summary = null; }
  delete property.key_summary_json;
  property.key_summary = summary && summary.rows > 0 ? summary : null;
}

/** Who may look at / change the keys of this property. */
async function propertyKeyAccess(env, actor, propertyId) {
  const property = await env.DB.prepare('SELECT id, name, pipeline FROM properties WHERE id = ?1').bind(propertyId).first();
  if (!property) return { response: fail('Property not found.', 404) };
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE draft_property_id = ?1 OR converted_property_id = ?1 LIMIT 1').bind(propertyId).first();
  const huntRead = !!target && canReadHuntingTarget(actor, target);
  const huntWrite = !!target && canUpdateHuntingTarget(actor, target);
  const catalog = property.pipeline === 'catalog';
  const canView = catalog ? (has(actor, 'team.read') || huntRead) : huntRead;
  if (!canView) return { response: fail('You do not have permission to see the keys of this property.', 403) };
  const canManage = catalog ? (canCreateCatalog(actor) || huntWrite) : huntWrite;
  return { property, canManage };
}

async function loadPropertyKeys(env, propertyId) {
  const { results } = await env.DB.prepare('SELECT * FROM property_keys WHERE property_id = ?1 ORDER BY sort_order, created_at').bind(propertyId).all();
  const keys = results ?? [];
  const summary = {
    rows: keys.length, copies: keys.reduce((n, k) => n + k.copies, 0),
    owner: keys.filter((k) => k.status === 'owner').length,
    employee: keys.filter((k) => k.status === 'employee').length,
    deposited: keys.filter((k) => k.status === 'deposited').length,
    holders: [...new Set(keys.filter((k) => k.status === 'employee' && k.held_by_name).map((k) => k.held_by_name))].join(', ') || null,
  };
  return { keys, summary: summary.rows ? summary : null };
}

const keyEvent = (env, propertyId, key, action, actor, detail = null) => env.DB.prepare(
  `INSERT INTO property_key_events (id, property_id, key_id, key_label, action, actor_user_id, detail) VALUES (?1,?2,?3,?4,?5,?6,?7)`
).bind(crypto.randomUUID(), propertyId, key.id, key.label, action, actorUserId(actor), detail);

function normaliseKeyFields(body, existing = null) {
  const kind = body.kind === undefined ? (existing?.kind ?? 'other') : body.kind;
  if (!KEY_KINDS.includes(kind)) return { error: 'Choose main door, bedroom, balcony or other.' };
  let label = body.label === undefined ? existing?.label : (typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '');
  if (!label) label = KEY_KIND_LABEL[kind];
  let copies = body.copies === undefined ? (existing?.copies ?? 1) : parseInt(body.copies, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 20) return { error: 'Number of copies must be between 1 and 20.' };
  const notes = body.notes === undefined ? (existing?.notes ?? null) : (typeof body.notes === 'string' ? body.notes.trim().slice(0, 300) || null : null);
  return { value: { kind, label, copies, notes } };
}

async function handlePropertyKeys(request, env, propertyId, keyId, custody, actor) {
  const access = await propertyKeyAccess(env, actor, propertyId);
  if (access.response) return access.response;
  const reply = async (status = 200) => json({ ...(await loadPropertyKeys(env, propertyId)), can_manage: access.canManage }, status);
  if (request.method === 'GET' && !keyId) return reply();

  const key = keyId ? await env.DB.prepare('SELECT * FROM property_keys WHERE id = ?1 AND property_id = ?2').bind(keyId, propertyId).first() : null;
  if (keyId && !key) return fail('Key not found.', 404);

  // Who holds the key: the custody buttons. Open to anyone who can see the property.
  if (custody && request.method === 'POST') {
    const body = await bodyJson(request);
    if (!body) return fail('JSON object required.', 400);
    const me = actorUserId(actor);
    const myName = actor.name || 'Someone';
    if (body.action === 'take') {
      let holderId = me, holderName = myName;
      if (body.user_id && body.user_id !== actor.id) {
        const user = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?1 AND is_active = 1').bind(String(body.user_id)).first();
        if (!user) return fail('That employee was not found.', 422);
        holderId = user.id; holderName = user.name;
      }
      const handed = holderId !== me;
      await env.DB.batch([
        env.DB.prepare(`UPDATE property_keys SET status = 'employee', held_by_user_id = ?2, held_by_name = ?3, taken_at = datetime('now'),
                          deposit_place = NULL, deposited_by = NULL, deposited_at = NULL, updated_at = datetime('now') WHERE id = ?1`).bind(key.id, holderId, holderName),
        keyEvent(env, propertyId, key, handed ? 'handed' : 'taken', actor, handed ? `${key.label} to ${holderName}` : key.label),
      ]);
    } else if (body.action === 'deposit') {
      const place = typeof body.deposit_place === 'string' ? body.deposit_place.trim().slice(0, 80) || null : null;
      const by = typeof body.deposited_by === 'string' ? body.deposited_by.trim().slice(0, 80) || myName : myName;
      await env.DB.batch([
        env.DB.prepare(`UPDATE property_keys SET status = 'deposited', held_by_user_id = NULL, held_by_name = NULL, deposit_place = ?2, deposited_by = ?3,
                          deposited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(key.id, place || 'Office', by),
        keyEvent(env, propertyId, key, 'deposited', actor, key.label),
      ]);
    } else if (body.action === 'return') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE property_keys SET status = 'owner', held_by_user_id = NULL, held_by_name = NULL, taken_at = NULL,
                          deposit_place = NULL, deposited_by = NULL, deposited_at = NULL, updated_at = datetime('now') WHERE id = ?1`).bind(key.id),
        keyEvent(env, propertyId, key, 'returned', actor, key.label),
      ]);
    } else return fail('Choose take, deposit or return.', 422);
    return reply();
  }

  // Everything below changes the list of keys itself.
  if (!access.canManage) return fail('Only administrators (or the hunting team on a property they are sourcing) can add, edit or remove keys.', 403);

  if (request.method === 'POST' && !keyId) {
    const body = await bodyJson(request);
    if (!body) return fail('JSON object required.', 400);
    const items = Array.isArray(body.keys) ? body.keys : [body];
    if (!items.length || items.length > 10) return fail('Add between 1 and 10 keys at a time.', 422);
    const existing = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), -1) AS top FROM property_keys WHERE property_id = ?1').bind(propertyId).first();
    if (existing.n + items.length > KEY_MAX_PER_PROPERTY) return fail(`A property can have at most ${KEY_MAX_PER_PROPERTY} keys.`, 422);
    const statements = [];
    for (const [i, item] of items.entries()) {
      const f = normaliseKeyFields(item && typeof item === 'object' ? item : {});
      if (f.error) return fail(f.error, 422);
      const id = crypto.randomUUID();
      statements.push(
        env.DB.prepare('INSERT INTO property_keys (id, property_id, label, kind, copies, notes, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7)')
          .bind(id, propertyId, f.value.label, f.value.kind, f.value.copies, f.value.notes, existing.top + 1 + i),
        keyEvent(env, propertyId, { id, label: f.value.label }, 'added', actor, f.value.label),
      );
    }
    await env.DB.batch(statements);
    return reply(201);
  }

  if (request.method === 'PATCH' && key) {
    const body = await bodyJson(request);
    if (!body) return fail('JSON object required.', 400);
    const f = normaliseKeyFields(body, key);
    if (f.error) return fail(f.error, 422);
    await env.DB.prepare(`UPDATE property_keys SET label = ?2, kind = ?3, copies = ?4, notes = ?5, updated_at = datetime('now') WHERE id = ?1`)
      .bind(key.id, f.value.label, f.value.kind, f.value.copies, f.value.notes).run();
    return reply();
  }

  if (request.method === 'DELETE' && key) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM property_keys WHERE id = ?1').bind(key.id),
      keyEvent(env, propertyId, key, 'removed', actor, key.label),
    ]);
    return reply();
  }
  return fail('Not found.', 404);
}

/** Comma-separated, deduped, alphabetised location list — the format `builders.locations` is stored in. */
function mergeLocations(existingCsv, addition) {
  const set = new Set((existingCsv || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (addition && addition.trim()) set.add(addition.trim());
  return [...set].sort((a, b) => a.localeCompare(b)).join(', ');
}

/**
 * Find-or-create a builder by name (case-insensitive) and fold in a newly
 * seen location. This is what makes "every location a builder operates in"
 * something the app maintains on its own, rather than data entry someone has
 * to keep in sync by hand every time a property is added.
 */
async function resolveBuilder(env, name, location) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const existing = await env.DB.prepare('SELECT * FROM builders WHERE lower(name) = lower(?1)').bind(trimmed).first();
  if (existing) {
    const merged = mergeLocations(existing.locations, location);
    if (merged !== existing.locations) {
      await env.DB.prepare('UPDATE builders SET locations = ?2 WHERE id = ?1').bind(existing.id, merged).run();
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO builders (id, name, locations) VALUES (?1, ?2, ?3)')
    .bind(id, trimmed, mergeLocations('', location)).run();
  return id;
}

/** A builder's hosted brochure must be a normal web link. Keeping this strict
 * prevents a catalogue entry from becoming a script/data URL when rendered as
 * a client-facing link in the browser. */
function normaliseBuilderBrochureUrl(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Builder brochure link must be a web address.' };
  const raw = value.trim();
  if (!raw) return { value: null };
  if (raw.length > 2048) return { error: 'Builder brochure link must be 2,048 characters or fewer.' };
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'Builder brochure link must start with http:// or https://.' };
    return { value: url.href };
  } catch {
    return { error: 'Enter a valid builder brochure web address.' };
  }
}

/** Tower counts describe a society/project, so zero, decimals, and free text
 * are not meaningful values. Keep the same rule for API clients and the
 * property wizard. */
function normaliseTowerCount(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string' && typeof value !== 'number') return { error: 'Number of towers must be a positive whole number.' };
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return { error: 'Number of towers must be a positive whole number.' };
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 1) return { error: 'Number of towers must be a positive whole number.' };
  return { value: count };
}

/** Shared by create and update — the wizard always submits the full shape
 *  either way, so both can normalise/validate identically. */
function normalisePropertyFields(body, builderBrochureUrl, towerCount) {
  const bedroomCount = parseCount(body.bedroom_count);
  const constructionStatus = CONSTRUCTION_STATUSES.includes(body.construction_status) ? body.construction_status : 'under_construction';
  const extra = propertyContactFields(body);
  return {
    name: body.name?.trim() || null,
    developer: body.developer?.trim() || null,
    property_type: body.property_type?.trim() || null,
    listing_type: LISTING_TYPES.includes(body.listing_type) ? body.listing_type : 'sell',
    category: PROPERTY_CATEGORIES.includes(body.category) ? body.category : 'residential',
    location: body.location?.trim() || null,
    locality: body.locality?.trim() || null,
    sub_locality: body.sub_locality?.trim() || null,
    society_name: body.society_name?.trim() || null,
    tower_count: towerCount,
    house_no: body.house_no?.trim() || null,
    carpet_area_sqft: parseCount(body.carpet_area_sqft),
    bedroom_count: bedroomCount,
    bathroom_count: parseCount(body.bathroom_count),
    balcony_count: parseCount(body.balcony_count),
    total_floors: parseCount(body.total_floors),
    floor_number: parseCount(body.floor_number),
    // A property that is newly launched or still being built has no meaningful
    // age (unless it's a resale). Keep this invariant on the server as well as in the wizard UI.
    age_of_property: (extra.sale_type === 'resale' || !PRE_COMPLETION_CONSTRUCTION_STATUSES.has(constructionStatus)) && PROPERTY_AGES.includes(body.age_of_property) ? body.age_of_property : null,
    price_expected: parseMoney(body.price_expected),
    price_per_sqft: parseMoney(body.price_per_sqft),
    price_negotiable: body.price_negotiable ? 1 : 0,
    price_all_inclusive: body.price_all_inclusive ? 1 : 0,
    budget_min: parseMoney(body.budget_min),
    budget_max: parseMoney(body.budget_max),
    // A precise "3" from the wizard's bedroom pills displays better than
    // nothing, but never overrides a summary someone typed by hand (e.g.
    // "2 and 3 BHK" for a project spanning configurations).
    bedrooms: body.bedrooms?.trim() || (bedroomCount ? `${bedroomCount} BHK` : null),
    availability: ['yes', 'no'].includes(body.availability) ? body.availability : 'yes',
    construction_status: constructionStatus,
    description: body.description?.trim() || null,
    builder_brochure_url: builderBrochureUrl,
    is_active: body.is_active === false ? 0 : 1,
    ...extra,
    ...plotPropertyOverrides(body, extra),
  };
}

// ---- plots (0058) ----
// A plot (residential or commercial land) has no BHK / floors / tower / age. Square feet per unit,
// so the one area number the rest of the app sorts and filters on (carpet_area_sqft) still works.
const PLOT_UNIT_SQFT = { sqft: 1, sqyd: 9, guntha: 1089, acre: 43560 };
const PLOT_FACINGS = ['north', 'south', 'east', 'west', 'north_east', 'north_west', 'south_east', 'south_west'];
const PLOT_LAND_USES = ['na', 'agricultural', 'residential', 'commercial', 'industrial'];
const isPlotType = (type) => canonicalPropertyType(type) === 'plot';
const PLOT_KEYS = ['plot_area', 'plot_area_unit', 'plot_dimensions', 'plot_facing', 'plot_road_width', 'plot_corner', 'plot_boundary_wall', 'plot_land_use', 'plot_clear_title'];
/** Tidy the plot_* values on `f` (already trimmed strings from the registry); everything is null unless the type is a plot. */
function normalisePlotFields(body, f) {
  if (!isPlotType(body.property_type)) { for (const k of PLOT_KEYS) f[k] = null; return; }
  const area = Number(String(body.plot_area ?? '').replace(/,/g, ''));
  f.plot_area = area > 0 && area < 1e9 ? String(Math.round(area * 100) / 100) : null;
  f.plot_area_unit = f.plot_area ? (PLOT_UNIT_SQFT[f.plot_area_unit] ? f.plot_area_unit : 'sqft') : null;
  if (!PLOT_FACINGS.includes(f.plot_facing)) f.plot_facing = null;
  const road = Math.round(Number(String(body.plot_road_width ?? '').replace(/[^\d.]/g, '')));
  f.plot_road_width = road > 0 && road <= 999 ? String(road) : null;
  for (const k of ['plot_corner', 'plot_boundary_wall', 'plot_clear_title']) if (!['yes', 'no'].includes(f[k])) f[k] = null;
  if (!PLOT_LAND_USES.includes(f.plot_land_use)) f.plot_land_use = null;
}
/** Columns forced for a plot: no rooms / floors / towers / age, and the area converted to sq ft. */
function plotPropertyOverrides(body, extra) {
  if (!isPlotType(body.property_type)) return {};
  const sqft = extra.plot_area ? Math.round(Number(extra.plot_area) * PLOT_UNIT_SQFT[extra.plot_area_unit]) : null;
  return {
    bedroom_count: null, bathroom_count: null, balcony_count: null, total_floors: null, floor_number: null,
    tower_count: null, age_of_property: null, bedrooms: null,
    ...(sqft > 0 ? { carpet_area_sqft: sqft } : {}),
  };
}

// Extra free-text fields saved alongside a property (key → max length).
const PROPERTY_EXTRA_MAX = {
  sourcing_manager_name: 120, sourcing_manager_phone: 120, site_head_name: 120, site_head_phone: 120, amenities: 2000, completion_month: 7,
  direct_contact_name: 120, direct_contact_phone: 120, indirect_contact_name: 120, indirect_contact_phone: 120,
  launch_date: 10, land_parcel_area: 120, commercial_advantages: 2000, furnishing: 20, sale_type: 10,
  usps: 2000, key_growth: 2000, available_from: 10, expected_rent: 20, // expected_rent is re-parsed to an integer below
  plot_area: 20, plot_area_unit: 8, plot_dimensions: 40, plot_facing: 12, plot_road_width: 4, plot_corner: 3, plot_boundary_wall: 3, plot_land_use: 14, plot_clear_title: 3, // plots only (0058); validated in normalisePlotFields
  security_deposit: 20, maintenance_charges: 20, maintenance_included: 8, lock_in_months: 4, // rentals only (0059); re-parsed below
  occupied: 3, // rentals only: 'yes' | 'no'
  tenant_preference: 10, // rentals only: 'families' | 'bachelors' | 'anyone'
  pet_friendly: 3, // rentals only: 'yes' | 'no'
  rating_locality: 4, rating_connectivity: 4, rating_appreciation: 4, rating_lifestyle: 4,
  zone: 12, // 0066: 'west_pune' | 'east_pune' | 'north_pune' | 'south_pune'; validated below
};
const PROPERTY_RATING_KEYS = ['rating_locality', 'rating_connectivity', 'rating_appreciation', 'rating_lifestyle'];
const PROPERTY_CONTACT_KEYS = Object.keys(PROPERTY_EXTRA_MAX);
function propertyContactFields(body) {
  const f = Object.fromEntries(PROPERTY_CONTACT_KEYS.map((k) => [k, typeof body[k] === 'string' ? body[k].trim().slice(0, PROPERTY_EXTRA_MAX[k]) || null : null]));
  // Reality report ratings: a number from 0 to 5, one decimal; anything else = not rated.
  for (const k of PROPERTY_RATING_KEYS) {
    const n = body[k] === '' || body[k] == null ? NaN : Number(body[k]);
    f[k] = n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : null;
  }
  // Expected completion ('YYYY-MM') only means something while under construction.
  if (body.construction_status !== 'under_construction' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(f.completion_month || '')) f.completion_month = null;
  // EOI details only apply in the EOI phase; furnishing only to rentals; new/resale only to sales.
  if (body.construction_status !== 'eoi_phase') f.launch_date = f.land_parcel_area = f.commercial_advantages = null;
  else if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(f.launch_date || '')) f.launch_date = null;
  if (body.listing_type !== 'rent' || !['furnished', 'semi_furnished', 'unfurnished'].includes(f.furnishing)) f.furnishing = null;
  if (['rent', 'pg'].includes(body.listing_type) || !['new', 'resale'].includes(f.sale_type)) f.sale_type = null;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(f.available_from || '')) f.available_from = null;
  // Expected monthly rent (₹) only for sale listings — rentals carry their own rent range.
  const rent = (body.listing_type || 'sell') === 'sell' ? parseMoney(body.expected_rent) : null;
  f.expected_rent = rent > 0 ? rent : null;
  normalisePlotFields(body, f); // plots (0058): validates the plot_* facts, clears them for any other type
  // ---- rental terms (0059): rentals only; amounts in ₹, lock-in in whole months ----
  const isRentListing = body.listing_type === 'rent';
  const rentAmount = (v) => { const n = isRentListing ? parseMoney(v) : null; return n > 0 ? n : null; };
  f.security_deposit = rentAmount(body.security_deposit);
  f.maintenance_charges = rentAmount(body.maintenance_charges);
  f.maintenance_included = isRentListing && ['included', 'extra'].includes(f.maintenance_included) ? f.maintenance_included : null;
  // "Included" means no separate amount; "extra" without an amount is fine too (amount unknown).
  if (f.maintenance_included === 'included') f.maintenance_charges = null;
  const lockIn = isRentListing ? Math.round(Number(String(body.lock_in_months ?? '').replace(/[^\d.]/g, ''))) : NaN;
  f.lock_in_months = lockIn > 0 && lockIn <= 600 ? lockIn : null;
  // Occupied: rentals only, 'yes' or 'no'; anything else = not set.
  if (body.listing_type !== 'rent' || !['yes', 'no'].includes(f.occupied)) f.occupied = null;
  // Tenant preference: rentals only; families / bachelors / anyone, else not set.
  if (body.listing_type !== 'rent' || !['families', 'bachelors', 'anyone'].includes(f.tenant_preference)) f.tenant_preference = null;
  // Pet friendly: rentals only, 'yes' or 'no'; anything else = not set.
  if (body.listing_type !== 'rent' || !['yes', 'no'].includes(f.pet_friendly)) f.pet_friendly = null;
  if (!PUNE_ZONES.includes(f.zone)) f.zone = null; // zones (0066)
  return f;
}
/** Saved as its own statement so the big positional INSERT/UPDATEs stay untouched. */
const setPropertyContacts = (env, id, f) => env.DB.prepare(
  `UPDATE properties SET ${PROPERTY_CONTACT_KEYS.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`
).bind(id, ...PROPERTY_CONTACT_KEYS.map((k) => f[k]));

/** Hunting-team drafts (pipeline='hunting') are gated by the hunting target
 * they belong to, not by catalogue permissions — so a hunting manager can
 * record details without being able to publish to the client catalogue. */
async function draftTargetFor(env, actor, targetId) {
  const target = targetId ? await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(String(targetId)).first() : null;
  if (!target) return { response: fail('Hunting property not found.', 404) };
  if (!canUpdateHuntingTarget(actor, target)) return { response: fail('You do not have permission to update this hunting property.', 403) };
  if (target.converted_property_id) return { response: fail('This property is already listed — edit it in Properties instead.', 409) };
  return { target };
}

/** Keep the target's summary fields (board card, list, search) in step with its full details. */
const syncTargetFromDraft = (env, propertyId, f) => env.DB.prepare(
  `UPDATE hunting_targets SET name = ?2, property_type = ?3, location = ?4, locality = ?5,
          asking_price = COALESCE(?6, asking_price), updated_at = datetime('now')
    WHERE draft_property_id = ?1`
).bind(propertyId, f.name, f.property_type, f.location, f.locality, f.price_expected);

async function handleCreateProperty(request, env, actor) {
  const body = await bodyJson(request);
  const hunting = body?.pipeline === 'hunting';
  let draftTarget = null;
  if (hunting) {
    const r = await draftTargetFor(env, actor, body.hunting_target_id);
    if (r.response) return r.response;
    if (r.target.draft_property_id) return fail('This property already has details — edit them instead.', 409);
    draftTarget = r.target;
  } else if (!canCreateCatalog(actor)) return fail('You do not have permission to add properties to the catalogue.', 403);
  if (!body?.name?.trim()) return fail('Property name is required.', 422);
  const id = crypto.randomUUID();
  const brochureUrl = normaliseBuilderBrochureUrl(body.builder_brochure_url);
  if (brochureUrl.error) return fail(brochureUrl.error, 422);
  const towerCount = normaliseTowerCount(body.tower_count);
  if (towerCount.error) return fail(towerCount.error, 422);
  const f = normalisePropertyFields(body, brochureUrl.value, towerCount.value);
  // Drafts don't create builder-directory entries until they're published.
  const builderId = hunting ? null : await resolveBuilder(env, f.developer, f.location);
  if (hunting) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO properties (
          id,name,developer,property_type,listing_type,category,
          location,locality,sub_locality,society_name,tower_count,house_no,
          carpet_area_sqft,bedroom_count,bathroom_count,balcony_count,total_floors,floor_number,age_of_property,
          price_expected,price_per_sqft,price_negotiable,price_all_inclusive,
          budget_min,budget_max,bedrooms,availability,construction_status,description,builder_brochure_url,is_active,created_by_user_id,pipeline
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,'hunting')`).bind(
          id, f.name, f.developer, f.property_type, f.listing_type, f.category,
          f.location, f.locality, f.sub_locality, f.society_name, f.tower_count, f.house_no,
          f.carpet_area_sqft, f.bedroom_count, f.bathroom_count, f.balcony_count, f.total_floors, f.floor_number, f.age_of_property,
          f.price_expected, f.price_per_sqft, f.price_negotiable, f.price_all_inclusive,
          f.budget_min, f.budget_max, f.bedrooms, f.availability, f.construction_status, f.description, f.builder_brochure_url, f.is_active,
          actorUserId(actor)
        ),
      env.DB.prepare('UPDATE hunting_targets SET draft_property_id = ?2 WHERE id = ?1 AND draft_property_id IS NULL').bind(draftTarget.id, id),
      syncTargetFromDraft(env, id, f),
      setPropertyContacts(env, id, f),
      env.DB.prepare("UPDATE properties SET inventory_status = 'draft' WHERE id = ?1").bind(id), // inventory status (0066)
    ]);
    return json({ ok: true, property_id: id }, 201);
  }
  await env.DB.prepare(`INSERT INTO properties (
      id,name,developer,builder_id,property_type,listing_type,category,
      location,locality,sub_locality,society_name,tower_count,house_no,
      carpet_area_sqft,bedroom_count,bathroom_count,balcony_count,total_floors,floor_number,age_of_property,
      price_expected,price_per_sqft,price_negotiable,price_all_inclusive,
      budget_min,budget_max,bedrooms,availability,construction_status,description,builder_brochure_url,is_active,created_by_user_id
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33)`).bind(
      id, f.name, f.developer, builderId, f.property_type, f.listing_type, f.category,
      f.location, f.locality, f.sub_locality, f.society_name, f.tower_count, f.house_no,
      f.carpet_area_sqft, f.bedroom_count, f.bathroom_count, f.balcony_count, f.total_floors, f.floor_number, f.age_of_property,
      f.price_expected, f.price_per_sqft, f.price_negotiable, f.price_all_inclusive,
      f.budget_min, f.budget_max, f.bedrooms, f.availability, f.construction_status, f.description, f.builder_brochure_url, f.is_active,
      has(actor, 'catalog.manage') ? null : actor.id
    ).run();
  await setPropertyContacts(env, id, f).run();
  await initCatalogInventory(env, id, actor); // inventory status (0066)
  return json({ ok: true, property_id: id }, 201);
}

async function handleUpdateProperty(request, env, propertyId, actor) {
  const existing = await env.DB.prepare('SELECT * FROM properties WHERE id = ?1').bind(propertyId).first(); // whole row: price history (0064) compares before/after
  const hunting = existing?.pipeline === 'hunting';
  if (hunting) {
    const owner = await env.DB.prepare('SELECT id FROM hunting_targets WHERE draft_property_id = ?1').bind(propertyId).first();
    const r = await draftTargetFor(env, actor, owner?.id);
    if (r.response) return r.response;
  } else if (!has(actor, 'catalog.manage')) return fail('Only administrators can edit properties.', 403);
  if (!existing) return fail('Property not found.', 404);
  const body = await bodyJson(request);
  if (!body?.name?.trim()) return fail('Property name is required.', 422);
  const brochureUrl = normaliseBuilderBrochureUrl(body.builder_brochure_url);
  if (brochureUrl.error) return fail(brochureUrl.error, 422);
  const towerCount = normaliseTowerCount(body.tower_count);
  if (towerCount.error) return fail(towerCount.error, 422);
  const f = normalisePropertyFields(body, brochureUrl.value, towerCount.value);
  const builderId = hunting ? null : await resolveBuilder(env, f.developer, f.location);
  if (hunting) await syncTargetFromDraft(env, propertyId, f).run();
  await env.DB.prepare(`UPDATE properties SET
      name=?2, developer=?3, builder_id=?4, property_type=?5, listing_type=?6, category=?7,
      location=?8, locality=?9, sub_locality=?10, society_name=?11, tower_count=?12, house_no=?13,
      carpet_area_sqft=?14, bedroom_count=?15, bathroom_count=?16, balcony_count=?17, total_floors=?18, floor_number=?19, age_of_property=?20,
      price_expected=?21, price_per_sqft=?22, price_negotiable=?23, price_all_inclusive=?24,
      budget_min=?25, budget_max=?26, bedrooms=?27, availability=?28, construction_status=?29, description=?30, builder_brochure_url=?31, is_active=?32,
      updated_at=datetime('now')
    WHERE id=?1`).bind(
      propertyId, f.name, f.developer, builderId, f.property_type, f.listing_type, f.category,
      f.location, f.locality, f.sub_locality, f.society_name, f.tower_count, f.house_no,
      f.carpet_area_sqft, f.bedroom_count, f.bathroom_count, f.balcony_count, f.total_floors, f.floor_number, f.age_of_property,
      f.price_expected, f.price_per_sqft, f.price_negotiable, f.price_all_inclusive,
      f.budget_min, f.budget_max, f.bedrooms, f.availability, f.construction_status, f.description, f.builder_brochure_url, f.is_active
    ).run();
  await setPropertyContacts(env, propertyId, f).run();
  await recordPropertyChanges(env, existing, propertyId, actor); // wave3 E: price & availability history + shortlist alerts
  return json({ ok: true, property_id: propertyId });
}

// ---- inventory status, team assignment, zones, hunting KPIs (wave3 G, migration 0066) ----
// Flow: the hunting team records a property ('draft') → "Convert to listing" makes it
// 'pending_verification' → someone with inventory.assign gives it to a client team, which
// makes it 'active'. Only active properties are offered to buyers by default; on hold and in
// negotiation still show (with a warning), sold / leased are kept but never offered.
const INVENTORY_STATUSES = ['draft', 'pending_verification', 'active', 'on_hold', 'negotiation', 'sold', 'leased'];
const INVENTORY_STATUS_LABEL = { draft: 'Draft', pending_verification: 'Waiting for a team', active: 'Active', on_hold: 'On hold', negotiation: 'In negotiation', sold: 'Sold', leased: 'Leased' };
const INVENTORY_MATCHABLE = ['active', 'on_hold', 'negotiation'];
const PUNE_ZONES = ['west_pune', 'east_pune', 'north_pune', 'south_pune'];

/** Does a table from another (possibly not yet applied) migration exist? Cached per isolate. */
const TABLE_EXISTS_CACHE = new Map();
async function invTableExists(env, name) {
  if (TABLE_EXISTS_CACHE.get(name)) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(name).first().catch(() => null);
  if (row) TABLE_EXISTS_CACHE.set(name, true);
  return !!row;
}

/** GET /api/properties filters: ?inventory_status=a,b and ?zone=a,b. A matching search (type /
 *  location / budget given, or ?for=matching) only offers active, on hold and in negotiation. */
function inventoryListFilters(url, filters, bind, matchingSearch) {
  const list = (key, allowed) => (url.searchParams.get(key) || '').split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));
  const statuses = list('inventory_status', INVENTORY_STATUSES);
  if (statuses.length) filters.push(`p.inventory_status IN (${statuses.map((s) => bind(s)).join(', ')})`);
  else if (matchingSearch || url.searchParams.get('for') === 'matching') filters.push(`p.inventory_status IN (${INVENTORY_MATCHABLE.map((s) => `'${s}'`).join(', ')})`);
  const zones = list('zone', PUNE_ZONES);
  if (zones.length) filters.push(`p.zone IN (${zones.map((z) => bind(z)).join(', ')})`);
}

/** A property added straight into the catalogue: active (in the adder's team) when they may
 *  assign inventory, otherwise it waits for a manager to give it to a team. */
async function initCatalogInventory(env, id, actor) {
  const canAssign = has(actor, 'inventory.assign');
  const team = canAssign && actor.team_id ? await env.DB.prepare('SELECT * FROM teams WHERE id = ?1').bind(actor.team_id).first() : null;
  const clientTeam = team && (team.vertical || 'client') === 'client' ? team.id : null;
  const status = canAssign ? 'active' : 'pending_verification';
  await env.DB.prepare('UPDATE properties SET inventory_status = ?2, assigned_team_id = ?3 WHERE id = ?1').bind(id, status, clientTeam).run();
}

/** POST /api/properties/:id/inventory { inventory_status?, assigned_team_id? } — change the
 *  status and/or the client team. Giving a waiting property a team makes it active. */
async function handleSetPropertyInventory(request, env, propertyId, actor) {
  if (!has(actor, 'inventory.assign')) return fail('Only managers and inventory approvers can change a property\'s status or team.', 403);
  const p = await env.DB.prepare('SELECT id, name, pipeline, inventory_status, assigned_team_id FROM properties WHERE id = ?1').bind(propertyId).first();
  if (!p) return fail('Property not found.', 404);
  if (p.pipeline !== 'catalog') return fail('The hunting team is still recording this property. Convert it to a listing first.', 409);
  const body = await bodyJson(request);
  if (!body || typeof body !== 'object') return fail('JSON object required.', 400);
  let status = p.inventory_status || 'active';
  let teamId = p.assigned_team_id || null;
  let team = null;
  if (Object.hasOwn(body, 'assigned_team_id')) {
    const raw = body.assigned_team_id ? String(body.assigned_team_id) : null;
    if (raw) {
      team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?1').bind(raw).first();
      if (!team) return fail('Choose a team from the list.', 422);
      if ((team.vertical || 'client') !== 'client') return fail('Properties can only be given to a client team.', 422);
    }
    teamId = raw;
    if (!Object.hasOwn(body, 'inventory_status')) {
      if (raw && ['draft', 'pending_verification'].includes(status)) status = 'active';
      if (!raw && status === 'active') status = 'pending_verification';
    }
  }
  if (Object.hasOwn(body, 'inventory_status')) {
    if (!INVENTORY_STATUSES.includes(body.inventory_status) || body.inventory_status === 'draft') return fail('Choose a valid status.', 422);
    status = body.inventory_status;
  }
  if (status === 'active' && !teamId) return fail('Give it to a client team first — a property becomes active once a team has it.', 422);
  if (status === p.inventory_status && teamId === (p.assigned_team_id || null)) return json({ ok: true, unchanged: true, inventory_status: status, assigned_team_id: teamId });
  const statements = [
    env.DB.prepare(`UPDATE properties SET inventory_status = ?2, assigned_team_id = ?3, updated_at = datetime('now') WHERE id = ?1`).bind(propertyId, status, teamId),
  ];
  if (status !== p.inventory_status && await invTableExists(env, 'property_price_history')) {
    statements.push(env.DB.prepare(`INSERT INTO property_price_history (id, property_id, field, old_value, new_value, changed_by_user_id) VALUES (?1, ?2, 'status', ?3, ?4, ?5)`)
      .bind(crypto.randomUUID(), propertyId, p.inventory_status, status, actorUserId(actor)));
  }
  await env.DB.batch(statements);
  if (status !== p.inventory_status) await alertShortlisters(env, p, [{ field: 'status', old: p.inventory_status, new: status }], actorUserId(actor)); // wave3 E: tell whoever shortlisted it
  if (team && teamId !== p.assigned_team_id) {
    await raiseAlert(env, {
      importance: 'medium',
      to: team.manager_user_id ? { userIds: [team.manager_user_id] } : { teamId: team.id },
      title: `New property for ${team.name}: ${p.name}`,
      body: `${actor.name || 'A manager'} gave this property to your team. It is now ${INVENTORY_STATUS_LABEL[status].toLowerCase()}.`,
      link: { kind: 'property', id: propertyId },
    });
  }
  return json({ ok: true, inventory_status: status, assigned_team_id: teamId, assigned_team_name: team?.name ?? (teamId ? (await env.DB.prepare('SELECT name FROM teams WHERE id = ?1').bind(teamId).first('name')) : null) });
}

/** PUT /api/projects/:id/zone { zone } — projects have no edit form, so the zone is set here. */
async function handleSetProjectZone(request, env, projectId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to change projects.', 403);
  const body = await bodyJson(request);
  const zone = body?.zone ? String(body.zone) : null;
  if (zone && !PUNE_ZONES.includes(zone)) return fail('Choose West, East, North or South Pune.', 422);
  const r = await env.DB.prepare(`UPDATE projects SET zone = ?2, updated_at = datetime('now') WHERE id = ?1`).bind(projectId, zone).run();
  if (!r.meta?.changes) return fail('Project not found.', 404);
  return json({ ok: true, zone });
}

/** GET /api/hunting-performance?days=30|90|365 (omit = all time): what the hunting team's
 *  sourcing produced — listed, assigned, active, by category / source, duplicates, and the
 *  client visits and won deals those properties brought in. Same row scope as the pipeline. */
async function handleHuntingPerformance(request, env, actor) {
  const days = parseInt(new URL(request.url).searchParams.get('days') || '', 10);
  const scoped = (extra = '') => {
    const binds = [];
    const scope = huntingScopeClause(actor, (v) => { binds.push(v); return `?${binds.length}`; });
    if (scope === null) return null;
    const where = [scope, days > 0 && days <= 3650 ? `t.created_at >= datetime('now', '-${days} days')` : '', extra].filter(Boolean);
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', binds };
  };
  const base = scoped();
  if (!base) return fail('You do not have permission to view hunting performance.', 403);
  const FROM = `FROM hunting_targets t LEFT JOIN properties p ON p.id = COALESCE(t.converted_property_id, t.draft_property_id)`;
  const q = (sql, s = base) => env.DB.prepare(sql).bind(...s.binds).all().then((r) => r.results ?? []);
  const COUNTS = `COUNT(*) AS sourced,
       COALESCE(SUM(t.converted_property_id IS NOT NULL), 0) AS listed,
       COALESCE(SUM(t.converted_property_id IS NOT NULL AND p.assigned_team_id IS NOT NULL), 0) AS assigned,
       COALESCE(SUM(t.converted_property_id IS NOT NULL AND p.inventory_status = 'active'), 0) AS active,
       COALESCE(SUM(t.converted_property_id IS NOT NULL AND p.inventory_status = 'pending_verification'), 0) AS waiting,
       COALESCE(SUM(t.converted_property_id IS NOT NULL AND p.inventory_status IN ('sold', 'leased')), 0) AS closed,
       COALESCE(SUM(t.stage = 'dropped'), 0) AS dropped`;
  const [totals, byCategory, bySource, duplicates, byEmployee] = await Promise.all([
    q(`SELECT ${COUNTS} ${FROM} ${base.where}`),
    q(`SELECT COALESCE(p.category, '') AS category, COALESCE(p.listing_type, '') AS listing_type, ${COUNTS} ${FROM} ${base.where} GROUP BY 1, 2 ORDER BY sourced DESC`),
    q(`SELECT COALESCE(NULLIF(trim(t.source), ''), '') AS source, ${COUNTS} ${FROM} ${base.where} GROUP BY 1 ORDER BY sourced DESC LIMIT 20`),
    q(`SELECT MIN(t.name) AS name, MIN(t.locality) AS locality, COUNT(*) AS n, group_concat(t.id) AS ids ${FROM} ${base.where}
        GROUP BY lower(trim(t.name)), lower(trim(COALESCE(t.locality, ''))) HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 20`),
    q(`SELECT t.assigned_user_id AS user_id, u.name AS user_name, ${COUNTS} ${FROM} LEFT JOIN users u ON u.id = t.assigned_user_id ${base.where} GROUP BY t.assigned_user_id ORDER BY sourced DESC`),
  ]);

  // Client-side results, only from tables that exist (site visits, shortlists, transactions come from other features).
  const tbl = { visits: await invTableExists(env, 'site_visits'), shortlist: await invTableExists(env, 'lead_shortlist'), txn: await invTableExists(env, 'transactions'), bookings: await invTableExists(env, 'bookings') };
  const listedScope = scoped('t.converted_property_id IS NOT NULL');
  let visits = [], deals = [], visitTotal = { visits: 0, completed: 0 }, dealTotal = 0;
  if (tbl.visits) {
    const sql = `FROM site_visits v JOIN hunting_targets t ON t.converted_property_id = v.property_id ${listedScope.where}`;
    visits = await q(`SELECT t.assigned_user_id AS user_id, COUNT(*) AS visits, COALESCE(SUM(v.attendance = 'completed'), 0) AS completed ${sql} GROUP BY t.assigned_user_id`, listedScope);
    visitTotal = (await q(`SELECT COUNT(*) AS visits, COALESCE(SUM(v.attendance = 'completed'), 0) AS completed ${sql}`, listedScope))[0] || visitTotal;
  }
  const links = ['SELECT lead_id, property_id FROM lead_discussed_properties',
    tbl.shortlist && 'SELECT lead_id, property_id FROM lead_shortlist WHERE property_id IS NOT NULL',
    tbl.visits && 'SELECT lead_id, property_id FROM site_visits WHERE property_id IS NOT NULL',
    tbl.txn && 'SELECT lead_id, property_id FROM transactions WHERE property_id IS NOT NULL AND lead_id IS NOT NULL',
    tbl.bookings && 'SELECT lead_id, property_id FROM bookings WHERE property_id IS NOT NULL'].filter(Boolean).join(' UNION ');
  const dealSql = `FROM hunting_targets t JOIN (${links}) x ON x.property_id = t.converted_property_id
     JOIN leads l ON l.id = x.lead_id AND (l.stage = 'won' OR l.status = 'converted') ${listedScope.where}`;
  deals = await q(`SELECT t.assigned_user_id AS user_id, COUNT(DISTINCT l.id) AS deals ${dealSql} GROUP BY t.assigned_user_id`, listedScope).catch(() => []);
  dealTotal = (await q(`SELECT COUNT(DISTINCT l.id) AS deals ${dealSql}`, listedScope).catch(() => [{ deals: 0 }]))[0]?.deals ?? 0;

  const key = (id) => id || '';
  const visitBy = new Map(visits.map((r) => [key(r.user_id), r]));
  const dealBy = new Map(deals.map((r) => [key(r.user_id), r.deals]));
  return json({
    period_days: days > 0 ? days : null,
    totals: { ...(totals[0] || {}), visits: visitTotal.visits, visits_completed: visitTotal.completed, deals: dealTotal },
    by_category: byCategory,
    by_source: bySource,
    duplicates: duplicates.map((d) => ({ name: d.name, locality: d.locality, count: d.n, target_ids: String(d.ids || '').split(',') })),
    by_employee: byEmployee.map((r) => ({ ...r, visits: visitBy.get(key(r.user_id))?.visits ?? 0, visits_completed: visitBy.get(key(r.user_id))?.completed ?? 0, deals: dealBy.get(key(r.user_id)) ?? 0 })),
    sources_available: { site_visits: tbl.visits, shortlist: tbl.shortlist, transactions: tbl.txn },
  });
}
// ---- end inventory status, zones, hunting KPIs (wave3 G) ----

// ---- Projects: a builder development with many units, added in bulk ----
// Stages run EOI phase → under construction → nearing possession → ready to
// move in; single resale flats live in `properties`. Writing follows the
// catalogue rule (canCreateCatalog), reading is open to anyone who can see the catalogue.

const PROJECT_STATUSES = ['eoi_phase', 'under_construction', 'nearing_possession', 'ready_to_move'];
/** Stages that still have an expected completion month (possession_by). */
const PROJECT_BUILDING_STATUSES = new Set(['under_construction', 'nearing_possession']);
/** Projects come from the builder side, so the property hunting team can add
 * and maintain them as well as catalogue administrators. */
const canManageProjects = (actor) => canCreateCatalog(actor) || has(actor, 'hunting.create');
const UNIT_STATUSES = ['available', 'booked', 'sold'];
/** projects.kind: flats ('building'), plots, villas / row houses; 'other' is the legacy mixed kind. */
const PROJECT_KINDS = ['building', 'plots', 'villas', 'other'];
const PROJECT_UNIT_WORD = { building: 'flat', plots: 'plot', villas: 'villa', other: 'unit' };
const cleanText = (v, max = 160) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);

/** One unit from a request body → { value } or { error }. Buildings need a floor. */
function parseProjectUnit(u, kind) {
  if (!u || typeof u !== 'object') return { error: 'Each flat, plot or villa must be an object.' };
  const floor = u.floor_number === '' || u.floor_number == null ? null : Number(u.floor_number);
  if (floor !== null && (!Number.isInteger(floor) || floor < -3 || floor > 200)) return { error: 'Floor must be a whole number (use 0 for ground).' };
  if (kind === 'building' && floor === null) return { error: 'Every flat in a building needs its floor.' };
  const status = UNIT_STATUSES.includes(u.status) ? u.status : 'available';
  return { value: {
    wing: cleanText(u.wing, 40), floor_number: floor, unit_no: cleanText(u.unit_no, 40),
    bedroom_count: parseCount(u.bedroom_count), carpet_area_sqft: parseCount(u.carpet_area_sqft),
    price_expected: parseMoney(u.price_expected), status,
  } };
}

const insertUnit = (env, projectId, u) => env.DB.prepare(
  `INSERT INTO project_units (id, project_id, wing, floor_number, unit_no, bedroom_count, carpet_area_sqft, price_expected, status)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
).bind(crypto.randomUUID(), projectId, u.wing, u.floor_number, u.unit_no, u.bedroom_count, u.carpet_area_sqft, u.price_expected, u.status);

/** Configurations (migration 0042): the BHK types a project offers, each with
 * one or more categories / plans. payment_plans is stored as JSON text. */
const PROJECT_BHKS = ['1 RK', '1 BHK', '1.5 BHK', '2 BHK', '2.5 BHK', '3 BHK', '3.5 BHK', '4 BHK', '4.5 BHK', '5 BHK', '5+ BHK'];
const PAYMENT_PLANS = ['construction_linked', 'one_time_down_payment', 'bullet'];

/** body.configurations → rows to insert (bad entries without a BHK are skipped), at most 100. */
function parseProjectConfigurations(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c === 'object').map((c) => {
    const bhkText = cleanText(c.bhk, 40);
    const bhk = PROJECT_BHKS.find((b) => b.toLowerCase() === bhkText?.toLowerCase()) ?? bhkText;
    const plans = (Array.isArray(c.payment_plans) ? c.payment_plans : []).filter((p, i, a) => PAYMENT_PLANS.includes(p) && a.indexOf(p) === i);
    return {
      bhk, variant_name: cleanText(c.variant_name, 60), carpet_area_sqft: parseCount(c.carpet_area_sqft),
      balcony_count: parseCount(c.balcony_count), price: c.price === '' ? null : parseMoney(c.price),
      payment_plans: plans.length ? JSON.stringify(plans) : null,
    };
  }).filter((c) => c.bhk).slice(0, 100);
}

const insertConfiguration = (env, projectId, c, sortOrder) => env.DB.prepare(
  `INSERT INTO project_configurations (id, project_id, bhk, variant_name, carpet_area_sqft, balcony_count, price, payment_plans, sort_order)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
).bind(crypto.randomUUID(), projectId, c.bhk, c.variant_name, c.carpet_area_sqft, c.balcony_count, c.price, c.payment_plans, sortOrder);

// ---- favourites ----
/** PUT/DELETE /api/favourites/:kind/:id — heart or un-heart a property / project for the signed-in user.
 * Hearting needs the item to exist and be visible to them; un-hearting always works so a stale heart can be cleared. */
async function handleSetFavourite(env, actor, kind, id, on) {
  if (!on) {
    await env.DB.prepare('DELETE FROM favourites WHERE user_id = ?1 AND kind = ?2 AND item_id = ?3').bind(actor.id, kind, id).run();
    return json({ kind, id, is_favourite: 0 });
  }
  if (kind === 'project') {
    if (!has(actor, 'team.read')) return fail('You do not have permission to view projects.', 403);
    if (!(await env.DB.prepare('SELECT 1 AS ok FROM projects WHERE id = ?1').bind(id).first())) return fail('Project not found.', 404);
  } else {
    const prop = await env.DB.prepare('SELECT id, pipeline FROM properties WHERE id = ?1 AND is_active = 1').bind(id).first();
    if (!prop) return fail('Property not found.', 404);
    if (prop.pipeline === 'catalog') {
      if (!has(actor, 'team.read')) return fail('You do not have permission to view the property catalogue.', 403);
    } else {
      // A hunting draft: only people who can see the hunting target carrying it.
      const binds = [];
      const bind = (value) => { binds.push(value); return `?${binds.length}`; };
      const scope = huntingScopeClause(actor, bind);
      if (scope === null) return fail('You do not have permission to view this property.', 403);
      const idRef = bind(id);
      const visible = await env.DB.prepare(
        `SELECT 1 AS ok FROM hunting_targets t WHERE (t.draft_property_id = ${idRef} OR t.converted_property_id = ${idRef})${scope ? ' AND ' + scope : ''} LIMIT 1`
      ).bind(...binds).first();
      if (!visible) return fail('Property not found.', 404);
    }
  }
  await env.DB.prepare('INSERT OR IGNORE INTO favourites (user_id, kind, item_id) VALUES (?1, ?2, ?3)').bind(actor.id, kind, id).run();
  return json({ kind, id, is_favourite: 1 });
}
// ---- end favourites ----

// ---- Project tokens (migration 0055): booking / EOI token variants ----
const MAX_PROJECT_TOKENS = 8;
const MAX_TOKEN_ADVANTAGES = 12;
/** body.tokens → { value: rows } or { error }. Each token needs a name and an amount above 0;
 * advantages may be an array or new-line text. Blank rows are skipped, at most MAX_PROJECT_TOKENS. */
function parseProjectTokens(list) {
  if (list == null || list === '') return { value: [] };
  if (!Array.isArray(list)) return { error: 'Token types must be a list.' };
  const rows = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') return { error: 'Each token type must be an object.' };
    const name = cleanText(t.name, 60);
    const blank = !name && (t.amount === '' || t.amount == null) && !String(Array.isArray(t.advantages) ? t.advantages.join('') : t.advantages ?? '').trim();
    if (blank) continue;
    if (!name) return { error: 'Each token type needs a name (for example Standard token).' };
    const amount = parseMoney(t.amount);
    if (!(amount > 0) || amount > 100_000_000_000) return { error: `Enter the token amount for “${name}” (more than ₹0).` };
    rows.push({
      name, amount,
      refundable: [1, true, '1'].includes(t.refundable) ? 1 : [0, false, '0'].includes(t.refundable) ? 0 : null,
      advantages: projectList(t.advantages, MAX_TOKEN_ADVANTAGES, 160),
    });
  }
  if (rows.length > MAX_PROJECT_TOKENS) return { error: `Add at most ${MAX_PROJECT_TOKENS} token types.` };
  return { value: rows };
}

const insertToken = (env, projectId, t, sortOrder) => env.DB.prepare(
  `INSERT INTO project_tokens (id, project_id, name, amount, refundable, advantages, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
).bind(crypto.randomUUID(), projectId, t.name, t.amount, t.refundable, t.advantages, sortOrder);

/** A stored token row → the API shape: { id, name, amount, refundable, advantages: string[] }. */
function projectTokenOut(t) {
  let advantages = [];
  try { const v = JSON.parse(t.advantages || '[]'); if (Array.isArray(v)) advantages = v; } catch { /* keep [] */ }
  return { id: t.id, name: t.name, amount: t.amount, refundable: t.refundable, advantages };
}

/** PUT /api/projects/:id/tokens — replaces the project's token types with body.tokens. */
async function handleReplaceProjectTokens(request, env, projectId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to change token types.', 403);
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?1').bind(projectId).first();
  if (!project) return fail('Project not found.', 404);
  const body = await bodyJson(request);
  const parsed = parseProjectTokens(body?.tokens);
  if (parsed.error) return fail(parsed.error, 422);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM project_tokens WHERE project_id = ?1').bind(projectId),
    ...parsed.value.map((t, i) => insertToken(env, projectId, t, i)),
    env.DB.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1").bind(projectId),
  ]);
  const { results } = await env.DB.prepare('SELECT * FROM project_tokens WHERE project_id = ?1 ORDER BY sort_order, created_at').bind(projectId).all();
  return json({ ok: true, tokens: (results ?? []).map(projectTokenOut) });
}

async function handleListProjects(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view projects.', 403);
  const [projects, units, configurations] = await Promise.all([
    env.DB.prepare("SELECT pr.*, (SELECT COUNT(*) FROM favourites f WHERE f.user_id = ?1 AND f.kind = 'project' AND f.item_id = pr.id) AS is_favourite FROM projects pr ORDER BY pr.updated_at DESC").bind(actor.id).all(),
    env.DB.prepare('SELECT * FROM project_units ORDER BY wing, floor_number, unit_no').all(),
    env.DB.prepare('SELECT * FROM project_configurations ORDER BY sort_order, created_at').all(),
  ]);
  const byProject = new Map();
  for (const u of units.results ?? []) (byProject.get(u.project_id) ?? byProject.set(u.project_id, []).get(u.project_id)).push(u);
  const configsByProject = new Map();
  for (const c of configurations.results ?? []) (configsByProject.get(c.project_id) ?? configsByProject.set(c.project_id, []).get(c.project_id)).push(c);
  const docsByProject = await projectDocumentsByProject(env);
  const tokensByProject = new Map();
  for (const t of (await env.DB.prepare('SELECT * FROM project_tokens ORDER BY sort_order, created_at').all()).results ?? []) (tokensByProject.get(t.project_id) ?? tokensByProject.set(t.project_id, []).get(t.project_id)).push(projectTokenOut(t));
  return json({ projects: (projects.results ?? []).map((p) => ({ ...p, units: byProject.get(p.id) ?? [], configurations: configsByProject.get(p.id) ?? [], tokens: tokensByProject.get(p.id) ?? [],documents: docsByProject.get(p.id) ?? [], launch_benefits: launchBenefitRows(p.launch_benefits) })) });
}

/** Available flats that fit a buyer: BHK from their stated type ("2 BHK"),
 * area against the project's location/locality, price inside their budget.
 * Scored like property matches (type 50, area 30, budget 20). */
async function handleProjectMatches(request, env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view projects.', 403);
  const url = new URL(request.url);
  const type = (url.searchParams.get('property_type') || '').toLowerCase();
  const area = (url.searchParams.get('location') || '').trim().toLowerCase();
  const min = parseMoney(url.searchParams.get('budget_min'));
  const max = parseMoney(url.searchParams.get('budget_max'));
  const bhk = Number(type.match(/(\d)\s*-?\s*bhk/)?.[1]) || null;
  // Plot / land buyers fit 'plots', villa / row-house buyers fit 'villas', flat
  // buyers fit buildings. Legacy 'other' projects (plots + villas mixed) fit both.
  const wantsKind = /plot|land/.test(type) ? 'plots' : /villa|row ?house|bungalow/.test(type) ? 'villas' : bhk || /flat|apartment/.test(type) ? 'building' : null;
  const kindFits = (k) => k === wantsKind || (k === 'other' && (wantsKind === 'plots' || wantsKind === 'villas'));
  const { results } = await env.DB.prepare(
    `SELECT u.*, p.name AS project_name, p.developer, p.kind, p.construction_status, p.location, p.locality, p.possession_by
       FROM project_units u JOIN projects p ON p.id = u.project_id
      WHERE u.status = 'available'`
  ).all();
  const matches = (results ?? []).map((u) => {
    let score = 0;
    const reasons = [];
    if (bhk && u.bedroom_count === bhk) { score += 50; reasons.push(bhk + ' BHK'); }
    else if (!bhk && wantsKind && kindFits(u.kind)) { score += 50; reasons.push('type'); }
    if (area && `${u.location || ''} ${u.locality || ''}`.toLowerCase().includes(area)) { score += 30; reasons.push('area'); }
    if ((min !== null || max !== null) && u.price_expected != null
        && u.price_expected >= (min ?? 0) && u.price_expected <= (max ?? Number.MAX_SAFE_INTEGER)) { score += 20; reasons.push('budget'); }
    // A flat of the wrong size or kind isn't a match, however close the area or price.
    if ((bhk && u.bedroom_count && u.bedroom_count !== bhk) || (wantsKind && !kindFits(u.kind))) score = 0;
    return { ...u, match_score: score, match_reasons: reasons };
  }).filter((u) => u.match_score >= 30)
    .sort((a, b) => b.match_score - a.match_score || (a.price_expected ?? 0) - (b.price_expected ?? 0))
    .slice(0, 12);
  return json({ matches });
}

/** Optional project details (migration 0040+): column → parser(body). Each
 * returns the value to store or null. handleCreateProject inserts whatever is
 * listed here, so a new project field is one entry plus its column.
 * List fields are stored as JSON text (see projectList). */
const PROJECT_FIELDS = {
  key_growth: (b) => projectList(b.key_growth, 20, 200),
  // RERA: 1 = registered, 0 = under process, null = not said. The number is kept only when registered.
  rera_registered: (b) => ([1, true, '1'].includes(b.rera_registered) ? 1 : [0, false, '0'].includes(b.rera_registered) ? 0 : null),
  rera_number: (b) => ([1, true, '1'].includes(b.rera_registered) ? cleanText(b.rera_number, 60) : null),
  amenity_spaces: (b) => projectAmenitySpaces(b.amenity_spaces), // [{ name, area_sqft }] — clubhouse, pool…
  segment: (b) => (['luxury', 'affordable'].includes(b.segment) ? b.segment : null),
  // EOI only: expected launch ('YYYY-MM') and whether the sample flat is ready.
  launch_month: (b) => (b.construction_status !== 'eoi_phase' ? null
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(b.launch_month || '') ? b.launch_month
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(b.expected_launch || '') ? b.expected_launch : null), // the project form sends one "Expected launch" month
  // Expected launch ('YYYY-MM', optional): kept while a launch is still ahead (not ready to move). On EOI it falls back to the EOI launch month.
  expected_launch: (b) => (b.construction_status === 'ready_to_move' ? null
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(b.expected_launch || '') ? b.expected_launch
    : b.construction_status === 'eoi_phase' && /^\d{4}-(0[1-9]|1[0-2])$/.test(b.launch_month || '') ? b.launch_month : null),
  launch_benefits: (b) => projectLaunchBenefits(b.launch_benefits), // pre- vs post-launch table: [{ benefit, pre, post }]
  // EOI only: the year buyers get their flats (year only, optional). Allowed: last year … 15 years ahead.
  possession_year: (b) => { const y = Number(b.possession_year); const now = new Date().getFullYear(); return b.construction_status === 'eoi_phase' && Number.isInteger(y) && y >= now - 1 && y <= now + 15 ? y : null; },
  sample_flat_ready: (b) => (b.construction_status !== 'eoi_phase' ? null : [1, true, '1'].includes(b.sample_flat_ready) ? 1 : [0, false, '0'].includes(b.sample_flat_ready) ? 0 : null),
  land_parcel_area: (b) => cleanText(b.land_parcel_area, 60),
  tower_count: (b) => parseCount(b.tower_count) || null,
  // Flats on each floor — only meaningful for a building of flats.
  flats_per_floor: (body) => (body.kind === 'building' ? parseCount(body.flats_per_floor) || null : null),
  usps: (b) => projectList(b.usps, 20, 160), // USPs / highlights — short selling points
  zone: (b) => (PUNE_ZONES.includes(b.zone) ? b.zone : null), // 0066: West / East / North / South Pune
};
/** Up to `max` non-empty trimmed strings from an array (or new-line text) → JSON text, or null. */
function projectList(value, maxItems = 30, maxLen = 300) {
  const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [])
    .map((v) => (typeof v === 'string' ? v.trim().slice(0, maxLen) : null)).filter(Boolean).slice(0, maxItems);
  return items.length ? JSON.stringify(items) : null;
}
/** Pre- vs post-launch benefits → clean rows: up to 15 { benefit, pre, post }, each a trimmed string of at most 120
 * characters. Rows with no benefit name (or with both values empty) are dropped. Accepts an array or its JSON text. */
function launchBenefitRows(value) {
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, 120) : '');
  return (Array.isArray(list) ? list : []).map((r) => ({ benefit: text(r?.benefit), pre: text(r?.pre), post: text(r?.post) }))
    .filter((r) => r.benefit && (r.pre || r.post)).slice(0, 15);
}
/** The same rows as JSON text for the launch_benefits column, or null when none. */
function projectLaunchBenefits(value) {
  const rows = launchBenefitRows(value);
  return rows.length ? JSON.stringify(rows) : null;
}
/** Amenity spaces → JSON text of up to 40 { name, area_sqft } (area a positive whole sq ft or null), or null.
 * Rows without a name are dropped. */
function projectAmenitySpaces(value) {
  const list = (Array.isArray(value) ? value : []).map((a) => {
    const name = cleanText(a?.name, 80);
    if (!name) return null;
    const area = parseCount(a.area_sqft);
    return { name, area_sqft: area && area <= 10000000 ? area : null };
  }).filter(Boolean).slice(0, 40);
  return list.length ? JSON.stringify(list) : null;
}

async function handleCreateProject(request, env, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to add projects.', 403);
  const body = await bodyJson(request);
  const name = cleanText(body?.name);
  if (!name) return fail('Project name is required.', 422);
  if (!PROJECT_STATUSES.includes(body.construction_status)) return fail('Choose a project stage: EOI phase, under construction, nearing possession or ready to move in.', 422);
  // Flats ('building'), 'plots' or 'villas'; legacy 'other' still accepted.
  const kind = PROJECT_KINDS.includes(body.kind) ? body.kind : 'building';
  const units = [];
  for (const raw of Array.isArray(body.units) ? body.units : []) {
    const r = parseProjectUnit(raw, kind);
    if (r.error) return fail(r.error, 422);
    units.push(r.value);
  }
  // Units are optional on create (the Configuration section describes the flats).
  if (units.length > 500) return fail('Add at most 500 units at once.', 422);
  const totalFloors = parseCount(body.total_floors);
  if (String(body.tower_count ?? '').trim() && !(parseCount(body.tower_count) > 0)) return fail('Total towers must be a whole number of 1 or more.', 422);
  const developer = cleanText(body.developer);
  const location = cleanText(body.location, 120);
  const tokenParse = parseProjectTokens(body.tokens); // token types (migration 0055), inserted with the project below
  if (tokenParse.error) return fail(tokenParse.error, 422);
  const builderId = await resolveBuilder(env, developer, location);
  const id = crypto.randomUUID();
  const c = propertyContactFields(body);
  const row = {
    id, name, developer, builder_id: builderId, kind, construction_status: body.construction_status, location, locality: cleanText(body.locality, 120),
    total_floors: totalFloors, possession_by: PROJECT_BUILDING_STATUSES.has(body.construction_status) ? cleanText(body.possession_by, 60) : null, description: cleanText(body.description, 5000),
    sourcing_manager_name: c.sourcing_manager_name, sourcing_manager_phone: c.sourcing_manager_phone,
    site_head_name: c.site_head_name, site_head_phone: c.site_head_phone, created_by_user_id: actorUserId(actor),
  };
  for (const [column, parse] of Object.entries(PROJECT_FIELDS)) row[column] = parse(body) ?? null;
  const columns = Object.keys(row);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO projects (${columns.join(', ')}) VALUES (${columns.map((_, i) => '?' + (i + 1)).join(', ')})`).bind(...Object.values(row)),
    ...units.map((u) => insertUnit(env, id, u)),
    ...parseProjectConfigurations(body.configurations).map((cfg, i) => insertConfiguration(env, id, cfg, i)),
    ...tokenParse.value.map((t, i) => insertToken(env, id, t, i)),
  ]);
  return json({ ok: true, project_id: id, units_added: units.length }, 201);
}

async function handleAddProjectUnits(request, env, projectId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to add flats.', 403);
  const project = await env.DB.prepare('SELECT id, kind FROM projects WHERE id = ?1').bind(projectId).first();
  if (!project) return fail('Project not found.', 404);
  const body = await bodyJson(request);
  const units = [];
  for (const raw of Array.isArray(body?.units) ? body.units : []) {
    const r = parseProjectUnit(raw, project.kind);
    if (r.error) return fail(r.error, 422);
    units.push(r.value);
  }
  if (!units.length) return fail(`Add at least one ${PROJECT_UNIT_WORD[project.kind] || 'unit'}.`, 422);
  await env.DB.batch([
    ...units.map((u) => insertUnit(env, projectId, u)),
    env.DB.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1").bind(projectId),
  ]);
  return json({ ok: true, units_added: units.length }, 201);
}

async function handleUpdateProjectUnit(request, env, projectId, unitId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to change flats.', 403);
  const body = await bodyJson(request);
  if (!UNIT_STATUSES.includes(body?.status)) return fail('Status must be available, booked or sold.', 422);
  const res = await env.DB.prepare('UPDATE project_units SET status = ?3 WHERE id = ?1 AND project_id = ?2').bind(unitId, projectId, body.status).run();
  if (!res.meta?.changes) return fail('Flat not found.', 404);
  return json({ ok: true });
}

async function handleDeleteProjectUnit(env, projectId, unitId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to remove flats.', 403);
  const res = await env.DB.prepare('DELETE FROM project_units WHERE id = ?1 AND project_id = ?2').bind(unitId, projectId).run();
  if (!res.meta?.changes) return fail('Flat not found.', 404);
  return json({ ok: true });
}

// ---- Project documents: brochures, price sheets, floor plans (R2) ----
// Same storage (env.IMAGES) and conventions as property photos below.

const MAX_PROJECT_DOC_BYTES = 25 * 1024 * 1024;
/** Allowed document types, by extension. Browsers often send an empty or
 * generic type for Office files, so the extension decides and the stored
 * content type is always one from this list. */
const PROJECT_DOC_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const projectDocUrl = (projectId, docId) => `/api/projects/${projectId}/documents/${docId}`;

/** project id → its documents (oldest first), for handleListProjects. */
async function projectDocumentsByProject(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, project_id, file_name, content_type, size_bytes, created_at FROM project_documents ORDER BY created_at'
  ).all();
  const byProject = new Map();
  for (const { project_id, ...d } of results ?? []) {
    (byProject.get(project_id) ?? byProject.set(project_id, []).get(project_id)).push({ ...d, url: projectDocUrl(project_id, d.id) });
  }
  return byProject;
}

/** Keep the original file name, minus path parts, control and quote characters. */
function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim();
  return base.slice(-160) || 'document';
}

async function handleUploadProjectDocument(request, env, projectId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to add project documents.', 403);
  if (!env.IMAGES) return fail('File storage is not configured on this deployment (missing R2 binding).', 503);
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?1').bind(projectId).first();
  if (!project) return fail('Project not found.', 404);

  let form;
  try { form = await request.formData(); } catch { return fail('Send the document as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file provided.', 422);
  const fileName = cleanFileName(file.name);
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const contentType = PROJECT_DOC_TYPES[ext];
  if (!contentType) return fail('Only PDF, Word, PowerPoint, Excel or JPG/PNG/WEBP files are supported.', 422);
  if (!file.size) return fail('That file is empty.', 422);
  if (file.size > MAX_PROJECT_DOC_BYTES) return fail(`Documents must be under ${MAX_PROJECT_DOC_BYTES / (1024 * 1024)} MB.`, 422);

  const docId = crypto.randomUUID();
  const key = `project-docs/${projectId}/${docId}.${ext}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO project_documents (id, project_id, r2_key, file_name, content_type, size_bytes, created_by_user_id) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(docId, projectId, key, fileName, contentType, file.size, actorUserId(actor)),
    env.DB.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1").bind(projectId),
  ]);
  return json({ ok: true, document: { id: docId, file_name: fileName, content_type: contentType, size_bytes: file.size, url: projectDocUrl(projectId, docId) } }, 201);
}

/** Public, unauthenticated on purpose, same reasoning as handleServeImage:
 *  a plain <a href> cannot attach a Bearer header, brochures are marketing
 *  material, and document IDs are random UUIDs. PDFs and images open in the
 *  browser; Office files download. `?download=1` always downloads. */
async function handleServeProjectDocument(request, env, projectId, docId) {
  const row = await env.DB.prepare('SELECT * FROM project_documents WHERE id = ?1 AND project_id = ?2').bind(docId, projectId).first();
  if (!row) return fail('Document not found.', 404);
  if (!env.IMAGES) return fail('File storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(row.r2_key);
  if (!object) return fail('Document not found.', 404);
  const inline = !new URL(request.url).searchParams.has('download')
    && (row.content_type === 'application/pdf' || row.content_type.startsWith('image/'));
  const ascii = row.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return new Response(object.body, {
    headers: {
      'content-type': row.content_type,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    },
  });
}

async function handleDeleteProjectDocument(env, projectId, docId, actor) {
  if (!canManageProjects(actor)) return fail('You do not have permission to remove project documents.', 403);
  const row = await env.DB.prepare('SELECT r2_key FROM project_documents WHERE id = ?1 AND project_id = ?2').bind(docId, projectId).first();
  if (!row) return fail('Document not found.', 404);
  await env.DB.prepare('DELETE FROM project_documents WHERE id = ?1').bind(docId).run();
  if (env.IMAGES) await env.IMAGES.delete(row.r2_key);
  return json({ ok: true });
}

// ---- Document control (wave3, H3) ----
// Versioned files on a transaction / NOC / lead / property / project (tables
// documents, document_versions, document_events — migration 0069). Files go to
// R2 under `docs/` and are NEVER served publicly: every download goes through
// handleDownloadDocument, which re-checks access and logs who downloaded what.
// Access: 'legal' files need document.read_restricted; 'internal' and 'client'
// files need access to the record (or document.approve, so reviewers can review).
const DOC_ENTITY_TYPES = ['transaction', 'noc', 'lead', 'property', 'project'];
const DOC_TYPES = ['Agreement', 'Index II', 'Possession letter', 'Share certificate', 'Tax receipt', 'MOU draft', 'Sale deed draft', 'NOC letter', 'ID proof', 'Other'];
const DOC_VISIBILITY = ['internal', 'legal', 'client'];
const DOC_REVIEW_STATUSES = ['draft', 'in_review', 'approved', 'rejected', 'signed'];
const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** The record a document hangs off, or null. Tables from other features
 *  (transactions, transaction_nocs) may not exist yet — treat that as "not found". */
async function docEntityRow(env, type, id) {
  const table = { transaction: 'transactions', noc: 'transaction_nocs', lead: 'leads', property: 'properties', project: 'projects' }[type];
  if (!table || !id) return null;
  try { return await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id).first(); } catch { return null; }
}

function docEntityLabel(type, row) {
  if (!row) return null;
  const join = (code, name, fallback) => [code, name].filter(Boolean).join(' · ') || fallback;
  if (type === 'lead') return join(row.lead_code, row.customer_name, 'Lead');
  if (type === 'transaction') return row.txn_code || 'Transaction';
  if (type === 'noc') return `${row.type_label || row.noc_type || ''} NOC`.trim();
  if (type === 'property') return join(row.property_code, row.name, 'Property');
  return row.name || 'Project';
}

/** What `actor` may do with documents on this record. */
function docEntityAccess(actor, type, row) {
  let read = false;
  if (type === 'lead') read = canReadLead(actor, row);
  else if (type === 'transaction' || type === 'noc') {
    read = has(actor, 'transaction.read') || has(actor, 'transaction.write') ||
      (!!actor.id && (row.coordinator_user_id === actor.id || row.relationship_manager_user_id === actor.id));
  } else read = has(actor, 'team.read');
  const write = read && (has(actor, 'document.write') || (type === 'lead' && canUpdateLead(actor, row)));
  return { read, write };
}

const docVisibleTo = (actor, visibility) => visibility !== 'legal' || has(actor, 'document.read_restricted');
const docCanRead = (actor, doc, access) => docVisibleTo(actor, doc.visibility) && (access.read || has(actor, 'document.approve'));

function docAlertLink(type, row, id) {
  if (type === 'noc') return row?.transaction_id ? { kind: 'transaction', id: row.transaction_id } : null;
  return { kind: type, id };
}

function docEvent(env, actor, documentId, action, { version = null, from = null, to = null, comment = null } = {}) {
  return env.DB.prepare(
    'INSERT INTO document_events (id, document_id, action, version, from_status, to_status, comment, user_id, user_name) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)'
  ).bind(crypto.randomUUID(), documentId, action, version, from, to, comment, actorUserId(actor), actor.name || null);
}

/** Active users who may approve documents (role + per-user overrides). */
async function docApproverIds(env, exceptId) {
  const { results } = await env.DB.prepare('SELECT id, role, permission_overrides FROM users WHERE is_active = 1').all();
  return (results ?? []).filter((u) => u.id !== exceptId && has(u, 'document.approve')).map((u) => u.id);
}

async function docNotifyReviewers(env, actor, doc, row) {
  const userIds = await docApproverIds(env, actor.id);
  if (!userIds.length) return;
  await raiseAlert(env, {
    importance: 'medium', to: { userIds },
    title: `Document waiting for review: ${doc.title}`,
    body: `${doc.doc_type} · ${docEntityLabel(doc.entity_type, row) || ''} · sent by ${actor.name || 'someone'}`,
    link: docAlertLink(doc.entity_type, row, doc.entity_id),
  });
}

/** Parse and validate the multipart upload (field "file"). Returns { form, file, fileName, ext, mime } or { error }. */
async function readDocUpload(request) {
  let form;
  try { form = await request.formData(); } catch { return { error: fail('Send the document as multipart/form-data with a "file" field.', 400) }; }
  const file = form.get('file');
  if (!(file instanceof File)) return { error: fail('Choose a file to upload.', 422) };
  const fileName = cleanFileName(file.name);
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const mime = PROJECT_DOC_TYPES[ext];
  if (!mime) return { error: fail('Only PDF, Word, PowerPoint, Excel or JPG/PNG/WEBP files are supported.', 422) };
  if (!file.size) return { error: fail('That file is empty.', 422) };
  if (file.size > MAX_DOC_BYTES) return { error: fail(`Documents must be under ${MAX_DOC_BYTES / (1024 * 1024)} MB.`, 422) };
  return { form, file, fileName, ext, mime };
}

const DOC_LIST_SELECT = `SELECT d.*, cu.name AS created_by_name,
    v.file_name, v.size, v.mime, v.uploaded_at, vu.name AS uploaded_by_name
  FROM documents d
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
  LEFT JOIN users vu ON vu.id = v.uploaded_by`;

/** GET /api/documents
 *   ?entity_type=&entity_id=  → documents on one record (+ what you may do there)
 *   ?queue=review             → everything waiting for review (document.approve)
 *   otherwise                 → the Post-Sales register: transaction + NOC documents,
 *                               filters doc_type, review_status, visibility, q */
async function handleListDocuments(request, env, actor) {
  const url = new URL(request.url);
  const p = (k) => (url.searchParams.get(k) || '').trim();
  const meta = {
    doc_types: DOC_TYPES, can_approve: has(actor, 'document.approve'),
    can_read_restricted: has(actor, 'document.read_restricted'),
  };
  const entityType = p('entity_type'), entityId = p('entity_id');
  if (entityType && entityId) {
    if (!DOC_ENTITY_TYPES.includes(entityType)) return fail('Unknown record type.', 422);
    const row = await docEntityRow(env, entityType, entityId);
    if (!row) return fail('Record not found.', 404);
    const access = docEntityAccess(actor, entityType, row);
    if (!access.read && !meta.can_approve) return fail('You do not have access to this record.', 403);
    const { results } = await env.DB.prepare(`${DOC_LIST_SELECT} WHERE d.entity_type = ?1 AND d.entity_id = ?2 ORDER BY d.created_at DESC`).bind(entityType, entityId).all();
    const documents = (results ?? []).filter((d) => docVisibleTo(actor, d.visibility));
    return json({ ...meta, can_write: access.write, documents });
  }

  const binds = [];
  const bind = (v) => { binds.push(v); return `?${binds.length}`; };
  const filters = [];
  if (p('queue') === 'review') {
    if (!meta.can_approve) return fail('Only people who approve documents can see the review list.', 403);
    filters.push("d.review_status = 'in_review'");
  } else {
    if (!(has(actor, 'transaction.read') || has(actor, 'transaction.write') || meta.can_approve || meta.can_read_restricted)) {
      return fail('You do not have permission to view transaction documents.', 403);
    }
    filters.push("d.entity_type IN ('transaction', 'noc')");
    if (DOC_REVIEW_STATUSES.includes(p('review_status'))) filters.push(`d.review_status = ${bind(p('review_status'))}`);
  }
  if (DOC_TYPES.includes(p('doc_type'))) filters.push(`d.doc_type = ${bind(p('doc_type'))}`);
  if (DOC_VISIBILITY.includes(p('visibility'))) filters.push(`d.visibility = ${bind(p('visibility'))}`);
  if (!meta.can_read_restricted) filters.push("d.visibility <> 'legal'");
  if (p('q')) { const like = bind(`%${p('q').slice(0, 100)}%`); filters.push(`(lower(d.title) LIKE lower(${like}) OR lower(COALESCE(v.file_name,'')) LIKE lower(${like}))`); }
  const { results } = await env.DB.prepare(`${DOC_LIST_SELECT} WHERE ${filters.join(' AND ')} ORDER BY d.updated_at DESC LIMIT 300`).bind(...binds).all();
  const documents = results ?? [];
  // Labels for the records ("T-00012", "L-00031 · Priya") — one lookup per record.
  const rows = new Map();
  await Promise.all([...new Set(documents.map((d) => d.entity_type + '|' + d.entity_id))].map(async (k) => {
    const [type, id] = k.split('|');
    rows.set(k, await docEntityRow(env, type, id));
  }));
  for (const d of documents) {
    const row = rows.get(d.entity_type + '|' + d.entity_id);
    d.entity_label = docEntityLabel(d.entity_type, row);
    d.transaction_id = d.entity_type === 'transaction' ? d.entity_id : d.entity_type === 'noc' ? (row?.transaction_id || null) : null;
  }
  return json({ ...meta, documents });
}

/** Load a document plus its record, and check read access. Returns { doc, row, access } or { error }. */
async function loadDocForActor(env, actor, id) {
  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1').bind(id).first();
  if (!doc) return { error: fail('Document not found.', 404) };
  const row = await docEntityRow(env, doc.entity_type, doc.entity_id);
  const access = row ? docEntityAccess(actor, doc.entity_type, row) : { read: false, write: false };
  if (!docCanRead(actor, doc, access)) return { error: fail('You do not have access to this document.', 403) };
  return { doc, row, access };
}

async function handleGetDocument(env, id, actor) {
  const { doc, row, access, error } = await loadDocForActor(env, actor, id);
  if (error) return error;
  const [versions, events] = await Promise.all([
    env.DB.prepare('SELECT v.id, v.version, v.file_name, v.size, v.mime, v.uploaded_at, v.note, u.name AS uploaded_by_name FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.document_id = ?1 ORDER BY v.version DESC').bind(id).all(),
    env.DB.prepare('SELECT action, version, from_status, to_status, comment, user_name, created_at FROM document_events WHERE document_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 200').bind(id).all(),
  ]);
  return json({
    document: { ...doc, entity_label: docEntityLabel(doc.entity_type, row) },
    versions: versions.results ?? [], events: events.results ?? [],
    can_write: access.write, can_approve: has(actor, 'document.approve'),
    can_read_restricted: has(actor, 'document.read_restricted'),
  });
}

/** POST /api/documents (multipart): file, entity_type, entity_id, doc_type, title, visibility, note?, submit? */
async function handleCreateDocument(request, env, actor) {
  if (!env.IMAGES) return fail('File storage is not configured on this deployment (missing R2 binding).', 503);
  const up = await readDocUpload(request);
  if (up.error) return up.error;
  const f = (k) => String(up.form.get(k) ?? '').trim();
  const entityType = f('entity_type'), entityId = f('entity_id');
  if (!DOC_ENTITY_TYPES.includes(entityType)) return fail('Unknown record type.', 422);
  const row = await docEntityRow(env, entityType, entityId);
  if (!row) return fail('Record not found.', 404);
  if (!docEntityAccess(actor, entityType, row).write) return fail('You do not have permission to add documents here.', 403);
  const docType = DOC_TYPES.includes(f('doc_type')) ? f('doc_type') : 'Other';
  const visibility = DOC_VISIBILITY.includes(f('visibility')) ? f('visibility') : 'internal';
  if (visibility === 'legal' && !has(actor, 'document.read_restricted')) return fail('Only Legal can add legal-only documents.', 403);
  const title = (f('title') || up.fileName.replace(/\.[^.]+$/, '')).slice(0, 160);
  const note = f('note').slice(0, 1000) || null;
  const submit = ['1', 'true', 'yes'].includes(f('submit').toLowerCase());
  const status = submit ? 'in_review' : 'draft';

  const docId = crypto.randomUUID(), versionId = crypto.randomUUID();
  const key = `docs/${docId}/${versionId}.${up.ext}`;
  await env.IMAGES.put(key, await up.file.arrayBuffer(), { httpMetadata: { contentType: up.mime } });
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO documents (id, entity_type, entity_id, doc_type, title, visibility, review_status, current_version, created_by) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)')
        .bind(docId, entityType, entityId, docType, title, visibility, status, actorUserId(actor)),
      env.DB.prepare('INSERT INTO document_versions (id, document_id, version, r2_key, file_name, size, mime, uploaded_by, note) VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8)')
        .bind(versionId, docId, key, up.fileName, up.file.size, up.mime, actorUserId(actor), note),
      docEvent(env, actor, docId, 'created', { version: 1, to: 'draft', comment: note }),
      ...(submit ? [docEvent(env, actor, docId, 'submitted', { version: 1, from: 'draft', to: 'in_review' })] : []),
    ]);
  } catch (e) { await env.IMAGES.delete(key).catch(() => {}); throw e; }
  const doc = { id: docId, entity_type: entityType, entity_id: entityId, doc_type: docType, title, visibility, review_status: status, current_version: 1 };
  if (submit) await docNotifyReviewers(env, actor, doc, row);
  return json({ ok: true, document: doc }, 201);
}

/** POST /api/documents/:id/versions (multipart): file, note. Never overwrites —
 *  a new version row + R2 object. Approved/signed documents need a note and go
 *  back to review; a rejected one goes back to review too. */
async function handleAddDocumentVersion(request, env, id, actor) {
  if (!env.IMAGES) return fail('File storage is not configured on this deployment (missing R2 binding).', 503);
  const { doc, row, access, error } = await loadDocForActor(env, actor, id);
  if (error) return error;
  if (!access.write) return fail('You do not have permission to upload a new version.', 403);
  const up = await readDocUpload(request);
  if (up.error) return up.error;
  const note = String(up.form.get('note') ?? '').trim().slice(0, 1000) || null;
  const locked = doc.review_status === 'approved' || doc.review_status === 'signed';
  if (locked && !note) return fail(`This document is ${doc.review_status}. Say what changed in the new version (a note is required) — it will go back for review.`, 422);
  const status = locked || doc.review_status === 'rejected' ? 'in_review' : doc.review_status;
  const version = doc.current_version + 1;
  const versionId = crypto.randomUUID();
  const key = `docs/${doc.id}/${versionId}.${up.ext}`;
  await env.IMAGES.put(key, await up.file.arrayBuffer(), { httpMetadata: { contentType: up.mime } });
  try {
    // UNIQUE(document_id, version) makes a concurrent upload of the same number fail the whole batch.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO document_versions (id, document_id, version, r2_key, file_name, size, mime, uploaded_by, note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
        .bind(versionId, doc.id, version, key, up.fileName, up.file.size, up.mime, actorUserId(actor), note),
      env.DB.prepare("UPDATE documents SET current_version = ?1, review_status = ?2, updated_at = datetime('now') WHERE id = ?3").bind(version, status, doc.id),
      docEvent(env, actor, doc.id, 'new_version', { version, from: doc.review_status, to: status, comment: note }),
    ]);
  } catch (e) {
    await env.IMAGES.delete(key).catch(() => {});
    if (/UNIQUE/i.test(String(e?.message || e))) return fail('Someone else uploaded a version at the same moment. Refresh and try again.', 409);
    throw e;
  }
  if (status === 'in_review' && doc.review_status !== 'in_review') await docNotifyReviewers(env, actor, doc, row);
  return json({ ok: true, version, review_status: status }, 201);
}

/** PATCH /api/documents/:id { title?, doc_type?, visibility? } */
async function handleUpdateDocument(request, env, id, actor) {
  const { doc, access, error } = await loadDocForActor(env, actor, id);
  if (error) return error;
  if (!access.write) return fail('You do not have permission to edit this document.', 403);
  const body = await bodyJson(request);
  if (!body || typeof body !== 'object') return fail('Send a JSON body.', 400);
  const next = { title: doc.title, doc_type: doc.doc_type, visibility: doc.visibility };
  if (body.title !== undefined) { const t = String(body.title || '').trim().slice(0, 160); if (!t) return fail('Give the document a name.', 422); next.title = t; }
  if (body.doc_type !== undefined) { if (!DOC_TYPES.includes(body.doc_type)) return fail('Unknown document type.', 422); next.doc_type = body.doc_type; }
  if (body.visibility !== undefined) {
    if (!DOC_VISIBILITY.includes(body.visibility)) return fail('Unknown visibility.', 422);
    if ((body.visibility === 'legal' || doc.visibility === 'legal') && body.visibility !== doc.visibility && !has(actor, 'document.read_restricted')) {
      return fail('Only Legal can change who sees legal-only documents.', 403);
    }
    next.visibility = body.visibility;
  }
  const changed = Object.keys(next).filter((k) => next[k] !== doc[k]);
  if (!changed.length) return json({ ok: true, document: { ...doc } });
  await env.DB.batch([
    env.DB.prepare("UPDATE documents SET title = ?1, doc_type = ?2, visibility = ?3, updated_at = datetime('now') WHERE id = ?4").bind(next.title, next.doc_type, next.visibility, doc.id),
    docEvent(env, actor, doc.id, 'edited', { comment: changed.map((k) => `${k.replace('_', ' ')}: ${doc[k]} → ${next[k]}`).join('; ') }),
  ]);
  return json({ ok: true, document: { ...doc, ...next } });
}

/** POST /api/documents/:id/review { action: submit | approve | reject | sign, comment? } */
async function handleReviewDocument(request, env, id, actor) {
  const { doc, row, access, error } = await loadDocForActor(env, actor, id);
  if (error) return error;
  const body = (await bodyJson(request)) || {};
  const action = String(body.action || '');
  const comment = String(body.comment ?? '').trim().slice(0, 1000) || null;
  const approver = has(actor, 'document.approve');
  const steps = {
    submit: { from: ['draft', 'rejected'], to: 'in_review', allowed: access.write, event: 'submitted' },
    approve: { from: ['in_review'], to: 'approved', allowed: approver, event: 'approved' },
    reject: { from: ['in_review'], to: 'rejected', allowed: approver, event: 'rejected' },
    sign: { from: ['approved'], to: 'signed', allowed: approver || access.write, event: 'signed' },
  };
  const step = steps[action];
  if (!step) return fail('Unknown review action.', 422);
  if (!step.allowed) return fail(action === 'approve' || action === 'reject' ? 'Only Legal or an administrator can approve or reject documents.' : 'You do not have permission to do that.', 403);
  if (action === 'reject' && !comment) return fail('Say why it is rejected, so it can be fixed.', 422);
  if (!step.from.includes(doc.review_status)) return fail(`This document is ${doc.review_status.replace('_', ' ')} — it cannot be ${step.event} now.`, 409);
  // The history line is written only if the guarded UPDATE changed the row (changes() = 1),
  // so two reviewers clicking at once can't both "win".
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE documents SET review_status = ?1, updated_at = datetime('now') WHERE id = ?2 AND review_status = ?3").bind(step.to, doc.id, doc.review_status),
    env.DB.prepare('INSERT INTO document_events (id, document_id, action, version, from_status, to_status, comment, user_id, user_name) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes() = 1')
      .bind(crypto.randomUUID(), doc.id, step.event, doc.current_version, doc.review_status, step.to, comment, actorUserId(actor), actor.name || null),
  ]);
  if (!res.meta?.changes) return fail('Someone else changed this document just now. Refresh and try again.', 409);
  if (action === 'submit') await docNotifyReviewers(env, actor, doc, row);
  if ((action === 'approve' || action === 'reject') && doc.created_by && doc.created_by !== actor.id) {
    await raiseAlert(env, {
      importance: action === 'reject' ? 'high' : 'normal', to: { userIds: [doc.created_by] },
      title: `${doc.title} was ${step.event}`,
      body: comment ? `${actor.name || 'Reviewer'}: ${comment}` : `By ${actor.name || 'the reviewer'}`,
      link: docAlertLink(doc.entity_type, row, doc.entity_id),
    });
  }
  return json({ ok: true, review_status: step.to });
}

/** GET /api/documents/:id/versions/:version/download — authenticated, access
 *  re-checked here, and every download is written to the history. */
async function handleDownloadDocument(request, env, id, versionNo, actor) {
  const { doc, error } = await loadDocForActor(env, actor, id);
  if (error) return error;
  if (!env.IMAGES) return fail('File storage is not configured on this deployment.', 503);
  const version = versionNo === 'latest' ? doc.current_version : parseInt(versionNo, 10);
  const v = await env.DB.prepare('SELECT * FROM document_versions WHERE document_id = ?1 AND version = ?2').bind(doc.id, version).first();
  if (!v) return fail('That version does not exist.', 404);
  const object = await env.IMAGES.get(v.r2_key);
  if (!object) return fail('The file is missing from storage.', 404);
  await docEvent(env, actor, doc.id, 'downloaded', { version: v.version }).run();
  const inline = new URL(request.url).searchParams.has('inline') && (v.mime === 'application/pdf' || v.mime.startsWith('image/'));
  const ascii = v.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return new Response(object.body, {
    headers: {
      'content-type': v.mime,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(v.file_name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
// ---- end document control (wave3, H3) ----

async function handleListBuilders(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view builders.', 403);
  const { results } = await env.DB.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM properties p WHERE p.builder_id = b.id AND p.is_active = 1 AND p.pipeline = 'catalog') AS property_count
       FROM builders b ORDER BY b.name`
  ).all();
  return json({
    builders: (results ?? []).map(({ logo_r2_key, ...b }) => ({
      ...b, locations: (b.locations || '').split(',').map((s) => s.trim()).filter(Boolean),
      logo_url: logo_r2_key ? `/api/builders/${b.id}/logo` : null,
    })),
  });
}

/** Declare or correct a builder's locations directly — independent of adding
 *  a property, e.g. to record a builder you know operates somewhere before
 *  the first property under them exists here. */
async function handleUpsertBuilder(request, env, actor) {
  if (!has(actor, 'catalog.manage')) return fail('Only administrators can manage builders.', 403);
  const body = await bodyJson(request);
  if (!body?.name?.trim()) return fail('Builder name is required.', 422);
  const name = body.name.trim();
  const locationsCsv = Array.isArray(body.locations)
    ? [...new Set(body.locations.map((s) => String(s).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).join(', ')
    : typeof body.locations === 'string' ? mergeLocations('', body.locations) : '';
  // Optional track record. A key left out of the body keeps what is stored;
  // null / '' clears it.
  const track = {};
  for (const [key, label, max] of [['projects_delivered', 'No. of projects delivered', 100000], ['years_in_business', 'No. of years', 500]]) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === undefined || String(raw).trim() === '') { track[key] = null; continue; }
    const text = String(raw).trim();
    if (!/^\d+$/.test(text) || Number(text) > max) return fail(`${label} must be a whole number from 0 to ${max.toLocaleString('en-IN')}.`, 422);
    track[key] = Number(text);
  }
  if ('possession_timeline' in body) {
    if (body.possession_timeline != null && typeof body.possession_timeline !== 'string') return fail('Possession timeline must be text.', 422);
    if ((body.possession_timeline ?? '').trim().length > 300) return fail('Possession timeline must be 300 characters or fewer.', 422);
    track.possession_timeline = cleanText(body.possession_timeline, 300);
  }
  const existing = await env.DB.prepare('SELECT * FROM builders WHERE lower(name) = lower(?1)').bind(name).first();
  const pick = (key) => (key in track ? track[key] : existing ? existing[key] ?? null : null);
  if (existing) {
    await env.DB.prepare('UPDATE builders SET name = ?2, locations = ?3, projects_delivered = ?4, possession_timeline = ?5, years_in_business = ?6 WHERE id = ?1')
      .bind(existing.id, name, locationsCsv || existing.locations, pick('projects_delivered'), pick('possession_timeline'), pick('years_in_business')).run();
    return json({ ok: true, builder_id: existing.id });
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO builders (id, name, locations, projects_delivered, possession_timeline, years_in_business) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, name, locationsCsv, pick('projects_delivered'), pick('possession_timeline'), pick('years_in_business')).run();
  } catch (e) {
    return fail(String(e).includes('UNIQUE') ? 'A builder with that name already exists.' : 'Could not save builder.', 422);
  }
  return json({ ok: true, builder_id: id }, 201);
}

// ---------------------------------------------------------------------------
// Property photos (Cloudflare R2)
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function handleUploadPropertyImage(request, env, propertyId, actor) {
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment (missing R2 binding).', 503);
  const property = await env.DB.prepare('SELECT id, created_by_user_id FROM properties WHERE id = ?1').bind(propertyId).first();
  if (!property) return fail('Property not found.', 404);
  if (!canManagePropertyImages(actor, property)) return fail('You can add photos only to properties you created.', 403);

  let form;
  try { form = await request.formData(); } catch { return fail('Send the image as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file provided.', 422);
  if (!Object.hasOwn(IMAGE_EXTENSION, file.type)) return fail('Only JPEG, PNG, WEBP or GIF images are supported.', 422);
  if (file.size > MAX_IMAGE_BYTES) return fail(`Image must be under ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, 422);

  const titleValue = form.get('title');
  const title = typeof titleValue === 'string' && titleValue.trim() ? titleValue.trim().slice(0, 120) : null;
  const category = form.get('category') === 'building' ? 'building' : 'property';
  const imageId = crypto.randomUUID();
  const key = `properties/${propertyId}/${imageId}.${IMAGE_EXTENSION[file.type]}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const sortOrder = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM property_images WHERE property_id = ?1').bind(propertyId).first('sort_order');
  await env.DB.prepare('INSERT INTO property_images (id, property_id, r2_key, content_type, size_bytes, title, category, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
    .bind(imageId, propertyId, key, file.type, file.size, title, category, sortOrder).run();
  return json({ ok: true, image_id: imageId, url: `/api/images/${imageId}`, title, category, sort_order: sortOrder }, 201);
}

/** Public, unauthenticated on purpose: a plain <img src> request from the
 *  browser cannot attach a Bearer header, and property photos are marketing
 *  material, not sensitive customer data. Image IDs are random UUIDs, so
 *  this is "unauthenticated" in the same sense an unlisted S3/R2 object URL
 *  is — not enumerable, but not access-controlled either. */
async function handleServeImage(env, imageId) {
  const row = await env.DB.prepare('SELECT * FROM property_images WHERE id = ?1').bind(imageId).first();
  if (!row) return fail('Image not found.', 404);
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(row.r2_key);
  if (!object) return fail('Image not found.', 404);
  return new Response(object.body, {
    headers: { 'content-type': row.content_type, 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

async function handleUploadBuilderLogo(request, env, builderId, actor) {
  if (!has(actor, 'catalog.manage')) return fail('Only administrators can manage builders.', 403);
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment (missing R2 binding).', 503);
  const builder = await env.DB.prepare('SELECT id, logo_r2_key FROM builders WHERE id = ?1').bind(builderId).first();
  if (!builder) return fail('Builder not found.', 404);

  let form;
  try { form = await request.formData(); } catch { return fail('Send the logo as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file provided.', 422);
  if (!Object.hasOwn(IMAGE_EXTENSION, file.type)) return fail('Only JPEG, PNG, WEBP or GIF images are supported.', 422);
  if (file.size > MAX_IMAGE_BYTES) return fail(`Logo must be under ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, 422);

  const key = `builders/${builderId}/logo-${crypto.randomUUID()}.${IMAGE_EXTENSION[file.type]}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  if (builder.logo_r2_key) await env.IMAGES.delete(builder.logo_r2_key);
  await env.DB.prepare('UPDATE builders SET logo_r2_key = ?2 WHERE id = ?1').bind(builderId, key).run();
  return json({ ok: true, logo_url: `/api/builders/${builderId}/logo` });
}

/** Public and unauthenticated on purpose, same reasoning as handleServeImage:
 *  a builder logo is marketing material shown on brochures, and a plain
 *  <img src> request can't attach a Bearer header. */
async function handleServeBuilderLogo(env, builderId) {
  const builder = await env.DB.prepare('SELECT logo_r2_key FROM builders WHERE id = ?1').bind(builderId).first();
  if (!builder?.logo_r2_key) return fail('Logo not found.', 404);
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(builder.logo_r2_key);
  if (!object) return fail('Logo not found.', 404);
  return new Response(object.body, {
    headers: { 'content-type': object.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

async function handleDeletePropertyImage(env, propertyId, imageId, actor) {
  const row = await env.DB.prepare(`SELECT pi.*, p.created_by_user_id
    FROM property_images pi JOIN properties p ON p.id = pi.property_id
    WHERE pi.id = ?1 AND pi.property_id = ?2`).bind(imageId, propertyId).first();
  if (!row) return fail('Image not found.', 404);
  if (!canManagePropertyImages(actor, row)) return fail('You can remove photos only from properties you created.', 403);
  if (env.IMAGES) await env.IMAGES.delete(row.r2_key);
  await env.DB.prepare('DELETE FROM property_images WHERE id = ?1').bind(imageId).run();
  return json({ ok: true });
}

async function handleUpdatePropertyImage(request, env, propertyId, imageId, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const row = await env.DB.prepare(`SELECT pi.*, p.created_by_user_id
    FROM property_images pi JOIN properties p ON p.id = pi.property_id
    WHERE pi.id = ?1 AND pi.property_id = ?2`).bind(imageId, propertyId).first();
  if (!row) return fail('Image not found.', 404);
  if (!canManagePropertyImages(actor, row)) return fail('You can edit photo details only for properties you created.', 403);
  const title = body.title === undefined ? row.title : (typeof body.title === 'string' ? body.title.trim().slice(0, 120) || null : null);
  const category = body.category === undefined ? row.category : body.category;
  if (!['building', 'property'].includes(category)) return fail('Choose Building Images or Property Images.', 422);
  const sortOrder = body.sort_order === undefined ? row.sort_order : Math.max(0, parseInt(body.sort_order, 10) || 0);
  await env.DB.prepare('UPDATE property_images SET title = ?3, category = ?4, sort_order = ?5 WHERE id = ?1 AND property_id = ?2')
    .bind(imageId, propertyId, title, category, sortOrder).run();
  return json({ ok: true, image: { id: imageId, title, category, sort_order: sortOrder, url: `/api/images/${imageId}` } });
}

async function handleUploadBrochureLogo(request, env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can replace the brochure logo.', 403);
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment (missing R2 binding).', 503);
  let form;
  try { form = await request.formData(); } catch { return fail('Send the logo as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File) || !Object.hasOwn(IMAGE_EXTENSION, file.type)) return fail('Use a JPEG, PNG, WEBP or GIF logo file.', 422);
  if (file.size > 2 * 1024 * 1024) return fail('Logo must be under 2 MB.', 422);
  const old = await env.DB.prepare("SELECT r2_key FROM workspace_assets WHERE key = 'brochure_logo'").first();
  const key = `branding/brochure-logo-${crypto.randomUUID()}.${IMAGE_EXTENSION[file.type]}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  if (old?.r2_key) await env.IMAGES.delete(old.r2_key);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_assets (key,r2_key,content_type) VALUES ('brochure_logo',?1,?2) ON CONFLICT(key) DO UPDATE SET r2_key=excluded.r2_key,content_type=excluded.content_type,updated_at=datetime('now')").bind(key, file.type),
    env.DB.prepare("INSERT INTO workspace_settings (key,value,updated_at) VALUES ('brochure_logo_url','/api/branding/logo',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')"),
  ]);
  return json({ ok: true, url: '/api/branding/logo' });
}

async function handleServeBrochureLogo(env) {
  const asset = await env.DB.prepare("SELECT * FROM workspace_assets WHERE key = 'brochure_logo'").first();
  if (!asset || !env.IMAGES) return fail('Custom brochure logo not found.', 404);
  const object = await env.IMAGES.get(asset.r2_key);
  if (!object) return fail('Custom brochure logo not found.', 404);
  return new Response(object.body, { headers: { 'content-type': asset.content_type, 'cache-control': 'public, max-age=31536000, immutable' } });
}

async function handleDeleteBrochureLogo(env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can remove the brochure logo.', 403);
  const asset = await env.DB.prepare("SELECT * FROM workspace_assets WHERE key = 'brochure_logo'").first();
  if (asset?.r2_key && env.IMAGES) await env.IMAGES.delete(asset.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspace_assets WHERE key = 'brochure_logo'"),
    env.DB.prepare("INSERT INTO workspace_settings (key,value,updated_at) VALUES ('brochure_logo_url','/atlantic-properties-logo.png',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')"),
  ]);
  return json({ ok: true, url: '/atlantic-properties-logo.png' });
}

/** PUT /api/auto-assign-approval { on: boolean } — super administrator and managers switch manager approval on or off. */
async function handleSetAutoAssignApproval(request, env, actor) {
  if (!['super_admin', 'manager'].includes(actor.role)) return fail('Only the super administrator and managers can change this.', 403);
  const body = await bodyJson(request);
  if (!body || typeof body.on !== 'boolean') return fail('Send { "on": true } or { "on": false }.', 422);
  await env.DB.prepare("INSERT INTO workspace_settings (key,value,updated_at) VALUES ('auto_assign_approval',?1,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(body.on ? 'on' : 'off').run();
  const assignedNow = body.on ? 0 : await autoApprovePending(env);
  return json({ ok: true, on: body.on, assigned_now: assignedNow });
}

async function handleWorkspaceSettings(request, env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view workspace settings.', 403);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT key, value FROM workspace_settings').all();
    return json({ settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...Object.fromEntries((results ?? []).map(row => [row.key, row.value])) } });
  }
  if (actor.role !== 'super_admin') return fail('Only the super administrator can change workspace settings.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const entries = Object.keys(DEFAULT_WORKSPACE_SETTINGS)
    .filter(key => typeof body[key] === 'string')
    .map(key => [key, body[key]]);
  if (!entries.length) return fail('Provide at least one setting to update.', 422);
  const required = new Set(['business_name', 'workspace_name', 'welcome_text']);
  for (const [key, value] of entries) {
    const max = key === 'brochure_contact_address' ? 400 : 160;
    if ((required.has(key) && !value.trim()) || value.trim().length > max) return fail(`Settings must contain ${required.has(key) ? '1' : '0'}–${max} characters.`, 422);
  }
  // Daily digest settings (Agent OPS). The provider API key is NOT a setting:
  // it is the RESEND_API_KEY Worker secret, read from env only.
  const aa = entries.find(([k]) => k === 'auto_assign_approval');
  if (aa && !['on', 'off'].includes(aa[1])) return fail('Manager approval must be on or off.', 422);
  const digestError = validateDigestSettings(Object.fromEntries(entries));
  if (digestError) return fail(digestError, 422);
  for (const [key, value] of entries) {
    await env.DB.prepare(
      "INSERT INTO workspace_settings (key,value,updated_at) VALUES (?1,?2,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(key, value.trim()).run();
  }
  let assignedNow = 0;
  if (aa && aa[1] === 'off') assignedNow = await autoApprovePending(env); // leads already waiting in the queue get their suggested person now
  const { results } = await env.DB.prepare('SELECT key, value FROM workspace_settings').all();
  return json({ assigned_now: assignedNow, settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...Object.fromEntries((results ?? []).map(row => [row.key, row.value])) } });
}

async function handleGetLead(env, id, actor) {
  const lead = await env.DB.prepare(
    `SELECT l.*, u.name AS assigned_user_name, t.name AS team_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_user_id
       LEFT JOIN teams t ON t.id = l.team_id
      WHERE l.id = ?1`
  )
    .bind(id)
    .first();

  if (!lead) return fail('Lead not found.', 404);
  // Someone offered this lead through a pending transfer must be able to open
  // it to decide whether to accept — otherwise the transfer can never resolve.
  if (!canReadLead(actor, lead)) {
    const offered = await env.DB.prepare("SELECT 1 FROM lead_transfer_requests WHERE lead_id = ?1 AND to_user_id = ?2 AND status = 'pending'").bind(id, actor.id).first();
    if (!offered && !(await handoverGrantsLeadRead(env, id, actor))) return fail('You do not have permission to view this lead.', 403); // wave3 D: handover receivers
  }

  const [history, activities, transfers, stageHistory, assignmentApproval, discussedProperties] = await Promise.all([
    env.DB.prepare(
      `SELECT h.*, fu.name AS from_user_name, tu.name AS to_user_name
         FROM assignment_history h
         LEFT JOIN users fu ON fu.id = h.from_user_id
         LEFT JOIN users tu ON tu.id = h.to_user_id
        WHERE h.lead_id = ?1
        ORDER BY h.id ASC`
    ).bind(id).all(),
    env.DB.prepare(`SELECT a.*, u.name AS actor_name FROM lead_activities a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.lead_id = ?1 ORDER BY a.created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT r.*, fu.name AS from_user_name, tu.name AS to_user_name FROM lead_transfer_requests r LEFT JOIN users fu ON fu.id = r.from_user_id LEFT JOIN users tu ON tu.id = r.to_user_id WHERE r.lead_id = ?1 ORDER BY r.created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT s.*, u.name AS actor_name FROM lead_stage_history s LEFT JOIN users u ON u.id = s.actor_user_id WHERE s.lead_id = ?1 ORDER BY s.id DESC`).bind(id).all(),
    env.DB.prepare(`SELECT a.*, u.name AS recommended_user_name, t.name AS recommended_team_name,
                          r.name AS reviewer_user_name, f.name AS final_user_name
                     FROM assignment_approvals a
                     LEFT JOIN users u ON u.id = a.recommended_user_id
                     LEFT JOIN teams t ON t.id = a.recommended_team_id
                     LEFT JOIN users r ON r.id = a.reviewer_user_id
                     LEFT JOIN users f ON f.id = a.final_user_id
                    WHERE a.lead_id = ?1`).bind(id).first(),
    env.DB.prepare(
      `SELECT p.id, p.name, p.property_type, p.location, p.locality, p.bedrooms, p.bedroom_count, p.bathroom_count, p.balcony_count,
              p.availability, p.construction_status, p.carpet_area_sqft, p.house_no, p.society_name, p.sub_locality, p.tower_count,
              p.description, p.listing_type, b.name AS builder_name
         FROM lead_discussed_properties d
         JOIN properties p ON p.id = d.property_id
         LEFT JOIN builders b ON b.id = p.builder_id
        WHERE d.lead_id = ?1
        ORDER BY d.created_at ASC`
    ).bind(id).all(),
  ]);
  return json({
    lead, history: history.results ?? [], activities: activities.results ?? [], transfers: transfers.results ?? [],
    stage_history: stageHistory.results ?? [], assignment_approval: assignmentApproval ?? null,
    discussed_properties: discussedProperties.results ?? [],
  });
}

async function handleAddDiscussedProperty(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body?.property_id) return fail('Choose a property.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  const property = await env.DB.prepare("SELECT id FROM properties WHERE id=?1 AND pipeline='catalog'").bind(body.property_id).first();
  if (!property) return fail('Property not found.', 404);
  await env.DB.prepare(
    'INSERT INTO lead_discussed_properties (lead_id, property_id) VALUES (?1,?2) ON CONFLICT(lead_id, property_id) DO NOTHING'
  ).bind(id, property.id).run();
  return json({ ok: true }, 201);
}

async function handleRemoveDiscussedProperty(env, id, propertyId, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  await env.DB.prepare('DELETE FROM lead_discussed_properties WHERE lead_id=?1 AND property_id=?2').bind(id, propertyId).run();
  return json({ ok: true });
}

// ---- requirement profile, options shared, price history (wave3 E, migration 0064) ----
/** leads.requirement_profile keys → allowed values (array = one of), or a value kind. */
const REQ_PROFILE_SPEC = {
  intent: ['buy', 'rent', 'invest'], purpose: ['self_use', 'investment'], move_in: 'month',
  category: ['residential', 'commercial', 'land'], property_kind: 'text', localities: 'list', projects: 'list',
  configuration: 'list', carpet_min: 'int', carpet_max: 'int', floor_pref: ['low', 'middle', 'high', 'any'],
  budget_min: 'money', budget_max: 'money', own_contribution: 'money', loan_amount: 'money', rent_max: 'money', deposit_max: 'money',
  stage_pref: ['ready_to_move', 'under_construction', 'prelaunch', 'any'], furnishing: ['unfurnished', 'semi_furnished', 'furnished', 'any'],
  parking: ['none', 'one', 'two_plus'], amenities: 'list', connectivity: 'text',
  decision_makers: 'text', property_to_sell: ['yes', 'no'], visit_availability: 'text', objections: 'text', deal_breakers: 'text',
  language: 'text', channel: ['call', 'whatsapp', 'email', 'in_person'], best_time: ['morning', 'afternoon', 'evening', 'weekend', 'any'],
};

/** Whitelists and tidies a profile object; unknown keys and empty values are dropped. */
function cleanRequirementProfile(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, kind] of Object.entries(REQ_PROFILE_SPEC)) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(kind)) { if (kind.includes(v)) out[key] = v; continue; }
    if (kind === 'text') { const t = String(v).trim().slice(0, 500); if (t) out[key] = t; }
    else if (kind === 'list') {
      const items = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().slice(0, 80)).filter(Boolean);
      const unique = [...new Set(items)].slice(0, 20);
      if (unique.length) out[key] = unique;
    } else if (kind === 'month') { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v))) out[key] = String(v); }
    else if (kind === 'int') { const n = parseCount(v); if (n !== null) out[key] = n; }
    else if (kind === 'money') { const n = parseMoney(v); if (n !== null && n >= 0) out[key] = n; }
  }
  return out;
}

/** PUT /api/leads/:id/requirement-profile { profile } — saves the profile and keeps the
 * older lead columns (budget, type, area, client timeline) in step where the profile says something. */
async function handleSaveRequirementProfile(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body || typeof body.profile !== 'object') return fail('Send the profile as { profile: {...} }.', 400);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  const p = cleanRequirementProfile(body.profile);
  if (p.budget_min != null && p.budget_max != null && p.budget_min > p.budget_max) return fail('Lowest budget is more than the highest budget.', 422);
  if (p.carpet_min != null && p.carpet_max != null && p.carpet_min > p.carpet_max) return fail('Smallest area is more than the largest area.', 422);
  const typeText = [p.configuration?.join(' / '), p.property_kind].filter(Boolean).join(' ');
  const propertyType = typeText ? (p.intent === 'rent' ? typeText + ' on rent' : typeText).slice(0, 160) : lead.property_type;
  const location = p.localities?.length ? p.localities.join(', ').slice(0, 200) : lead.location;
  const clientStatus = p.stage_pref && p.stage_pref !== 'any' ? p.stage_pref : lead.client_status;
  await env.DB.prepare('UPDATE leads SET requirement_profile=?2, budget_min=?3, budget_max=?4, property_type=?5, location=?6, client_status=?7 WHERE id=?1')
    .bind(id, JSON.stringify(p), p.budget_min ?? lead.budget_min, p.budget_max ?? lead.budget_max, propertyType, location, clientStatus).run();
  return json({ ok: true, profile: p });
}

const SHORTLIST_RESPONSES = ['interested', 'not_interested', 'visit_wanted', 'no_reply'];

/** GET /api/leads/:id/shortlist — every option shared with this client, newest first. */
async function handleListShortlist(env, id, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canReadLead(actor, lead)) return fail('You do not have permission to view this lead.', 403);
  const rows = (await env.DB.prepare(
    `SELECT s.*, u.name AS shared_by_name, pr.name AS project_name, pr.locality AS project_locality, pr.location AS project_location
       FROM lead_shortlist s
       LEFT JOIN users u ON u.id = s.shared_by_user_id
       LEFT JOIN projects pr ON pr.id = s.project_id
      WHERE s.lead_id = ?1 ORDER BY s.shared_at DESC, s.rowid DESC`
  ).bind(id).all()).results ?? [];
  // Properties fetched whole so later columns (property_code, inventory_status) come along when present.
  const ids = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
  const props = new Map();
  if (ids.length) {
    const found = await env.DB.prepare(`SELECT * FROM properties WHERE id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...ids).all();
    for (const p of found.results ?? []) props.set(p.id, p);
  }
  return json({ shortlist: rows.map((r) => {
    const p = props.get(r.property_id);
    return { ...r, property: p ? {
      id: p.id, name: p.name, property_code: p.property_code ?? null, property_type: p.property_type, locality: p.locality, location: p.location,
      price_expected: p.price_expected, budget_min: p.budget_min, budget_max: p.budget_max, availability: p.availability,
      is_active: p.is_active, inventory_status: p.inventory_status ?? null,
    } : null };
  }) });
}

/** POST /api/leads/:id/shortlist { items: [{ property_id | project_id, price_shared? }], note? } */
async function handleAddShortlist(request, env, id, actor) {
  const body = await bodyJson(request);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
  if (!items.length) return fail('Choose at least one property or project.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null;
  const statements = [];
  const names = [];
  for (const item of items) {
    let propertyId = null, projectId = null, name, current = null;
    if (item?.property_id) {
      const p = await env.DB.prepare("SELECT id, name, price_expected, budget_min FROM properties WHERE id=?1 AND pipeline='catalog'").bind(item.property_id).first();
      if (!p) return fail('One of the chosen properties was not found.', 404);
      propertyId = p.id; name = p.name; current = p.price_expected ?? p.budget_min ?? null;
    } else if (item?.project_id) {
      const pr = await env.DB.prepare('SELECT id, name FROM projects WHERE id=?1').bind(item.project_id).first();
      if (!pr) return fail('One of the chosen projects was not found.', 404);
      projectId = pr.id; name = pr.name;
    } else return fail('Each option needs a property or a project.', 422);
    const price = item.price_shared === undefined ? current : parseMoney(item.price_shared);
    statements.push(env.DB.prepare(
      'INSERT INTO lead_shortlist (id, lead_id, property_id, project_id, price_shared, shared_by_user_id, note) VALUES (?1,?2,?3,?4,?5,?6,?7)'
    ).bind(crypto.randomUUID(), id, propertyId, projectId, price, actorUserId(actor), note));
    // Shared options also count as "discussed", so the combined brochure picks them up.
    if (propertyId) statements.push(env.DB.prepare(
      'INSERT INTO lead_discussed_properties (lead_id, property_id) VALUES (?1,?2) ON CONFLICT(lead_id, property_id) DO NOTHING'
    ).bind(id, propertyId));
    names.push(name);
  }
  statements.push(env.DB.prepare("INSERT INTO lead_activities (id,lead_id,actor_user_id,type,subject) VALUES (?1,?2,?3,'note',?4)")
    .bind(crypto.randomUUID(), id, actorUserId(actor), ('Shared options: ' + names.join(', ')).slice(0, 500)));
  await env.DB.batch(statements);
  return handleListShortlist(env, id, actor);
}

/** PATCH / DELETE /api/leads/:id/shortlist/:sid — record the client's answer, or remove the row. */
async function handleShortlistItem(request, env, id, sid, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  const row = await env.DB.prepare('SELECT * FROM lead_shortlist WHERE id=?1 AND lead_id=?2').bind(sid, id).first();
  if (!row) return fail('That shared option was not found.', 404);
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM lead_shortlist WHERE id=?1').bind(sid).run();
    return json({ ok: true });
  }
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const response = body.response === undefined ? row.response : body.response;
  if (!SHORTLIST_RESPONSES.includes(response)) return fail('Choose how the client responded.', 422);
  const note = body.note === undefined ? row.note : (typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null);
  const price = body.price_shared === undefined ? row.price_shared : parseMoney(body.price_shared);
  await env.DB.prepare("UPDATE lead_shortlist SET response=?2, note=?3, price_shared=?4, updated_at=datetime('now') WHERE id=?1")
    .bind(sid, response, note, price).run();
  return json({ ok: true });
}

/** GET /api/properties/:id/price-history */
async function handlePropertyPriceHistory(env, propertyId, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view the property catalogue.', 403);
  const rows = await env.DB.prepare(
    `SELECT h.*, u.name AS changed_by_name FROM property_price_history h LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.property_id = ?1 ORDER BY h.changed_at DESC, h.rowid DESC LIMIT 200`
  ).bind(propertyId).all();
  return json({ history: rows.results ?? [] });
}

const inrShort = (n) => (n == null || n === '' ? '—' : Number(n) >= 1e7 ? '₹' + (Number(n) / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr' : '₹' + (Number(n) / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L');
/** Price as stored in history: the asking price, else the "min-max" budget range. */
const priceSnapshot = (p) => (p.price_expected != null ? String(p.price_expected)
  : p.budget_min != null || p.budget_max != null ? `${p.budget_min ?? ''}-${p.budget_max ?? ''}` : null);
const priceWords = (v) => (v == null ? 'no price' : v.includes('-') ? v.split('-').map((x) => (x ? inrShort(x) : '?')).join(' – ') : inrShort(v));
const availabilitySnapshot = (p) => (p.availability === 'no' || p.is_active === 0 ? 'no' : 'yes');
const UNAVAILABLE_STATUSES = new Set(['sold', 'leased']);

/**
 * Called after a property is saved with the row as it was before: logs price /
 * availability / inventory status changes and alerts whoever shared it with an open
 * lead. Never throws (a history problem must not fail the save). Other features that
 * change inventory_status can call it too.
 */
async function recordPropertyChanges(env, before, propertyId, actor) {
  try {
    if (!before) return;
    const after = await env.DB.prepare('SELECT * FROM properties WHERE id=?1').bind(propertyId).first();
    if (!after) return;
    const changes = [];
    const priceOld = priceSnapshot(before), priceNew = priceSnapshot(after);
    if (priceOld !== priceNew) changes.push({ field: 'price', old: priceOld, new: priceNew });
    const availOld = availabilitySnapshot(before), availNew = availabilitySnapshot(after);
    if (availOld !== availNew) changes.push({ field: 'availability', old: availOld, new: availNew });
    if ('inventory_status' in after && (before.inventory_status ?? null) !== (after.inventory_status ?? null)) {
      changes.push({ field: 'status', old: before.inventory_status ?? null, new: after.inventory_status ?? null });
    }
    if (!changes.length) return;
    const by = actorUserId(actor);
    await env.DB.batch(changes.map((c) => env.DB.prepare(
      'INSERT INTO property_price_history (id, property_id, field, old_value, new_value, changed_by_user_id) VALUES (?1,?2,?3,?4,?5,?6)'
    ).bind(crypto.randomUUID(), propertyId, c.field, c.old, c.new, by)));
    await alertShortlisters(env, after, changes, by);
  } catch (e) { console.error('recordPropertyChanges failed', e); }
}

/** Alerts the sharer(s) + assignee of every open lead that has this property on its shortlist.
 * `after` = property row (id, name, pipeline), changes = [{ field, old, new }]. Never throws. */
async function alertShortlisters(env, after, changes, by) {
  try {
    if (!after || after.pipeline !== 'catalog' || !changes?.length) return;
    const propertyId = after.id;
    const lostIt = changes.some((c) => (c.field === 'availability' && c.new === 'no') || (c.field === 'status' && UNAVAILABLE_STATUSES.has(c.new)));
    const priceChange = changes.find((c) => c.field === 'price');
    const statusChange = changes.find((c) => c.field === 'status');
    const title = lostIt
      ? `${after.name} is no longer available` + (statusChange && UNAVAILABLE_STATUSES.has(statusChange.new) ? ` (${statusChange.new})` : '')
      : priceChange ? `Price changed: ${after.name}`
      : `${after.name} is ` + (statusChange ? (INVENTORY_STATUS_LABEL[statusChange.new] || String(statusChange.new || 'updated').replace(/_/g, ' ')).toLowerCase() : 'available again');
    const detail = priceChange ? `Price was ${priceWords(priceChange.old)}, now ${priceWords(priceChange.new)}.` : '';
    const rows = (await env.DB.prepare(
      `SELECT s.lead_id, s.shared_by_user_id, l.assigned_user_id, l.customer_name
         FROM lead_shortlist s JOIN leads l ON l.id = s.lead_id
        WHERE s.property_id = ?1 AND s.response <> 'not_interested' AND l.stage NOT IN ('won', 'lost')`
    ).bind(propertyId).all()).results ?? [];
    const byLead = new Map();
    for (const r of rows) {
      const entry = byLead.get(r.lead_id) ?? byLead.set(r.lead_id, { name: r.customer_name, users: new Set() }).get(r.lead_id);
      for (const u of [r.shared_by_user_id, r.assigned_user_id]) if (u && u !== by) entry.users.add(u);
    }
    for (const [leadId, entry] of byLead) {
      if (!entry.users.size) continue;
      await raiseAlert(env, {
        importance: lostIt ? 'high' : 'medium', to: { userIds: [...entry.users] }, title,
        body: [detail, `It is on ${entry.name || 'a client'}'s shortlist.`].filter(Boolean).join(' '),
        link: { kind: 'lead', id: leadId },
      });
    }
  } catch (e) { console.error('alertShortlisters failed', e); }
}

// ---- Site visits (wave3, F) ----
// A client visit to a catalogue property or a project: scheduled from the lead
// window, confirmed with the client, then recorded (attended + feedback, or
// no-show). Scheduling moves the lead to 'site_visit_scheduled', completing to
// 'site_visited' — through handleUpdateLead, so stage history is recorded.
const VISIT_CONFIRMATIONS = ['pending', 'confirmed', 'cancelled'];
const VISIT_ATTENDANCE = ['scheduled', 'completed', 'no_show'];
const VISIT_ZONES = ['west_pune', 'east_pune', 'north_pune', 'south_pune'];
const VISIT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];
// Pipeline order a visit may advance a lead along (won / lost are never touched).
const VISIT_STAGE_ORDER = STAGES.filter((s) => !['won', 'lost', 'nurture'].includes(s));
const VISIT_STATUS_SQL = `(CASE WHEN v.confirmation = 'cancelled' THEN 'cancelled' WHEN v.attendance <> 'scheduled' THEN v.attendance ELSE v.confirmation END)`;
const VISIT_DAY_SQL = `date(v.scheduled_at, '+330 minutes')`; // IST calendar day

const visitText = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);

/** WHERE fragment (aliases v, l, eu) for the visits this actor may see, or null = none.
 *  Admins: all · managers: their team's leads or team members' visits · agents: own leads or visits they take. */
function visitScopeClause(actor, binds) {
  if (has(actor, 'lead.read_all')) return '1=1';
  if (has(actor, 'lead.read_team') && actor.team_id) {
    binds.push(actor.team_id);
    return `(l.team_id = ?${binds.length} OR eu.team_id = ?${binds.length})`;
  }
  if (has(actor, 'lead.read_own')) {
    binds.push(actor.id);
    return `(l.assigned_user_id = ?${binds.length} OR v.employee_user_id = ?${binds.length})`;
  }
  return null;
}

/** Visit rows with names. zone / lead_code / property_code come from other
 *  migrations — if a column is missing yet, the query is retried without it. */
async function visitRows(env, where, binds, { order = 'v.scheduled_at ASC', limit = 1000 } = {}) {
  const opt = { zone: true, lead_code: true, property_code: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    const sql = `SELECT v.*, ${VISIT_STATUS_SQL} AS status,
        l.customer_name, l.phone AS lead_phone, l.stage AS lead_stage, l.assigned_user_id AS lead_assigned_user_id,
        ${opt.lead_code ? 'l.lead_code' : 'NULL'} AS lead_code,
        p.name AS property_name, ${opt.property_code ? 'p.property_code' : 'NULL'} AS property_code,
        COALESCE(p.locality, p.location) AS property_area,
        pj.name AS project_name, COALESCE(pj.locality, pj.location) AS project_area,
        ${opt.zone ? 'COALESCE(p.zone, pj.zone)' : 'NULL'} AS zone,
        eu.name AS employee_name, COALESCE(eu.team_id, l.team_id) AS team_id, t.name AS team_name
       FROM site_visits v
       JOIN leads l ON l.id = v.lead_id
       LEFT JOIN properties p ON p.id = v.property_id
       LEFT JOIN projects pj ON pj.id = v.project_id
       LEFT JOIN users eu ON eu.id = v.employee_user_id
       LEFT JOIN teams t ON t.id = COALESCE(eu.team_id, l.team_id)
      ${where} ORDER BY ${order} LIMIT ${limit}`;
    try {
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return (results ?? []).map((r) => ({ ...r, liked: r.liked == null ? null : r.liked === 1, zone: VISIT_ZONES.includes(r.zone) ? r.zone : null }));
    } catch (e) {
      const col = String(e?.message || e).match(/no such column: (?:\w+\.)?(\w+)/)?.[1];
      if (!col || !(col in opt) || !opt[col]) throw e;
      opt[col] = false;
    }
  }
  throw new Error('site visit query failed');
}

/** Move the lead forward to `toStage` (never backwards, never out of won/lost)
 *  and/or set its next follow-up, via the normal lead update so history is kept. */
async function visitUpdateLead(env, lead, actor, toStage, { note = null, followUpAt } = {}) {
  const fromIdx = VISIT_STAGE_ORDER.indexOf(lead.stage);
  const advance = toStage && (lead.stage === 'nurture' || (fromIdx >= 0 && fromIdx < VISIT_STAGE_ORDER.indexOf(toStage)));
  const body = {};
  if (advance) { body.stage = toStage; if (note) body.note = note; }
  if (followUpAt !== undefined) body.next_follow_up_at = followUpAt;
  if (!Object.keys(body).length) return;
  const res = await handleUpdateLead(new Request('https://internal/visit', { method: 'PATCH', body: JSON.stringify(body) }), env, lead.id, actor);
  if (res.ok) return;
  // The visit is already saved — fall back to the bare stage move rather than lose it.
  const stage = body.stage ?? lead.stage;
  const status = stage === 'won' ? 'converted' : stage === 'lost' ? 'dead' : lead.assigned_user_id ? 'in_process' : 'new';
  await env.DB.batch([
    env.DB.prepare('UPDATE leads SET stage=?2, status=?3, next_follow_up_at=?4 WHERE id=?1')
      .bind(lead.id, stage, status, body.next_follow_up_at === undefined ? lead.next_follow_up_at : body.next_follow_up_at),
    ...(advance ? [env.DB.prepare('INSERT INTO lead_stage_history (lead_id,from_stage,to_stage,actor_user_id,note) VALUES (?1,?2,?3,?4,?5)')
      .bind(lead.id, lead.stage, stage, actor.id, note)] : []),
  ]);
}

async function visitTarget(env, body) {
  const propertyId = visitText(body.property_id, 100);
  const projectId = visitText(body.project_id, 100);
  if (!propertyId && !projectId) return { error: 'Choose the property or project the client will visit.' };
  if (propertyId && !(await env.DB.prepare('SELECT 1 FROM properties WHERE id=?1').bind(propertyId).first())) return { error: 'Property not found.' };
  if (projectId && !(await env.DB.prepare('SELECT 1 FROM projects WHERE id=?1').bind(projectId).first())) return { error: 'Project not found.' };
  return { propertyId, projectId };
}

async function visitEmployee(env, userId) {
  if (!userId) return { value: null };
  const u = await env.DB.prepare('SELECT id FROM users WHERE id=?1 AND is_active=1').bind(userId).first();
  return u ? { value: u.id } : { error: 'Choose an active employee to take the client.' };
}

async function handleListLeadVisits(env, id, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canReadLead(actor, lead)) return fail('You do not have permission to view this lead.', 403);
  const visits = await visitRows(env, 'WHERE v.lead_id = ?1', [id], { order: 'v.scheduled_at DESC' });
  // Suggested places to visit: shortlisted options first, then properties discussed.
  const suggestions = [];
  const seen = new Set();
  const add = (rows, why) => {
    for (const r of rows ?? []) {
      const key = (r.property_id || '') + '|' + (r.project_id || '');
      if (!r.name || seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ property_id: r.property_id || null, project_id: r.project_id || null, name: r.name, area: r.area || null, why });
    }
  };
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.property_id, s.project_id, COALESCE(p.name, pj.name) AS name,
              COALESCE(p.locality, p.location, pj.locality, pj.location) AS area
         FROM lead_shortlist s LEFT JOIN properties p ON p.id = s.property_id LEFT JOIN projects pj ON pj.id = s.project_id
        WHERE s.lead_id = ?1 ORDER BY s.shared_at DESC`).bind(id).all();
    add(results, 'shortlisted');
  } catch { /* shortlist table not there yet */ }
  const { results: discussed } = await env.DB.prepare(
    `SELECT p.id AS property_id, NULL AS project_id, p.name, COALESCE(p.locality, p.location) AS area
       FROM lead_discussed_properties d JOIN properties p ON p.id = d.property_id
      WHERE d.lead_id = ?1 ORDER BY d.created_at ASC`).bind(id).all();
  add(discussed, 'discussed');
  return json({ visits, suggestions, can_write: has(actor, 'visit.write') && canUpdateLead(actor, lead) });
}

async function handleCreateVisit(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!has(actor, 'visit.write') || !canUpdateLead(actor, lead)) return fail('You do not have permission to schedule visits for this lead.', 403);
  const target = await visitTarget(env, body);
  if (target.error) return fail(target.error, 422);
  const when = normaliseHuntingFollowUp(body.scheduled_at);
  if (when.error || !when.value) return fail('Pick the date and time of the visit.', 422);
  const employee = await visitEmployee(env, body.employee_user_id === undefined ? (lead.assigned_user_id || actorUserId(actor)) : body.employee_user_id);
  if (employee.error) return fail(employee.error, 422);
  const confirmation = body.confirmation ?? 'pending';
  if (!VISIT_CONFIRMATIONS.includes(confirmation)) return fail('Confirmation must be pending, confirmed or cancelled.', 422);
  const visitId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO site_visits (id, lead_id, property_id, project_id, employee_user_id, scheduled_at, confirmation, created_by_user_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
  ).bind(visitId, id, target.propertyId, target.projectId, employee.value, when.value, confirmation, actorUserId(actor)).run();
  const [visit] = await visitRows(env, 'WHERE v.id = ?1', [visitId]);
  if (confirmation !== 'cancelled') {
    await visitUpdateLead(env, lead, actor, 'site_visit_scheduled', { note: `Site visit booked: ${visit.property_name || visit.project_name || 'site'}` });
  }
  if (employee.value && employee.value !== actor.id) {
    await raiseAlert(env, {
      importance: 'normal', to: { userIds: [employee.value] }, title: 'Site visit booked for you',
      body: `${lead.customer_name || 'A client'} — ${visit.property_name || visit.project_name || 'site'}`, link: { kind: 'lead', id },
    });
  }
  return json({ visit }, 201);
}

async function handleUpdateVisit(request, env, visitId, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const visit = await env.DB.prepare('SELECT * FROM site_visits WHERE id=?1').bind(visitId).first();
  if (!visit) return fail('Visit not found.', 404);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(visit.lead_id).first();
  if (!lead) return fail('Lead not found.', 404);
  // The lead's owners, or the employee taking the client, may update a visit.
  if (!has(actor, 'visit.write') || !(canUpdateLead(actor, lead) || (visit.employee_user_id && visit.employee_user_id === actor.id))) {
    return fail('You do not have permission to update this visit.', 403);
  }
  const next = { ...visit };
  if (body.property_id !== undefined || body.project_id !== undefined) {
    const target = await visitTarget(env, { property_id: body.property_id ?? null, project_id: body.project_id ?? null });
    if (target.error) return fail(target.error, 422);
    next.property_id = target.propertyId; next.project_id = target.projectId;
  }
  if (body.scheduled_at !== undefined) {
    const when = normaliseHuntingFollowUp(body.scheduled_at);
    if (when.error || !when.value) return fail('Pick the date and time of the visit.', 422);
    next.scheduled_at = when.value;
  }
  if (body.employee_user_id !== undefined) {
    const employee = await visitEmployee(env, body.employee_user_id);
    if (employee.error) return fail(employee.error, 422);
    next.employee_user_id = employee.value;
  }
  if (body.confirmation !== undefined) {
    if (!VISIT_CONFIRMATIONS.includes(body.confirmation)) return fail('Confirmation must be pending, confirmed or cancelled.', 422);
    next.confirmation = body.confirmation;
  }
  if (body.attendance !== undefined) {
    if (!VISIT_ATTENDANCE.includes(body.attendance)) return fail('Attendance must be scheduled, completed or no_show.', 422);
    next.attendance = body.attendance;
  }
  if (body.liked !== undefined) {
    if (body.liked !== null && typeof body.liked !== 'boolean') return fail('liked must be true, false or null.', 422);
    next.liked = body.liked === null ? null : body.liked ? 1 : 0;
  }
  for (const key of ['feedback', 'objections', 'next_step']) if (body[key] !== undefined) next[key] = visitText(body[key]);
  if (body.next_step_at !== undefined) {
    const at = normaliseHuntingFollowUp(body.next_step_at);
    if (at.error) return fail('Next step date must be a date and time.', 422);
    next.next_step_at = at.value;
  }
  if (next.attendance === 'completed') {
    if (next.liked == null) return fail('Add the client\'s feedback (liked it or not) before marking the visit done.', 422);
    if (!next.next_step) return fail('Add the next step before marking the visit done.', 422);
    if (next.confirmation === 'cancelled') next.confirmation = 'confirmed'; // they came after all
  }
  await env.DB.prepare(
    `UPDATE site_visits SET property_id=?2, project_id=?3, employee_user_id=?4, scheduled_at=?5, confirmation=?6, attendance=?7,
            liked=?8, feedback=?9, objections=?10, next_step=?11, next_step_at=?12, updated_at=datetime('now') WHERE id=?1`
  ).bind(visitId, next.property_id, next.project_id, next.employee_user_id, next.scheduled_at, next.confirmation, next.attendance,
    next.liked, next.feedback, next.objections, next.next_step, next.next_step_at).run();
  const [row] = await visitRows(env, 'WHERE v.id = ?1', [visitId]);
  const completedNow = next.attendance === 'completed' && visit.attendance !== 'completed';
  const followUpChanged = next.next_step_at && next.next_step_at !== visit.next_step_at;
  if (completedNow || followUpChanged) {
    const place = row.property_name || row.project_name || 'site';
    await visitUpdateLead(env, lead, actor, completedNow ? 'site_visited' : null, {
      note: completedNow ? `Visited ${place}${next.liked === 1 ? ' — liked it' : next.liked === 0 ? ' — did not like it' : ''}. Next: ${next.next_step}` : null,
      followUpAt: followUpChanged ? next.next_step_at : undefined,
    });
  }
  return json({ visit: row });
}

/** Calendar / list: ?from=&to= (IST days), employee, team, status, lead, converted. */
async function handleListVisits(request, env, actor) {
  const url = new URL(request.url);
  const range = analyticsRange(url);
  if (range.error) return range.error;
  const binds = [];
  const scope = visitScopeClause(actor, binds);
  if (scope == null) return fail('You do not have permission to view visits.', 403);
  const filters = [scope];
  if (range.from) { binds.push(range.from); filters.push(`${VISIT_DAY_SQL} >= ?${binds.length}`); }
  if (range.to) { binds.push(range.to); filters.push(`${VISIT_DAY_SQL} <= ?${binds.length}`); }
  const employee = url.searchParams.get('employee');
  if (employee) { binds.push(employee); filters.push(`v.employee_user_id = ?${binds.length}`); }
  const team = url.searchParams.get('team');
  if (team) { binds.push(team); filters.push(`COALESCE(eu.team_id, l.team_id) = ?${binds.length}`); }
  const status = url.searchParams.get('status');
  if (status) {
    if (!VISIT_STATUSES.includes(status)) return fail(`status must be one of: ${VISIT_STATUSES.join(', ')}.`, 422);
    binds.push(status); filters.push(`${VISIT_STATUS_SQL} = ?${binds.length}`);
  }
  const leadId = url.searchParams.get('lead');
  if (leadId) { binds.push(leadId); filters.push(`v.lead_id = ?${binds.length}`); }
  const converted = analyticsConverted(url);
  if (converted.sql) filters.push(converted.sql);
  const visits = await visitRows(env, `WHERE ${filters.join(' AND ')}`, binds, { limit: 2000 });
  return json({ range, visits });
}

/** Performance card: completed visits per team × zone, with per-employee rows. */
async function handleVisitAnalytics(request, env, actor) {
  const url = new URL(request.url);
  const range = analyticsRange(url);
  if (range.error) return range.error;
  const binds = [];
  const scope = visitScopeClause(actor, binds);
  if (scope == null) return fail('You do not have permission to view analytics.', 403);
  const filters = [scope, `v.confirmation <> 'cancelled'`, `v.attendance <> 'scheduled'`];
  if (range.from) { binds.push(range.from); filters.push(`${VISIT_DAY_SQL} >= ?${binds.length}`); }
  if (range.to) { binds.push(range.to); filters.push(`${VISIT_DAY_SQL} <= ?${binds.length}`); }
  const converted = analyticsConverted(url);
  if (converted.sql) filters.push(converted.sql);
  const rows = await visitRows(env, `WHERE ${filters.join(' AND ')}`, binds, { limit: 20000 });
  const zones = [...VISIT_ZONES, 'unset'];
  const blank = () => Object.fromEntries(zones.map((z) => [z, 0]));
  const teams = new Map();
  for (const r of rows) {
    const teamKey = r.team_id || '';
    if (!teams.has(teamKey)) teams.set(teamKey, { team_id: r.team_id || null, team_name: r.team_name || 'No team', completed: 0, no_show: 0, by_zone: blank(), employees: new Map() });
    const t = teams.get(teamKey);
    const empKey = r.employee_user_id || '';
    if (!t.employees.has(empKey)) t.employees.set(empKey, { user_id: r.employee_user_id || null, name: r.employee_name || 'Not assigned', completed: 0, no_show: 0, by_zone: blank() });
    const e = t.employees.get(empKey);
    if (r.attendance === 'no_show') { t.no_show++; e.no_show++; continue; }
    const z = r.zone || 'unset';
    t.completed++; e.completed++; t.by_zone[z]++; e.by_zone[z]++;
  }
  const out = [...teams.values()].map((t) => ({ ...t, employees: [...t.employees.values()].sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.completed - a.completed || a.team_name.localeCompare(b.team_name));
  return json({ range, converted: converted.value, zones, teams: out, total_completed: out.reduce((n, t) => n + t.completed, 0), total_no_show: out.reduce((n, t) => n + t.no_show, 0) });
}
// ---- end Site visits (wave3, F) ----

/** Pending recommendations that the signed-in manager is allowed to decide. */
async function handleListAssignmentApprovals(env, actor) {
  if (!has(actor, 'lead.assign_direct')) return fail('Only managers and administrators can review automatic assignments.', 403);

  let scopeSql = '';
  const params = [];
  if (!has(actor, 'lead.read_all')) {
    if (!has(actor, 'lead.read_team') || !actor.team_id) return fail('You do not have permission to review automatic assignments.', 403);
    scopeSql = 'AND a.recommended_team_id = ?1';
    params.push(actor.team_id);
  }

  const { results } = await env.DB.prepare(
    `SELECT a.*, l.customer_name, l.phone, l.email, l.project_name, l.property_type, l.location,
            l.budget_min, l.budget_max, l.priority, l.source, l.research_level, l.created_at AS lead_created_at,
            u.name AS recommended_user_name, t.name AS recommended_team_name,
            (SELECT COUNT(*) FROM leads open_leads
              WHERE open_leads.assigned_user_id = a.recommended_user_id
                AND open_leads.status IN (${OPEN_STATUSES.map(status => `'${status}'`).join(',')})) AS recommended_open_leads
       FROM assignment_approvals a
       JOIN leads l ON l.id = a.lead_id
       JOIN users u ON u.id = a.recommended_user_id
       JOIN teams t ON t.id = a.recommended_team_id
      WHERE a.status = 'pending' ${scopeSql}
      ORDER BY a.created_at ASC`
  ).bind(...params).all();
  return json({ approvals: results ?? [] });
}

/** Confirm the system's recommended agent, or replace them with another active
 * agent in the routed team. This is deliberately separate from reassignment:
 * no owner is written until a manager makes this decision. */
async function handleDecideAssignmentApproval(request, env, approvalId, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);

  const approval = await env.DB.prepare('SELECT * FROM assignment_approvals WHERE id = ?1').bind(approvalId).first();
  if (!approval) return fail('Automatic-assignment request not found.', 404);
  if (approval.status !== 'pending') return fail('This automatic-assignment request has already been decided.', 409);
  if (!canReviewAutoAssignment(actor, approval)) return fail('You can approve automatic assignments only for your own team.', 403);

  const toUserId = typeof body.to_user_id === 'string' && body.to_user_id.trim()
    ? body.to_user_id.trim()
    : approval.recommended_user_id;
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(toUserId).first();
  if (!target?.is_active) return fail('Choose an active person to receive this lead.', 422);
  // A reviewing manager (specifically — not admin/super_admin) can take the
  // lead themselves. canReviewAutoAssignment already confirmed they are
  // allowed to review this team's approvals, so no further role/team check is
  // needed for that one case. Anyone else offered still has to be an active
  // agent on the routed team, same as before.
  const isSelf = target.id === actor.id && TEAM_HEAD_ROLES.includes(actor.role);
  if (!isSelf && !isAgentRole(target.role)) return fail('Choose an active agent to receive this lead.', 422);
  if (!isSelf && target.team_id !== approval.recommended_team_id) return fail('Choose an agent from the routed team.', 422);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(approval.lead_id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (lead.assigned_user_id) return fail('This lead has already been assigned.', 409);
  // An unranked lead cannot be given an owner: the reviewer must rank its
  // market research level as part of this decision. A ranked lead may still
  // send a (valid) level to correct it.
  const researchLevel = body.research_level ?? null;
  if (researchLevel !== null && !RESEARCH_LEVELS.includes(researchLevel)) return fail(RESEARCH_LEVEL_MESSAGE, 422);
  if (!lead.research_level && !researchLevel) return fail(`Rank this lead before assigning it. ${RESEARCH_LEVEL_MESSAGE}`, 422);

  const decision = target.id === approval.recommended_user_id ? 'approved' : 'changed';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
  const reviewerId = actor.id === 'super-admin' ? null : actor.id;
  const applied = await env.DB.prepare(
    `UPDATE assignment_approvals
        SET status = ?2, reviewer_user_id = ?3, final_user_id = ?4,
            note = ?5, reviewed_at = datetime('now')
      WHERE id = ?1 AND status = 'pending'`
  ).bind(approvalId, decision, reviewerId, target.id, note).run();
  if (!applied.meta.changes) return fail('This automatic-assignment request has already been decided.', 409);

  await env.DB.batch([
    env.DB.prepare(`UPDATE leads
                      SET assigned_user_id = ?2, team_id = ?3,
                          status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END,
                          research_level = COALESCE(?4, research_level)
                    WHERE id = ?1 AND assigned_user_id IS NULL`)
      .bind(lead.id, target.id, target.team_id, researchLevel),
    env.DB.prepare(
      `INSERT INTO assignment_history
         (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, actor_user_id, note)
       VALUES (?1,NULL,?2,?3,?3,?4,?5,?6)`
    ).bind(lead.id, target.id, target.team_id, decision === 'approved' ? 'auto:manager_approved' : 'auto:manager_changed', actor.id, note),
  ]);

  return handleGetLead(env, lead.id, actor);
}

/** Manual reassignment and team transfer. Both are the same operation. */
async function handleAssignLead(request, env, id, actor) {
  if (!has(actor, 'lead.assign_direct')) return fail('Only managers and administrators can reassign directly.', 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return fail('Body must be valid JSON.', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('JSON object required.', 400);
  const toUserId = body.to_user_id ?? null;
  const toTeamId = body.to_team_id ?? null;
  if (!toUserId && !toTeamId) return fail('Provide to_user_id and/or to_team_id.', 400);

  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?1`).bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to reassign this lead.', 403);
  // Giving an unranked lead an owner requires ranking it in the same request.
  // A team-only move (no owner) is not gated.
  const researchLevel = body.research_level ?? null;
  if (researchLevel !== null && !RESEARCH_LEVELS.includes(researchLevel)) return fail(RESEARCH_LEVEL_MESSAGE, 422);
  if (toUserId && !lead.research_level && !researchLevel) return fail(`Rank this lead before assigning it. ${RESEARCH_LEVEL_MESSAGE}`, 422);

  let targetUser = null;
  if (toUserId) {
    targetUser = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(toUserId).first();
    if (!targetUser) return fail(`User '${toUserId}' not found.`, 422);
    if (!targetUser.is_active) return fail(`User '${toUserId}' is inactive.`, 422);
  }

  // Transferring to a user without naming a team moves the lead to that user's
  // team, otherwise the lead's team and its owner silently disagree.
  const finalTeamId = toTeamId ?? targetUser?.team_id ?? lead.team_id;
  // Team leaders reassign only inside their own team (0060).
  if (actor.role === 'team_leader' && finalTeamId !== actor.team_id) return fail('Team leaders can pass a lead only to someone in their own team.', 403);

  if (finalTeamId && !await env.DB.prepare('SELECT id FROM teams WHERE id = ?1').bind(finalTeamId).first()) return fail('Team not found.', 422);
  if (targetUser && targetUser.team_id !== finalTeamId) return fail('User must belong to the selected team.', 422);

  const reviewerId = actor.id === 'super-admin' ? null : actor.id;
  await env.DB.batch([
    // A manager may manually take over a pending recommendation from the lead
    // detail view. Close that request first so it can never later overwrite
    // this deliberate assignment.
    env.DB.prepare(
      `UPDATE assignment_approvals
          SET status = 'cancelled', reviewer_user_id = ?2, final_user_id = ?3,
              note = COALESCE(?4, note), reviewed_at = datetime('now')
        WHERE lead_id = ?1 AND status = 'pending'`
    ).bind(id, reviewerId, toUserId, body.note ?? null),
    env.DB.prepare(
      `INSERT INTO assignment_history
         (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, actor_user_id, note)
       SELECT id, assigned_user_id, ?2, team_id, ?3,
              CASE WHEN team_id IS NOT ?3 THEN 'transfer:direct' ELSE 'manual' END, ?4, ?5
         FROM leads WHERE id = ?1`
    ).bind(id, toUserId, finalTeamId, actor.id, body.note ?? null),
    env.DB.prepare(
      `UPDATE leads
          SET assigned_user_id = ?2,
              team_id = ?3,
              status = CASE WHEN ?2 IS NOT NULL AND status = 'new' THEN 'assigned' ELSE status END,
              research_level = COALESCE(?4, research_level)
        WHERE id = ?1`
    ).bind(id, toUserId, finalTeamId, researchLevel),
  ]);

  return handleGetLead(env, id, actor);
}

/** POST /api/leads/:id/archive { archived: true|false } - hide a lead from the lists (or bring it back). Nothing is lost. */
async function handleArchiveLead(request, env, id, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to archive this lead.', 403);
  const body = await bodyJson(request);
  const archived = body?.archived !== false;
  await env.DB.batch([
    env.DB.prepare(archived ? "UPDATE leads SET archived_at = datetime('now') WHERE id = ?1" : 'UPDATE leads SET archived_at = NULL WHERE id = ?1').bind(id),
    env.DB.prepare("INSERT INTO lead_activities (id,lead_id,actor_user_id,type,subject) VALUES (?1,?2,?3,'note',?4)")
      .bind(crypto.randomUUID(), id, actorUserId(actor), archived ? 'Lead archived' : 'Lead restored from the archive'),
  ]);
  return json({ ok: true, archived });
}

/** DELETE /api/leads/:id - permanently removes a lead and its history. Administrators only; refused when a token or deal exists. */
async function handleDeleteLead(env, id, actor) {
  if (!has(actor, 'lead.delete')) return fail('Only administrators can delete a lead. You can archive it instead.', 403);
  const lead = await env.DB.prepare('SELECT id FROM leads WHERE id = ?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  const deals = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM bookings WHERE lead_id = ?1) + (SELECT COUNT(*) FROM transactions WHERE lead_id = ?1) AS n').bind(id).first('n');
  if (deals > 0) return fail('This lead has a token or a deal recorded, so it cannot be deleted. Archive it instead.', 409);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM intake_receipts WHERE lead_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM leads WHERE id = ?1').bind(id), // history, visits, handovers, shortlist... go with it (ON DELETE CASCADE)
  ]);
  return json({ ok: true });
}

async function handleListUsers(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view employees.', 403);
  const placeholders = OPEN_STATUSES.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT u.*, t.name AS team_name,
            (SELECT COUNT(*) FROM leads l
              WHERE l.assigned_user_id = u.id AND l.status IN (${placeholders})) AS open_leads
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
      ${has(actor, 'lead.read_all') ? '' : 'WHERE u.team_id = ?' + (OPEN_STATUSES.length + 1)}
      ORDER BY t.name, u.name`
  )
    .bind(...OPEN_STATUSES, ...(has(actor, 'lead.read_all') ? [] : [actor.team_id || '__none__']))
    .all();

  return json({ users: results ?? [] });
}

async function handleCreateTeam(request, env, actor) {
  if (!has(actor, 'user.manage')) return fail('Only a super administrator can create teams.', 403);
  const body = await bodyJson(request);
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return fail('Team name is required.', 422);
  if (name.length > 80) return fail('Team name must be 80 characters or fewer.', 422);

  const existing = await env.DB.prepare('SELECT id, name FROM teams WHERE lower(name) = lower(?1)').bind(name).first();
  if (existing) return json({ ok: true, created: false, team: existing });

  // Which side of the business the team works on (0060); defaults to client.
  if (body.vertical != null && !TEAM_VERTICALS.includes(body.vertical)) return fail('Choose Pre-Sales, Client team, Property hunting or Post-Sales.', 422);
  const team = { id: `team_${crypto.randomUUID()}`, name, vertical: body.vertical || 'client' };
  try {
    await env.DB.prepare('INSERT INTO teams (id, name, vertical) VALUES (?1, ?2, ?3)').bind(team.id, team.name, team.vertical).run();
  } catch (e) {
    // Preserve a clean response if two administrators create the same name at once.
    const duplicate = await env.DB.prepare('SELECT id, name FROM teams WHERE lower(name) = lower(?1)').bind(name).first();
    if (duplicate) return json({ ok: true, created: false, team: duplicate });
    return fail('Could not create team.', 422);
  }
  return json({ ok: true, created: true, team }, 201);
}

/** Rename a team, set its tagline, or set its manager. The super admin can
 * change everything; a team's own manager can rename it and set the tagline. */
async function handleUpdateTeam(request, env, id, actor) {
  const team = await env.DB.prepare('SELECT id, manager_user_id FROM teams WHERE id=?1').bind(id).first();
  if (!team) return fail('Team not found.', 404);
  const isSuper = has(actor, 'user.manage');
  if (!isSuper && team.manager_user_id !== actor.id) return fail('Only the super administrator or this team\'s manager can edit it.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const sets = [];
  const binds = [id];
  const set = (col, value) => { binds.push(value); sets.push(`${col}=?${binds.length}`); };

  if ('name' in body) {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return fail('Team name is required.', 422);
    if (name.length > 80) return fail('Team name must be 80 characters or fewer.', 422);
    const clash = await env.DB.prepare('SELECT id FROM teams WHERE lower(name) = lower(?1) AND id != ?2').bind(name, id).first();
    if (clash) return fail('Another team already has that name.', 409);
    set('name', name);
  }
  if ('tagline' in body) {
    const tagline = typeof body.tagline === 'string' ? body.tagline.trim().replace(/\s+/g, ' ') : '';
    if (tagline.length > 140) return fail('Tagline must be 140 characters or fewer.', 422);
    set('tagline', tagline || null);
  }
  if ('vertical' in body) { // 0060
    if (!isSuper) return fail('Only a super administrator can change what a team works on.', 403);
    if (!TEAM_VERTICALS.includes(body.vertical)) return fail('Choose Pre-Sales, Client team, Property hunting or Post-Sales.', 422);
    set('vertical', body.vertical);
  }
  if ('manager_user_id' in body) {
    if (!isSuper) return fail('Only a super administrator can set a team manager.', 403);
    const managerId = body.manager_user_id || null;
    if (managerId) {
      const manager = await env.DB.prepare('SELECT id, role, team_id, is_active FROM users WHERE id=?1').bind(managerId).first();
      if (!manager || !manager.is_active) return fail('Choose an active employee to manage this team.', 422);
      if (!['manager', 'admin', 'sales_head', 'team_leader'].includes(manager.role)) return fail('Only a manager, team leader, sales head or administrator can look after a team.', 422);
      if (manager.team_id !== id) return fail('Choose someone who is on this team.', 422);
    }
    set('manager_user_id', managerId);
  }
  if (!sets.length) return fail('Nothing to change.', 422);
  await env.DB.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id=?1`).bind(...binds).run();
  return json({ ok: true });
}


async function bodyJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

async function handleCreateUser(request, env, actor) {
  if (!has(actor, 'user.manage')) return fail('Only a super administrator can create employees.', 403);
  const body = await bodyJson(request);
  if (!body?.name?.trim() || !body?.email?.trim()) return fail('Employee name and email are required.', 422);
  const role = body.role || 'agent';
  if (!Object.hasOwn(ROLE_PERMISSIONS, role) || role === 'super_admin') return fail('Choose a valid employee role.', 422);
  if (body.team_id && !await env.DB.prepare('SELECT id FROM teams WHERE id=?1').bind(body.team_id).first()) return fail('Team not found.', 422);
  const pwProblem = passwordProblem(body.password);
  if (pwProblem) return fail(pwProblem, 422);
  const email = body.email.trim().toLowerCase();
  if (await env.DB.prepare('SELECT 1 FROM app_admin WHERE email = ?1').bind(email).first()) return fail('That email is already in use.', 422);
  const id = `u_${crypto.randomUUID()}`;
  const availability = body.availability || 'available';
  try {
    await env.DB.prepare(`INSERT INTO users (id,name,email,phone,role,team_id,is_active,accepts_leads,availability,permission_overrides,password_hash)
      VALUES (?1,?2,?3,?4,?5,?6,1,?7,?8,?9,?10)`)
      .bind(id, body.name.trim(), email, body.phone || null, role, body.team_id || null,
        isAgentRole(role) && availability === 'available' ? (body.accepts_leads === false ? 0 : 1) : 0,
        availability, JSON.stringify(body.permission_overrides || {}), await hashPassword(body.password)).run();
  } catch (e) { return fail(String(e).includes('UNIQUE') ? 'An employee already uses that email.' : 'Could not create employee.', 422); }
  return json({ ok: true, user_id: id, message: 'Account created. Tell them their email and password privately.' }, 201);
}

async function handleUpdateUser(request, env, id, actor) {
  if (!has(actor, 'user.manage')) return fail('Only a super administrator can change employee status or permissions.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(id).first();
  if (!user) return fail('Employee not found.', 404);
  const role = body.role ?? user.role;
  if (!Object.hasOwn(ROLE_PERMISSIONS, role) || role === 'super_admin') return fail('Choose a valid employee role.', 422);
  const teamId = body.team_id === undefined ? user.team_id : body.team_id;
  if (teamId && !await env.DB.prepare('SELECT id FROM teams WHERE id=?1').bind(teamId).first()) return fail('Team not found.', 422);
  const availability = body.availability ?? user.availability;
  if (!['available', 'away', 'busy', 'offline'].includes(availability)) return fail('Invalid availability.', 422);
  // Only agents are ever eligible for auto-assignment, full stop — this is not
  // a preference to toggle, it's what keeps managers/admins/viewers out of the
  // round-robin pool. Mirrors the same gate in handleCreateUser, and the
  // assign_new_lead trigger enforces it a second time at the SQL layer.
  const acceptsLeads = !isAgentRole(role) || availability !== 'available'
    ? 0
    : (body.accepts_leads === undefined ? user.accepts_leads : (body.accepts_leads ? 1 : 0));
  await env.DB.prepare(`UPDATE users SET name=?2, email=?3, phone=?4, role=?5, team_id=?6,
    is_active=?7, accepts_leads=?8, availability=?9, permission_overrides=?10 WHERE id=?1`).bind(
      id, body.name?.trim() || user.name, body.email?.trim().toLowerCase() || user.email, body.phone ?? user.phone,
      role, teamId, body.is_active === undefined ? user.is_active : (body.is_active ? 1 : 0),
      acceptsLeads, availability,
      JSON.stringify(body.permission_overrides ?? parseOverrides(user.permission_overrides))).run();
  // A team's manager_user_id is a separate pointer from the person's own
  // team_id — if they just left the team, were deactivated, or lost the role
  // that lets them manage a team, any team still pointing at them as manager
  // would otherwise go stale ("Looked after by" someone no longer there).
  const activeNow = body.is_active === undefined ? user.is_active : (body.is_active ? 1 : 0);
  const stillEligibleManager = ['manager', 'admin', 'sales_head', 'team_leader'].includes(role);
  await env.DB.prepare(
    `UPDATE teams SET manager_user_id = NULL WHERE manager_user_id = ?1 AND (id != ?2 OR ?3 = 0 OR ?4 = 0)`
  ).bind(id, teamId || '', activeNow, stillEligibleManager ? 1 : 0).run();
  // Deactivating someone signs them out everywhere straight away.
  if (body.is_active === false || body.is_active === 0) await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(id).run();
  return json({ ok: true, message: 'Employee updated.' });
}

// ---- employee leaves / offboarding (wave3 A, 0060) ----
// "Mark as left": open work moves to one person, the leaver is deactivated,
// their sign-in code stops working and they leave the auto-assign pool.
// History (stage history, activities, created_by, closed leads) is kept.
async function offboardTables(env) {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('site_visits', 'transactions', 'transaction_nocs', 'transaction_tasks')`
  ).all();
  return new Set((results || []).map((r) => r.name));
}

/** Open work owned by `userId`: [{ key, label, count, sql, where }]. */
async function offboardWork(env, userId) {
  const tables = await offboardTables(env);
  const openLeads = OPEN_STATUSES.map((s) => `'${s}'`).join(',');
  const closedHunting = HUNTING_CLOSED_STAGES.map((s) => `'${s}'`).join(',');
  const parts = [
    { key: 'leads', label: 'Open leads', table: 'leads', col: 'assigned_user_id', where: `status IN (${openLeads})` },
    { key: 'tasks', label: 'Open To Do tasks', table: 'tasks', col: 'assigned_to_user_id', where: 'completed_at IS NULL' },
    { key: 'hunting', label: 'Hunting properties', table: 'hunting_targets', col: 'assigned_user_id', where: `stage NOT IN (${closedHunting})` },
  ];
  if (tables.has('site_visits')) parts.push({ key: 'visits', label: 'Upcoming site visits', table: 'site_visits', col: 'employee_user_id', where: `attendance = 'scheduled' AND confirmation <> 'cancelled'` });
  if (tables.has('transactions')) {
    parts.push({ key: 'transactions', label: 'Deals they coordinate', table: 'transactions', col: 'coordinator_user_id', where: `status = 'open'` });
    parts.push({ key: 'transactions_rm', label: 'Deals they manage for the client', table: 'transactions', col: 'relationship_manager_user_id', where: `status = 'open'` });
  }
  if (tables.has('transaction_nocs')) parts.push({ key: 'nocs', label: 'NOCs they follow up', table: 'transaction_nocs', col: 'coordinator_user_id', where: `status NOT IN ('approved', 'not_applicable')` });
  if (tables.has('transaction_tasks')) parts.push({ key: 'deal_tasks', label: 'Deal tasks', table: 'transaction_tasks', col: 'owner_user_id', where: `status IN ('pending', 'in_progress', 'blocked')` });
  const counts = await env.DB.batch(parts.map((p) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${p.table} WHERE ${p.col} = ?1 AND ${p.where}`).bind(userId)));
  parts.forEach((p, i) => { p.count = counts[i].results?.[0]?.n || 0; });
  return parts;
}

async function handleOffboardPreview(env, id, actor) {
  if (!has(actor, 'user.offboard')) return fail('Only administrators can mark an employee as left.', 403);
  const user = await env.DB.prepare('SELECT id, name, role, team_id, is_active, left_at FROM users WHERE id = ?1').bind(id).first();
  if (!user) return fail('Employee not found.', 404);
  const work = await offboardWork(env, id);
  // Suggest the person who looks after their team (or any manager on it).
  const suggested = await env.DB.prepare(
    `SELECT u.id FROM users u
      WHERE u.is_active = 1 AND u.id <> ?1 AND u.team_id IS ?2 AND u.role IN ('manager', 'team_leader', 'sales_head', 'admin')
      ORDER BY CASE WHEN u.id = (SELECT manager_user_id FROM teams WHERE id = ?2) THEN 0 ELSE 1 END, u.name LIMIT 1`
  ).bind(id, user.team_id).first();
  return json({
    user,
    items: work.map(({ key, label, count }) => ({ key, label, count })),
    total: work.reduce((n, p) => n + p.count, 0),
    suggested_user_id: suggested?.id || null,
  });
}

async function handleOffboardUser(request, env, id, actor) {
  if (!has(actor, 'user.offboard')) return fail('Only administrators can mark an employee as left.', 403);
  if (id === actor.id) return fail('You cannot mark yourself as left.', 422);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!user) return fail('Employee not found.', 404);
  if (!user.is_active || user.left_at) return fail('This employee is already marked as left.', 409);
  if (user.role === 'admin' && actor.role !== 'super_admin') return fail('Only the super administrator can mark an administrator as left.', 403);
  const body = await bodyJson(request) || {};
  const work = await offboardWork(env, id);
  const total = work.reduce((n, p) => n + p.count, 0);
  const toId = typeof body.reassign_to_user_id === 'string' && body.reassign_to_user_id.trim() ? body.reassign_to_user_id.trim() : null;
  let target = null;
  if (toId) {
    target = await env.DB.prepare('SELECT id, name, role, team_id, is_active FROM users WHERE id = ?1').bind(toId).first();
    if (!target?.is_active || target.id === id || target.role === 'viewer') return fail('Choose an active employee to take over their work.', 422);
  } else if (total > 0) {
    return fail('Choose who takes over their open work first.', 422);
  }

  const actorId = actorUserId(actor);
  const note = `Handed over from ${user.name} (left the company)`;
  const stmts = [];
  const leads = work.find((p) => p.key === 'leads');
  if (target && leads.count) {
    const openLeads = OPEN_STATUSES.map((s) => `'${s}'`).join(',');
    const scope = `assigned_user_id = ?1 AND status IN (${openLeads})`;
    stmts.push(
      // Pending "who should get this lead" suggestions and transfer offers
      // involving the leaver are closed; the lead now has a real owner.
      env.DB.prepare(`UPDATE assignment_approvals SET status = 'cancelled', final_user_id = ?2, note = ?3, reviewed_at = datetime('now')
                       WHERE status = 'pending' AND lead_id IN (SELECT id FROM leads WHERE ${scope})`).bind(id, toId, note),
      env.DB.prepare(`INSERT INTO assignment_history (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, actor_user_id, note)
                      SELECT id, assigned_user_id, ?2, team_id, COALESCE(?3, team_id), 'offboard', ?4, ?5 FROM leads WHERE ${scope}`)
        .bind(id, toId, target.team_id, actor.id, note),
      env.DB.prepare(`INSERT INTO lead_activities (id, lead_id, actor_user_id, type, subject, body)
                      SELECT lower(hex(randomblob(16))), id, ?2, 'note', ?3, ?4 FROM leads WHERE ${scope}`)
        .bind(id, actorId, note, `Now with ${target.name}.`),
      env.DB.prepare(`UPDATE leads SET assigned_user_id = ?2, team_id = COALESCE(?3, team_id) WHERE ${scope}`).bind(id, toId, target.team_id),
    );
  }
  if (target) {
    for (const p of work) {
      if (p.key === 'leads' || !p.count) continue;
      const extra = p.table === 'tasks' ? `, updated_at = datetime('now')` : '';
      stmts.push(env.DB.prepare(`UPDATE ${p.table} SET ${p.col} = ?2${extra} WHERE ${p.col} = ?1 AND ${p.where}`).bind(id, toId));
    }
  }
  stmts.push(
    env.DB.prepare(`UPDATE lead_transfer_requests SET status = 'cancelled', responded_at = datetime('now')
                     WHERE status = 'pending' AND (from_user_id = ?1 OR to_user_id = ?1)`).bind(id),
    env.DB.prepare('UPDATE teams SET manager_user_id = NULL WHERE manager_user_id = ?1').bind(id),
    env.DB.prepare(`UPDATE users SET is_active = 0, accepts_leads = 0, access_token_hash = NULL, availability = 'offline',
                           left_at = datetime('now') WHERE id = ?1`).bind(id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(id),
  );
  const counts = Object.fromEntries(work.map((p) => [p.key, target ? p.count : 0]));
  stmts.push(env.DB.prepare(`INSERT INTO user_offboarding (id, user_id, user_name, reassigned_to_user_id, reassigned_to_name, counts, actor_user_id)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(crypto.randomUUID(), id, user.name, toId, target?.name || null, JSON.stringify(counts), actor.id));
  await env.DB.batch(stmts);
  if (target && total) {
    await raiseAlert(env, { importance: 'medium', to: { userIds: [toId] }, title: `You now look after ${user.name}'s work`,
      body: `${user.name} has left. ${work.filter((p) => p.count).map((p) => `${p.count} ${p.label.toLowerCase()}`).join(', ')} moved to you.` });
  }
  return json({ ok: true, moved: counts, message: `${user.name} is marked as left.` });
}

async function handleRestoreUser(env, id, actor) {
  if (!has(actor, 'user.offboard')) return fail('Only administrators can restore an employee.', 403);
  const user = await env.DB.prepare('SELECT id, name, left_at FROM users WHERE id = ?1').bind(id).first();
  if (!user) return fail('Employee not found.', 404);
  if (!user.left_at) return fail('This employee is not marked as left.', 409);
  // Access comes back without a sign-in code: the super administrator issues a
  // fresh one (Sign-in codes). Auto-assign stays off until someone turns it on.
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET is_active = 1, left_at = NULL, availability = 'available' WHERE id = ?1`).bind(id),
    env.DB.prepare(`UPDATE user_offboarding SET restored_at = datetime('now')
                     WHERE id = (SELECT id FROM user_offboarding WHERE user_id = ?1 AND restored_at IS NULL ORDER BY created_at DESC LIMIT 1)`).bind(id),
  ]);
  return json({ ok: true, message: `${user.name} can work again. Give them a new sign-in code.` });
}

/** People marked as left, newest first, with who took over. */
async function handleFormerUsers(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view employees.', 403);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.team_id, u.left_at, t.name AS team_name,
            o.reassigned_to_name, o.counts
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN user_offboarding o ON o.id = (SELECT id FROM user_offboarding WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1)
      WHERE u.left_at IS NOT NULL
      ORDER BY u.left_at DESC`
  ).all();
  return json({ users: (results || []).map((r) => ({ ...r, counts: (() => { try { return JSON.parse(r.counts || '{}'); } catch { return {}; } })() })) });
}
// ---- end employee leaves ----

// ---- lead sub-status + lost reason (wave3 C) ----
const LEAD_DETAIL_LABELS = {
  unassigned: 'Not given to anyone yet', assigned: 'Given to an agent', first_call_pending: 'First call pending',
  no_answer: 'No answer', busy: 'Busy', switched_off: 'Switched off', call_back_later: 'Call back later',
  connected: 'Connected', callback_requested: 'Asked to call back', qualification_pending: 'Need to ask more',
  qualified: 'Requirement clear', handover_requested: 'Handover requested',
  visit_pending_confirmation: 'Waiting to confirm', visit_confirmed: 'Visit confirmed', visit_rescheduled: 'Rescheduled',
  visit_done: 'Visit done', revisit_planned: 'Second visit planned', feedback_pending: 'Waiting for feedback',
  offer_shared: 'Offer shared', awaiting_reply: 'Waiting for reply',
  price_discussion: 'Discussing price', token_pending: 'Token pending', final_approval: 'Final approval pending',
  booked: 'Booked', won: 'Deal closed', invalid: 'Invalid', dropped: 'Dropped',
  buying_later: 'Buying later', arranging_funds: 'Arranging money', just_browsing: 'Just looking',
};
const LOST_REASON_LABELS = {
  invalid_number: 'Invalid number', duplicate: 'Duplicate', junk: 'Fake / test enquiry',
  not_interested: 'Not interested', no_requirement: 'No requirement', budget_mismatch: 'Budget mismatch',
  bought_elsewhere: 'Bought elsewhere', unreachable: 'Unreachable after many tries', other: 'Other',
};

/**
 * Works out sub_status / lost_reason / lost_note for a PATCH /api/leads/:id.
 * sub_status: omitted = kept while the stage stays, reset when it moves;
 * null/'' clears; otherwise must belong to the (new) stage. Moving to 'lost'
 * needs lost_reason ('other' also needs lost_note, or the stage note); the
 * lost lead's sub_status is the reason's group. Any other stage clears the
 * reason, so a reopened lead starts clean. Returns { error } or the values
 * plus `activity` (text for a same-stage change, logged as a note).
 */
function leadSubStatusPlan(body, lead, stage, note) {
  const sameStage = stage === lead.stage;
  let subStatus = null, lostReason = null, lostNote = null;
  if (stage === 'lost') {
    lostReason = body.lost_reason === undefined ? (sameStage ? lead.lost_reason : null) : (typeof body.lost_reason === 'string' ? body.lost_reason.trim() || null : null);
    if (!lostReason && (!sameStage || body.lost_reason !== undefined)) return { error: fail(LOST_REASON_MESSAGE, 422) };
    if (lostReason && !LOST_REASONS[lostReason]) return { error: fail(`lost_reason must be one of: ${Object.keys(LOST_REASONS).join(', ')}.`, 422) };
    lostNote = body.lost_note === undefined
      ? (lostReason === lead.lost_reason ? lead.lost_note : null)
      : (typeof body.lost_note === 'string' ? body.lost_note.trim().slice(0, 500) || null : null);
    if (lostReason === 'other' && !lostNote) lostNote = note ? note.slice(0, 500) : null;
    if (lostReason === 'other' && !lostNote) return { error: fail('Please add a short note saying why — it is needed when the reason is "Other".', 422) };
    subStatus = lostReason ? LOST_REASONS[lostReason] : null;
  } else {
    const raw = body.sub_status === undefined ? (sameStage ? lead.sub_status : null) : (typeof body.sub_status === 'string' ? body.sub_status.trim() || null : null);
    if (raw && !(LEAD_SUB_STATUSES[stage] || []).includes(raw)) {
      // A stale detail carried over from before is dropped quietly; a bad one sent now is an error.
      if (body.sub_status !== undefined) return { error: fail(`That detail does not fit this stage. Choose one of: ${(LEAD_SUB_STATUSES[stage] || []).map((s) => LEAD_DETAIL_LABELS[s] || s).join(', ')}.`, 422) };
    } else subStatus = raw;
  }
  let activity = null;
  if (sameStage) {
    if (stage === 'lost' && lostReason !== lead.lost_reason) activity = 'Reason changed to ' + (LOST_REASON_LABELS[lostReason] || lostReason) + (lostNote ? ` (${lostNote})` : '');
    else if (stage !== 'lost' && subStatus !== (lead.sub_status || null)) activity = subStatus ? 'Detail: ' + (LEAD_DETAIL_LABELS[subStatus] || subStatus) : 'Detail cleared';
  }
  return { subStatus, lostReason, lostNote, activity };
}
// ---- end lead sub-status ----

async function handleUpdateLead(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You do not have permission to update this lead.', 403);
  const stage = body.stage ?? lead.stage;
  if (!STAGES.includes(stage)) return fail('Invalid lead stage.', 422);
  const priority = body.priority ?? lead.priority;
  if (!PRIORITIES.includes(priority)) return fail('Invalid priority.', 422);
  // Omitted = unchanged; null clears it back to "not ranked"; else must be valid.
  const researchLevel = body.research_level === undefined ? lead.research_level : body.research_level;
  if (researchLevel !== null && !RESEARCH_LEVELS.includes(researchLevel)) return fail(`research_level must be one of: ${RESEARCH_LEVELS.join(', ')}, or null.`, 422);
  const textField = (key) => {
    if (body[key] === undefined) return lead[key];
    return typeof body[key] === 'string' ? body[key].trim() || null : null;
  };
  const projectName = textField('project_name');
  const propertyType = textField('property_type');
  const location = textField('location');
  const status = stage === 'won' ? 'converted' : stage === 'lost' ? 'dead' : lead.assigned_user_id ? 'in_process' : 'new';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;
  const sub = leadSubStatusPlan(body, lead, stage, note); // wave3 C
  if (sub.error) return sub.error;
  const sameStageNote = [sub.activity, note].filter(Boolean).join(' — ') || null;
  await env.DB.batch([
    env.DB.prepare('UPDATE leads SET stage=?2, priority=?3, next_follow_up_at=?4, status=?5, project_name=?6, property_type=?7, location=?8, research_level=?9 WHERE id=?1')
      .bind(id, stage, priority, body.next_follow_up_at === undefined ? lead.next_follow_up_at : body.next_follow_up_at || null, status, projectName, propertyType, location, researchLevel),
    env.DB.prepare('UPDATE leads SET sub_status=?2, lost_reason=?3, lost_note=?4 WHERE id=?1').bind(id, sub.subStatus, sub.lostReason, sub.lostNote),
    ...(stage !== lead.stage ? [env.DB.prepare('INSERT INTO lead_stage_history (lead_id,from_stage,to_stage,actor_user_id,note,sub_status,lost_reason) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(id, lead.stage, stage, actor.id, note || sub.lostNote, sub.subStatus, sub.lostReason)] : []),
    // A note typed (or a detail changed) without moving the stage is kept as a plain note.
    ...(stage === lead.stage && sameStageNote ? [env.DB.prepare("INSERT INTO lead_activities (id,lead_id,actor_user_id,type,subject) VALUES (?1,?2,?3,'note',?4)")
      .bind(crypto.randomUUID(), id, actor.id, sameStageNote)] : []),
  ]);
  return handleGetLead(env, id, actor);
}

async function handleCreateActivity(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body?.subject?.trim() || !['note', 'call', 'meeting', 'task', 'email'].includes(body.type)) return fail('Activity type and subject are required.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead) || !has(actor, 'activity.write')) return fail('You do not have permission to add activity.', 403);
  await env.DB.prepare('INSERT INTO lead_activities (id,lead_id,actor_user_id,type,subject,body,due_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
    .bind(crypto.randomUUID(), id, actor.id, body.type, body.subject.trim(), body.body || null, body.due_at || null).run();
  return json({ ok: true }, 201);
}

/** Tick a task done (or undo). Only tasks carry due_at/completed_at. */
async function handleUpdateActivity(request, env, leadId, activityId, actor) {
  const body = await bodyJson(request);
  if (typeof body?.completed !== 'boolean') return fail('Send { completed: true|false }.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(leadId).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead) || !has(actor, 'activity.write')) return fail('You do not have permission to update this task.', 403);
  const res = await env.DB.prepare(
    `UPDATE lead_activities SET completed_at = CASE WHEN ?3 THEN datetime('now') ELSE NULL END
      WHERE id = ?1 AND lead_id = ?2 AND type = 'task'`
  ).bind(activityId, leadId, body.completed ? 1 : 0).run();
  if (!res.meta?.changes) return fail('Task not found.', 404);
  return json({ ok: true });
}

async function handleRequestTransfer(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body?.to_user_id) return fail('Choose an employee to receive the transfer.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(id).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead) || !has(actor, 'transfer.request')) return fail('You do not have permission to request this transfer.', 403);
  // Agents can only request transfers on leads they own, but the super admin's
  // wildcard (or an override) could reach an unowned lead; accepting would give
  // it an owner, so an unowned lead must be ranked first like any assignment.
  if (!lead.assigned_user_id && !lead.research_level) return fail(`Rank this lead before assigning it. ${RESEARCH_LEVEL_MESSAGE}`, 422);
  const target = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(body.to_user_id).first();
  // viewer is read-only by design (ROLE_PERMISSIONS grants it no update/write
  // permissions) — accepting this transfer would still hand it ownership of
  // the lead via assigned_user_id, bypassing that restriction entirely.
  if (!target?.is_active || target.role === 'viewer' || target.id === lead.assigned_user_id) {
    return fail('Choose an active employee (not a viewer) other than the current owner.', 422);
  }
  try {
    await env.DB.prepare('INSERT INTO lead_transfer_requests (id,lead_id,from_user_id,to_user_id,note) VALUES (?1,?2,?3,?4,?5)')
      .bind(crypto.randomUUID(), id, actor.id, target.id, body.note || null).run();
  } catch { return fail('This lead already has a pending transfer request.', 409); }
  return json({ ok: true, message: `Transfer request sent to ${target.name}.` }, 201);
}

/**
 * Powers the "Today" landing view: what needs doing right now, computed from
 * real lead data (not a separate stats table) so it can never drift from the
 * leads list itself. RBAC-scoped identically to handleListLeads.
 */
async function handleDashboard(env, actor) {
  if (!has(actor, 'team.read')) return fail('You do not have permission to view this.', 403);

  let scopeSql = '';
  const scopeParams = [];
  if (!has(actor, 'lead.read_all')) {
    if (has(actor, 'lead.read_own')) { scopeSql = 'AND l.assigned_user_id = ?'; scopeParams.push(actor.id); }
    else if (has(actor, 'lead.read_team') && actor.team_id) { scopeSql = 'AND l.team_id = ?'; scopeParams.push(actor.team_id); }
    else return fail('You do not have permission to view this.', 403);
  }

  const OPEN = `'${OPEN_STATUSES.join("','")}'`;
  // Timestamps are stored in UTC, but "today" and "this month" mean the
  // business's day in India (IST, UTC+5:30) — otherwise 00:00–05:30 IST counts
  // as yesterday.
  const TODAY = `date('now', '+330 minutes')`;
  const localDay = (col) => `date(${col}, '+330 minutes')`;
  const MONTH_START_UTC = `datetime(date('now', '+330 minutes', 'start of month'), '-330 minutes')`;
  const CALL_LIST_WHERE = `l.archived_at IS NULL AND l.status IN (${OPEN})
          AND (l.stage = 'new' OR (l.next_follow_up_at IS NOT NULL AND ${localDay('l.next_follow_up_at')} <= ${TODAY}))
          ${scopeSql}`;

  const [callFirst, dueLater, siteVisits, soldThisMonth, totalThisMonth, callListResult, callListTotal] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.archived_at IS NULL AND l.status IN (${OPEN})
         AND (l.stage = 'new' OR (l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < datetime('now')))
         ${scopeSql}`
    ).bind(...scopeParams).first('n'),

    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.archived_at IS NULL AND l.status IN (${OPEN})
         AND l.next_follow_up_at IS NOT NULL AND ${localDay('l.next_follow_up_at')} = ${TODAY} AND l.next_follow_up_at >= datetime('now')
         ${scopeSql}`
    ).bind(...scopeParams).first('n'),

    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.stage = 'site_visit_scheduled'
         AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at BETWEEN datetime('now') AND datetime('now', '+7 days')
         ${scopeSql}`
    ).bind(...scopeParams).first('n'),

    env.DB.prepare(
      `SELECT COUNT(DISTINCT sh.lead_id) AS n FROM lead_stage_history sh JOIN leads l ON l.id = sh.lead_id
         WHERE sh.to_stage = 'won' AND sh.created_at >= ${MONTH_START_UTC}
         ${scopeSql}`
    ).bind(...scopeParams).first('n'),

    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.created_at >= ${MONTH_START_UTC} ${scopeSql}`
    ).bind(...scopeParams).first('n'),

    env.DB.prepare(
      `SELECT l.*, u.name AS assigned_user_name, t.name AS team_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_user_id
         LEFT JOIN teams t ON t.id = l.team_id
        WHERE ${CALL_LIST_WHERE}
        ORDER BY
          CASE WHEN l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < datetime('now') THEN 0
               WHEN l.next_follow_up_at IS NOT NULL THEN 1
               ELSE 2 END,
          COALESCE(l.next_follow_up_at, l.created_at) ASC
        LIMIT 100`
    ).bind(...scopeParams).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${CALL_LIST_WHERE}`).bind(...scopeParams).first('n'),
  ]);

  return json({
    call_first: callFirst ?? 0,
    due_later_today: dueLater ?? 0,
    site_visits_week: siteVisits ?? 0,
    sold_this_month: soldThisMonth ?? 0,
    total_this_month: totalThisMonth ?? 0,
    call_list: callListResult.results ?? [],
    call_list_total: callListTotal ?? 0,
  });
}

/**
 * The actual, live intake URLs — not placeholders — so Settings can show a
 * super-admin exactly what to paste into each portal's dashboard. Restricted
 * to super_admin because these embed the same shared secret used to
 * authenticate inbound portal pushes (see handleIntake).
 */
async function handlePortalLinks(request, env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can view portal integration links.', 403);
  const origin = new URL(request.url).origin;
  const sources = [
    { source: '99acres', label: '99acres', envKey: 'INTAKE_TOKEN_99ACRES' },
    { source: 'magicbricks', label: 'MagicBricks', envKey: 'INTAKE_TOKEN_MAGICBRICKS' },
  ];
  const links = sources.map(({ source, label, envKey }) => {
    const token = env[envKey];
    return {
      source,
      label,
      configured: Boolean(token),
      url: token ? `${origin}/api/intake/${source}?token=${token}` : null,
    };
  });
  return json({ links });
}

/** Pending transfers offered to the signed-in employee — shown on Today so a
 * request never sits unseen. */
async function handleIncomingTransfers(env, actor) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.lead_id, r.note, r.created_at, l.customer_name, l.project_name, l.location, fu.name AS from_user_name
       FROM lead_transfer_requests r JOIN leads l ON l.id = r.lead_id LEFT JOIN users fu ON fu.id = r.from_user_id
      WHERE r.to_user_id = ?1 AND r.status = 'pending' ORDER BY r.created_at ASC`
  ).bind(actor.id).all();
  return json({ transfers: results ?? [] });
}

/** The requester (or anyone who can update the lead, e.g. its manager) can
 * withdraw a pending transfer, freeing the lead for a new request. */
async function handleCancelTransfer(env, transferId, actor) {
  const transfer = await env.DB.prepare('SELECT r.*, l.assigned_user_id, l.team_id FROM lead_transfer_requests r JOIN leads l ON l.id=r.lead_id WHERE r.id=?1').bind(transferId).first();
  if (!transfer) return fail('Transfer request not found.', 404);
  if (transfer.status !== 'pending') return fail('This transfer has already been resolved.', 409);
  if (actor.id !== transfer.from_user_id && !canUpdateLead(actor, transfer)) return fail('Only the person who asked, or a manager, can cancel this transfer.', 403);
  await env.DB.prepare("UPDATE lead_transfer_requests SET status='cancelled', responded_at=datetime('now') WHERE id=?1 AND status='pending'").bind(transferId).run();
  return json({ ok: true, status: 'cancelled' });
}

async function handleRespondTransfer(request, env, transferId, actor) {
  const body = await bodyJson(request);
  if (!['accepted', 'rejected'].includes(body?.decision)) return fail('Decision must be accepted or rejected.', 422);
  const transfer = await env.DB.prepare('SELECT r.*, l.assigned_user_id, l.team_id FROM lead_transfer_requests r JOIN leads l ON l.id=r.lead_id WHERE r.id=?1').bind(transferId).first();
  if (!transfer) return fail('Transfer request not found.', 404);
  if (transfer.status !== 'pending') return fail('This transfer has already been resolved.', 409);
  if (actor.id !== transfer.to_user_id && actor.role !== 'super_admin') return fail('Only the proposed employee can respond.', 403);
  const target = await env.DB.prepare('SELECT * FROM users WHERE id=?1 AND is_active=1').bind(transfer.to_user_id).first();
  if (!target) return fail('The proposed employee is inactive.', 422);
  const statements = [env.DB.prepare("UPDATE lead_transfer_requests SET status=?2, responded_note=?3, responded_at=datetime('now') WHERE id=?1").bind(transferId, body.decision, body.note || null)];
  if (body.decision === 'accepted') {
    statements.push(
      env.DB.prepare('UPDATE leads SET assigned_user_id=?2, team_id=?3, status=CASE WHEN status=\'new\' THEN \'assigned\' ELSE status END WHERE id=?1').bind(transfer.lead_id, target.id, target.team_id),
      env.DB.prepare('INSERT INTO assignment_history (lead_id,from_user_id,to_user_id,from_team_id,to_team_id,reason,actor_user_id,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(transfer.lead_id, transfer.assigned_user_id, target.id, transfer.team_id, target.team_id, 'transfer:accepted', actor.id, transfer.note || null),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, status: body.decision });
}

// ---- Pre-Sales handovers & calling list (wave3, agent D, migration 0063) ----
// A Pre-Sales person qualifies a lead and hands it to a client team
// (teams.vertical = 'client'; NULL counts as client). The lead stays with the
// sender until the receiving team's manager / team leader (handover.respond)
// accepts and picks the relationship manager. Reject sends it back to the
// sender; "Ask a question" waits for the sender's answer, then it is pending
// again. Only ACCEPTED handovers count as successful.
const HANDOVER_OPEN = ['pending', 'clarification'];
const HANDOVER_STATUSES = ['pending', 'accepted', 'rejected', 'clarification'];
const HANDOVER_SUMMARY_LIMITS = { budget: 200, area: 200, timeline: 200, decision_maker: 200, notes: 2000 };
const HANDOVER_SELECT =
  `SELECT h.*, t.name AS to_team_name, t.manager_user_id AS to_team_manager_id, ft.name AS from_team_name,
          fu.name AS from_user_name, tu.name AS to_user_name, rb.name AS responded_by_name
     FROM lead_handovers h
     LEFT JOIN teams t ON t.id = h.to_team_id
     LEFT JOIN teams ft ON ft.id = h.from_team_id
     LEFT JOIN users fu ON fu.id = h.from_user_id
     LEFT JOIN users tu ON tu.id = h.to_user_id
     LEFT JOIN users rb ON rb.id = h.responded_by_user_id`;

function handoverJson(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}
function handoverNote(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) || null : null;
}
function handoverEntry(actor, kind, text) {
  return { kind, text: text || null, by_user_id: actorUserId(actor), by_name: actor.name || 'Someone', at: new Date().toISOString().slice(0, 19).replace('T', ' ') }; // same UTC format as datetime('now')
}
function handoverLeadName(lead) {
  return (lead?.customer_name || 'a lead') + (lead?.lead_code ? ` (${lead.lead_code})` : '');
}
function canRespondHandover(actor, h) {
  return has(actor, 'handover.respond') && (has(actor, 'lead.read_all') ||
    Boolean(actor.team_id && actor.team_id === h.to_team_id) || Boolean(h.to_team_manager_id && h.to_team_manager_id === actor.id));
}
function canAnswerHandover(actor, h, lead) {
  return Boolean(h.from_user_id && h.from_user_id === actor.id) || (has(actor, 'handover.submit') && Boolean(lead) && canUpdateLead(actor, lead));
}
async function loadHandover(env, id) {
  return env.DB.prepare(`${HANDOVER_SELECT} WHERE h.id = ?1`).bind(id).first();
}
/** Client teams a lead can be handed to (vertical 'client', NULL = client). */
async function handoverTargetTeams(env) {
  const { results } = await env.DB.prepare(`SELECT t.*, m.name AS manager_name FROM teams t LEFT JOIN users m ON m.id = t.manager_user_id ORDER BY t.name`).all();
  return (results ?? []).filter((t) => (t.vertical ?? 'client') === 'client');
}
/** The receiving team's manager and team leaders — they decide on handovers. */
async function handoverReceivers(env, teamId, managerId) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM users WHERE team_id = ?1 AND is_active = 1 AND role IN ('manager', 'team_leader', 'sales_head')`
  ).bind(teamId || '__none__').all();
  const ids = [...new Set([managerId, ...(results ?? []).map((u) => u.id)].filter(Boolean))];
  return ids.length ? { userIds: ids } : { teamId };
}
/** Someone deciding on (or suggested for) an open handover may open the lead. */
async function handoverGrantsLeadRead(env, leadId, actor) {
  const { results } = await env.DB.prepare(`${HANDOVER_SELECT} WHERE h.lead_id = ?1 AND h.status IN ('pending', 'clarification')`).bind(leadId).all();
  return (results ?? []).some((h) => canRespondHandover(actor, h) || h.to_user_id === actor.id);
}
/** Lead sub-status (wave3 C) is optional here: skipped quietly if the column isn't there yet. */
async function setHandoverSubStatus(env, leadId, subStatus) {
  try { await env.DB.prepare(`UPDATE leads SET sub_status = ?2 WHERE id = ?1 AND stage = 'qualified'`).bind(leadId, subStatus).run(); } catch {}
}

async function shapeHandovers(env, actor, rows) {
  const ids = [...new Set(rows.map((r) => r.lead_id))];
  const leads = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT l.*, u.name AS assigned_user_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id WHERE l.id IN (${chunk.map((_, j) => '?' + (j + 1)).join(',')})`
    ).bind(...chunk).all();
    for (const l of results ?? []) leads.set(l.id, l);
  }
  return rows.map((r) => {
    const l = leads.get(r.lead_id);
    return {
      ...r,
      summary: handoverJson(r.summary, {}),
      thread: handoverJson(r.thread, []),
      lead: l ? {
        id: l.id, lead_code: l.lead_code || null, customer_name: l.customer_name, phone: l.phone, stage: l.stage, source: l.source,
        location: l.location, property_type: l.property_type, budget_min: l.budget_min, budget_max: l.budget_max, assigned_user_name: l.assigned_user_name || null,
      } : null,
      can_respond: HANDOVER_OPEN.includes(r.status) && canRespondHandover(actor, r),
      can_answer: r.status === 'clarification' && canAnswerHandover(actor, r, l),
      can_see: canRespondHandover(actor, r) || r.to_user_id === actor.id || r.from_user_id === actor.id || Boolean(l && canReadLead(actor, l)),
    };
  });
}

/** GET /api/handovers?box=sent|received|lead[&lead_id=][&status=open|pending|…][&mine=1] */
async function handleListHandovers(request, env, actor) {
  const url = new URL(request.url);
  const box = url.searchParams.get('box') || 'sent';
  const mine = url.searchParams.get('mine') === '1';
  const binds = [];
  const where = [];
  const bind = (v) => { binds.push(v); return '?' + binds.length; };
  if (box === 'lead') {
    const leadId = url.searchParams.get('lead_id');
    if (!leadId) return fail('lead_id is required.', 422);
    where.push(`h.lead_id = ${bind(leadId)}`); // each row's visibility is checked below
  } else if (box === 'sent') {
    if (has(actor, 'lead.read_all') && !mine) { /* everything */ }
    else if (has(actor, 'lead.read_team') && actor.team_id && !mine) where.push(`(h.from_user_id = ${bind(actor.id)} OR h.from_team_id = ${bind(actor.team_id)})`);
    else where.push(`h.from_user_id = ${bind(actor.id)}`);
  } else if (box === 'received') {
    if (!(has(actor, 'handover.respond') && has(actor, 'lead.read_all'))) {
      const c = [`h.to_user_id = ${bind(actor.id)}`];
      if (has(actor, 'handover.respond')) {
        c.push(`t.manager_user_id = ${bind(actor.id)}`);
        if (actor.team_id) c.push(`h.to_team_id = ${bind(actor.team_id)}`);
      }
      where.push(`(${c.join(' OR ')})`);
    }
  } else return fail('box must be sent, received or lead.', 422);
  const status = url.searchParams.get('status');
  if (status === 'open') where.push(`h.status IN ('pending', 'clarification')`);
  else if (status) {
    if (!HANDOVER_STATUSES.includes(status)) return fail(`status must be open or one of: ${HANDOVER_STATUSES.join(', ')}.`, 422);
    where.push(`h.status = ${bind(status)}`);
  }
  const { results } = await env.DB.prepare(
    `${HANDOVER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN h.status IN ('pending', 'clarification') THEN 0 ELSE 1 END, COALESCE(h.responded_at, h.created_at) DESC
      LIMIT 200`
  ).bind(...binds).all();
  let rows = await shapeHandovers(env, actor, results ?? []);
  if (box === 'lead') rows = rows.filter((r) => r.can_see);
  return json({ handovers: rows });
}

/** GET /api/handovers/options — client teams and their active people (for "hand over to" and "relationship manager"). */
async function handleHandoverOptions(env, actor) {
  if (!has(actor, 'handover.submit') && !has(actor, 'handover.respond')) return fail('You do not have permission to hand over leads.', 403);
  const teams = await handoverTargetTeams(env);
  const { results } = await env.DB.prepare(
    `SELECT id, name, role, team_id FROM users WHERE is_active = 1 AND role <> 'viewer' AND team_id IS NOT NULL ORDER BY name`
  ).all();
  const people = results ?? [];
  return json({
    teams: teams.map((t) => ({
      id: t.id, name: t.name, vertical: t.vertical ?? 'client', manager_name: t.manager_name || null,
      members: people.filter((u) => u.team_id === t.id).map(({ id, name, role }) => ({ id, name, role })),
    })),
  });
}

/** POST /api/handovers { lead_id, to_team_id, to_user_id?, research_level?, summary: { requirement_confirmed, budget, area, timeline, decision_maker?, notes? } } */
async function handleCreateHandover(request, env, actor) {
  if (!has(actor, 'handover.submit')) return fail('You do not have permission to hand over leads.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const lead = body.lead_id ? await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(String(body.lead_id)).first() : null;
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead)) return fail('You can only hand over leads you look after.', 403);
  if (['won', 'lost'].includes(lead.stage)) return fail('This lead is closed. Reopen it before handing it over.', 422);
  const team = body.to_team_id ? (await handoverTargetTeams(env)).find((t) => t.id === String(body.to_team_id)) : null;
  if (!team) return fail('Choose a client team to hand this lead to.', 422);
  let toUser = null;
  if (body.to_user_id) {
    toUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(String(body.to_user_id)).first();
    if (!toUser?.is_active || toUser.role === 'viewer' || toUser.team_id !== team.id) return fail('The person you picked must be an active member of that team.', 422);
  }
  const s = body.summary && typeof body.summary === 'object' && !Array.isArray(body.summary) ? body.summary : {};
  if (s.requirement_confirmed !== true) return fail("Confirm the client's requirement before handing over.", 422);
  const summary = { requirement_confirmed: true };
  for (const [key, max] of Object.entries(HANDOVER_SUMMARY_LIMITS)) summary[key] = handoverNote(s[key], max);
  if (!summary.budget || !summary.area || !summary.timeline) return fail('Budget, area and timeline are needed for a handover.', 422);
  const researchLevel = body.research_level ?? null;
  if (researchLevel !== null && !RESEARCH_LEVELS.includes(researchLevel)) return fail(RESEARCH_LEVEL_MESSAGE, 422);
  if (!lead.research_level && !researchLevel) return fail(`Rank this lead before handing it over. ${RESEARCH_LEVEL_MESSAGE}`, 422);
  if (await env.DB.prepare(`SELECT 1 FROM lead_handovers WHERE lead_id = ?1 AND status IN ('pending', 'clarification')`).bind(lead.id).first()) {
    return fail('This lead already has a handover waiting for a decision.', 409);
  }
  const id = crypto.randomUUID();
  // Handing over means the lead is qualified; earlier stages move up to it.
  const toQualified = ['new', 'contact_attempted', 'contacted', 'nurture'].includes(lead.stage);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO lead_handovers (id, lead_id, from_user_id, from_team_id, to_team_id, to_user_id, summary, thread) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(id, lead.id, actorUserId(actor), actor.team_id || null, team.id, toUser?.id || null, JSON.stringify(summary), JSON.stringify([handoverEntry(actor, 'sent', summary.notes)])),
      env.DB.prepare(
        `UPDATE leads SET research_level = COALESCE(?2, research_level),
                stage = CASE WHEN ?3 THEN 'qualified' ELSE stage END,
                status = CASE WHEN ?3 AND assigned_user_id IS NOT NULL THEN 'in_process' ELSE status END
          WHERE id = ?1`
      ).bind(lead.id, researchLevel, toQualified ? 1 : 0),
      ...(toQualified ? [env.DB.prepare('INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, actor_user_id, note) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(lead.id, lead.stage, 'qualified', actor.id, `Qualified and handed over to ${team.name}`)] : []),
      env.DB.prepare(`INSERT INTO lead_activities (id, lead_id, actor_user_id, type, subject, body) VALUES (?1, ?2, ?3, 'note', ?4, ?5)`)
        .bind(crypto.randomUUID(), lead.id, actor.id, `Handed over to ${team.name}${toUser ? ` (suggested: ${toUser.name})` : ''} — waiting for them to accept`, summary.notes),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message || e))) return fail('This lead already has a handover waiting for a decision.', 409);
    throw e;
  }
  await setHandoverSubStatus(env, lead.id, 'handover_requested');
  await raiseAlert(env, {
    importance: 'medium', to: await handoverReceivers(env, team.id, team.manager_user_id),
    title: `New handover: ${handoverLeadName(lead)}`,
    body: `${actor.name || 'Someone'} handed ${lead.customer_name || 'a lead'} over to ${team.name}. Please accept it, reject it or ask a question.`,
    link: { kind: 'lead', id: lead.id },
  });
  const [handover] = await shapeHandovers(env, actor, [await loadHandover(env, id)]);
  return json({ ok: true, handover }, 201);
}

/** POST /api/handovers/:id/respond { action: 'accept'|'reject'|'clarify', note?, relationship_manager_user_id? } */
async function handleRespondHandover(request, env, id, actor) {
  const body = await bodyJson(request);
  const action = body?.action;
  if (!['accept', 'reject', 'clarify'].includes(action)) return fail('action must be accept, reject or clarify.', 422);
  const h = await loadHandover(env, id);
  if (!h) return fail('Handover not found.', 404);
  if (!canRespondHandover(actor, h)) return fail("Only the receiving team's manager or team leader can answer this handover.", 403);
  if (!HANDOVER_OPEN.includes(h.status)) return fail('This handover has already been decided.', 409);
  if (action === 'clarify' && h.status !== 'pending') return fail('A question is already waiting for an answer.', 409);
  const note = handoverNote(body.note);
  if (action === 'reject' && !note) return fail('Please say why you are rejecting this handover.', 422);
  if (action === 'clarify' && !note) return fail('Type your question for the sender.', 422);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(h.lead_id).first();
  if (!lead) return fail('Lead not found.', 404);
  const thread = handoverJson(h.thread, []);
  const who = actorUserId(actor);
  const actorName = actor.name || 'Someone';
  const sender = h.from_user_id ? { userIds: [h.from_user_id] } : {};
  const activity = (subject, text = null) => env.DB.prepare(`INSERT INTO lead_activities (id, lead_id, actor_user_id, type, subject, body) VALUES (?1, ?2, ?3, 'note', ?4, ?5)`)
    .bind(crypto.randomUUID(), lead.id, actor.id, subject, text);
  const guard = `WHERE id = ?1 AND status IN ('pending', 'clarification')`;

  if (action === 'accept') {
    const rmId = body.relationship_manager_user_id || h.to_user_id;
    const rm = rmId ? await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(String(rmId)).first() : null;
    if (!rm?.is_active || rm.role === 'viewer' || rm.team_id !== h.to_team_id) return fail('Choose the relationship manager from the receiving team.', 422);
    thread.push(handoverEntry(actor, 'accepted', `Relationship manager: ${rm.name}${note ? ' — ' + note : ''}`));
    const res = await env.DB.prepare(`UPDATE lead_handovers SET status = 'accepted', to_user_id = ?2, response_note = ?3, responded_by_user_id = ?4, responded_at = datetime('now'), thread = ?5 ${guard}`)
      .bind(id, rm.id, note, who, JSON.stringify(thread)).run();
    if (!res.meta?.changes) return fail('This handover has already been decided.', 409);
    // The lead keeps its source, stage and history; only the owner and team change.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO assignment_history (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, actor_user_id, note)
                      SELECT id, assigned_user_id, ?2, team_id, ?3, 'handover:accepted', ?4, ?5 FROM leads WHERE id = ?1`).bind(lead.id, rm.id, h.to_team_id, actor.id, note),
      env.DB.prepare(`UPDATE leads SET assigned_user_id = ?2, team_id = ?3, status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END WHERE id = ?1`).bind(lead.id, rm.id, h.to_team_id),
      env.DB.prepare(`UPDATE assignment_approvals SET status = 'cancelled', reviewer_user_id = ?2, final_user_id = ?3, reviewed_at = datetime('now') WHERE lead_id = ?1 AND status = 'pending'`).bind(lead.id, who, rm.id),
      env.DB.prepare(`UPDATE lead_transfer_requests SET status = 'cancelled', responded_at = datetime('now') WHERE lead_id = ?1 AND status = 'pending'`).bind(lead.id),
      activity(`Handover accepted by ${actorName} (${h.to_team_name || 'client team'}) — now looked after by ${rm.name}`, note),
    ]);
    await setHandoverSubStatus(env, lead.id, 'qualified');
    if (h.from_user_id) await raiseAlert(env, { importance: 'normal', to: sender, title: `Handover accepted: ${handoverLeadName(lead)}`, body: `${h.to_team_name || 'The client team'} accepted it. ${rm.name} will look after the client.`, link: { kind: 'lead', id: lead.id } });
    if (rm.id !== actor.id) await raiseAlert(env, { importance: 'medium', to: { userIds: [rm.id] }, title: `New client for you: ${handoverLeadName(lead)}`, body: `${actorName} gave you this lead from a Pre-Sales handover.`, link: { kind: 'lead', id: lead.id } });
  } else if (action === 'reject') {
    thread.push(handoverEntry(actor, 'rejected', note));
    const res = await env.DB.prepare(`UPDATE lead_handovers SET status = 'rejected', response_note = ?2, responded_by_user_id = ?3, responded_at = datetime('now'), thread = ?4 ${guard}`)
      .bind(id, note, who, JSON.stringify(thread)).run();
    if (!res.meta?.changes) return fail('This handover has already been decided.', 409);
    // The lead goes back to the sender (it normally never left them).
    const senderUser = h.from_user_id ? await env.DB.prepare('SELECT * FROM users WHERE id = ?1 AND is_active = 1').bind(h.from_user_id).first() : null;
    const back = senderUser && lead.assigned_user_id !== senderUser.id;
    await env.DB.batch([
      ...(back ? [
        env.DB.prepare(`INSERT INTO assignment_history (lead_id, from_user_id, to_user_id, from_team_id, to_team_id, reason, actor_user_id, note)
                        SELECT id, assigned_user_id, ?2, team_id, ?3, 'handover:rejected', ?4, ?5 FROM leads WHERE id = ?1`).bind(lead.id, senderUser.id, senderUser.team_id, actor.id, note),
        env.DB.prepare(`UPDATE leads SET assigned_user_id = ?2, team_id = ?3 WHERE id = ?1`).bind(lead.id, senderUser.id, senderUser.team_id),
      ] : []),
      activity(`Handover rejected by ${actorName} (${h.to_team_name || 'client team'})`, note),
    ]);
    await setHandoverSubStatus(env, lead.id, 'qualified');
    await raiseAlert(env, { importance: 'medium', to: sender, title: `Handover rejected: ${handoverLeadName(lead)}`, body: `${actorName} (${h.to_team_name || 'client team'}): ${note}`, link: { kind: 'lead', id: lead.id } });
  } else {
    thread.push(handoverEntry(actor, 'question', note));
    const res = await env.DB.prepare(`UPDATE lead_handovers SET status = 'clarification', response_note = ?2, responded_by_user_id = ?3, thread = ?4 WHERE id = ?1 AND status = 'pending'`)
      .bind(id, note, who, JSON.stringify(thread)).run();
    if (!res.meta?.changes) return fail('This handover has already been decided.', 409);
    await activity(`${actorName} asked a question about the handover`, note).run();
    await raiseAlert(env, { importance: 'medium', to: sender, title: `Question on your handover: ${handoverLeadName(lead)}`, body: `${actorName} (${h.to_team_name || 'client team'}) asks: ${note}`, link: { kind: 'lead', id: lead.id } });
  }
  const [handover] = await shapeHandovers(env, actor, [await loadHandover(env, id)]);
  return json({ ok: true, handover });
}

/** POST /api/handovers/:id/answer { note } — the sender answers the receiving team's question; back to pending. */
async function handleAnswerHandover(request, env, id, actor) {
  const body = await bodyJson(request);
  const h = await loadHandover(env, id);
  if (!h) return fail('Handover not found.', 404);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(h.lead_id).first();
  if (!canAnswerHandover(actor, h, lead)) return fail('Only the person who sent this handover can answer.', 403);
  if (h.status !== 'clarification') return fail('There is no question waiting for an answer.', 409);
  const note = handoverNote(body?.note);
  if (!note) return fail('Type your answer.', 422);
  const thread = handoverJson(h.thread, []);
  thread.push(handoverEntry(actor, 'answer', note));
  const res = await env.DB.prepare(`UPDATE lead_handovers SET status = 'pending', thread = ?2 WHERE id = ?1 AND status = 'clarification'`).bind(id, JSON.stringify(thread)).run();
  if (!res.meta?.changes) return fail('There is no question waiting for an answer.', 409);
  if (lead) {
    await env.DB.prepare(`INSERT INTO lead_activities (id, lead_id, actor_user_id, type, subject, body) VALUES (?1, ?2, ?3, 'note', ?4, ?5)`)
      .bind(crypto.randomUUID(), lead.id, actor.id, `${actor.name || 'Someone'} answered the handover question`, note).run();
  }
  await raiseAlert(env, {
    importance: 'medium', to: await handoverReceivers(env, h.to_team_id, h.to_team_manager_id),
    title: `Handover answer: ${handoverLeadName(lead)}`, body: `${actor.name || 'Someone'}: ${note}`, link: { kind: 'lead', id: h.lead_id },
  });
  const [handover] = await shapeHandovers(env, actor, [await loadHandover(env, id)]);
  return json({ ok: true, handover });
}

/** Pre-Sales pages scope: everyone (read_all) / my team (read_team) / just me; ?scope=mine narrows. */
function presalesScope(actor, url) {
  const wantMine = url.searchParams.get('scope') === 'mine';
  if (has(actor, 'lead.read_all') && !wantMine) return { scope: 'all', lead: () => '1=1', person: () => '1=1' };
  if (has(actor, 'lead.read_team') && actor.team_id && !wantMine) {
    return { scope: 'team', lead: (b) => `l.team_id = ${b(actor.team_id)}`, person: (col, b) => `${col} IN (SELECT id FROM users WHERE team_id = ${b(actor.team_id)})` };
  }
  if (has(actor, 'lead.read_own') || has(actor, 'lead.read_team') || has(actor, 'lead.read_all')) {
    return { scope: 'mine', lead: (b) => `l.assigned_user_id = ${b(actor.id)}`, person: (col, b) => `${col} = ${b(actor.id)}` };
  }
  return null;
}

/** GET /api/presales/calling-list — open leads that need a call: overdue / today's callbacks first, then new, then tried-but-not-reached. */
async function handlePresalesCallingList(request, env, actor) {
  const sc = presalesScope(actor, new URL(request.url));
  if (!sc) return fail('You do not have permission to view leads.', 403);
  const binds = [];
  const b = (v) => { binds.push(v); return '?' + binds.length; };
  const due = `l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} <= ${LEAD_LENS_TODAY}`;
  const { results } = await env.DB.prepare(
    `SELECT l.*, u.name AS assigned_user_name,
            CASE WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} < ${LEAD_LENS_TODAY} THEN 'overdue'
                 WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} = ${LEAD_LENS_TODAY} THEN 'today'
                 WHEN l.stage = 'new' THEN 'new' ELSE 'attempted' END AS call_reason,
            (SELECT h.status FROM lead_handovers h WHERE h.lead_id = l.id AND h.status IN ('pending', 'clarification') LIMIT 1) AS handover_status
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_user_id
      WHERE ${LEAD_LENS_OPEN} AND l.stage NOT IN ('won', 'lost')
        AND (l.stage = 'new' OR (${due}) OR (l.stage = 'contact_attempted' AND l.next_follow_up_at IS NULL))
        AND ${sc.lead(b)}
      ORDER BY CASE WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} < ${LEAD_LENS_TODAY} THEN 0
                    WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} = ${LEAD_LENS_TODAY} THEN 1
                    WHEN l.stage = 'new' THEN 2 ELSE 3 END,
               l.next_follow_up_at IS NULL, l.next_follow_up_at ASC, l.created_at DESC
      LIMIT 200`
  ).bind(...binds).all();
  return json({ scope: sc.scope, leads: results ?? [] });
}

/** GET /api/presales/all-leads — every lead in the caller's scope (any stage), newest first. ?q= search, ?project= project name, ?offset= / ?limit= paging. */
async function handlePresalesAllLeads(request, env, actor) {
  const url = new URL(request.url);
  const sc = presalesScope(actor, url);
  if (!sc) return fail('You do not have permission to view leads.', 403);
  const binds = [];
  const b = (v) => { binds.push(v); return '?' + binds.length; };
  const where = [sc.lead(b), 'l.archived_at IS NULL'];
  const project = url.searchParams.get('project')?.trim();
  if (project) where.push(`lower(trim(COALESCE(l.project_name,''))) = lower(${b(project.slice(0, 200))})`);
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    const like = b(`%${q.slice(0, 100)}%`);
    const clauses = ['customer_name', 'email', 'project_name', 'location'].map((c) => `lower(COALESCE(l.${c},'')) LIKE lower(${like})`);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4) clauses.push(`${huntingPhoneKeySql('l.phone')} LIKE ${b(`%${digits.slice(-10)}%`)}`);
    const code = recordCodeQuery(q, 'L');
    if (code) clauses.push(`l.lead_code = ${b(code)}`);
    where.push(`(${clauses.join(' OR ')})`);
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const whereSql = where.join(' AND ');
  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT l.*, u.name AS assigned_user_name,
              CASE WHEN l.stage IN ('won', 'lost') THEN 'closed'
                   WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} < ${LEAD_LENS_TODAY} THEN 'overdue'
                   WHEN l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} = ${LEAD_LENS_TODAY} THEN 'today'
                   WHEN l.stage = 'new' THEN 'new' ELSE 'attempted' END AS call_reason,
              (SELECT h.status FROM lead_handovers h WHERE h.lead_id = l.id AND h.status IN ('pending', 'clarification') LIMIT 1) AS handover_status
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id
        WHERE ${whereSql}
        ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    ).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${whereSql}`).bind(...binds).first(),
  ]);
  return json({ scope: sc.scope, total: total?.n ?? 0, leads: results ?? [] });
}

/** GET /api/presales/overview — simple Pre-Sales tiles (India days / months). */
async function handlePresalesOverview(request, env, actor) {
  const sc = presalesScope(actor, new URL(request.url));
  if (!sc) return fail('You do not have permission to view leads.', 403);
  const one = (build) => { const binds = []; const sql = build((v) => { binds.push(v); return '?' + binds.length; }); return env.DB.prepare(sql).bind(...binds).first(); };
  const month = `strftime('%Y-%m', 'now', '+330 minutes')`;
  const inMonth = (col) => `strftime('%Y-%m', ${col}, '+330 minutes') = ${month}`;
  const [leads, qualified, ho] = await Promise.all([
    one((b) => `SELECT COUNT(CASE WHEN date(l.created_at, '+330 minutes') = ${LEAD_LENS_TODAY} THEN 1 END) AS new_today,
                       COUNT(CASE WHEN ${LEAD_LENS_OPEN} AND l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} <= ${LEAD_LENS_TODAY} THEN 1 END) AS calls_due,
                       COUNT(CASE WHEN ${LEAD_LENS_OPEN} AND l.next_follow_up_at IS NOT NULL AND ${LEAD_LENS_DAY} < ${LEAD_LENS_TODAY} THEN 1 END) AS calls_overdue,
                       COUNT(CASE WHEN ${LEAD_LENS_OPEN} AND l.stage = 'new' THEN 1 END) AS not_called_yet
                  FROM leads l WHERE ${sc.lead(b)}`),
    one((b) => `SELECT COUNT(DISTINCT s.lead_id) AS n FROM lead_stage_history s
                 WHERE s.to_stage = 'qualified' AND ${inMonth('s.created_at')} AND ${sc.person('s.actor_user_id', b)}`),
    one((b) => `SELECT COUNT(CASE WHEN h.status = 'pending' THEN 1 END) AS pending_now,
                       COUNT(CASE WHEN h.status = 'clarification' THEN 1 END) AS questions_now,
                       COUNT(CASE WHEN ${inMonth('h.created_at')} THEN 1 END) AS sent_month,
                       COUNT(CASE WHEN ${inMonth('h.created_at')} AND h.status = 'accepted' THEN 1 END) AS accepted_month,
                       COUNT(CASE WHEN ${inMonth('h.created_at')} AND h.status = 'rejected' THEN 1 END) AS rejected_month
                  FROM lead_handovers h WHERE ${sc.person('h.from_user_id', b)}`),
  ]);
  const sent = ho?.sent_month || 0;
  return json({
    scope: sc.scope,
    new_today: leads?.new_today || 0, calls_due: leads?.calls_due || 0, calls_overdue: leads?.calls_overdue || 0, not_called_yet: leads?.not_called_yet || 0,
    qualified_month: qualified?.n || 0,
    handovers: {
      pending_now: ho?.pending_now || 0, questions_now: ho?.questions_now || 0, sent_month: sent,
      accepted_month: ho?.accepted_month || 0, rejected_month: ho?.rejected_month || 0,
      // Only ACCEPTED handovers count as successful: accepted ÷ handed over this month.
      accepted_rate: sent ? Math.round(((ho?.accepted_month || 0) * 100) / sent) : null,
    },
  });
}
// ---- end Pre-Sales handovers & calling list ----

// ---------------------------------------------------------------------------
// Property hunting — the supply-side pipeline (owners / plots / projects we
// are trying to list). Scoping and permission checks deliberately mirror the
// lead equivalents above.
// ---------------------------------------------------------------------------

// The owner_ref_* / cover_image_id helper columns are folded into
// `owner` / `cover_image_url` by shapeHuntingTarget() — always pass rows
// from this SELECT through it before returning them.
const HUNTING_TARGET_SELECT =
  `SELECT t.*, u.name AS assigned_user_name, tm.name AS team_name,
          o.name AS owner_ref_name, o.phone AS owner_ref_phone, o.email AS owner_ref_email, o.owner_type AS owner_ref_type,
          (SELECT i.id FROM hunting_target_images i WHERE i.hunting_target_id = t.id
            ORDER BY i.sort_order, i.created_at LIMIT 1) AS cover_image_id,
          (SELECT pc.property_code FROM properties pc WHERE pc.id = COALESCE(t.converted_property_id, t.draft_property_id)) AS property_code
     FROM hunting_targets t
     LEFT JOIN users u ON u.id = t.assigned_user_id
     LEFT JOIN teams tm ON tm.id = t.team_id
     LEFT JOIN hunting_owners o ON o.id = t.owner_id`;

/** Target row → contract shape. Adds `owner` ({ id, name, phone, email,
 *  owner_type } or null) and `cover_image_url` (first site photo or null). */
function shapeHuntingTarget(row) {
  if (!row) return row;
  const { owner_ref_name, owner_ref_phone, owner_ref_email, owner_ref_type, cover_image_id, ...target } = row;
  target.owner = target.owner_id
    ? { id: target.owner_id, name: owner_ref_name, phone: owner_ref_phone, email: owner_ref_email, owner_type: owner_ref_type }
    : null;
  target.cover_image_url = cover_image_id ? `/api/hunting-images/${cover_image_id}` : null;
  return target;
}

// Free-text target fields and the most we store for each.
const HUNTING_TEXT_FIELDS = {
  owner_name: 160, owner_phone: 80, owner_email: 200, property_type: 80,
  location: 120, locality: 120, notes: 5000, source: 120, terms_notes: 5000,
};

/** The built-in super administrator is not a `users` row, so any column with
 *  a foreign key to users stores NULL for it. */
function actorUserId(actor) {
  return actor.id === 'super-admin' ? null : actor.id;
}

/** Row-level visibility as a WHERE fragment on alias `t`: '' = everything,
 *  null = no read access at all. Same precedence as handleListLeads. */
function huntingScopeClause(actor, bind) {
  if (has(actor, 'hunting.read_all')) return '';
  if (has(actor, 'hunting.read_own')) return `t.assigned_user_id = ${bind(actor.id)}`;
  if (has(actor, 'hunting.read_team') && actor.team_id) return `t.team_id = ${bind(actor.team_id)}`;
  return null;
}

/** Follow-up time → SQLite `YYYY-MM-DD HH:MM:SS` (UTC) so it compares
 *  correctly against datetime('now'). Accepts that exact form, the `T`
 *  separated form, a bare date, or a full ISO string with Z / offset. */
function normaliseHuntingFollowUp(value) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Follow-up must be a date and time.' };
  const raw = value.trim();
  if (!raw) return { value: null };
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return { error: 'Follow-up must be a date and time.' };
  if (m[5]) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: 'Follow-up must be a date and time.' };
    return { value: d.toISOString().slice(0, 19).replace('T', ' ') };
  }
  const sql = `${m[1]} ${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}`;
  if (Number.isNaN(new Date(sql.replace(' ', 'T') + 'Z').getTime())) return { error: 'Follow-up must be a date and time.' };
  return { value: sql };
}

/**
 * Validate the editable target fields present in `body`. Returns
 * { fields } holding only the keys that were supplied (already normalised),
 * or { error }. `requireName` is for create, where name is mandatory.
 */
function parseHuntingFields(body, requireName) {
  const fields = {};
  if (requireName || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { error: 'Target name is required.' };
    if (name.length > 160) return { error: 'Target name must be 160 characters or fewer.' };
    fields.name = name;
  }
  for (const [key, max] of Object.entries(HUNTING_TEXT_FIELDS)) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') return { error: `${key.replace(/_/g, ' ')} must be text.` };
    let text = (body[key] ?? '').trim();
    if (key === 'owner_email') text = text.toLowerCase();
    if (text.length > max) return { error: `${key.replace(/_/g, ' ')} must be ${max.toLocaleString('en-IN')} characters or fewer.` };
    fields[key] = text || null;
  }
  if (body.asking_price !== undefined) {
    if (body.asking_price === null || body.asking_price === '') fields.asking_price = null;
    else {
      const price = typeof body.asking_price === 'number' || typeof body.asking_price === 'string' ? parseMoney(body.asking_price) : null;
      if (price === null || !Number.isSafeInteger(price)) return { error: 'Asking price must be a whole number of rupees.' };
      fields.asking_price = price;
    }
  }
  if (body.next_follow_up_at !== undefined) {
    const followUp = normaliseHuntingFollowUp(body.next_follow_up_at);
    if (followUp.error) return { error: followUp.error };
    fields.next_follow_up_at = followUp.value;
  }
  // Commission & terms (migration 0022).
  if (body.commission_percent !== undefined) {
    if (body.commission_percent === null || body.commission_percent === '') fields.commission_percent = null;
    else {
      const pct = typeof body.commission_percent === 'number' ? body.commission_percent
        : typeof body.commission_percent === 'string' ? Number(body.commission_percent.trim().replace(/%$/, '')) : NaN;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: 'Commission must be a percentage between 0 and 100.' };
      fields.commission_percent = Math.round(pct * 100) / 100;
    }
  }
  if (body.exclusive !== undefined) {
    if (![true, false, 0, 1].includes(body.exclusive)) return { error: 'Exclusive must be true or false.' };
    fields.exclusive = body.exclusive ? 1 : 0;
  }
  if (body.listing_valid_until !== undefined) {
    if (body.listing_valid_until === null || body.listing_valid_until === '') fields.listing_valid_until = null;
    else {
      const d = typeof body.listing_valid_until === 'string' ? body.listing_valid_until.trim() : '';
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z') : null;
      // Round-trip rejects impossible dates such as 2026-02-31.
      const ok = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
      if (!ok) return { error: 'Listing valid until must be a date (YYYY-MM-DD).' };
      fields.listing_valid_until = d;
    }
  }
  return { fields };
}

/** Check a requested assignee. Returns { user } or a ready-made error Response. */
async function resolveHuntingAssignee(env, actor, userId) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(userId).first();
  if (!user?.is_active || user.role === 'viewer') return { response: fail('Choose an active employee who can work this target.', 422) };
  // Same team boundary a manager has when creating a lead for someone else:
  // anyone short of full update rights hands targets only within their team.
  if (!has(actor, 'hunting.update_all') && user.id !== actor.id && user.team_id !== actor.team_id) {
    return { response: fail('Managers can choose an employee from their own team only.', 403) };
  }
  return { user };
}

async function loadHuntingTarget(env, id) {
  return shapeHuntingTarget(await env.DB.prepare(`${HUNTING_TARGET_SELECT} WHERE t.id = ?1`).bind(id).first());
}

/** `owner_id` from a create/PATCH body: undefined = not supplied, null =
 *  unlink, otherwise it must name an existing owner. Returns { value } or { error }. */
async function resolveHuntingOwnerId(env, body) {
  if (body.owner_id === undefined) return { value: undefined };
  if (body.owner_id === null || body.owner_id === '') return { value: null };
  if (typeof body.owner_id !== 'string') return { error: 'Owner must be an owner id.' };
  const owner = await env.DB.prepare('SELECT id FROM hunting_owners WHERE id = ?1').bind(body.owner_id.trim()).first();
  if (!owner) return { error: 'That owner no longer exists.' };
  return { value: owner.id };
}

async function handleListHuntingTargets(request, env, actor) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 200));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

  const binds = [];
  const bind = value => { binds.push(value); return `?${binds.length}`; };
  const scope = huntingScopeClause(actor, bind);
  if (scope === null) return fail('You do not have permission to view hunting properties.', 403);
  const filters = scope ? [scope] : [];

  for (const key of ['stage', 'assigned_user_id']) {
    const value = url.searchParams.get(key)?.trim();
    if (value) filters.push(`t.${key} = ${bind(value)}`);
  }
  if (url.searchParams.get('open') === '1') {
    filters.push(`t.stage NOT IN (${HUNTING_CLOSED_STAGES.map(s => `'${s}'`).join(',')})`);
  }
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    const p = bind(`%${q.toLowerCase()}%`);
    // Also matches the linked owner record's name / phone (alias o).
    filters.push(`(${['t.name', 't.owner_name', 't.owner_phone', 't.locality', 't.location', 'o.name', 'o.phone']
      .map(col => `lower(COALESCE(${col}, '')) LIKE ${p}`).join(' OR ')}${(() => { const c = recordCodeQuery(q, 'P'); return c ? ` OR EXISTS (SELECT 1 FROM properties pc WHERE pc.id IN (t.converted_property_id, t.draft_property_id) AND pc.property_code = ${bind(c)})` : ''; })()})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const [list, total] = await Promise.all([
    env.DB.prepare(`${HUNTING_TARGET_SELECT} ${where} ORDER BY t.updated_at DESC, t.created_at DESC, t.id LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`)
      .bind(...binds, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM hunting_targets t LEFT JOIN hunting_owners o ON o.id = t.owner_id ${where}`).bind(...binds).first('n'),
  ]);
  return json({ targets: (list.results ?? []).map(shapeHuntingTarget), total: total ?? 0 });
}

async function handleHuntingSummary(env, actor) {
  const binds = [];
  const bind = value => { binds.push(value); return `?${binds.length}`; };
  const scope = huntingScopeClause(actor, bind);
  if (scope === null) return fail('You do not have permission to view hunting properties.', 403);
  const where = scope ? `WHERE ${scope}` : '';
  const closed = HUNTING_CLOSED_STAGES.map(s => `'${s}'`).join(',');

  const [totals, stages] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN t.stage NOT IN (${closed}) THEN 1 ELSE 0 END), 0) AS open,
              COALESCE(SUM(CASE WHEN t.stage NOT IN (${closed})
                                 AND t.next_follow_up_at IS NOT NULL
                                 AND t.next_follow_up_at <= datetime('now') THEN 1 ELSE 0 END), 0) AS follow_ups_due
         FROM hunting_targets t ${where}`
    ).bind(...binds).first(),
    // Group by the column expression itself (t.stage), not an output alias.
    env.DB.prepare(`SELECT t.stage AS stage, COUNT(*) AS n FROM hunting_targets t ${where} GROUP BY t.stage`).bind(...binds).all(),
  ]);
  const byStage = Object.fromEntries(HUNTING_STAGES.map(s => [s, 0]));
  for (const row of stages.results ?? []) if (row.stage in byStage) byStage[row.stage] = row.n;
  return json({ total: totals?.total ?? 0, open: totals?.open ?? 0, by_stage: byStage, follow_ups_due: totals?.follow_ups_due ?? 0 });
}

async function handleCreateHuntingTarget(request, env, actor) {
  if (!has(actor, 'hunting.create')) return fail('You do not have permission to add hunting targets.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const parsed = parseHuntingFields(body, true);
  if (parsed.error) return fail(parsed.error, 422);
  const f = parsed.fields;

  const requestedAssignee = typeof body.assigned_user_id === 'string' ? body.assigned_user_id.trim() : '';
  let assignee = null;
  if (requestedAssignee && requestedAssignee !== actor.id) {
    if (!has(actor, 'hunting.assign')) return fail('You do not have permission to assign targets to someone else.', 403);
    const resolved = await resolveHuntingAssignee(env, actor, requestedAssignee);
    if (resolved.response) return resolved.response;
    assignee = resolved.user;
  } else if (actor.id !== 'super-admin') {
    // Omitted (or yourself): the person entering the target works it.
    assignee = actor;
  }

  const ownerRef = await resolveHuntingOwnerId(env, body);
  if (ownerRef.error) return fail(ownerRef.error, 422);

  const id = `ht_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hunting_targets (
        id,name,owner_name,owner_phone,owner_email,property_type,location,locality,asking_price,notes,source,
        stage,next_follow_up_at,assigned_user_id,team_id,created_by_user_id,
        owner_id,commission_percent,exclusive,listing_valid_until,terms_notes
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'identified',?12,?13,?14,?15,?16,?17,?18,?19,?20)`).bind(
      id, f.name, f.owner_name ?? null, f.owner_phone ?? null, f.owner_email ?? null, f.property_type ?? null,
      f.location ?? null, f.locality ?? null, f.asking_price ?? null, f.notes ?? null, f.source ?? null,
      f.next_follow_up_at ?? null, assignee?.id ?? null, assignee?.team_id ?? null, actorUserId(actor),
      ownerRef.value ?? null, f.commission_percent ?? null, f.exclusive ?? 0, f.listing_valid_until ?? null, f.terms_notes ?? null
    ),
    env.DB.prepare(`INSERT INTO hunting_target_stage_history (hunting_target_id,from_stage,to_stage,actor_user_id,note) VALUES (?1,NULL,'identified',?2,NULL)`)
      .bind(id, actor.id),
  ]);
  return json({ target: await loadHuntingTarget(env, id) }, 201);
}

async function handleGetHuntingTarget(env, id, actor) {
  const target = await loadHuntingTarget(env, id);
  if (!target) return fail('Hunting property not found.', 404);
  if (!canReadHuntingTarget(actor, target)) return fail('You do not have permission to view this hunting target.', 403);
  // The built-in super admin has no users row, so name it explicitly.
  const actorName = (alias) => `COALESCE(u.name, CASE WHEN ${alias}.actor_user_id = 'super-admin' THEN 'Super administrator' END)`;
  const [activities, stageHistory, siteVisits, documents, images] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.type, a.subject, a.body, a.actor_user_id, ${actorName('a')} AS actor_name, a.created_at
         FROM hunting_target_activities a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.hunting_target_id = ?1 ORDER BY a.created_at DESC, a.rowid DESC`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT s.id, s.from_stage, s.to_stage, s.note, s.actor_user_id, ${actorName('s')} AS actor_name, s.created_at
         FROM hunting_target_stage_history s LEFT JOIN users u ON u.id = s.actor_user_id
        WHERE s.hunting_target_id = ?1 ORDER BY s.id DESC`
    ).bind(id).all(),
    loadHuntingSiteVisits(env, id),
    loadHuntingDocuments(env, id),
    env.DB.prepare(
      `SELECT id, title, category, sort_order, content_type, size_bytes, created_at FROM hunting_target_images
        WHERE hunting_target_id = ?1 ORDER BY sort_order, created_at`
    ).bind(id).all(),
  ]);
  const draftProperty = target.draft_property_id
    ? await env.DB.prepare('SELECT * FROM properties WHERE id = ?1').bind(target.draft_property_id).first()
    : null;
  return json({
    target, activities: activities.results ?? [], stage_history: stageHistory.results ?? [],
    draft_property: draftProperty,
    site_visits: siteVisits, documents,
    images: (images.results ?? []).map(img => ({ ...img, url: `/api/hunting-images/${img.id}` })),
  });
}

async function handleUpdateHuntingTarget(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to update this hunting property.', 403);

  const parsed = parseHuntingFields(body, false);
  if (parsed.error) return fail(parsed.error, 422);
  const next = { ...target, ...parsed.fields };

  const stage = body.stage === undefined || body.stage === null || body.stage === '' ? target.stage : body.stage;
  if (!HUNTING_STAGES.includes(stage)) return fail('Invalid hunting stage.', 422);
  const stageChanged = stage !== target.stage;
  if (stageChanged && target.converted_property_id) return fail('This target has already been converted to a listing, so its stage can no longer change.', 409);
  if (stageChanged && stage === 'listed') return fail('Use Convert to listing', 422);
  next.stage = stage;

  if (body.assigned_user_id !== undefined) {
    const requested = typeof body.assigned_user_id === 'string' ? body.assigned_user_id.trim() || null : null;
    if (requested !== target.assigned_user_id) {
      if (!has(actor, 'hunting.assign')) return fail('You do not have permission to reassign hunting targets.', 403);
      if (!requested) return fail('Choose an active employee who can work this target.', 422);
      const resolved = await resolveHuntingAssignee(env, actor, requested);
      if (resolved.response) return resolved.response;
      next.assigned_user_id = resolved.user.id;
      next.team_id = resolved.user.team_id ?? null;
    }
  }

  const ownerRef = await resolveHuntingOwnerId(env, body);
  if (ownerRef.error) return fail(ownerRef.error, 422);
  if (ownerRef.value !== undefined) next.owner_id = ownerRef.value;

  const stageNote = typeof body.stage_note === 'string' ? body.stage_note.trim() || null : null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE hunting_targets
        SET name=?2, owner_name=?3, owner_phone=?4, owner_email=?5, property_type=?6, location=?7, locality=?8,
            asking_price=?9, notes=?10, source=?11, stage=?12, next_follow_up_at=?13, assigned_user_id=?14, team_id=?15,
            owner_id=?16, commission_percent=?17, exclusive=?18, listing_valid_until=?19, terms_notes=?20,
            updated_at=datetime('now')
      WHERE id=?1`).bind(
      id, next.name, next.owner_name, next.owner_phone, next.owner_email, next.property_type, next.location, next.locality,
      next.asking_price, next.notes, next.source, next.stage, next.next_follow_up_at, next.assigned_user_id, next.team_id,
      next.owner_id ?? null, next.commission_percent ?? null, next.exclusive ?? 0, next.listing_valid_until ?? null, next.terms_notes ?? null
    ),
    ...(stageChanged ? [env.DB.prepare('INSERT INTO hunting_target_stage_history (hunting_target_id,from_stage,to_stage,actor_user_id,note) VALUES (?1,?2,?3,?4,?5)')
      .bind(id, target.stage, stage, actor.id, stageNote)] : []),
  ]);
  return json({ target: await loadHuntingTarget(env, id) });
}

async function handleCreateHuntingActivity(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body?.subject?.trim?.() || !['note', 'call', 'meeting', 'task', 'email'].includes(body.type)) return fail('Activity type and subject are required.', 422);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to add activity.', 403);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO hunting_target_activities (id,hunting_target_id,actor_user_id,type,subject,body) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(crypto.randomUUID(), id, actor.id, body.type, body.subject.trim(), typeof body.body === 'string' ? body.body.trim() || null : null),
    env.DB.prepare(`UPDATE hunting_targets SET updated_at = datetime('now') WHERE id = ?1`).bind(id),
  ]);
  return json({ ok: true }, 201);
}

async function handleConvertHuntingTarget(request, env, id, actor) {
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  // Publishing is the hunting team's job, so update rights on the target are
  // what's needed here — not client-side catalogue permissions.
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to update this hunting property.', 403);
  if (target.converted_property_id) return fail('This target has already been converted to a listing.', 409);
  if (target.stage === 'dropped') return fail('A dropped target cannot be converted. Move it back to an open stage first.', 409);

  const body = await bodyJson(request); // optional { note }
  const note = typeof body?.note === 'string' ? body.note.trim() || null : null;
  // With full details recorded, converting publishes that draft as-is;
  // otherwise a basic catalogue entry is built from the target's summary.
  const draft = target.draft_property_id
    ? await env.DB.prepare("SELECT id, developer, location FROM properties WHERE id = ?1 AND pipeline = 'hunting'").bind(target.draft_property_id).first()
    : null;
  const propertyId = draft ? draft.id : crypto.randomUUID();
  const builderId = draft ? await resolveBuilder(env, draft.developer, draft.location) : null;
  // Every statement is guarded on the target still being unconverted, so two
  // simultaneous clicks can never create two catalogue entries.
  await env.DB.batch([
    draft
      ? env.DB.prepare(
        `UPDATE properties SET pipeline = 'catalog', builder_id = ?3, inventory_status = 'pending_verification', updated_at = datetime('now')
          WHERE id = ?1 AND pipeline = 'hunting'
            AND EXISTS (SELECT 1 FROM hunting_targets WHERE id = ?2 AND converted_property_id IS NULL AND stage != 'dropped')`
      ).bind(propertyId, id, builderId)
      : env.DB.prepare(
        `INSERT INTO properties (id, name, property_type, location, locality, price_expected, description, created_by_user_id, inventory_status)
         SELECT ?1, name, property_type, location, locality, asking_price, notes, ?3, 'pending_verification'
           FROM hunting_targets WHERE id = ?2 AND converted_property_id IS NULL AND stage != 'dropped'`
      ).bind(propertyId, id, actorUserId(actor)),
    env.DB.prepare(
      `INSERT INTO hunting_target_stage_history (hunting_target_id, from_stage, to_stage, actor_user_id, note)
       SELECT id, stage, 'listed', ?3, ?4 FROM hunting_targets
        WHERE id = ?1 AND converted_property_id IS NULL AND stage != 'dropped'
          AND EXISTS (SELECT 1 FROM properties WHERE id = ?2)`
    ).bind(id, propertyId, actor.id, note),
    env.DB.prepare(
      `UPDATE hunting_targets SET converted_property_id = ?2, stage = 'listed', updated_at = datetime('now')
        WHERE id = ?1 AND converted_property_id IS NULL AND stage != 'dropped'
          AND EXISTS (SELECT 1 FROM properties WHERE id = ?2)`
    ).bind(id, propertyId),
  ]);
  const updated = await loadHuntingTarget(env, id);
  if (updated?.converted_property_id !== propertyId) return fail('This target has already been converted to a listing.', 409);
  // Only the request that actually converted reaches this point, so photos
  // are copied exactly once.
  const photosCopied = await copyHuntingImagesToProperty(env, id, propertyId);
  const property = await env.DB.prepare('SELECT id, name FROM properties WHERE id = ?1').bind(propertyId).first();
  await raiseAlert(env, { importance: 'normal', to: { roles: ['inventory_approver', 'admin'] }, title: `New listing waiting for a team: ${property?.name || 'property'}`, body: 'Converted by the property hunting team. Assign it to a client team to make it active.', link: { kind: 'property', id: propertyId } }); // inventory status (0066)
  return json({ target: updated, property, photos_copied: photosCopied });
}

// ---- Property hunting, wave 2: owners, terms, site visits, documents, photos (Agent HUNT) ----
//
// These lists are the ONE definition of each vocabulary. The UI does not keep
// its own copy: it reads them from GET /api/hunting-meta.

const HUNTING_OWNER_TYPES = ['individual', 'builder', 'broker', 'other'];

// Site-visit checklist items. `type` drives both validation here and the
// form the UI renders (boolean → checkbox, choice → select, text → input).
const HUNTING_SITE_VISIT_CHECKLIST = [
  { key: 'access_road', label: 'Good access road', type: 'boolean' },
  { key: 'water_supply', label: 'Water supply', type: 'boolean' },
  { key: 'power_supply', label: 'Power supply', type: 'boolean' },
  { key: 'parking', label: 'Parking', type: 'boolean' },
  { key: 'lift', label: 'Lift', type: 'boolean' },
  { key: 'condition', label: 'Condition', type: 'choice', options: ['good', 'average', 'poor'] },
  { key: 'legal_docs_seen', label: 'Saw the legal documents', type: 'boolean' },
  { key: 'neighbourhood_price_note', label: 'Neighbourhood prices', type: 'text', max: 1000 },
  { key: 'issues_found', label: 'Issues found', type: 'text', max: 2000 },
];
// Logging a visit moves a target in one of these stages on to 'site_visited'.
const HUNTING_SITE_VISIT_ADVANCE_FROM = ['identified', 'owner_contacted', 'site_visit_scheduled'];

const HUNTING_DOC_TYPES = [
  { key: 'title_deed', label: 'Title deed' },
  { key: 'rera', label: 'RERA registration' },
  { key: 'noc', label: 'NOC' },
  { key: 'encumbrance', label: 'Encumbrance certificate' },
  { key: 'tax_receipts', label: 'Property tax receipts' },
  { key: 'approved_plan', label: 'Approved building plan' },
  { key: 'other', label: 'Other' },
];
const HUNTING_DOC_STATUSES = [
  { key: 'pending', label: 'Pending' },
  { key: 'received', label: 'Received' },
  { key: 'verified', label: 'Verified' },
  { key: 'not_applicable', label: 'Not applicable' },
];
// The convert confirmation warns when any of these is not verified / N/A.
const HUNTING_CRITICAL_DOCS = ['title_deed', 'rera', 'encumbrance'];

/** Owners are shared contacts: anyone who can read ANY hunting targets can
 *  read the whole contact book. (Targets under an owner are still scoped.) */
function hasAnyHuntingRead(actor) {
  return has(actor, 'hunting.read_all') || has(actor, 'hunting.read_team') || has(actor, 'hunting.read_own');
}

async function handleHuntingMeta(actor) {
  if (!hasAnyHuntingRead(actor)) return fail('You do not have permission to view property hunting.', 403);
  return json({
    stages: HUNTING_STAGES,
    owner_types: HUNTING_OWNER_TYPES,
    site_visit_checklist: HUNTING_SITE_VISIT_CHECKLIST,
    site_visit_advance_from: HUNTING_SITE_VISIT_ADVANCE_FROM,
    document_types: HUNTING_DOC_TYPES,
    document_statuses: HUNTING_DOC_STATUSES,
    critical_documents: HUNTING_CRITICAL_DOCS,
  });
}

// ---- Owner contact book ----

/** Duplicate-detection key for a phone number: its last 10 digits (so
 *  "+91 98765-43210" and "9876543210" match). '' when too short to trust. */
function huntingPhoneKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(-10) : '';
}
/** SQL equivalent of huntingPhoneKey() for a column (strips the usual
 *  separators; SQLite has no regex replace). */
const huntingPhoneKeySql = (col) =>
  `substr(replace(replace(replace(replace(replace(replace(COALESCE(${col}, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), -10)`;

const HUNTING_OWNER_TEXT_FIELDS = { phone: 80, alt_phone: 80, email: 200, locality: 120, notes: 5000 };

function parseHuntingOwnerFields(body, requireName) {
  const fields = {};
  if (requireName || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { error: 'Owner name is required.' };
    if (name.length > 160) return { error: 'Owner name must be 160 characters or fewer.' };
    fields.name = name;
  }
  for (const [key, max] of Object.entries(HUNTING_OWNER_TEXT_FIELDS)) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') return { error: `${key.replace(/_/g, ' ')} must be text.` };
    let text = (body[key] ?? '').trim();
    if (key === 'email') text = text.toLowerCase();
    if (text.length > max) return { error: `${key.replace(/_/g, ' ')} must be ${max.toLocaleString('en-IN')} characters or fewer.` };
    fields[key] = text || null;
  }
  if (body.owner_type !== undefined) {
    const type = body.owner_type === null || body.owner_type === '' ? 'individual' : body.owner_type;
    if (!HUNTING_OWNER_TYPES.includes(type)) return { error: 'Owner type must be individual, builder, broker or other.' };
    fields.owner_type = type;
  }
  return { fields };
}

/**
 * Owners (with target_count / open_target_count) matching `build(bind)`'s
 * WHERE fragment. The counts only include targets the actor may read, so they
 * always agree with the targets list on the owner's detail view.
 */
async function selectHuntingOwners(env, actor, build, limit = 200) {
  const binds = [];
  const bind = value => { binds.push(value); return `?${binds.length}`; };
  const scope = huntingScopeClause(actor, bind);
  const joinScope = scope === null ? ' AND 0' : scope ? ` AND ${scope}` : '';
  const where = build(bind);
  const closed = HUNTING_CLOSED_STAGES.map(s => `'${s}'`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT o.*, COUNT(t.id) AS target_count,
            COALESCE(SUM(CASE WHEN t.stage NOT IN (${closed}) THEN 1 ELSE 0 END), 0) AS open_target_count
       FROM hunting_owners o
       LEFT JOIN hunting_targets t ON t.owner_id = o.id${joinScope}
      ${where ? `WHERE ${where}` : ''}
      GROUP BY o.id
      ORDER BY o.updated_at DESC, o.name
      LIMIT ${bind(limit)}`
  ).bind(...binds).all();
  return results ?? [];
}

/** First owner (other than `excludeId`) whose phone or alt phone matches any of `phones`. */
async function findHuntingOwnerByPhone(env, actor, phones, excludeId = null) {
  const keys = [...new Set(phones.map(huntingPhoneKey).filter(Boolean))];
  if (!keys.length) return null;
  const [owner] = await selectHuntingOwners(env, actor, (bind) => {
    const list = keys.map(bind).join(',');
    return `(${huntingPhoneKeySql('o.phone')} IN (${list}) OR ${huntingPhoneKeySql('o.alt_phone')} IN (${list}))` +
      (excludeId ? ` AND o.id <> ${bind(excludeId)}` : '');
  }, 1);
  return owner ?? null;
}

async function handleListHuntingOwners(request, env, actor) {
  if (!hasAnyHuntingRead(actor)) return fail('You do not have permission to view owners.', 403);
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 200));
  const q = url.searchParams.get('q')?.trim();
  // ?phone= is an exact duplicate lookup (last-10-digit match on phone or alt phone).
  if (url.searchParams.has('phone')) {
    const key = huntingPhoneKey(url.searchParams.get('phone'));
    if (!key) return json({ owners: [] });
    const owners = await selectHuntingOwners(env, actor, (bind) => {
      const k = bind(key);
      return `(${huntingPhoneKeySql('o.phone')} = ${k} OR ${huntingPhoneKeySql('o.alt_phone')} = ${k})`;
    }, limit);
    return json({ owners });
  }
  const owners = await selectHuntingOwners(env, actor, (bind) => {
    if (!q) return '';
    const p = bind(`%${q.toLowerCase()}%`);
    const parts = ['o.name', 'o.phone', 'o.alt_phone', 'o.email', 'o.locality'].map(col => `lower(COALESCE(${col}, '')) LIKE ${p}`);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) {
      const d = bind(`%${digits}%`);
      parts.push(`${huntingPhoneKeySql('o.phone')} LIKE ${d}`, `${huntingPhoneKeySql('o.alt_phone')} LIKE ${d}`);
    }
    return `(${parts.join(' OR ')})`;
  }, limit);
  return json({ owners });
}

async function loadHuntingOwner(env, actor, id) {
  const [owner] = await selectHuntingOwners(env, actor, (bind) => `o.id = ${bind(id)}`, 1);
  return owner ?? null;
}

async function handleCreateHuntingOwner(request, env, actor) {
  if (!has(actor, 'hunting.create')) return fail('You do not have permission to add owners.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const parsed = parseHuntingOwnerFields(body, true);
  if (parsed.error) return fail(parsed.error, 422);
  const f = parsed.fields;
  // Offer the existing contact instead of silently creating a duplicate.
  // The UI re-sends with force:true if the user really wants a second record.
  if (body.force !== true) {
    const dup = await findHuntingOwnerByPhone(env, actor, [f.phone, f.alt_phone]);
    if (dup) return fail(`${dup.name} already has this phone number.`, 409, { duplicate_of: dup });
  }
  const id = `ho_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO hunting_owners (id,name,phone,alt_phone,email,owner_type,locality,notes,created_by_user_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`).bind(
    id, f.name, f.phone ?? null, f.alt_phone ?? null, f.email ?? null, f.owner_type ?? 'individual',
    f.locality ?? null, f.notes ?? null, actorUserId(actor)
  ).run();
  return json({ owner: await loadHuntingOwner(env, actor, id) }, 201);
}

async function handleGetHuntingOwner(env, id, actor) {
  if (!hasAnyHuntingRead(actor)) return fail('You do not have permission to view owners.', 403);
  const owner = await loadHuntingOwner(env, actor, id);
  if (!owner) return fail('Owner not found.', 404);
  // Only the targets this actor could open anyway.
  const binds = [id];
  const bind = value => { binds.push(value); return `?${binds.length}`; };
  const scope = huntingScopeClause(actor, bind);
  let targets = [];
  if (scope !== null) {
    const { results } = await env.DB.prepare(
      `${HUNTING_TARGET_SELECT} WHERE t.owner_id = ?1 ${scope ? `AND ${scope}` : ''} ORDER BY t.updated_at DESC, t.id`
    ).bind(...binds).all();
    targets = (results ?? []).map(shapeHuntingTarget);
  }
  return json({ owner, targets });
}

async function handleUpdateHuntingOwner(request, env, id, actor) {
  if (!has(actor, 'hunting.create')) return fail('You do not have permission to edit owners.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const owner = await env.DB.prepare('SELECT * FROM hunting_owners WHERE id = ?1').bind(id).first();
  if (!owner) return fail('Owner not found.', 404);
  const parsed = parseHuntingOwnerFields(body, false);
  if (parsed.error) return fail(parsed.error, 422);
  const next = { ...owner, ...parsed.fields };
  // Only numbers that are new on this owner are checked, so a duplicate the
  // user already accepted (force) never blocks unrelated edits later.
  const oldKeys = new Set([huntingPhoneKey(owner.phone), huntingPhoneKey(owner.alt_phone)]);
  const newPhones = [next.phone, next.alt_phone].filter(p => huntingPhoneKey(p) && !oldKeys.has(huntingPhoneKey(p)));
  if (newPhones.length && body.force !== true) {
    const dup = await findHuntingOwnerByPhone(env, actor, newPhones, id);
    if (dup) return fail(`${dup.name} already has this phone number.`, 409, { duplicate_of: dup });
  }
  await env.DB.prepare(`UPDATE hunting_owners SET name=?2, phone=?3, alt_phone=?4, email=?5, owner_type=?6, locality=?7, notes=?8,
      updated_at=datetime('now') WHERE id=?1`).bind(
    id, next.name, next.phone, next.alt_phone, next.email, next.owner_type, next.locality, next.notes
  ).run();
  return json({ owner: await loadHuntingOwner(env, actor, id) });
}

// ---- Site-visit checklist ----

/** Normalise a checklist: every known key present (booleans default false,
 *  choice/text default null); unknown keys are rejected. */
function parseSiteVisitChecklist(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Checklist must be an object.' };
  const known = new Set(HUNTING_SITE_VISIT_CHECKLIST.map(item => item.key));
  const unknown = Object.keys(input).find(key => !known.has(key));
  if (unknown) return { error: `Unknown checklist item: ${unknown}.` };
  const checklist = {};
  for (const item of HUNTING_SITE_VISIT_CHECKLIST) {
    const v = input[item.key];
    if (item.type === 'boolean') {
      if (v !== undefined && v !== null && ![true, false, 0, 1].includes(v)) return { error: `${item.label} must be yes or no.` };
      checklist[item.key] = Boolean(v);
    } else if (item.type === 'choice') {
      if (v === undefined || v === null || v === '') checklist[item.key] = null;
      else if (!item.options.includes(v)) return { error: `${item.label} must be one of: ${item.options.join(', ')}.` };
      else checklist[item.key] = v;
    } else {
      if (v !== undefined && v !== null && typeof v !== 'string') return { error: `${item.label} must be text.` };
      const text = (v ?? '').trim();
      if (text.length > item.max) return { error: `${item.label} must be ${item.max.toLocaleString('en-IN')} characters or fewer.` };
      checklist[item.key] = text || null;
    }
  }
  return { checklist };
}

async function loadHuntingSiteVisits(env, targetId) {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.hunting_target_id, v.visited_by_user_id,
            COALESCE(u.name, CASE WHEN v.visited_by_user_id = 'super-admin' THEN 'Super administrator' END) AS visited_by_name,
            v.visited_at, v.checklist, v.rating, v.summary, v.created_at
       FROM hunting_site_visits v LEFT JOIN users u ON u.id = v.visited_by_user_id
      WHERE v.hunting_target_id = ?1 ORDER BY v.visited_at DESC, v.created_at DESC, v.rowid DESC`
  ).bind(targetId).all();
  return (results ?? []).map(v => {
    let checklist = {};
    try { checklist = JSON.parse(v.checklist || '{}'); } catch { /* keep {} */ }
    return { ...v, checklist };
  });
}

async function handleCreateHuntingSiteVisit(request, env, id, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to update this hunting property.', 403);

  const parsed = parseSiteVisitChecklist(body.checklist);
  if (parsed.error) return fail(parsed.error, 422);
  let rating = null;
  if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
    rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail('Rating must be a whole number from 1 to 5.', 422);
  }
  if (body.summary !== undefined && body.summary !== null && typeof body.summary !== 'string') return fail('Summary must be text.', 422);
  const summary = (body.summary ?? '').trim() || null;
  if (summary && summary.length > 2000) return fail('Summary must be 2,000 characters or fewer.', 422);
  let visitedAt = null;
  if (body.visited_at !== undefined && body.visited_at !== null && body.visited_at !== '') {
    const v = normaliseHuntingFollowUp(body.visited_at);
    if (v.error) return fail('Visit time must be a date and time.', 422);
    // A visit is logged after it happens; allow an hour of clock skew.
    if (v.value && new Date(v.value.replace(' ', 'T') + 'Z').getTime() > Date.now() + 60 * 60 * 1000) {
      return fail('A site visit cannot be logged in the future.', 422);
    }
    visitedAt = v.value;
  }

  const visitId = `hv_${crypto.randomUUID()}`;
  const advanceFrom = HUNTING_SITE_VISIT_ADVANCE_FROM.map(s => `'${s}'`).join(',');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hunting_site_visits (id,hunting_target_id,visited_by_user_id,visited_at,checklist,rating,summary)
      VALUES (?1,?2,?3,COALESCE(?4, datetime('now')),?5,?6,?7)`)
      .bind(visitId, id, actor.id, visitedAt, JSON.stringify(parsed.checklist), rating, summary),
    // History row first: it reads the stage BEFORE the update below moves it.
    env.DB.prepare(`INSERT INTO hunting_target_stage_history (hunting_target_id,from_stage,to_stage,actor_user_id,note)
      SELECT id, stage, 'site_visited', ?2, 'Site visit logged' FROM hunting_targets
       WHERE id = ?1 AND converted_property_id IS NULL AND stage IN (${advanceFrom})`).bind(id, actor.id),
    env.DB.prepare(`UPDATE hunting_targets
        SET stage = CASE WHEN converted_property_id IS NULL AND stage IN (${advanceFrom}) THEN 'site_visited' ELSE stage END,
            updated_at = datetime('now')
      WHERE id = ?1`).bind(id),
  ]);
  const [visits, updated] = await Promise.all([loadHuntingSiteVisits(env, id), loadHuntingTarget(env, id)]);
  return json({
    site_visit: visits.find(v => v.id === visitId) ?? null,
    target: updated,
    stage_advanced: updated.stage !== target.stage,
  }, 201);
}

// ---- Document tracker ----

/** Every doc type, in HUNTING_DOC_TYPES order; missing rows read as 'pending'. */
async function loadHuntingDocuments(env, targetId) {
  const { results } = await env.DB.prepare(
    `SELECT d.doc_type, d.status, d.note, d.updated_by_user_id,
            COALESCE(u.name, CASE WHEN d.updated_by_user_id = 'super-admin' THEN 'Super administrator' END) AS updated_by_name,
            d.updated_at
       FROM hunting_documents d LEFT JOIN users u ON u.id = d.updated_by_user_id
      WHERE d.hunting_target_id = ?1`
  ).bind(targetId).all();
  const byType = new Map((results ?? []).map(row => [row.doc_type, row]));
  return HUNTING_DOC_TYPES.map(({ key, label }) => {
    const row = byType.get(key);
    return {
      doc_type: key, label, status: row?.status ?? 'pending', note: row?.note ?? null,
      updated_by_user_id: row?.updated_by_user_id ?? null, updated_by_name: row?.updated_by_name ?? null, updated_at: row?.updated_at ?? null,
    };
  });
}

async function handlePutHuntingDocument(request, env, id, docType, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  if (!HUNTING_DOC_TYPES.some(d => d.key === docType)) return fail('Unknown document type.', 404);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to update this hunting property.', 403);
  if (!HUNTING_DOC_STATUSES.some(s => s.key === body.status)) return fail('Status must be pending, received, verified or not_applicable.', 422);
  // note omitted = keep whatever note is already stored.
  const noteGiven = body.note !== undefined;
  if (noteGiven && body.note !== null && typeof body.note !== 'string') return fail('Note must be text.', 422);
  const note = noteGiven ? (body.note ?? '').trim() || null : null;
  if (note && note.length > 1000) return fail('Note must be 1,000 characters or fewer.', 422);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hunting_documents (hunting_target_id, doc_type, status, note, updated_by_user_id, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
      ON CONFLICT (hunting_target_id, doc_type) DO UPDATE SET
        status = excluded.status,
        note = CASE WHEN ?6 THEN excluded.note ELSE hunting_documents.note END,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at`).bind(id, docType, body.status, note, actor.id, noteGiven ? 1 : 0),
    env.DB.prepare(`UPDATE hunting_targets SET updated_at = datetime('now') WHERE id = ?1`).bind(id),
  ]);
  const documents = await loadHuntingDocuments(env, id);
  return json({ document: documents.find(d => d.doc_type === docType), documents });
}

// ---- Site photos (R2, same bucket and limits as property photos) ----

async function handleUploadHuntingImage(request, env, id, actor) {
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment (missing R2 binding).', 503);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target) return fail('Hunting property not found.', 404);
  if (!canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to add photos to this hunting target.', 403);

  let form;
  try { form = await request.formData(); } catch { return fail('Send the image as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file provided.', 422);
  if (!Object.hasOwn(IMAGE_EXTENSION, file.type)) return fail('Only JPEG, PNG, WEBP or GIF images are supported.', 422);
  if (file.size > MAX_IMAGE_BYTES) return fail(`Image must be under ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, 422);

  const titleValue = form.get('title');
  const title = typeof titleValue === 'string' && titleValue.trim() ? titleValue.trim().slice(0, 120) : null;
  const category = form.get('category') === 'building' ? 'building' : 'property';
  const imageId = crypto.randomUUID();
  const key = `hunting/${id}/${imageId}.${IMAGE_EXTENSION[file.type]}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const sortOrder = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM hunting_target_images WHERE hunting_target_id = ?1').bind(id).first('sort_order');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO hunting_target_images (id, hunting_target_id, r2_key, content_type, size_bytes, title, category, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
      .bind(imageId, id, key, file.type, file.size, title, category, sortOrder),
    env.DB.prepare(`UPDATE hunting_targets SET updated_at = datetime('now') WHERE id = ?1`).bind(id),
  ]);
  const url = `/api/hunting-images/${imageId}`;
  return json({ ok: true, image_id: imageId, url, image: { id: imageId, url, title, category, sort_order: sortOrder } }, 201);
}

async function handleDeleteHuntingImage(env, id, imageId, actor) {
  const row = await env.DB.prepare('SELECT * FROM hunting_target_images WHERE id = ?1 AND hunting_target_id = ?2').bind(imageId, id).first();
  if (!row) return fail('Image not found.', 404);
  const target = await env.DB.prepare('SELECT * FROM hunting_targets WHERE id = ?1').bind(id).first();
  if (!target || !canUpdateHuntingTarget(actor, target)) return fail('You do not have permission to remove photos from this hunting target.', 403);
  if (env.IMAGES) await env.IMAGES.delete(row.r2_key);
  await env.DB.prepare('DELETE FROM hunting_target_images WHERE id = ?1').bind(imageId).run();
  return json({ ok: true });
}

/** Public, unauthenticated on purpose, like handleServeImage: a plain
 *  <img src> request from the browser cannot attach a Bearer header. Unlike
 *  catalogue photos these are NOT marketing material yet — they are site
 *  photos of a property we have not listed — so the protection is the ID
 *  itself: a random UUID that only ever reaches a client inside an
 *  authenticated, scope-checked target response. Not enumerable, but not
 *  access-controlled either, and served `private` so shared caches/CDNs don't
 *  keep a copy. Do not upload sensitive documents (title deeds etc.) here. */
async function handleServeHuntingImage(env, imageId) {
  const row = await env.DB.prepare('SELECT * FROM hunting_target_images WHERE id = ?1').bind(imageId).first();
  if (!row) return fail('Image not found.', 404);
  if (!env.IMAGES) return fail('Image storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(row.r2_key);
  if (!object) return fail('Image not found.', 404);
  return new Response(object.body, {
    headers: { 'content-type': row.content_type, 'cache-control': 'private, max-age=86400' },
  });
}

/**
 * On convert: copy every site photo into property_images for the new
 * property. Each R2 object is duplicated under a NEW properties/… key rather
 * than shared, so deleting the photo on either side can never break the
 * other. Best effort: a photo that fails to copy is logged and skipped — the
 * conversion itself has already succeeded. Returns how many were copied.
 */
async function copyHuntingImagesToProperty(env, targetId, propertyId) {
  if (!env.IMAGES) return 0;
  const { results } = await env.DB.prepare('SELECT * FROM hunting_target_images WHERE hunting_target_id = ?1 ORDER BY sort_order, created_at').bind(targetId).all();
  const inserts = [];
  const newKeys = [];
  for (const img of results ?? []) {
    try {
      const object = await env.IMAGES.get(img.r2_key);
      if (!object) continue;
      const newId = crypto.randomUUID();
      const key = `properties/${propertyId}/${newId}.${IMAGE_EXTENSION[img.content_type] || 'jpg'}`;
      await env.IMAGES.put(key, await object.arrayBuffer(), { httpMetadata: { contentType: img.content_type } });
      newKeys.push(key);
      inserts.push(env.DB.prepare('INSERT INTO property_images (id, property_id, r2_key, content_type, size_bytes, title, category, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(newId, propertyId, key, img.content_type, img.size_bytes, img.title, img.category, inserts.length));
    } catch (e) {
      console.error('Could not copy hunting photo to property:', img.id, e);
    }
  }
  if (!inserts.length) return 0;
  try {
    await env.DB.batch(inserts);
    return inserts.length;
  } catch (e) {
    console.error('Could not record copied hunting photos:', propertyId, e);
    await Promise.all(newKeys.map(key => env.IMAGES.delete(key).catch(() => {})));
    return 0;
  }
}
// ---- end Property hunting, wave 2 ----

// ---------------------------------------------------------------------------
// ---- Background jobs: daily follow-up digest + nightly backups (Agent OPS) ----
//
// Both jobs run from the `scheduled()` export (cron in wrangler.jsonc:
// "30 2 * * *" = 02:30 UTC = 08:00 IST) and can be triggered on demand by the
// super administrator via POST /api/digest/run and POST /api/backups/run.
// runScheduledJobs() runs them independently: a failure in one is recorded
// (digests / backups table + console.error) and never stops the other.
// ---------------------------------------------------------------------------

const DIGEST_ITEM_LIMIT = 10;          // overdue items listed per person
const DIGEST_RETENTION_DAYS = 30;
const DIGEST_EMAIL_PROVIDERS = ['resend'];
const BACKUP_KEEP = 14;
const BACKUP_PREFIX = 'backups/crm-';

/** Current UTC time as SQLite's `YYYY-MM-DD HH:MM:SS`. */
function opsSqlNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Validates only the digest_* keys present in a settings PATCH; null if OK. */
function validateDigestSettings(values) {
  if ('digest_enabled' in values && !['true', 'false'].includes(values.digest_enabled.trim())) return 'Daily reminder email must be on or off.';
  if ('digest_email_provider' in values && !DIGEST_EMAIL_PROVIDERS.includes(values.digest_email_provider.trim())) return 'Choose a supported email service.';
  if ('digest_from_email' in values) {
    const from = values.digest_from_email.trim();
    // Either a bare address or "Display Name <address>", as Resend accepts.
    const addr = '[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+';
    if (from && !new RegExp(`^(?:${addr}|[^<>]{1,80}<\\s*${addr}\\s*>)$`).test(from)) return 'The "send from" address must be an email, e.g. CRM <reminders@yourdomain.com>.';
  }
  const enabling = (values.digest_enabled ?? '').trim() === 'true';
  if (enabling && 'digest_from_email' in values && !values.digest_from_email.trim()) return 'Add a "send from" address before turning reminder emails on.';
  return null;
}

function opsErrorText(e) {
  return String(e?.message || e || 'Unknown error').slice(0, 500);
}

async function readWorkspaceSettingsMap(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM workspace_settings').all();
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...Object.fromEntries((results ?? []).map(row => [row.key, row.value])) };
}

/**
 * Compute every digest for one run. "Overdue" means next_follow_up_at is at or
 * before `runAt` — client leads with an open status, and hunting targets not
 * yet listed/dropped. datetime() normalises the stored value first, so the
 * `T`-separated / `Z`-suffixed forms the UI may send compare correctly.
 */
async function computeDigests(env, runAt) {
  const OPEN = OPEN_STATUSES.map(s => `'${s}'`).join(',');
  const CLOSED = HUNTING_CLOSED_STAGES.map(s => `'${s}'`).join(',');
  const LEAD_DUE = `l.archived_at IS NULL AND l.status IN (${OPEN}) AND l.next_follow_up_at IS NOT NULL AND datetime(l.next_follow_up_at) <= datetime(?1)`;
  const HUNT_DUE = `t.stage NOT IN (${CLOSED}) AND t.next_follow_up_at IS NOT NULL AND datetime(t.next_follow_up_at) <= datetime(?1)`;

  const [usersRes, teamsRes, leadCounts, huntCounts, leadItems, huntItems] = await Promise.all([
    env.DB.prepare('SELECT id, name, email, role, team_id FROM users WHERE is_active = 1 ORDER BY name').all(),
    env.DB.prepare('SELECT id, name, manager_user_id FROM teams ORDER BY name').all(),
    env.DB.prepare(`SELECT l.assigned_user_id AS user_id, l.team_id, COUNT(*) AS n FROM leads l WHERE ${LEAD_DUE}
                     GROUP BY l.assigned_user_id, l.team_id`).bind(runAt).all(),
    env.DB.prepare(`SELECT t.assigned_user_id AS user_id, t.team_id, COUNT(*) AS n FROM hunting_targets t WHERE ${HUNT_DUE}
                     GROUP BY t.assigned_user_id, t.team_id`).bind(runAt).all(),
    env.DB.prepare(`SELECT * FROM (
        SELECT l.id, l.customer_name, l.stage, l.location, l.next_follow_up_at, l.assigned_user_id,
               ROW_NUMBER() OVER (PARTITION BY l.assigned_user_id ORDER BY datetime(l.next_follow_up_at)) AS rn
          FROM leads l WHERE l.assigned_user_id IS NOT NULL AND ${LEAD_DUE}
      ) WHERE rn <= ?2`).bind(runAt, DIGEST_ITEM_LIMIT).all(),
    env.DB.prepare(`SELECT * FROM (
        SELECT t.id, t.name, t.owner_name, t.stage, COALESCE(NULLIF(t.locality, ''), t.location) AS area,
               t.next_follow_up_at, t.assigned_user_id,
               ROW_NUMBER() OVER (PARTITION BY t.assigned_user_id ORDER BY datetime(t.next_follow_up_at)) AS rn
          FROM hunting_targets t WHERE t.assigned_user_id IS NOT NULL AND ${HUNT_DUE}
      ) WHERE rn <= ?2`).bind(runAt, DIGEST_ITEM_LIMIT).all(),
  ]);

  const users = usersRes.results ?? [];
  const teams = teamsRes.results ?? [];
  const teamName = new Map(teams.map(t => [t.id, t.name]));
  const blank = () => ({ leads: 0, hunting: 0, unassigned_leads: 0, unassigned_hunting: 0 });
  const perUser = new Map();
  const perTeam = new Map();
  const bucket = (map, key) => { if (!map.has(key)) map.set(key, blank()); return map.get(key); };
  const totals = blank();
  for (const [rows, field] of [[leadCounts.results ?? [], 'leads'], [huntCounts.results ?? [], 'hunting']]) {
    for (const r of rows) {
      const n = Number(r.n) || 0;
      totals[field] += n;
      bucket(perTeam, r.team_id || '')[field] += n;
      if (r.user_id) bucket(perUser, r.user_id)[field] += n;
      else { totals['unassigned_' + field] += n; bucket(perTeam, r.team_id || '')['unassigned_' + field] += n; }
    }
  }

  const itemsByUser = new Map();
  const items = (id) => { if (!itemsByUser.has(id)) itemsByUser.set(id, { leads: [], hunting: [] }); return itemsByUser.get(id); };
  for (const r of leadItems.results ?? []) {
    items(r.assigned_user_id).leads.push({ id: r.id, customer_name: r.customer_name, stage: r.stage, location: r.location, next_follow_up_at: r.next_follow_up_at });
  }
  for (const r of huntItems.results ?? []) {
    items(r.assigned_user_id).hunting.push({ id: r.id, name: r.name, owner_name: r.owner_name, stage: r.stage, area: r.area, next_follow_up_at: r.next_follow_up_at });
  }

  const person = (u) => {
    const c = perUser.get(u.id) || blank();
    return { user_id: u.id, name: u.name, role: u.role, team_id: u.team_id || null, team_name: teamName.get(u.team_id) || null, leads: c.leads, hunting: c.hunting };
  };
  const byLoad = (a, b) => (b.leads + b.hunting) - (a.leads + a.hunting) || String(a.name).localeCompare(String(b.name));
  const teamRow = (id) => ({ team_id: id || null, name: id ? (teamName.get(id) || id) : 'No team', ...(perTeam.get(id) || blank()) });

  const company = {
    kind: 'company',
    run_at: runAt,
    totals,
    teams: [...new Set([...teams.map(t => t.id), ...perTeam.keys()])].map(teamRow)
      .filter(t => t.team_id || t.leads || t.hunting),
    people: users.map(person).sort(byLoad),
  };

  const delayedFor = await delayedTasksForDigest(env).catch(() => null); // delayed To Do tasks (content only)
  const digests = users.map((u) => {
    const own = perUser.get(u.id) || blank();
    const mine = itemsByUser.get(u.id) || { leads: [], hunting: [] };
    const payload = {
      kind: 'user',
      run_at: runAt,
      user: { id: u.id, name: u.name, role: u.role },
      leads: { count: own.leads, items: mine.leads },
      hunting: { count: own.hunting, items: mine.hunting },
    };
    if (delayedFor) payload.delayed_tasks = delayedFor(u); // { own, team, count } of delayed To Do tasks
    if (u.role === 'admin' || u.role === 'super_admin' || u.role === 'sales_head') {
      payload.company_rollup = { totals: company.totals, teams: company.teams, people: company.people };
    } else if (TEAM_HEAD_ROLES.includes(u.role)) {
      // A manager's team = their own team plus any team that names them as manager.
      const scope = new Set(teams.filter(t => t.manager_user_id === u.id).map(t => t.id));
      if (u.team_id) scope.add(u.team_id);
      const teamRows = [...scope].map(teamRow);
      payload.team_rollup = {
        totals: teamRows.reduce((acc, t) => {
          for (const k of Object.keys(acc)) acc[k] += t[k];
          return acc;
        }, blank()),
        teams: teamRows,
        people: users.filter(p => p.team_id && scope.has(p.team_id)).map(person).sort(byLoad),
      };
    }
    return { user: u, payload };
  });

  return { company, digests };
}

function digestHasContent(payload) {
  const roll = payload.company_rollup || payload.team_rollup;
  return payload.leads.count > 0 || payload.hunting.count > 0 || (payload.delayed_tasks?.count ?? 0) > 0 ||
    !!(roll && (roll.totals.leads > 0 || roll.totals.hunting > 0));
}

/** Plain-text email body for one person's digest. */
function digestEmailContent(payload, settings) {
  const lines = [`Good morning ${payload.user.name},`, ''];
  lines.push(`Overdue client follow-ups: ${payload.leads.count}`);
  for (const l of payload.leads.items) lines.push(`  - ${l.customer_name || 'Unnamed lead'} (${l.stage}${l.location ? ', ' + l.location : ''}) — due ${l.next_follow_up_at} UTC`);
  if (payload.leads.count > payload.leads.items.length) lines.push(`  …and ${payload.leads.count - payload.leads.items.length} more`);
  lines.push('', `Overdue property-hunting follow-ups: ${payload.hunting.count}`);
  for (const t of payload.hunting.items) lines.push(`  - ${t.name}${t.owner_name ? ' / ' + t.owner_name : ''} (${t.stage}${t.area ? ', ' + t.area : ''}) — due ${t.next_follow_up_at} UTC`);
  if (payload.hunting.count > payload.hunting.items.length) lines.push(`  …and ${payload.hunting.count - payload.hunting.items.length} more`);
  const dt = payload.delayed_tasks;
  if (dt?.own.count) {
    lines.push('', `Your delayed tasks: ${dt.own.count}`);
    for (const t of dt.own.items) lines.push(`  - ${t.title} — ${t.days_late} day${t.days_late === 1 ? '' : 's'} late`);
  }
  if (dt?.team.count) {
    lines.push('', `Delayed tasks in your team: ${dt.team.count}`);
    for (const t of dt.team.items) lines.push(`  - ${t.who}: ${t.title} — ${t.days_late} day${t.days_late === 1 ? '' : 's'} late`);
    if (dt.team.count > dt.team.items.length) lines.push(`  …and ${dt.team.count - dt.team.items.length} more`);
  }
  const roll = payload.company_rollup || payload.team_rollup;
  if (roll) {
    lines.push('', payload.company_rollup ? 'Company overview:' : 'Your team:');
    lines.push(`  ${roll.totals.leads} client follow-ups and ${roll.totals.hunting} hunting follow-ups overdue` +
      (roll.totals.unassigned_leads ? ` (${roll.totals.unassigned_leads} leads unassigned)` : ''));
    for (const p of roll.people.filter(p => p.leads || p.hunting)) lines.push(`  - ${p.name}: ${p.leads} leads, ${p.hunting} hunting`);
  }
  lines.push('', `— ${settings.workspace_name || 'CRM'}`);
  const subject = `${payload.leads.count + payload.hunting.count} overdue follow-up${payload.leads.count + payload.hunting.count === 1 ? '' : 's'} today — ${settings.workspace_name || 'CRM'}`;
  return { subject, text: lines.join('\n') };
}

/**
 * Builds (but does not send) the Resend API request. Kept separate from the
 * fetch so it can be unit-checked without sending anything. The API key only
 * ever travels in this Authorization header — it is never logged, stored in
 * D1, or returned by any endpoint.
 */
function buildResendEmailRequest({ apiKey, from, to, subject, text }) {
  return new Request('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
}

/** Returns { delivered_via, delivery_error } for one person's digest. */
async function deliverDigest(env, settings, user, payload) {
  if (settings.digest_enabled !== 'true') return { delivered_via: 'none', delivery_error: null };
  if (!digestHasContent(payload)) return { delivered_via: 'none', delivery_error: null };
  const provider = settings.digest_email_provider || 'resend';
  if (!DIGEST_EMAIL_PROVIDERS.includes(provider)) return { delivered_via: 'none', delivery_error: `Unknown email provider "${provider}".` };
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { delivered_via: 'none', delivery_error: 'Email is on but the RESEND_API_KEY secret is not set.' };
  if (!settings.digest_from_email) return { delivered_via: 'none', delivery_error: 'Email is on but no "send from" address is set.' };
  if (!user.email) return { delivered_via: 'none', delivery_error: 'This person has no email address.' };
  try {
    const { subject, text } = digestEmailContent(payload, settings);
    const res = await fetch(buildResendEmailRequest({ apiKey, from: settings.digest_from_email, to: user.email, subject, text }));
    if (!res.ok) return { delivered_via: 'none', delivery_error: `Resend responded ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
    return { delivered_via: 'email', delivery_error: null };
  } catch (e) {
    return { delivered_via: 'none', delivery_error: opsErrorText(e) };
  }
}

async function runDigestJob(env) {
  const runAt = opsSqlNow();
  const settings = await readWorkspaceSettingsMap(env);
  const { company, digests } = await computeDigests(env, runAt);
  const rows = [{ user_id: null, payload: company, delivered_via: 'none', delivery_error: null }];
  let emailed = 0;
  let emailErrors = 0;
  for (const { user, payload } of digests) {
    const attempted = settings.digest_enabled === 'true' && env.RESEND_API_KEY && digestHasContent(payload);
    const result = await deliverDigest(env, settings, user, payload);
    if (result.delivered_via === 'email') emailed++;
    if (result.delivery_error) emailErrors++;
    rows.push({ user_id: user.id, payload, ...result });
    // Resend's default limit is ~2 requests/second; stay under it. (Each
    // email is one subrequest — Workers Free allows 50 per invocation.)
    if (attempted) await new Promise(resolve => setTimeout(resolve, 550));
  }
  const insert = env.DB.prepare('INSERT INTO digests (id, run_at, user_id, payload, delivered_via, delivery_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)');
  const statements = rows.map(r => insert.bind(`dg_${crypto.randomUUID()}`, runAt, r.user_id, JSON.stringify(r.payload), r.delivered_via, r.delivery_error));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  const pruned = await env.DB.prepare(`DELETE FROM digests WHERE run_at < datetime(?1, '-${DIGEST_RETENTION_DAYS} days')`).bind(runAt).run();
  return {
    ok: true,
    run_at: runAt,
    digests_stored: rows.length,
    people: digests.length,
    emailed,
    email_errors: emailErrors,
    pruned: pruned.meta?.changes ?? 0,
    totals: company.totals,
    email: {
      enabled: settings.digest_enabled === 'true',
      provider: settings.digest_email_provider,
      from: settings.digest_from_email || null,
      api_key_set: !!env.RESEND_API_KEY,
    },
  };
}

/** A failed digest run is recorded as a company row carrying the error, so
 *  the Settings preview shows it instead of silently showing stale data. */
async function recordDigestFailure(env, error) {
  await env.DB.prepare('INSERT INTO digests (id, run_at, user_id, payload, delivered_via, delivery_error) VALUES (?1, ?2, NULL, ?3, \'none\', ?4)')
    .bind(`dg_${crypto.randomUUID()}`, opsSqlNow(), JSON.stringify({ kind: 'company', error }), `Digest job failed: ${error}`).run();
}

/**
 * GET /api/digest/me — the caller's latest digest. The ADMIN_TOKEN super
 * administrator is not a row in `users`, so for them this returns the latest
 * company roll-up (user_id NULL) plus the email-delivery status.
 */
async function handleMyDigest(env, actor) {
  const isRootAdmin = actor.id === 'super-admin';
  const row = isRootAdmin
    ? await env.DB.prepare('SELECT * FROM digests WHERE user_id IS NULL ORDER BY run_at DESC LIMIT 1').first()
    : await env.DB.prepare('SELECT * FROM digests WHERE user_id = ?1 ORDER BY run_at DESC LIMIT 1').bind(actor.id).first();
  const digest = row ? {
    id: row.id, run_at: row.run_at, user_id: row.user_id,
    delivered_via: row.delivered_via, delivery_error: row.delivery_error,
    payload: (() => { try { return JSON.parse(row.payload); } catch { return null; } })(),
  } : null;
  const body = { digest };
  if (actor.role === 'super_admin') body.email = { api_key_set: !!env.RESEND_API_KEY };
  return json(body);
}

async function handleRunDigest(env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can run the daily digest.', 403);
  try { return json(await runDigestJob(env)); }
  catch (e) {
    const error = opsErrorText(e);
    console.error('Digest job failed (manual run):', e);
    await recordDigestFailure(env, error).catch(() => {});
    return fail(`Digest job failed: ${error}`, 500);
  }
}

/**
 * Backup: every app table as JSON, gzip-compressed, into R2.
 *
 * NOTE: this writes into the IMAGES bucket (crm-property-images) to avoid new
 * infrastructure. In production a dedicated, private bucket is better (its
 * own retention/lifecycle rules and access, separate from public photos):
 * create one with `npx wrangler r2 bucket create crm-backups`, add an
 * r2_buckets entry `{ "binding": "BACKUPS", "bucket_name": "crm-backups" }` to
 * wrangler.jsonc, and backupBucket() below will pick it up automatically.
 *
 * Each dump is loaded fully into memory (SELECT * per table), which is fine
 * for a CRM of this size but would need paging for very large tables.
 */
function backupBucket(env) {
  return env.BACKUPS || env.IMAGES;
}

async function runBackupJob(env) {
  const id = `bk_${crypto.randomUUID()}`;
  const createdAt = opsSqlNow();
  const key = `${BACKUP_PREFIX}${createdAt.slice(0, 10)}.json.gz`;
  try {
    const bucket = backupBucket(env);
    if (!bucket) throw new Error('No R2 bucket is bound (IMAGES / BACKUPS).');
    // Same v2 format as the "Download full backup" button (wave3 J), so nightly files restore the same way.
    const dump = await bkrBuildExport(env, createdAt);
    const counts = dump.row_counts;
    const raw = new TextEncoder().encode(JSON.stringify(dump));
    const gz = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await bucket.put(key, gz, {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { format: 'realestate-crm-backup-v2', uncompressed_bytes: String(raw.byteLength) },
    });
    // Same-day re-runs overwrite the day's object, so drop the older 'ok'
    // row that pointed at it before recording this one.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM backups WHERE r2_key = ?1 AND status = 'ok'").bind(key),
      env.DB.prepare("INSERT INTO backups (id, r2_key, created_at, bytes, table_counts, status, error) VALUES (?1, ?2, ?3, ?4, ?5, 'ok', NULL)")
        .bind(id, key, createdAt, gz.byteLength, JSON.stringify(counts)),
    ]);
    const pruned = await pruneBackups(env, bucket, createdAt);
    return { ok: true, id, r2_key: key, created_at: createdAt, bytes: gz.byteLength, uncompressed_bytes: raw.byteLength, table_counts: counts, pruned };
  } catch (e) {
    const error = opsErrorText(e);
    console.error('Backup job failed:', e);
    await env.DB.prepare("INSERT INTO backups (id, r2_key, created_at, bytes, table_counts, status, error) VALUES (?1, ?2, ?3, NULL, NULL, 'error', ?4)")
      .bind(id, key, createdAt, error).run().catch(() => {});
    return { ok: false, id, r2_key: key, created_at: createdAt, error };
  }
}

/** Keep the newest BACKUP_KEEP dumps (keys sort by date); failed-run rows are kept 30 days. */
async function pruneBackups(env, bucket, now) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const doomed = keys.sort().reverse().slice(BACKUP_KEEP);
  if (doomed.length) {
    await bucket.delete(doomed);
    const del = env.DB.prepare('DELETE FROM backups WHERE r2_key = ?1');
    await env.DB.batch(doomed.map(k => del.bind(k)));
  }
  await env.DB.prepare("DELETE FROM backups WHERE status = 'error' AND created_at < datetime(?1, '-30 days')").bind(now).run();
  return doomed;
}

// Backups hold EVERY customer's name, phone and email, every employee record
// (including access-token hashes) and all settings. That is why listing,
// downloading and running them is restricted to the super administrator —
// not admins, not managers — and why downloads are never cached.
async function handleListBackups(env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can view backups.', 403);
  const { results } = await env.DB.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 60').all();
  return json({
    keep: BACKUP_KEEP,
    backups: (results ?? []).map(r => ({ ...r, table_counts: (() => { try { return JSON.parse(r.table_counts || 'null'); } catch { return null; } })() })),
  });
}

async function handleDownloadBackup(env, id, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can download backups.', 403);
  const row = await env.DB.prepare('SELECT * FROM backups WHERE id = ?1').bind(id).first();
  if (!row || row.status !== 'ok' || !row.r2_key) return fail('Backup not found.', 404);
  const bucket = backupBucket(env);
  const object = bucket && await bucket.get(row.r2_key);
  if (!object) return fail('That backup file is no longer stored.', 404);
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${row.r2_key.split('/').pop()}"`,
      'cache-control': 'no-store',
    },
  });
}

async function handleRunBackup(env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can run backups.', 403);
  const result = await runBackupJob(env);
  return json(result, result.ok ? 200 : 500);
}

/** Entry point for the cron trigger. Each job is isolated: its own try/catch,
 *  its own error record, and neither awaits the other's success. */
async function runScheduledJobs(env, cron) {
  // Delayed To Do tasks: tell each head before the digest is built (idempotent; see src/tasks.js).
  await escalateDelayedTasks(env).catch((e) => console.error('Task escalation failed:', e));
  await alertOverdueWorkstreams(env, raiseAlert).catch((e) => console.error('NOC / workstream alerts failed:', e)); // wave3, H2
  await runFinanceOverdueJob(env).catch((e) => console.error('Finance overdue alerts failed:', e)); // wave3 H4
  const [digest, backup] = await Promise.allSettled([
    (async () => {
      try { return await runDigestJob(env); }
      catch (e) {
        const error = opsErrorText(e);
        console.error('Scheduled digest job failed:', e);
        await recordDigestFailure(env, error).catch(() => {});
        return { ok: false, error };
      }
    })(),
    runBackupJob(env), // records its own failure in `backups`
  ]);
  console.log('Scheduled jobs finished', cron, JSON.stringify({
    digest: digest.status === 'fulfilled' ? { ok: digest.value.ok, error: digest.value.error, people: digest.value.people, emailed: digest.value.emailed } : String(digest.reason),
    backup: backup.status === 'fulfilled' ? { ok: backup.value.ok, error: backup.value.error, r2_key: backup.value.r2_key } : String(backup.reason),
  }));
}

// ---- end background jobs (Agent OPS) ----

// ---- Backup export + restore (wave3 J) ----
//
// Super administrator only.
//   GET  /api/backups/export                  → one JSON file with every table.
//   POST /api/backups/restore/preview         → body = that file (or a nightly
//        .json.gz). Validates it and says what would be replaced. Changes nothing.
//   POST /api/backups/restore?confirm=RESTORE → same body; replaces the data.
//   POST /api/backups/:id/restore[/preview]   → the same, from a stored R2 backup.
//
// A restore, in order:
//  1. validates format, schema version, tables, columns and row counts;
//  2. saves a safety backup of the CURRENT data to R2 (backups/safety-…). It is
//     listed with the nightly backups, so a restore can itself be undone;
//  3. runs ONE D1 batch (= one SQLite transaction, all-or-nothing): defers
//     foreign-key checks, drops the triggers (so restored rows don't fire lead
//     routing / code numbering again), empties the tables children-first,
//     re-inserts the backup's rows parents-first, re-creates the triggers.
//     Rows are packed into multi-row INSERTs with escaped literals (< 90 KB each;
//     D1's statement limit is 100 KB) to keep the statement count low. Only if
//     D1 refuses that one batch for a non-data reason (too big) does it fall back
//     to smaller batches; if one of those fails, the safety backup is put back.
// Not replaced:
//  * `users` is MERGED: people in the backup get their details back, but who can
//    sign in and what they may do (token hash, active flag, role, permission
//    overrides) stays as it is now, and nobody who exists now is removed. The
//    ADMIN_TOKEN super administrator has no row at all, so can always sign in.
//  * `backups` and `digests` are bookkeeping (pointers to R2 files; daily
//    snapshots rebuilt every morning) and stay as they are now.
//  * SQLite / D1 / Cloudflare internal tables (sqlite_*, d1_*, _cf_*) and any
//    virtual tables are never exported or touched.
// Photos and documents live in R2 and are NOT inside the JSON; the export only
// lists their keys. A restore never deletes or changes R2 files.
// ---------------------------------------------------------------------------

const CRM_SCHEMA_VERSION = 76; // number of the newest migrations/NNNN-*.sql file — bump it with every new migration
const BKR_FORMAT = 'realestate-crm-backup';
const BKR_KEEP_TABLES = new Set(['backups', 'digests', 'app_admin']); // app_admin = the super administrator's own login: a restore never replaces it
const BKR_AUTH_COLUMNS = new Set(['access_token_hash', 'password_hash', 'is_active', 'role', 'permission_overrides']);
const BKR_SAFETY_PREFIX = 'backups/safety-';
const BKR_SAFETY_KEEP = 5;
const BKR_STATEMENT_BYTES = 90_000;
const BKR_CHUNK_STATEMENTS = 40;
const bkrUtf8 = new TextEncoder();

const bkrQ = (name) => '"' + String(name).replaceAll('"', '""') + '"';

/** App tables, generic so tables added by later migrations are included automatically. */
async function bkrTables(env) {
  const { results } = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite!_%' ESCAPE '!'
        AND name NOT LIKE '!_cf!_%' ESCAPE '!'
        AND name NOT LIKE 'd1!_%' ESCAPE '!'
      ORDER BY name`
  ).all();
  const rows = results ?? [];
  const virtual = rows.filter(r => /^CREATE\s+VIRTUAL/i.test(r.sql || '')).map(r => r.name);
  // Sessions and lock-out counters are not data worth backing up (and would sign people in from a file).
  return rows.map(r => r.name).filter(n => !virtual.some(v => n === v || n.startsWith(v + '_')) && !['auth_sessions', 'login_attempts', 'app_admin'].includes(n));
}

/** Columns + foreign-key parents per table. */
async function bkrSchema(env, tables) {
  const [cols, fks] = await Promise.all([
    env.DB.batch(tables.map(t => env.DB.prepare(`PRAGMA table_info(${bkrQ(t)})`))),
    env.DB.batch(tables.map(t => env.DB.prepare(`PRAGMA foreign_key_list(${bkrQ(t)})`))),
  ]);
  const info = {};
  tables.forEach((t, i) => {
    info[t] = {
      columns: (cols[i].results ?? []).map(c => ({ name: c.name, notnull: !!c.notnull, dflt_value: c.dflt_value, pk: Number(c.pk) || 0 })),
      parents: new Set((fks[i].results ?? []).map(f => f.table)),
    };
  });
  return info;
}

/** Parents before children. Cycles (teams <-> users) are fine: FK checks are deferred. */
function bkrOrder(tables, info) {
  const left = new Set(tables), out = [];
  const waitingOn = (t) => [...info[t].parents].filter(p => p !== t && left.has(p)).sort();
  while (left.size) {
    const ready = [...left].filter(t => waitingOn(t).length === 0).sort();
    let pick = ready;
    if (!ready.length) {
      // Stuck: follow parent links until a table repeats; that one sits in a cycle, so it goes next.
      const seen = new Set();
      let t = [...left].sort()[0];
      while (!seen.has(t)) { seen.add(t); t = waitingOn(t)[0]; }
      pick = [t];
    }
    for (const t of pick) { out.push(t); left.delete(t); }
  }
  return out;
}

/** R2 photo/document keys (not their bytes). Backup dumps themselves are left out. */
async function bkrListFiles(env) {
  const objects = [];
  let cursor, truncated = false;
  if (env.IMAGES) do {
    const page = await env.IMAGES.list({ cursor, limit: 1000 });
    for (const o of page.objects) if (!o.key.startsWith('backups/')) objects.push({ key: o.key, size: o.size });
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && objects.length >= 100000) { truncated = true; break; }
  } while (cursor);
  return {
    note: 'Photos and documents stay in file storage (R2). They are listed here by key only; their contents are not in this file.',
    count: objects.length, truncated, objects,
  };
}

/** Every app table in one consistent read (a D1 batch is a single transaction). */
async function bkrBuildExport(env, createdAt = opsSqlNow()) {
  const tables = await bkrTables(env);
  const [reads, info, files] = await Promise.all([
    env.DB.batch(tables.map(t => env.DB.prepare(`SELECT * FROM ${bkrQ(t)}`))),
    bkrSchema(env, tables),
    bkrListFiles(env),
  ]);
  const dump = { format: BKR_FORMAT, version: 2, schema_version: CRM_SCHEMA_VERSION, created_at: createdAt, row_counts: {}, columns: {}, files, tables: {} };
  tables.forEach((t, i) => {
    dump.tables[t] = reads[i].results ?? [];
    // A backup file never carries password or token hashes (a leaked file could be cracked offline).
    // After restoring into an empty database an administrator sets the passwords again.
    if (t === 'users') dump.tables[t] = dump.tables[t].map((r) => ({ ...r, password_hash: null, access_token_hash: null }));
    dump.row_counts[t] = dump.tables[t].length;
    dump.columns[t] = info[t].columns.map(c => c.name);
  });
  return dump;
}

async function bkrGzip(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

/** Accepts plain JSON or gzip (nightly .json.gz). Null when unreadable. */
async function bkrReadDump(bytes) {
  let buf = new Uint8Array(bytes);
  try {
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    return JSON.parse(new TextDecoder().decode(buf));
  } catch { return null; }
}

async function bkrLoadDump(request, env, backupId) {
  if (backupId) {
    const row = await env.DB.prepare('SELECT * FROM backups WHERE id = ?1').bind(backupId).first();
    if (!row || row.status !== 'ok' || !row.r2_key) return { error: 'Backup not found.', status: 404 };
    const object = await backupBucket(env)?.get(row.r2_key);
    if (!object) return { error: 'That backup file is no longer stored.', status: 404 };
    const dump = await bkrReadDump(await object.arrayBuffer());
    return dump ? { dump, source: row.r2_key } : { error: 'That backup file could not be read.', status: 422 };
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return { error: 'Choose a backup file first.', status: 400 };
  const dump = await bkrReadDump(bytes);
  return dump ? { dump, source: 'upload' } : { error: "This file isn't a CRM backup (it can't be read).", status: 400 };
}

/** Validates a dump against the live schema and works out what a restore would do. */
async function bkrPlan(env, dump) {
  const errors = [], warnings = [];
  if (!dump || typeof dump !== 'object' || dump.format !== BKR_FORMAT || ![1, 2].includes(dump.version) ||
      !dump.tables || typeof dump.tables !== 'object' || Array.isArray(dump.tables)) {
    return { errors: ["This file isn't a CRM backup made by this app."], warnings, tables: [] };
  }
  if (dump.version >= 2) {
    const v = Number(dump.schema_version);
    if (!Number.isInteger(v)) errors.push('The backup has no schema version.');
    else if (v > CRM_SCHEMA_VERSION) errors.push(`This backup comes from a newer version of the app (schema ${v}; this app is on ${CRM_SCHEMA_VERSION}). Update the app first.`);
    else if (v < CRM_SCHEMA_VERSION) warnings.push(`This backup is from an older version of the app (schema ${v}; now ${CRM_SCHEMA_VERSION}). Newer fields will get their default values.`);
  } else {
    warnings.push('Older nightly backup format with no schema version; tables and fields were checked one by one instead.');
  }
  const names = await bkrTables(env);
  const info = await bkrSchema(env, names);
  const known = new Set(names);
  for (const name of Object.keys(dump.tables)) {
    if (!known.has(name) && !/^(sqlite_|d1_|_cf_)/.test(name)) warnings.push(`"${name}" is not part of this app any more, so it will be skipped.`);
  }
  const counts = await env.DB.batch(names.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${bkrQ(t)}`)));
  const tables = [];
  names.forEach((t, i) => {
    const current_rows = counts[i].results?.[0]?.n ?? 0;
    const rows = dump.tables[t];
    if (BKR_KEEP_TABLES.has(t) || (t === 'users' && rows === undefined)) {
      if (t === 'users') warnings.push('The backup has no list of people, so people are kept as they are now.');
      tables.push({ name: t, action: 'keep', current_rows, backup_rows: null });
      return;
    }
    if (rows === undefined) {
      warnings.push(`"${t}" is not in this backup, so it will be emptied.`);
      tables.push({ name: t, action: 'empty', current_rows, backup_rows: 0 });
      return;
    }
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
      errors.push(`"${t}" in the file is damaged.`);
      return;
    }
    if (dump.version >= 2 && dump.row_counts?.[t] !== rows.length) {
      errors.push(`"${t}" should have ${dump.row_counts?.[t]} rows but the file has ${rows.length}. The file may be damaged or edited.`);
    }
    const colNames = new Set(info[t].columns.map(c => c.name));
    const present = new Set();
    for (const r of rows) for (const k of Object.keys(r)) present.add(k);
    const extra = [...present].filter(k => !colNames.has(k));
    if (extra.length) warnings.push(`"${t}": ${extra.join(', ')} no longer exist${extra.length === 1 ? 's' : ''}, skipped.`);
    if (rows.length) {
      const missing = info[t].columns.filter(c => c.notnull && c.dflt_value == null && !c.pk && !present.has(c.name)).map(c => c.name);
      if (missing.length) errors.push(`"${t}" is missing required field(s): ${missing.join(', ')}.`);
    }
    tables.push({ name: t, action: t === 'users' ? 'merge' : 'replace', current_rows, backup_rows: rows.length });
  });
  // A person who is new in the backup must not clash with someone's email now.
  if (Array.isArray(dump.tables.users) && known.has('users') && info.users.columns.some(c => c.name === 'email')) {
    const { results: cur } = await env.DB.prepare('SELECT id, email FROM users').all();
    const ids = new Set((cur ?? []).map(u => u.id));
    const emails = new Map((cur ?? []).filter(u => u.email).map(u => [u.email, u.id]));
    for (const u of dump.tables.users) {
      if (u && !ids.has(u.id) && u.email && emails.has(u.email)) errors.push(`${u.name || u.id} in the backup has the same email (${u.email}) as someone in the app now.`);
    }
  }
  return { errors, warnings, tables, info, order: bkrOrder(names, info) };
}

function bkrLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return "X'" + v.map(b => (Number(b) & 255).toString(16).padStart(2, '0')).join('') + "'"; // D1 returns BLOBs as byte arrays
  if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v).replaceAll("'", "''") + "'";
}

function bkrBindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return new Uint8Array(v).buffer;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Multi-row INSERTs under D1's statement size limit; oversized rows are bound instead. */
function bkrInsertStatements(env, table, cols, rows, suffix = '') {
  const out = [];
  const head = `INSERT INTO ${bkrQ(table)} (${cols.map(bkrQ).join(', ')}) VALUES `;
  const budget = BKR_STATEMENT_BYTES - bkrUtf8.encode(head + suffix).length;
  let parts = [], bytes = 0;
  const flush = () => { if (parts.length) out.push(env.DB.prepare(head + parts.join(',') + suffix)); parts = []; bytes = 0; };
  for (const r of rows) {
    const tuple = '(' + cols.map(c => bkrLiteral(r[c])).join(',') + ')';
    const size = bkrUtf8.encode(tuple).length + 1;
    if ((size > budget || tuple.includes('\u0000')) && cols.length <= 100) {
      out.push(env.DB.prepare(`${head}(${cols.map((_, i) => '?' + (i + 1)).join(',')})${suffix}`).bind(...cols.map(c => bkrBindValue(r[c]))));
      continue;
    }
    if (parts.length && bytes + size > budget) flush();
    parts.push(tuple); bytes += size;
  }
  flush();
  return out;
}

function bkrStatements(env, dump, plan, triggers) {
  const list = [env.DB.prepare('PRAGMA defer_foreign_keys = ON')];
  for (const tr of triggers) list.push(env.DB.prepare(`DROP TRIGGER IF EXISTS ${bkrQ(tr.name)}`));
  const byName = Object.fromEntries(plan.tables.map(t => [t.name, t]));
  const cleared = plan.order.filter(t => ['replace', 'empty'].includes(byName[t]?.action));
  for (const t of [...cleared].reverse()) list.push(env.DB.prepare(`DELETE FROM ${bkrQ(t)}`));
  for (const t of plan.order) {
    const p = byName[t];
    if (!p || !['replace', 'merge'].includes(p.action) || !dump.tables[t].length) continue;
    const rows = dump.tables[t];
    const present = new Set();
    for (const r of rows) for (const k of Object.keys(r)) present.add(k);
    const colInfo = plan.info[t].columns;
    const cols = colInfo.map(c => c.name).filter(c => present.has(c));
    let suffix = '';
    if (p.action === 'merge') {
      const pk = colInfo.filter(c => c.pk).map(c => c.name);
      const upd = cols.filter(c => !pk.includes(c) && !BKR_AUTH_COLUMNS.has(c));
      suffix = ` ON CONFLICT(${pk.map(bkrQ).join(', ')}) DO ` +
        (upd.length ? 'UPDATE SET ' + upd.map(c => `${bkrQ(c)} = excluded.${bkrQ(c)}`).join(', ') : 'NOTHING');
    }
    list.push(...bkrInsertStatements(env, t, cols, rows, suffix));
  }
  for (const tr of triggers) if (tr.sql) list.push(env.DB.prepare(tr.sql));
  return list;
}

/** Fallback for a restore too big for one batch: same statements, several batches. */
async function bkrRunChunked(env, list) {
  for (let i = 1; i < list.length; i += BKR_CHUNK_STATEMENTS) {
    await env.DB.batch([env.DB.prepare('PRAGMA defer_foreign_keys = ON'), ...list.slice(i, i + BKR_CHUNK_STATEMENTS)]);
  }
}

async function bkrSaveSafety(env) {
  const bucket = backupBucket(env);
  if (!bucket) throw new Error('No R2 bucket is bound (IMAGES / BACKUPS).');
  const createdAt = opsSqlNow();
  const dump = await bkrBuildExport(env, createdAt);
  const gz = await bkrGzip(JSON.stringify(dump));
  const key = `${BKR_SAFETY_PREFIX}${createdAt.replace(' ', '-').replaceAll(':', '')}.json.gz`;
  await bucket.put(key, gz, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { format: 'realestate-crm-backup-v2', reason: 'before-restore' },
  });
  const id = `bk_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO backups (id, r2_key, created_at, bytes, table_counts, status, error) VALUES (?1, ?2, ?3, ?4, ?5, 'ok', NULL)")
    .bind(id, key, createdAt, gz.byteLength, JSON.stringify(dump.row_counts)).run();
  // Keep only the newest few safety copies.
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: BKR_SAFETY_PREFIX, cursor });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const doomed = keys.sort().reverse().slice(BKR_SAFETY_KEEP);
  if (doomed.length) {
    await bucket.delete(doomed);
    const del = env.DB.prepare('DELETE FROM backups WHERE r2_key = ?1');
    await env.DB.batch(doomed.map(k => del.bind(k)));
  }
  return { id, r2_key: key, created_at: createdAt, dump };
}

async function bkrRestore(env, dump, plan) {
  const { results: trig } = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
  const triggers = trig ?? [];
  let safety;
  try { safety = await bkrSaveSafety(env); }
  catch (e) { throw new Error(`Could not save a safety backup first, so nothing was changed: ${opsErrorText(e)}`); }
  const statements = bkrStatements(env, dump, plan, triggers);
  let mode = 'single';
  try {
    await env.DB.batch(statements);
  } catch (e) {
    const msg = opsErrorText(e);
    // A data problem rolls the whole batch back: nothing changed, and smaller batches would fail the same way.
    if (/constraint|SQLITE_MISMATCH|no such (table|column)|syntax error/i.test(msg)) throw new Error(`Nothing was changed. The backup could not be applied: ${msg}`);
    mode = 'chunked';
    try {
      await bkrRunChunked(env, statements);
    } catch (e2) {
      try {
        const back = await bkrPlan(env, safety.dump);
        await bkrRunChunked(env, bkrStatements(env, safety.dump, back, triggers));
      } catch (e3) {
        // Never leave the lead-routing / code-numbering triggers missing.
        await env.DB.batch(triggers.filter(tr => tr.sql).flatMap(tr => [env.DB.prepare(`DROP TRIGGER IF EXISTS ${bkrQ(tr.name)}`), env.DB.prepare(tr.sql)])).catch(() => {});
        throw new Error(`Restore failed part-way (${opsErrorText(e2)}) and putting the data back also failed (${opsErrorText(e3)}). Restore the safety backup from ${safety.created_at} (${safety.r2_key}).`);
      }
      throw new Error(`Restore failed part-way (${opsErrorText(e2)}). Your data was put back as it was from the safety backup.`);
    }
  }
  const after = await env.DB.batch(plan.tables.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${bkrQ(t.name)}`)));
  const tables = plan.tables.map((t, i) => ({ ...t, after_rows: after[i].results?.[0]?.n ?? 0 }));
  const mismatched = tables.filter(t => (t.action === 'replace' || t.action === 'empty') && t.after_rows !== t.backup_rows).map(t => t.name);
  return {
    mode,
    safety_backup: { id: safety.id, r2_key: safety.r2_key, created_at: safety.created_at },
    restored_rows: tables.filter(t => t.action === 'replace' || t.action === 'merge').reduce((a, t) => a + (t.backup_rows || 0), 0),
    tables,
    mismatched,
  };
}

function bkrPlanSummary(loaded, plan) {
  const d = loaded.dump || {};
  return {
    ok: !plan.errors.length,
    source: loaded.source,
    created_at: d.created_at ?? null,
    version: d.version ?? null,
    schema_version: d.schema_version ?? null,
    app_schema_version: CRM_SCHEMA_VERSION,
    files: d.files && typeof d.files === 'object' ? { count: Number(d.files.count) || 0 } : null,
    errors: plan.errors,
    warnings: plan.warnings,
    tables: plan.tables,
  };
}

async function handleExportBackup(env, actor) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can download backups.', 403);
  const dump = await bkrBuildExport(env);
  const stamp = dump.created_at.replace(' ', '-').replaceAll(':', '').slice(0, 15);
  return new Response(JSON.stringify(dump), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="crm-full-backup-${stamp}.json"`,
      'cache-control': 'no-store',
    },
  });
}

async function handleRestorePreview(request, env, actor, backupId) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can restore backups.', 403);
  const loaded = await bkrLoadDump(request, env, backupId);
  if (loaded.error) return fail(loaded.error, loaded.status);
  return json(bkrPlanSummary(loaded, await bkrPlan(env, loaded.dump)));
}

async function handleRestore(request, env, actor, backupId) {
  if (actor.role !== 'super_admin') return fail('Only the super administrator can restore backups.', 403);
  if (new URL(request.url).searchParams.get('confirm') !== 'RESTORE') return fail('Type RESTORE to confirm.', 400);
  const loaded = await bkrLoadDump(request, env, backupId);
  if (loaded.error) return fail(loaded.error, loaded.status);
  const plan = await bkrPlan(env, loaded.dump);
  if (plan.errors.length) return fail(`This backup can't be restored: ${plan.errors[0]}`, 422, { errors: plan.errors });
  try {
    const result = await bkrRestore(env, loaded.dump, plan);
    console.log('Backup restored', JSON.stringify({ by: actor.id, source: loaded.source, mode: result.mode, safety: result.safety_backup.r2_key, rows: result.restored_rows }));
    return json({ ok: true, source: loaded.source, created_at: loaded.dump.created_at ?? null, warnings: plan.warnings, ...result });
  } catch (e) {
    console.error('Restore failed:', e);
    return fail(opsErrorText(e), 500);
  }
}

// ---- end backup export + restore (wave3 J) ----

// ---------------------------------------------------------------------------
// ---- Finance for transactions (wave3 H4) ----
// Tables (migration 0070): brokerage, invoices, receipts, expenses, partner_payouts.
// Four numbers are kept apart on purpose:
//   Expected    = brokerage.expected_amount (before GST; 0 once cancelled)
//   Invoiced    = total incl. tax of invoices that went out (sent / partly paid / paid)
//   Collected   = active (not reversed) receipts on those invoices
//   Outstanding = Invoiced − Collected;  Not yet invoiced = Expected − invoiced amount before tax
// Nothing is hard-deleted: invoices / expenses / payouts are 'cancelled', receipts 'reversed'.
// Every route needs finance.read (GET) or finance.write; others get 403.
// ---------------------------------------------------------------------------
const FIN_LIVE = ['sent', 'partly_paid', 'paid'];
const FIN_LIVE_SQL = "('sent','partly_paid','paid')";
const FIN_MODES = ['cash', 'cheque', 'bank_transfer', 'upi'];
const FIN_FROM = ['buyer', 'seller', 'builder', 'both'];
const FIN_PARTNER_TYPES = ['channel_partner', 'sub_broker', 'employee_incentive'];
const FIN_PROOF_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const FIN_PROOF_MAX = 8 * 1024 * 1024;

const finRound = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** "1,25,000" / 125000 / "₹ 1,25,000" → 125000; null when blank, invalid or negative. */
function finAmount(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) && n >= 0 ? finRound(n) : null;
}
const finDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const finText = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Today's date in India (IST), YYYY-MM-DD. */
const finToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const finAddDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const finRupees = (n) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(finRound(n));
const finCanRead = (actor) => has(actor, 'finance.read') || has(actor, 'finance.write');
const finNoRead = () => fail('You do not have access to finance.', 403);
const finNoWrite = () => fail('Only the finance team can change money records.', 403);

/** The transaction (plus its lead's owner / source), or null. Never throws —
 *  the transactions table belongs to another feature and may not exist yet. */
async function finTransaction(env, id) {
  try {
    return await env.DB.prepare(
      `SELECT t.*, l.assigned_user_id AS lead_owner_user_id, l.customer_name AS lead_name, l.source AS lead_source
         FROM transactions t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?1`
    ).bind(id).first();
  } catch (e) { console.error('finance: could not read transaction', id, e); return null; }
}
/** People who own the deal: relationship manager + the lead's owner. */
const finDealOwners = (txn) => [...new Set([txn?.relationship_manager_user_id, txn?.lead_owner_user_id].filter(Boolean))];

/** Paid amount and status of one invoice, re-derived from its active receipts. */
async function finSyncInvoice(env, invoiceId) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?1').bind(invoiceId).first();
  if (!inv) return null;
  const paid = finRound(await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM receipts WHERE invoice_id = ?1 AND status = 'active'").bind(invoiceId).first('s'));
  if (inv.status === 'cancelled') return { ...inv, paid_amount: paid, balance: 0 };
  const status = paid >= inv.total_amount - 0.005 ? 'paid' : paid > 0 ? 'partly_paid' : inv.status === 'draft' ? 'draft' : 'sent';
  if (status !== inv.status) await env.DB.prepare("UPDATE invoices SET status = ?2, updated_at = datetime('now') WHERE id = ?1").bind(invoiceId, status).run();
  return { ...inv, status, paid_amount: paid, balance: finRound(inv.total_amount - paid) };
}

/** The four numbers (plus extras) for one transaction's finance rows. */
function finSummary(brokerage, invoices, expenses, payouts, today = finToday()) {
  const sum = (rows, f) => finRound(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0));
  const expected = brokerage && brokerage.status !== 'cancelled' ? finRound(brokerage.expected_amount) : 0;
  const live = invoices.filter((i) => FIN_LIVE.includes(i.status));
  const invoiced = sum(live, (i) => i.total_amount);
  const invoicedBase = sum(live, (i) => i.amount);
  const collected = sum(live, (i) => i.paid_amount);
  const overdue = live.filter((i) => i.due_date && i.due_date < today && i.balance > 0.005);
  const activePayouts = payouts.filter((p) => p.status !== 'cancelled');
  return {
    expected, invoiced, invoiced_before_tax: invoicedBase, collected,
    outstanding: finRound(invoiced - collected),
    not_invoiced: finRound(Math.max(0, expected - invoicedBase)),
    overdue_count: overdue.length, overdue_amount: sum(overdue, (i) => i.balance),
    draft_count: invoices.filter((i) => i.status === 'draft').length,
    expenses_total: sum(expenses.filter((e) => e.status === 'active'), (e) => e.amount),
    payouts_total: sum(activePayouts, (p) => p.amount),
    payouts_paid: sum(activePayouts.filter((p) => p.status === 'paid'), (p) => p.amount),
    payouts_pending_approval: activePayouts.filter((p) => p.status === 'pending').length,
  };
}

async function finBundle(env, txnId) {
  const [brokerage, inv, rec, exp, pay] = await Promise.all([
    env.DB.prepare('SELECT * FROM brokerage WHERE transaction_id = ?1').bind(txnId).first(),
    env.DB.prepare(`SELECT i.*, COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.invoice_id = i.id AND r.status = 'active'), 0) AS paid_amount
                      FROM invoices i WHERE i.transaction_id = ?1 ORDER BY i.issue_date DESC, i.invoice_no DESC`).bind(txnId).all(),
    env.DB.prepare(`SELECT r.id, r.invoice_id, r.amount, r.received_on, r.mode, r.reference, r.status, r.reverse_reason, r.reversed_at, r.created_at,
                           (r.proof_key IS NOT NULL) AS has_proof, i.invoice_no, u.name AS created_by_name
                      FROM receipts r JOIN invoices i ON i.id = r.invoice_id LEFT JOIN users u ON u.id = r.created_by_user_id
                     WHERE r.transaction_id = ?1 ORDER BY r.received_on DESC, r.created_at DESC`).bind(txnId).all(),
    env.DB.prepare('SELECT * FROM expenses WHERE transaction_id = ?1 ORDER BY spent_on DESC, created_at DESC').bind(txnId).all(),
    env.DB.prepare(`SELECT p.*, u.name AS approved_by_name FROM partner_payouts p LEFT JOIN users u ON u.id = p.approved_by_user_id
                     WHERE p.transaction_id = ?1 ORDER BY p.created_at`).bind(txnId).all(),
  ]);
  const invoices = (inv.results || []).map((i) => ({ ...i, paid_amount: finRound(i.paid_amount), balance: i.status === 'cancelled' ? 0 : finRound(i.total_amount - i.paid_amount) }));
  const expenses = exp.results || [];
  const payouts = pay.results || [];
  return { brokerage: brokerage || null, invoices, receipts: rec.results || [], expenses, payouts, summary: finSummary(brokerage, invoices, expenses, payouts) };
}

async function handleTxnFinance(env, txnId, actor) {
  if (!finCanRead(actor)) return finNoRead();
  const txn = await finTransaction(env, txnId);
  if (!txn) return fail('Transaction not found.', 404);
  return json({ transaction: { id: txn.id, txn_code: txn.txn_code || null, agreed_price: txn.agreed_price ?? null }, ...(await finBundle(env, txnId)), can_write: has(actor, 'finance.write') });
}

async function handlePutBrokerage(request, env, txnId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const txn = await finTransaction(env, txnId);
  if (!txn) return fail('Transaction not found.', 404);
  const body = await bodyJson(request);
  if (!body) return fail('Send the brokerage details as JSON.', 400);
  const basis = body.basis === 'fixed' ? 'fixed' : 'percent';
  const fromParty = FIN_FROM.includes(body.from_party) ? body.from_party : 'buyer';
  const status = body.status === 'cancelled' ? 'cancelled' : 'expected';
  let rate = null, fixed = null, expected;
  if (basis === 'percent') {
    rate = finAmount(body.rate);
    if (rate == null || rate <= 0 || rate > 100) return fail('Enter the brokerage % (for example 2).', 422);
    const price = finAmount(body.agreed_price ?? txn.agreed_price);
    if (!price) return fail('Add the agreed price on the transaction first, or use a fixed amount.', 422);
    expected = finRound(price * rate / 100);
  } else {
    fixed = finAmount(body.fixed_amount);
    if (!fixed) return fail('Enter the brokerage amount.', 422);
    expected = fixed;
  }
  const dueDate = body.due_date ? finDate(body.due_date) : null;
  if (body.due_date && !dueDate) return fail('Pick a valid due date.', 422);
  await env.DB.prepare(
    `INSERT INTO brokerage (id, transaction_id, basis, rate, fixed_amount, expected_amount, gst_note, from_party, due_date, status, note, created_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(transaction_id) DO UPDATE SET basis = excluded.basis, rate = excluded.rate, fixed_amount = excluded.fixed_amount,
       expected_amount = excluded.expected_amount, gst_note = excluded.gst_note, from_party = excluded.from_party, due_date = excluded.due_date,
       status = excluded.status, note = excluded.note, updated_at = datetime('now')`
  ).bind(crypto.randomUUID(), txnId, basis, rate, fixed, expected, finText(body.gst_note, 300), fromParty, dueDate, status, finText(body.note, 2000), actorUserId(actor)).run();
  return json({ ok: true, ...(await finBundle(env, txnId)) });
}

async function finNextInvoiceNo(env) {
  const n = await env.DB.prepare("SELECT MAX(CAST(SUBSTR(invoice_no, 5) AS INTEGER)) AS n FROM invoices WHERE invoice_no LIKE 'INV-%'").first('n');
  return 'INV-' + String((Number(n) || 0) + 1).padStart(5, '0');
}

async function handleCreateInvoice(request, env, txnId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const txn = await finTransaction(env, txnId);
  if (!txn) return fail('Transaction not found.', 404);
  const body = await bodyJson(request);
  if (!body) return fail('Send the invoice as JSON.', 400);
  const billedTo = finText(body.billed_to, 200);
  if (!billedTo) return fail('Who is this invoice for?', 422);
  const amount = finAmount(body.amount);
  if (!amount) return fail('Enter the invoice amount.', 422);
  let tax = finAmount(body.tax_amount);
  if (tax == null && body.tax_rate != null && body.tax_rate !== '') {
    const rate = finAmount(body.tax_rate);
    if (rate == null || rate > 100) return fail('Enter a valid GST %.', 422);
    tax = finRound(amount * rate / 100);
  }
  tax = tax || 0;
  const issueDate = body.issue_date ? finDate(body.issue_date) : finToday();
  if (!issueDate) return fail('Pick a valid invoice date.', 422);
  const dueDate = body.due_date ? finDate(body.due_date) : finAddDays(issueDate, 15);
  if (!dueDate) return fail('Pick a valid due date.', 422);
  if (dueDate < issueDate) return fail('The due date cannot be before the invoice date.', 422);
  const status = body.status === 'sent' ? 'sent' : 'draft';
  const id = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    const invoiceNo = await finNextInvoiceNo(env);
    try {
      await env.DB.prepare(
        `INSERT INTO invoices (id, invoice_no, transaction_id, billed_to, amount, tax_amount, total_amount, issue_date, due_date, status, note, created_by_user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      ).bind(id, invoiceNo, txnId, billedTo, amount, tax, finRound(amount + tax), issueDate, dueDate, status, finText(body.note, 2000), actorUserId(actor)).run();
      break;
    } catch (e) {
      if (attempt < 3 && /UNIQUE/i.test(String(e?.message))) continue; // someone took the number at the same moment
      throw e;
    }
  }
  return json({ ok: true, invoice: await finSyncInvoice(env, id), ...(await finBundle(env, txnId)) }, 201);
}

/** PATCH /api/invoices/:id — { action: 'send' | 'cancel', reason } or field edits.
 *  Amounts change only while draft; due date / note while not cancelled. */
async function handleUpdateInvoice(request, env, invoiceId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const inv = await finSyncInvoice(env, invoiceId);
  if (!inv) return fail('Invoice not found.', 404);
  const body = await bodyJson(request);
  if (!body) return fail('Send the changes as JSON.', 400);
  if (inv.status === 'cancelled') return fail('This invoice is cancelled and cannot be changed.', 409);
  if (body.action === 'cancel') {
    if (inv.paid_amount > 0) return fail('Payments are recorded on this invoice. Reverse those payments first, then cancel it.', 409);
    const reason = finText(body.reason, 500);
    if (!reason) return fail('Say why the invoice is cancelled.', 422);
    await env.DB.prepare("UPDATE invoices SET status = 'cancelled', cancel_reason = ?2, cancelled_at = datetime('now'), cancelled_by_user_id = ?3, updated_at = datetime('now') WHERE id = ?1")
      .bind(invoiceId, reason, actorUserId(actor)).run();
  } else if (body.action === 'send') {
    if (inv.status !== 'draft') return fail('This invoice has already gone out.', 409);
    await env.DB.prepare("UPDATE invoices SET status = 'sent', updated_at = datetime('now') WHERE id = ?1").bind(invoiceId).run();
  } else {
    const next = { billed_to: inv.billed_to, amount: inv.amount, tax_amount: inv.tax_amount, due_date: inv.due_date, note: inv.note, issue_date: inv.issue_date };
    const money = ['billed_to', 'amount', 'tax_amount', 'issue_date'].some((k) => Object.hasOwn(body, k));
    if (money && inv.status !== 'draft') return fail('Only a draft invoice can have its amount, date or billed-to changed. Cancel it and raise a new one instead.', 409);
    if (Object.hasOwn(body, 'billed_to')) { next.billed_to = finText(body.billed_to, 200); if (!next.billed_to) return fail('Who is this invoice for?', 422); }
    if (Object.hasOwn(body, 'amount')) { next.amount = finAmount(body.amount); if (!next.amount) return fail('Enter the invoice amount.', 422); }
    if (Object.hasOwn(body, 'tax_amount')) { next.tax_amount = finAmount(body.tax_amount); if (next.tax_amount == null) return fail('Enter a valid tax amount.', 422); }
    if (Object.hasOwn(body, 'issue_date')) { next.issue_date = finDate(body.issue_date); if (!next.issue_date) return fail('Pick a valid invoice date.', 422); }
    if (Object.hasOwn(body, 'due_date')) { next.due_date = finDate(body.due_date); if (!next.due_date) return fail('Pick a valid due date.', 422); }
    if (Object.hasOwn(body, 'note')) next.note = finText(body.note, 2000);
    if (next.due_date && next.due_date < next.issue_date) return fail('The due date cannot be before the invoice date.', 422);
    if (finRound(next.amount + next.tax_amount) < inv.paid_amount) return fail('The total cannot be less than what is already paid.', 409);
    await env.DB.prepare(
      `UPDATE invoices SET billed_to = ?2, amount = ?3, tax_amount = ?4, total_amount = ?5, issue_date = ?6, due_date = ?7, note = ?8,
              overdue_alerted_at = CASE WHEN ?7 IS NOT due_date THEN NULL ELSE overdue_alerted_at END, updated_at = datetime('now') WHERE id = ?1`
    ).bind(invoiceId, next.billed_to, next.amount, next.tax_amount, finRound(next.amount + next.tax_amount), next.issue_date, next.due_date, next.note).run();
  }
  await finSyncInvoice(env, invoiceId);
  return json({ ok: true, ...(await finBundle(env, inv.transaction_id)) });
}

/** POST /api/invoices/:id/receipts — JSON, or multipart with an optional "proof" photo / PDF. */
async function handleRecordReceipt(request, env, invoiceId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const inv = await finSyncInvoice(env, invoiceId);
  if (!inv) return fail('Invoice not found.', 404);
  if (inv.status === 'cancelled') return fail('This invoice is cancelled.', 409);
  let body, proof = null;
  if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
    let form;
    try { form = await request.formData(); } catch { return fail('Could not read the form.', 400); }
    body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const file = form.get('proof');
    if (file instanceof File && file.size > 0) proof = file;
  } else body = await bodyJson(request);
  if (!body) return fail('Send the payment details.', 400);
  const amount = finAmount(body.amount);
  if (!amount) return fail('Enter the amount received.', 422);
  if (amount > inv.balance + 0.005) return fail(`That is more than the balance on this invoice (${finRupees(inv.balance)}).`, 422);
  const mode = FIN_MODES.includes(body.mode) ? body.mode : null;
  if (!mode) return fail('Choose how it was paid: cash, cheque, bank transfer or UPI.', 422);
  const receivedOn = body.received_on ? finDate(body.received_on) : finToday();
  if (!receivedOn) return fail('Pick a valid payment date.', 422);
  if (receivedOn > finAddDays(finToday(), 1)) return fail('The payment date cannot be in the future.', 422);
  const id = crypto.randomUUID();
  let proofKey = null;
  if (proof) {
    if (!env.IMAGES) return fail('File storage is not configured on this deployment.', 503);
    if (!Object.hasOwn(FIN_PROOF_TYPES, proof.type)) return fail('Proof must be a photo (JPEG, PNG, WEBP) or a PDF.', 422);
    if (proof.size > FIN_PROOF_MAX) return fail('Proof must be under 8 MB.', 422);
    proofKey = `finance/receipts/${id}.${FIN_PROOF_TYPES[proof.type]}`;
    await env.IMAGES.put(proofKey, await proof.arrayBuffer(), { httpMetadata: { contentType: proof.type } });
  }
  await env.DB.prepare(
    `INSERT INTO receipts (id, invoice_id, transaction_id, amount, received_on, mode, reference, proof_key, proof_content_type, created_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(id, invoiceId, inv.transaction_id, amount, receivedOn, mode, finText(body.reference, 200), proofKey, proof ? proof.type : null, actorUserId(actor)).run();
  const updated = await finSyncInvoice(env, invoiceId);
  return json({ ok: true, receipt_id: id, invoice: updated, ...(await finBundle(env, inv.transaction_id)) }, 201);
}

/** POST /api/receipts/:id/reverse — keeps the row, marks it reversed, re-opens the invoice balance. */
async function handleReverseReceipt(request, env, receiptId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const rec = await env.DB.prepare('SELECT * FROM receipts WHERE id = ?1').bind(receiptId).first();
  if (!rec) return fail('Payment not found.', 404);
  if (rec.status === 'reversed') return fail('This payment is already reversed.', 409);
  const body = await bodyJson(request);
  const reason = finText(body?.reason, 500);
  if (!reason) return fail('Say why the payment is reversed (e.g. cheque bounced).', 422);
  await env.DB.prepare("UPDATE receipts SET status = 'reversed', reverse_reason = ?2, reversed_at = datetime('now'), reversed_by_user_id = ?3 WHERE id = ?1 AND status = 'active'")
    .bind(receiptId, reason, actorUserId(actor)).run();
  await finSyncInvoice(env, rec.invoice_id);
  return json({ ok: true, ...(await finBundle(env, rec.transaction_id)) });
}

async function handleReceiptProof(env, receiptId, actor) {
  if (!finCanRead(actor)) return finNoRead();
  const rec = await env.DB.prepare('SELECT proof_key, proof_content_type FROM receipts WHERE id = ?1').bind(receiptId).first();
  if (!rec?.proof_key) return fail('No proof attached to this payment.', 404);
  if (!env.IMAGES) return fail('File storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(rec.proof_key);
  if (!object) return fail('Proof file not found.', 404);
  return new Response(object.body, { headers: { 'content-type': rec.proof_content_type || 'application/octet-stream', 'cache-control': 'private, no-store' } });
}

/** POST /api/expenses (transaction optional) and POST /api/transactions/:id/expenses. */
async function handleCreateExpense(request, env, txnIdFromPath, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const body = await bodyJson(request);
  if (!body) return fail('Send the expense as JSON.', 400);
  const txnId = txnIdFromPath || finText(body.transaction_id, 80);
  if (txnId && !(await finTransaction(env, txnId))) return fail('Transaction not found.', 404);
  const category = finText(body.category, 80);
  if (!category) return fail('Choose what the expense was for.', 422);
  const amount = finAmount(body.amount);
  if (!amount) return fail('Enter the expense amount.', 422);
  const spentOn = body.spent_on ? finDate(body.spent_on) : finToday();
  if (!spentOn) return fail('Pick a valid date.', 422);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO expenses (id, transaction_id, category, amount, spent_on, paid_by, note, created_by_user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, txnId || null, category, amount, spentOn, finText(body.paid_by, 120), finText(body.note, 2000), actorUserId(actor)).run();
  return json({ ok: true, expense_id: id, ...(txnId ? await finBundle(env, txnId) : {}) }, 201);
}

async function handleCancelExpense(request, env, expenseId, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const row = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?1').bind(expenseId).first();
  if (!row) return fail('Expense not found.', 404);
  if (row.status === 'cancelled') return fail('This expense is already cancelled.', 409);
  const body = await bodyJson(request);
  await env.DB.prepare("UPDATE expenses SET status = 'cancelled', cancel_reason = ?2, cancelled_at = datetime('now') WHERE id = ?1").bind(expenseId, finText(body?.reason, 500)).run();
  return json({ ok: true, ...(row.transaction_id ? await finBundle(env, row.transaction_id) : {}) });
}

/** POST /api/transactions/:id/payouts — anyone who may change the transaction
 *  (or finance) can propose a partner's share; it then waits for finance approval. */
async function handleCreatePayout(request, env, txnId, actor) {
  if (!has(actor, 'finance.write') && !has(actor, 'transaction.write')) return finNoWrite();
  const txn = await finTransaction(env, txnId);
  if (!txn) return fail('Transaction not found.', 404);
  const body = await bodyJson(request);
  if (!body) return fail('Send the payout as JSON.', 400);
  const name = finText(body.partner_name, 160);
  if (!name) return fail('Who gets this payout?', 422);
  const type = FIN_PARTNER_TYPES.includes(body.partner_type) ? body.partner_type : 'channel_partner';
  const basis = body.share_basis === 'percent' ? 'percent' : 'fixed';
  let rate = null, amount;
  if (basis === 'percent') {
    rate = finAmount(body.share_rate);
    if (!rate || rate > 100) return fail('Enter the share % (of the brokerage).', 422);
    const b = await env.DB.prepare("SELECT expected_amount FROM brokerage WHERE transaction_id = ?1 AND status != 'cancelled'").bind(txnId).first();
    if (!b?.expected_amount) return fail('Set the brokerage first, or enter a fixed amount.', 422);
    amount = finRound(b.expected_amount * rate / 100);
  } else {
    amount = finAmount(body.amount);
    if (!amount) return fail('Enter the payout amount.', 422);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO partner_payouts (id, transaction_id, partner_name, partner_type, share_basis, share_rate, amount, note, created_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(id, txnId, name, type, basis, rate, amount, finText(body.note, 2000), actorUserId(actor)).run();
  await raiseAlert(env, {
    importance: 'medium', to: { roles: ['finance'] },
    title: `Payout waiting for approval: ${name}`,
    body: `${finRupees(amount)} on ${txn.txn_code || 'a transaction'}${txn.lead_name ? ' (' + txn.lead_name + ')' : ''}.`,
    link: { kind: 'transaction', id: txnId },
  });
  return json({ ok: true, payout_id: id, ...(await finBundle(env, txnId)) }, 201);
}

/** POST /api/payouts/:id/(approve|paid|cancel) — finance only. */
async function handlePayoutAction(request, env, payoutId, action, actor) {
  if (!has(actor, 'finance.write')) return finNoWrite();
  const p = await env.DB.prepare('SELECT * FROM partner_payouts WHERE id = ?1').bind(payoutId).first();
  if (!p) return fail('Payout not found.', 404);
  const body = (await bodyJson(request)) || {};
  if (action === 'approve') {
    if (p.status !== 'pending') return fail('Only a pending payout can be approved.', 409);
    await env.DB.prepare("UPDATE partner_payouts SET status = 'approved', approved_by_user_id = ?2, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND status = 'pending'")
      .bind(payoutId, actorUserId(actor)).run();
  } else if (action === 'paid') {
    if (p.status !== 'approved') return fail('Approve the payout before marking it paid.', 409);
    const paidOn = body.paid_on ? finDate(body.paid_on) : finToday();
    if (!paidOn) return fail('Pick a valid payment date.', 422);
    await env.DB.prepare("UPDATE partner_payouts SET status = 'paid', paid_on = ?2, payment_reference = ?3, updated_at = datetime('now') WHERE id = ?1 AND status = 'approved'")
      .bind(payoutId, paidOn, finText(body.payment_reference, 200)).run();
  } else {
    if (p.status === 'paid') return fail('This payout is already paid and cannot be cancelled.', 409);
    if (p.status === 'cancelled') return fail('This payout is already cancelled.', 409);
    await env.DB.prepare("UPDATE partner_payouts SET status = 'cancelled', cancel_reason = ?2, cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1")
      .bind(payoutId, finText(body.reason, 500)).run();
  }
  return json({ ok: true, ...(await finBundle(env, p.transaction_id)) });
}

/** GET /api/finance/overview?from&to&team_id&rm — Post-Sales → Finance page.
 *  Expected = brokerage due in the period, Invoiced = issued in the period,
 *  Collected = received in the period; Outstanding / overdue / ageing are as of today. */
async function handleFinanceOverview(request, env, actor) {
  if (!finCanRead(actor)) return finNoRead();
  const url = new URL(request.url);
  const today = finToday();
  const from = finDate(url.searchParams.get('from')) || today.slice(0, 8) + '01';
  const to = finDate(url.searchParams.get('to')) || finAddDays(finAddDays(today.slice(0, 8) + '01', 32).slice(0, 8) + '01', -1);
  const teamId = finText(url.searchParams.get('team_id'), 80);
  const rmId = finText(url.searchParams.get('rm'), 80);
  // ?1 team, ?2 rm, ?3 from, ?4 to, ?5 today
  const ft = `WITH ft AS (
      SELECT t.id, t.txn_code, t.relationship_manager_user_id AS rm_id, rmu.name AS rm_name,
             COALESCE(rmu.team_id, l.team_id) AS team_id, tm.name AS team_name,
             COALESCE(l.source, 'unknown') AS lead_source, l.customer_name AS lead_name
        FROM transactions t
        LEFT JOIN leads l ON l.id = t.lead_id
        LEFT JOIN users rmu ON rmu.id = t.relationship_manager_user_id
        LEFT JOIN teams tm ON tm.id = COALESCE(rmu.team_id, l.team_id)
       WHERE (?1 IS NULL OR COALESCE(rmu.team_id, l.team_id) = ?1) AND (?2 IS NULL OR t.relationship_manager_user_id = ?2)
         AND ?3 IS NOT NULL AND ?4 IS NOT NULL AND ?5 IS NOT NULL)`; // every query binds all five
  const q = (sql) => env.DB.prepare(ft + sql).bind(teamId, rmId, from, to, today).all().then((r) => r.results || []);
  let perTxn, liveInvoices, pendingPayouts, recentReceipts, recentExpenses;
  try {
    [perTxn, liveInvoices, pendingPayouts, recentReceipts, recentExpenses] = await Promise.all([
      q(`SELECT ft.*,
           (SELECT COALESCE(SUM(b.expected_amount), 0) FROM brokerage b WHERE b.transaction_id = ft.id AND b.status != 'cancelled' AND b.due_date BETWEEN ?3 AND ?4) AS expected,
           (SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i WHERE i.transaction_id = ft.id AND i.status IN ${FIN_LIVE_SQL} AND i.issue_date BETWEEN ?3 AND ?4) AS invoiced,
           (SELECT COALESCE(SUM(r.amount), 0) FROM receipts r JOIN invoices i ON i.id = r.invoice_id
             WHERE r.transaction_id = ft.id AND r.status = 'active' AND i.status IN ${FIN_LIVE_SQL} AND r.received_on BETWEEN ?3 AND ?4) AS collected
         FROM ft`),
      q(`SELECT i.id, i.invoice_no, i.transaction_id, i.billed_to, i.total_amount, i.issue_date, i.due_date, i.status,
                ft.txn_code, ft.lead_name, ft.rm_name, ft.team_id, ft.rm_id, ft.lead_source,
                COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.invoice_id = i.id AND r.status = 'active'), 0) AS paid_amount
           FROM invoices i JOIN ft ON ft.id = i.transaction_id WHERE i.status IN ${FIN_LIVE_SQL}`),
      q(`SELECT p.*, ft.txn_code, ft.lead_name, ft.rm_name FROM partner_payouts p JOIN ft ON ft.id = p.transaction_id
          WHERE p.status IN ('pending', 'approved') ORDER BY p.status DESC, p.created_at`),
      q(`SELECT r.id, r.amount, r.received_on, r.mode, r.reference, r.status, (r.proof_key IS NOT NULL) AS has_proof, r.transaction_id,
                i.invoice_no, i.billed_to, ft.txn_code, ft.lead_name
           FROM receipts r JOIN invoices i ON i.id = r.invoice_id JOIN ft ON ft.id = r.transaction_id
          WHERE r.received_on BETWEEN ?3 AND ?4 ORDER BY r.received_on DESC, r.created_at DESC LIMIT 25`),
      q(`SELECT e.*, ft.txn_code FROM expenses e LEFT JOIN ft ON ft.id = e.transaction_id
          WHERE e.spent_on BETWEEN ?3 AND ?4 AND (e.transaction_id IS NULL AND ?1 IS NULL AND ?2 IS NULL OR ft.id IS NOT NULL)
          ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 25`),
    ]);
  } catch (e) {
    console.error('finance overview failed (transactions table missing?)', e);
    return json({ ready: false, from, to, error: 'Transactions are not set up yet.' });
  }
  const invoices = liveInvoices.map((i) => {
    const balance = finRound(i.total_amount - i.paid_amount);
    const daysOverdue = i.due_date && i.due_date < today ? Math.round((Date.parse(today) - Date.parse(i.due_date)) / 86400000) : 0;
    return { ...i, paid_amount: finRound(i.paid_amount), balance, days_overdue: daysOverdue };
  }).filter((i) => i.balance > 0.005);
  const overdue = invoices.filter((i) => i.days_overdue > 0).sort((a, b) => b.days_overdue - a.days_overdue);
  const ageing = { not_due: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const i of invoices) {
    const k = !i.days_overdue ? 'not_due' : i.days_overdue <= 30 ? 'd0_30' : i.days_overdue <= 60 ? 'd31_60' : i.days_overdue <= 90 ? 'd61_90' : 'd90_plus';
    ageing[k] = finRound(ageing[k] + i.balance);
  }
  const outstandingByTxn = {};
  for (const i of invoices) outstandingByTxn[i.transaction_id] = finRound((outstandingByTxn[i.transaction_id] || 0) + i.balance);
  const group = (keyOf, labelOf) => {
    const map = new Map();
    for (const t of perTxn) {
      const key = keyOf(t) || 'none';
      const g = map.get(key) || { key, label: labelOf(t), expected: 0, invoiced: 0, collected: 0, outstanding: 0, transactions: 0 };
      g.expected = finRound(g.expected + t.expected); g.invoiced = finRound(g.invoiced + t.invoiced);
      g.collected = finRound(g.collected + t.collected); g.outstanding = finRound(g.outstanding + (outstandingByTxn[t.id] || 0));
      g.transactions++;
      map.set(key, g);
    }
    return [...map.values()].filter((g) => g.expected || g.invoiced || g.collected || g.outstanding)
      .sort((a, b) => (b.expected + b.invoiced + b.outstanding) - (a.expected + a.invoiced + a.outstanding));
  };
  const total = (f) => finRound(perTxn.reduce((s, t) => s + (Number(f(t)) || 0), 0));
  return json({
    ready: true, from, to, today,
    tiles: {
      expected: total((t) => t.expected), invoiced: total((t) => t.invoiced), collected: total((t) => t.collected),
      outstanding: finRound(invoices.reduce((s, i) => s + i.balance, 0)),
      overdue_count: overdue.length, overdue_amount: finRound(overdue.reduce((s, i) => s + i.balance, 0)),
      expenses: finRound(recentExpenses.filter((e) => e.status === 'active').reduce((s, e) => s + e.amount, 0)),
    },
    ageing,
    overdue_invoices: overdue.slice(0, 50),
    payouts: pendingPayouts,
    recent_receipts: recentReceipts,
    recent_expenses: recentExpenses,
    by_team: group((t) => t.team_id, (t) => t.team_name || 'No team'),
    by_member: group((t) => t.rm_id, (t) => t.rm_name || 'No relationship manager'),
    by_source: group((t) => t.lead_source, (t) => t.lead_source || 'Unknown'),
    can_write: has(actor, 'finance.write'),
  });
}

/** Daily (cron): one medium alert per invoice the first day it is overdue, to
 *  finance + the deal owners. De-duplicated with invoices.overdue_alerted_at
 *  (cleared again if the due date is moved). */
async function runFinanceOverdueJob(env) {
  const today = finToday();
  let rows;
  try {
    rows = (await env.DB.prepare(
      `SELECT i.*, COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.invoice_id = i.id AND r.status = 'active'), 0) AS paid_amount
         FROM invoices i WHERE i.status IN ('sent', 'partly_paid') AND i.due_date IS NOT NULL AND i.due_date < ?1 AND i.overdue_alerted_at IS NULL
        ORDER BY i.due_date LIMIT 200`
    ).bind(today).all()).results || [];
  } catch (e) { console.error('finance overdue job: invoices unavailable', e); return { ok: false, alerted: 0 }; }
  let alerted = 0;
  for (const inv of rows) {
    const balance = finRound(inv.total_amount - inv.paid_amount);
    if (balance <= 0.005) continue;
    const txn = await finTransaction(env, inv.transaction_id);
    await raiseAlert(env, {
      importance: 'medium', to: { roles: ['finance'], userIds: finDealOwners(txn) },
      title: `Invoice ${inv.invoice_no} is overdue`,
      body: `${inv.billed_to} still owes ${finRupees(balance)} (due ${inv.due_date})${txn?.txn_code ? ' on ' + txn.txn_code : ''}.`,
      link: { kind: 'transaction', id: inv.transaction_id },
    });
    await env.DB.prepare("UPDATE invoices SET overdue_alerted_at = datetime('now') WHERE id = ?1").bind(inv.id).run();
    alerted++;
  }
  return { ok: true, alerted };
}

/** Finance routes; null when the path is not ours. */
async function routeFinance(path, request, env, actor) {
  if (!/^\/api\/(finance|invoices|receipts|expenses|payouts|transactions\/[^/]+\/(finance|brokerage|invoices|expenses|payouts))(\/|$)/.test(path)) return null;
  const m = request.method;
  let x;
  if ((x = path.match(/^\/api\/transactions\/([^/]+)\/finance$/)) && m === 'GET') return handleTxnFinance(env, x[1], actor);
  if ((x = path.match(/^\/api\/transactions\/([^/]+)\/brokerage$/)) && m === 'PUT') return handlePutBrokerage(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/transactions\/([^/]+)\/invoices$/)) && m === 'POST') return handleCreateInvoice(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/transactions\/([^/]+)\/expenses$/)) && m === 'POST') return handleCreateExpense(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/transactions\/([^/]+)\/payouts$/)) && m === 'POST') return handleCreatePayout(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/invoices\/([^/]+)$/)) && m === 'PATCH') return handleUpdateInvoice(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/invoices\/([^/]+)\/receipts$/)) && m === 'POST') return handleRecordReceipt(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/receipts\/([^/]+)\/reverse$/)) && m === 'POST') return handleReverseReceipt(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/receipts\/([^/]+)\/proof$/)) && m === 'GET') return handleReceiptProof(env, x[1], actor);
  if (path === '/api/expenses' && m === 'POST') return handleCreateExpense(request, env, null, actor);
  if ((x = path.match(/^\/api\/expenses\/([^/]+)\/cancel$/)) && m === 'POST') return handleCancelExpense(request, env, x[1], actor);
  if ((x = path.match(/^\/api\/payouts\/([^/]+)\/(approve|paid|cancel)$/)) && m === 'POST') return handlePayoutAction(request, env, x[1], x[2], actor);
  if (path === '/api/finance/overview' && m === 'GET') return handleFinanceOverview(request, env, actor);
  if (path === '/api/finance/run-overdue' && m === 'POST') {
    if (actor.role !== 'super_admin') return fail('Only the super administrator can run this.', 403);
    return json(await runFinanceOverdueJob(env));
  }
  return null;
}
// ---- end Finance for transactions (wave3 H4) ----

// ---------------------------------------------------------------------------

async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!path.startsWith('/api/')) {
      return fail('Not found.', 404);
    }

    if (path === '/api/health') {
      return json({ ok: true, service: 'realestate-crm', time: new Date().toISOString() });
    }

    if (path === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/public/enquiries' && request.method === 'POST') return handlePublicEnquiry(request, env);
    if (path === '/api/public/properties' && request.method === 'GET') return handlePublicProperties(env);
    if (path === '/api/branding/logo' && request.method === 'GET') return handleServeBrochureLogo(env);

    // Public and unauthenticated on purpose — see handleServeImage's comment.
    const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
    if (imageMatch && request.method === 'GET') return handleServeImage(env, imageMatch[1]);
    // Hunting site photos — also public on purpose, see handleServeHuntingImage.
    const huntingImageMatch = path.match(/^\/api\/hunting-images\/([^/]+)$/);
    if (huntingImageMatch && request.method === 'GET') return handleServeHuntingImage(env, huntingImageMatch[1]);
    // Project brochures/documents — also public on purpose, see handleServeProjectDocument.
    const projectDocServeMatch = path.match(/^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/);
    if (projectDocServeMatch && request.method === 'GET') return handleServeProjectDocument(request, env, projectDocServeMatch[1], projectDocServeMatch[2]);

    const builderLogoMatch = path.match(/^\/api\/builders\/([^/]+)\/logo$/);
    if (builderLogoMatch && request.method === 'GET') return handleServeBuilderLogo(env, builderLogoMatch[1]);

    const intake = path.match(/^\/api\/intake\/([a-z0-9_-]+)$/i);
    if (intake) {
      // GET is allowed because some portals deliver leads as a query string
      // on a plain GET rather than as a POST body.
      if (request.method !== 'POST' && request.method !== 'GET') {
        return fail('Use POST or GET.', 405);
      }
      return handleIntake(request, env, intake[1].toLowerCase());
    }

    // All workspace routes accept the super-admin token or an employee token.
    // Authorization is checked again in every handler, against the current
    // employee role and any per-user allow/deny overrides.
    const actor = await authenticate(request, env);
    if (!actor) return fail('Unauthorized.', 401);
    // NOCs, workstream checklist, Post-Sales dashboard (wave3, H2 — src/transaction_workstreams.js); null = not ours.
    { const wsRes = await routeTransactionWorkstreams(request, env, actor, path, { has, raiseAlert }); if (wsRes) return wsRes; }
    // Token / bookings + transactions core (wave3, H1 — src/transactions.js); null = not ours.
    { const txRes = await routeTransactions(request, env, actor, path, { has, raiseAlert, canReadLead, canUpdateLead, parseMoney, actorUserId, recordCodeQuery }); if (txRes) return txRes; }

    if (path === '/api/auth/logout' && request.method === 'POST') return handleLogout(env, actor);
    if (path === '/api/auth/change-password' && request.method === 'POST') return handleChangePassword(request, env, actor);
    { const pwm = path.match(/^\/api\/users\/([^/]+)\/password$/); if (pwm && request.method === 'POST') return handleSetUserPassword(request, env, pwm[1], actor); }
    if (path === '/api/me' && request.method === 'GET') return json({ user: { id: actor.id, name: actor.name, email: actor.email || null, role: actor.role, team_id: actor.team_id || null, permissions: ROLE_PERMISSIONS[actor.role] || [], overrides: parseOverrides(actor.permission_overrides) } });
    if (path === '/api/dashboard' && request.method === 'GET') return handleDashboard(env, actor);
    if (path === '/api/portal-links' && request.method === 'GET') return handlePortalLinks(request, env, actor);
    if (path === '/api/leads' && request.method === 'GET') return handleListLeads(request, env, actor);
    if (path === '/api/leads/summary' && request.method === 'GET') return handleLeadSummary(request, env, actor);
    if (path === '/api/leads/projects' && request.method === 'GET') return handleLeadProjects(request, env, actor);
    if (path === '/api/leads' && request.method === 'POST') return handleCreateManualLead(request, env, actor);
    if (path === '/api/analytics/leads' && request.method === 'GET') return handleLeadAnalytics(request, env, actor);
    if (path === '/api/tasks' && request.method === 'GET') return handleListTasks(request, env, actor);
    if (path === '/api/tasks' && request.method === 'POST') return handleCreateTask(request, env, actor);
    if (path === '/api/tasks/stats' && request.method === 'GET') return handleTaskStats(request, env, actor);
    if (path === '/api/tasks/summary' && request.method === 'GET') return handleTaskSummary(request, env, actor);
    if (path === '/api/tasks/clear-completed' && request.method === 'POST') return handleClearCompletedTasks(request, env, actor);
    if (path === '/api/task-lists' && request.method === 'POST') return handleTaskListWrite(request, env, actor, null);
    const taskListMatch = path.match(/^\/api\/task-lists\/([^/]+)$/);
    if (taskListMatch && ['PATCH', 'DELETE'].includes(request.method)) return handleTaskListWrite(request, env, actor, taskListMatch[1]);
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'PATCH') return handleUpdateTask(request, env, taskMatch[1], actor);
    if (taskMatch && request.method === 'DELETE') return handleDeleteTask(env, taskMatch[1], actor);
    if (path === '/api/assistant' && request.method === 'GET') return handleAssistantStatus(env, actor);
    if (path === '/api/assistant/chat' && request.method === 'POST') {
      const ws = await env.DB.prepare('SELECT value FROM workspace_settings WHERE key = ?1').bind('business_name').first().catch(() => null);
      return handleAssistantChat(request, env, actor, ws?.value || DEFAULT_WORKSPACE_SETTINGS.business_name);
    }
    if (path === '/api/assistant/transcribe' && request.method === 'POST') return handleAssistantTranscribe(request, env, actor);
    if (path === '/api/notifications' && request.method === 'GET') return handleListNotifications(request, env, actor);
    if (path === '/api/notifications/read' && request.method === 'POST') return handleMarkNotificationsRead(env, actor);
    // alerts (wave3)
    if (path === '/api/alerts' && request.method === 'GET') return handleListAlerts(request, env, actor);
    if (path === '/api/alerts' && request.method === 'POST') return handleSendAlert(request, env, actor);
    if (path === '/api/alerts/read-all' && request.method === 'POST') return handleAlertReadAll(env, actor);
    { const m = path.match(/^\/api\/alerts\/([^/]+)\/(read|ack)$/); if (m && request.method === 'POST') return handleAlertMark(env, actor, decodeURIComponent(m[1]), m[2]); }
    if (path === '/api/analytics/supply-gap' && request.method === 'GET') return handleSupplyGap(request, env, actor);
    if (path === '/api/analytics/sources' && request.method === 'GET') return handleSourceAnalytics(request, env, actor);
    if (path === '/api/analytics/lost-reasons' && request.method === 'GET') return handleLostReasonAnalytics(request, env, actor); // wave3 C

    const appraisalMatch = path.match(/^\/api\/reports\/employee\/([^/]+)$/);
    if (appraisalMatch && request.method === 'GET') return handleEmployeeAppraisal(request, env, appraisalMatch[1], actor);

    if (path === '/api/assignment-approvals' && request.method === 'GET') return handleListAssignmentApprovals(env, actor);
    if (path === '/api/settings' && (request.method === 'GET' || request.method === 'PATCH')) return handleWorkspaceSettings(request, env, actor);
    // ---- Background jobs (Agent OPS): digest + backups ----
    if (path === '/api/digest/me' && request.method === 'GET') return handleMyDigest(env, actor);
    if (path === '/api/digest/run' && request.method === 'POST') return handleRunDigest(env, actor);
    if (path === '/api/backups' && request.method === 'GET') return handleListBackups(env, actor);
    if (path === '/api/backups/run' && request.method === 'POST') return handleRunBackup(env, actor);
    const backupDownloadMatch = path.match(/^\/api\/backups\/([^/]+)\/download$/);
    if (backupDownloadMatch && request.method === 'GET') return handleDownloadBackup(env, backupDownloadMatch[1], actor);
    // ---- end Agent OPS routes ----
    // ---- Backup export + restore (wave3 J) ----
    if (path === '/api/backups/export' && request.method === 'GET') return handleExportBackup(env, actor);
    if (path === '/api/backups/restore/preview' && request.method === 'POST') return handleRestorePreview(request, env, actor, null);
    if (path === '/api/backups/restore' && request.method === 'POST') return handleRestore(request, env, actor, null);
    const bkrRestoreMatch = path.match(/^\/api\/backups\/([^/]+)\/restore(\/preview)?$/);
    if (bkrRestoreMatch && request.method === 'POST') return bkrRestoreMatch[2] ? handleRestorePreview(request, env, actor, bkrRestoreMatch[1]) : handleRestore(request, env, actor, bkrRestoreMatch[1]);
    { const financeRes = await routeFinance(path, request, env, actor); if (financeRes) return financeRes; } // wave3 H4 finance
    if (path === '/api/properties' && request.method === 'GET') return handleListProperties(request, env, actor);
    if (path === '/api/projects' && request.method === 'GET') return handleListProjects(env, actor);
    const favouriteMatch = path.match(/^\/api\/favourites\/(property|project)\/([^/]+)$/);
    if (favouriteMatch && (request.method === 'PUT' || request.method === 'DELETE')) return handleSetFavourite(env, actor, favouriteMatch[1], favouriteMatch[2], request.method === 'PUT');
    if (path === '/api/projects/matches' && request.method === 'GET') return handleProjectMatches(request, env, actor);
    if (path === '/api/projects' && request.method === 'POST') return handleCreateProject(request, env, actor);
    const projectUnitsMatch = path.match(/^\/api\/projects\/([^/]+)\/units$/);
    if (projectUnitsMatch && request.method === 'POST') return handleAddProjectUnits(request, env, projectUnitsMatch[1], actor);
    const projectUnitMatch = path.match(/^\/api\/projects\/([^/]+)\/units\/([^/]+)$/);
    if (projectUnitMatch && request.method === 'PATCH') return handleUpdateProjectUnit(request, env, projectUnitMatch[1], projectUnitMatch[2], actor);
    if (projectUnitMatch && request.method === 'DELETE') return handleDeleteProjectUnit(env, projectUnitMatch[1], projectUnitMatch[2], actor);
    const projectTokensMatch = path.match(/^\/api\/projects\/([^/]+)\/tokens$/);
    if (projectTokensMatch && request.method === 'PUT') return handleReplaceProjectTokens(request, env, projectTokensMatch[1], actor);
    const projectDocsMatch = path.match(/^\/api\/projects\/([^/]+)\/documents$/);
    if (projectDocsMatch && request.method === 'POST') return handleUploadProjectDocument(request, env, projectDocsMatch[1], actor);
    const projectDocMatch = path.match(/^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/);
    if (projectDocMatch && request.method === 'DELETE') return handleDeleteProjectDocument(env, projectDocMatch[1], projectDocMatch[2], actor);
    // ---- Document control (wave3, H3) ----
    if (path === '/api/documents' && request.method === 'GET') return handleListDocuments(request, env, actor);
    if (path === '/api/documents' && request.method === 'POST') return handleCreateDocument(request, env, actor);
    const docDownloadMatch = path.match(/^\/api\/documents\/([^/]+)\/versions\/(\d+|latest)\/download$/);
    if (docDownloadMatch && request.method === 'GET') return handleDownloadDocument(request, env, docDownloadMatch[1], docDownloadMatch[2], actor);
    const docVersionsMatch = path.match(/^\/api\/documents\/([^/]+)\/versions$/);
    if (docVersionsMatch && request.method === 'POST') return handleAddDocumentVersion(request, env, docVersionsMatch[1], actor);
    const docReviewMatch = path.match(/^\/api\/documents\/([^/]+)\/review$/);
    if (docReviewMatch && request.method === 'POST') return handleReviewDocument(request, env, docReviewMatch[1], actor);
    const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (docMatch && request.method === 'GET') return handleGetDocument(env, docMatch[1], actor);
    if (docMatch && request.method === 'PATCH') return handleUpdateDocument(request, env, docMatch[1], actor);
    if (path === '/api/properties' && request.method === 'POST') return handleCreateProperty(request, env, actor);

    const propertyUpdateMatch = path.match(/^\/api\/properties\/([^/]+)$/);
    if (propertyUpdateMatch && request.method === 'PATCH') return handleUpdateProperty(request, env, propertyUpdateMatch[1], actor);
    // inventory status / team / zones / hunting KPIs (wave3 G)
    const propertyInventoryMatch = path.match(/^\/api\/properties\/([^/]+)\/inventory$/);
    if (propertyInventoryMatch && request.method === 'POST') return handleSetPropertyInventory(request, env, propertyInventoryMatch[1], actor);
    const projectZoneMatch = path.match(/^\/api\/projects\/([^/]+)\/zone$/);
    if (projectZoneMatch && request.method === 'PUT') return handleSetProjectZone(request, env, projectZoneMatch[1], actor);
    if (path === '/api/hunting-performance' && request.method === 'GET') return handleHuntingPerformance(request, env, actor);
    const propertyKeysMatch = path.match(/^\/api\/properties\/([^/]+)\/keys(?:\/([^/]+)(\/custody)?)?$/);
    if (propertyKeysMatch) return handlePropertyKeys(request, env, propertyKeysMatch[1], propertyKeysMatch[2], !!propertyKeysMatch[3], actor);
    if (path === '/api/builders' && request.method === 'GET') return handleListBuilders(env, actor);
    if (path === '/api/builders' && request.method === 'POST') return handleUpsertBuilder(request, env, actor);
    const builderLogoUploadMatch = path.match(/^\/api\/builders\/([^/]+)\/logo$/);
    if (builderLogoUploadMatch && request.method === 'POST') return handleUploadBuilderLogo(request, env, builderLogoUploadMatch[1], actor);
    if (path === '/api/users' && request.method === 'GET') return handleListUsers(env, actor);
    if (path === '/api/users' && request.method === 'POST') return handleCreateUser(request, env, actor);

    if (path === '/api/teams' && request.method === 'GET') {
      if (!has(actor, 'team.read')) return fail('You do not have permission to view teams.', 403);
      const { results } = await env.DB.prepare(
        `SELECT t.*, m.name AS manager_name
           FROM teams t LEFT JOIN users m ON m.id = t.manager_user_id
          ORDER BY t.name`
      ).all();
      return json({ teams: results ?? [] });
    }
    if (path === '/api/teams' && request.method === 'POST') return handleCreateTeam(request, env, actor);

    const teamUpdateMatch = path.match(/^\/api\/teams\/([^/]+)$/);
    if (teamUpdateMatch && request.method === 'PATCH') return handleUpdateTeam(request, env, teamUpdateMatch[1], actor);

    if (path === '/api/auto-assign-approval' && request.method === 'PUT') return handleSetAutoAssignApproval(request, env, actor);
    const leadArchiveMatch = path.match(/^\/api\/leads\/([^/]+)\/archive$/);
    if (leadArchiveMatch && request.method === 'POST') return handleArchiveLead(request, env, leadArchiveMatch[1], actor);
    const leadDeleteMatch = path.match(/^\/api\/leads\/([^/]+)$/);
    if (leadDeleteMatch && request.method === 'DELETE') return handleDeleteLead(env, leadDeleteMatch[1], actor);
    if (path === '/api/budget-rules' && request.method === 'GET') return handleListBudgetRules(env, actor);
    if (path === '/api/budget-rules' && request.method === 'POST') return handleCreateBudgetRule(request, env, actor);
    const budgetRuleMatch = path.match(/^\/api\/budget-rules\/([^/]+)$/);
    if (budgetRuleMatch && request.method === 'PATCH') return handleUpdateBudgetRule(request, env, budgetRuleMatch[1], actor);
    if (budgetRuleMatch && request.method === 'DELETE') return handleDeleteBudgetRule(env, budgetRuleMatch[1], actor);

    if (path === '/api/rules' && request.method === 'GET') {
      if (!has(actor, 'team.read')) return fail('You do not have permission to view routing rules.', 403);
      const { results } = await env.DB.prepare(
        `SELECT r.*, t.name AS team_name
           FROM routing_rules r LEFT JOIN teams t ON t.id = r.team_id
          ORDER BY ((match_source IS NOT NULL) + (match_property_type IS NOT NULL)) DESC,
                   priority ASC, id ASC`
      ).all();
      return json({ rules: results ?? [] });
    }

    const assignMatch = path.match(/^\/api\/leads\/([^/]+)\/assign$/);
    if (assignMatch) {
      if (request.method !== 'POST') return fail('Use POST.', 405);
      return handleAssignLead(request, env, assignMatch[1], actor);
    }

    const assignmentApprovalMatch = path.match(/^\/api\/assignment-approvals\/([^/]+)\/decide$/);
    if (assignmentApprovalMatch) {
      if (request.method !== 'POST') return fail('Use POST.', 405);
      return handleDecideAssignmentApproval(request, env, assignmentApprovalMatch[1], actor);
    }

    const activityMatch = path.match(/^\/api\/leads\/([^/]+)\/activities$/);
    if (activityMatch && request.method === 'POST') return handleCreateActivity(request, env, activityMatch[1], actor);

    const discussedMatch = path.match(/^\/api\/leads\/([^/]+)\/discussed-properties$/);
    if (discussedMatch && request.method === 'POST') return handleAddDiscussedProperty(request, env, discussedMatch[1], actor);

    const discussedItemMatch = path.match(/^\/api\/leads\/([^/]+)\/discussed-properties\/([^/]+)$/);
    if (discussedItemMatch && request.method === 'DELETE') return handleRemoveDiscussedProperty(env, discussedItemMatch[1], discussedItemMatch[2], actor);

    // Site visits (wave3, F)
    const leadVisitsMatch = path.match(/^\/api\/leads\/([^/]+)\/visits$/);
    if (leadVisitsMatch && request.method === 'GET') return handleListLeadVisits(env, leadVisitsMatch[1], actor);
    if (leadVisitsMatch && request.method === 'POST') return handleCreateVisit(request, env, leadVisitsMatch[1], actor);
    if (path === '/api/visits' && request.method === 'GET') return handleListVisits(request, env, actor);
    const visitMatch = path.match(/^\/api\/visits\/([^/]+)$/);
    if (visitMatch && request.method === 'PATCH') return handleUpdateVisit(request, env, visitMatch[1], actor);
    if (path === '/api/analytics/site-visits' && request.method === 'GET') return handleVisitAnalytics(request, env, actor);
    // wave3 E: requirement profile, options shared, price history
    const reqProfileMatch = path.match(/^\/api\/leads\/([^/]+)\/requirement-profile$/);
    if (reqProfileMatch && request.method === 'PUT') return handleSaveRequirementProfile(request, env, reqProfileMatch[1], actor);
    const shortlistMatch = path.match(/^\/api\/leads\/([^/]+)\/shortlist$/);
    if (shortlistMatch && request.method === 'GET') return handleListShortlist(env, shortlistMatch[1], actor);
    if (shortlistMatch && request.method === 'POST') return handleAddShortlist(request, env, shortlistMatch[1], actor);
    const shortlistItemMatch = path.match(/^\/api\/leads\/([^/]+)\/shortlist\/([^/]+)$/);
    if (shortlistItemMatch && ['PATCH', 'DELETE'].includes(request.method)) return handleShortlistItem(request, env, shortlistItemMatch[1], shortlistItemMatch[2], actor);
    const priceHistoryMatch = path.match(/^\/api\/properties\/([^/]+)\/price-history$/);
    if (priceHistoryMatch && request.method === 'GET') return handlePropertyPriceHistory(env, priceHistoryMatch[1], actor);

    const imageUploadMatch = path.match(/^\/api\/properties\/([^/]+)\/images$/);
    if (imageUploadMatch && request.method === 'POST') return handleUploadPropertyImage(request, env, imageUploadMatch[1], actor);

    const imageDeleteMatch = path.match(/^\/api\/properties\/([^/]+)\/images\/([^/]+)$/);
    if (imageDeleteMatch && request.method === 'DELETE') return handleDeletePropertyImage(env, imageDeleteMatch[1], imageDeleteMatch[2], actor);

    const imageUpdateMatch = path.match(/^\/api\/properties\/([^/]+)\/images\/([^/]+)$/);
    if (imageUpdateMatch && request.method === 'PATCH') return handleUpdatePropertyImage(request, env, imageUpdateMatch[1], imageUpdateMatch[2], actor);

    if (path === '/api/branding/logo' && request.method === 'POST') return handleUploadBrochureLogo(request, env, actor);
    if (path === '/api/branding/logo' && request.method === 'DELETE') return handleDeleteBrochureLogo(env, actor);

    const transferRequestMatch = path.match(/^\/api\/leads\/([^/]+)\/transfer-requests$/);
    if (transferRequestMatch && request.method === 'POST') return handleRequestTransfer(request, env, transferRequestMatch[1], actor);

    const transferResponseMatch = path.match(/^\/api\/transfers\/([^/]+)\/respond$/);
    if (transferResponseMatch && request.method === 'POST') return handleRespondTransfer(request, env, transferResponseMatch[1], actor);
    const transferCancelMatch = path.match(/^\/api\/transfers\/([^/]+)\/cancel$/);
    if (transferCancelMatch && request.method === 'POST') return handleCancelTransfer(env, transferCancelMatch[1], actor);
    if (path === '/api/transfers/incoming' && request.method === 'GET') return handleIncomingTransfers(env, actor);
    // ---- Pre-Sales handovers & calling list (wave3, agent D) ----
    if (path === '/api/handovers' && request.method === 'GET') return handleListHandovers(request, env, actor);
    if (path === '/api/handovers' && request.method === 'POST') return handleCreateHandover(request, env, actor);
    if (path === '/api/handovers/options' && request.method === 'GET') return handleHandoverOptions(env, actor);
    const handoverActionMatch = path.match(/^\/api\/handovers\/([^/]+)\/(respond|answer)$/);
    if (handoverActionMatch && request.method === 'POST') {
      return handoverActionMatch[2] === 'respond' ? handleRespondHandover(request, env, handoverActionMatch[1], actor) : handleAnswerHandover(request, env, handoverActionMatch[1], actor);
    }
    if (path === '/api/presales/calling-list' && request.method === 'GET') return handlePresalesCallingList(request, env, actor);
    if (path === '/api/presales/all-leads' && request.method === 'GET') return handlePresalesAllLeads(request, env, actor);
    if (path === '/api/presales/overview' && request.method === 'GET') return handlePresalesOverview(request, env, actor);
    // ---- end Pre-Sales routes ----

    const activityItemMatch = path.match(/^\/api\/leads\/([^/]+)\/activities\/([^/]+)$/);
    if (activityItemMatch && request.method === 'PATCH') return handleUpdateActivity(request, env, activityItemMatch[1], activityItemMatch[2], actor);

    // ---- employee leaves (wave3 A) ----
    if (path === '/api/users/former' && request.method === 'GET') return handleFormerUsers(env, actor);
    const offboardMatch = path.match(/^\/api\/users\/([^/]+)\/(offboard-preview|offboard|restore)$/);
    if (offboardMatch && offboardMatch[2] === 'offboard-preview' && request.method === 'GET') return handleOffboardPreview(env, offboardMatch[1], actor);
    if (offboardMatch && offboardMatch[2] === 'offboard' && request.method === 'POST') return handleOffboardUser(request, env, offboardMatch[1], actor);
    if (offboardMatch && offboardMatch[2] === 'restore' && request.method === 'POST') return handleRestoreUser(env, offboardMatch[1], actor);

    const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && request.method === 'PATCH') return handleUpdateUser(request, env, userMatch[1], actor);

    const updateLeadMatch = path.match(/^\/api\/leads\/([^/]+)$/);
    if (updateLeadMatch && request.method === 'PATCH') return handleUpdateLead(request, env, updateLeadMatch[1], actor);

    const leadMatch = path.match(/^\/api\/leads\/([^/]+)$/);
    if (leadMatch && request.method === 'GET') return handleGetLead(env, leadMatch[1], actor);

    // Property hunting (supply-side sourcing pipeline).
    if (path === '/api/hunting-summary' && request.method === 'GET') return handleHuntingSummary(env, actor);
    if (path === '/api/hunting-properties' && request.method === 'GET') return handleListHuntingProperties(env, actor);
    if (path === '/api/hunting-targets' && request.method === 'GET') return handleListHuntingTargets(request, env, actor);
    if (path === '/api/hunting-targets' && request.method === 'POST') return handleCreateHuntingTarget(request, env, actor);

    const huntingActivityMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/activities$/);
    if (huntingActivityMatch && request.method === 'POST') return handleCreateHuntingActivity(request, env, huntingActivityMatch[1], actor);

    const huntingConvertMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/convert$/);
    if (huntingConvertMatch && request.method === 'POST') return handleConvertHuntingTarget(request, env, huntingConvertMatch[1], actor);

    const huntingTargetMatch = path.match(/^\/api\/hunting-targets\/([^/]+)$/);
    if (huntingTargetMatch && request.method === 'GET') return handleGetHuntingTarget(env, huntingTargetMatch[1], actor);
    if (huntingTargetMatch && request.method === 'PATCH') return handleUpdateHuntingTarget(request, env, huntingTargetMatch[1], actor);

    // Property hunting, wave 2: owners, site visits, documents, photos.
    if (path === '/api/hunting-meta' && request.method === 'GET') return handleHuntingMeta(actor);
    if (path === '/api/hunting-owners' && request.method === 'GET') return handleListHuntingOwners(request, env, actor);
    if (path === '/api/hunting-owners' && request.method === 'POST') return handleCreateHuntingOwner(request, env, actor);
    const huntingOwnerMatch = path.match(/^\/api\/hunting-owners\/([^/]+)$/);
    if (huntingOwnerMatch && request.method === 'GET') return handleGetHuntingOwner(env, huntingOwnerMatch[1], actor);
    if (huntingOwnerMatch && request.method === 'PATCH') return handleUpdateHuntingOwner(request, env, huntingOwnerMatch[1], actor);
    const huntingVisitMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/site-visits$/);
    if (huntingVisitMatch && request.method === 'POST') return handleCreateHuntingSiteVisit(request, env, huntingVisitMatch[1], actor);
    const huntingDocMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/documents\/([^/]+)$/);
    if (huntingDocMatch && request.method === 'PUT') return handlePutHuntingDocument(request, env, huntingDocMatch[1], huntingDocMatch[2], actor);
    const huntingImageUploadMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/images$/);
    if (huntingImageUploadMatch && request.method === 'POST') return handleUploadHuntingImage(request, env, huntingImageUploadMatch[1], actor);
    const huntingImageDeleteMatch = path.match(/^\/api\/hunting-targets\/([^/]+)\/images\/([^/]+)$/);
    if (huntingImageDeleteMatch && request.method === 'DELETE') return handleDeleteHuntingImage(env, huntingImageDeleteMatch[1], huntingImageDeleteMatch[2], actor);

    return fail('Not found.', 404);

}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) {
      // Never swallow this silently — without a log line every runtime error
      // (a bad D1 query, a null-reference on a malformed record) is
      // invisible: the caller just sees 503, and Workers Logs shows nothing.
      console.error('Unhandled error:', request.method, new URL(request.url).pathname, e);
      return fail('Service temporarily unavailable. Please retry.', 503);
    }
  },

  // Cron trigger (wrangler.jsonc → triggers.crons). Runs the digest and backup
  // jobs independently — see runScheduledJobs (Agent OPS block).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledJobs(env, event.cron));
  },
};
