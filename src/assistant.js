/**
 * Super-admin AI assistant (Gemini) — chat + voice transcription.
 *
 * Accuracy: the model never sees the database directly. It can only call the
 * read-only tools below; every number, name and date it states must come from
 * a tool result (enforced by the system prompt, and tools return exact
 * counts so it never has to count rows itself).
 *
 * Cost: Flash-Lite at its default "minimal" thinking, short history, compact
 * tool results, capped output, a daily request limit, and a per-day usage
 * meter (ai_usage). The system prompt + tool list are a stable prefix, so
 * Gemini's implicit caching can bill repeats at the cached rate.
 *
 * Secrets / vars: GEMINI_API_KEY (required), GEMINI_MODEL (default
 * gemini-3.5-flash-lite), ASSISTANT_DAILY_LIMIT (default 400),
 * GEMINI_BASE_URL (only to point local tests at a mock).
 */

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (message, status = 400) => json({ error: message }, status);

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
// USD per 1M tokens for gemini-3.5-flash-lite (ai.google.dev/gemini-api/docs/pricing).
const PRICE = { input: 0.30, cached: 0.03, output: 2.50 };
const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_CHARS = 6000;
const MAX_AUDIO_BYTES = 1_600_000; // ~45s of 16 kHz mono WAV

const STAGES = ['new', 'contact_attempted', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visited', 'proposal', 'negotiation', 'won', 'lost', 'nurture'];
const HUNT_STAGES = ['identified', 'owner_contacted', 'site_visit_scheduled', 'site_visited', 'documents_requested', 'terms_negotiated', 'listed', 'dropped'];
const IST_TODAY = `date('now', '+330 minutes')`;
const istDay = (col) => `date(${col}, '+330 minutes')`;

/** ₹ in the way Indian sales teams say it: 85 L, 1.2 Cr. */
function inr(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  n = Number(n);
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
  return '₹' + n.toLocaleString('en-IN');
}
const budgetText = (min, max) => (min || max ? [inr(min), inr(max)].filter(Boolean).join(' – ') : null);
const clampLimit = (n, d = 15) => Math.max(1, Math.min(25, Number.parseInt(n, 10) || d));
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const like = (s) => '%' + String(s).trim().replace(/[%_]/g, '') + '%';

/** Shared WHERE builder for lead filters (all dates are IST calendar days). */
function leadFilters(a, binds) {
  const where = [];
  const add = (sql, v) => { binds.push(v); where.push(sql.replaceAll('?', '?' + binds.length)); };
  if (STAGES.includes(a.stage)) add('l.stage = ?', a.stage);
  if (a.source) add('lower(l.source) = lower(?)', String(a.source));
  if (a.employee_name) add('u.name LIKE ?', like(a.employee_name));
  if (a.location) add("(l.location LIKE ? )", like(a.location));
  if (isDate(a.created_from)) add(`${istDay('l.created_at')} >= ?`, a.created_from);
  if (isDate(a.created_to)) add(`${istDay('l.created_at')} <= ?`, a.created_to);
  if (a.query) {
    binds.push(like(a.query));
    const i = binds.length;
    const code = recordCode(a.query, 'L'); // wave3 B: "L-00012" / "l-12"
    if (code) binds.push(code);
    where.push(`(l.customer_name LIKE ?${i} OR l.phone LIKE ?${i} OR l.project_name LIKE ?${i} OR l.email LIKE ?${i}${code ? ` OR l.lead_code = ?${binds.length}` : ''})`);
  }
  if (Number(a.budget_min) > 0) add('COALESCE(l.budget_max, l.budget_min) >= ?', Number(a.budget_min));
  if (Number(a.budget_max) > 0) add('COALESCE(l.budget_min, l.budget_max) <= ?', Number(a.budget_max));
  if (a.follow_up === 'overdue') where.push(`l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < datetime('now') AND l.stage NOT IN ('won','lost')`);
  if (a.follow_up === 'today') where.push(`${istDay('l.next_follow_up_at')} = ${IST_TODAY}`);
  if (a.follow_up === 'this_week') where.push(`${istDay('l.next_follow_up_at')} BETWEEN ${IST_TODAY} AND date(${IST_TODAY}, '+6 days')`);
  if (a.open_only) where.push(`l.stage NOT IN ('won','lost')`);
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}
const LEAD_FROM = 'FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id LEFT JOIN teams t ON t.id = l.team_id';
// wave3 B: reference codes (L-00001 / P-00001). "L-00012", "l-12", "12" → exact code.
const recordCode = (q, prefix) => {
  const m = String(q || '').trim().match(new RegExp(`^(?:${prefix}\\s*-?\\s*)?0*(\\d{1,7})$`, 'i'));
  return m && Number(m[1]) > 0 ? `${prefix}-${m[1].padStart(5, '0')}` : null;
};
const leadRow = (l) => ({
  id: l.id, lead_id_code: l.lead_code, customer: l.customer_name, phone: l.phone, stage: l.stage, priority: l.priority, source: l.source,
  project: l.project_name, type: l.property_type, location: l.location, budget: budgetText(l.budget_min, l.budget_max),
  research_level: l.research_level, employee: l.employee || 'Unassigned', team: l.team,
  created_ist: l.created_ist, next_follow_up_ist: l.follow_ist,
});

// ---------------------------------------------------------------- tools
const LEAD_FILTER_PROPS = {
  stage: { type: 'string', enum: STAGES, description: 'Pipeline stage.' },
  source: { type: 'string', description: 'Lead source, e.g. 99acres, magicbricks, manual, walk-in.' },
  employee_name: { type: 'string', description: 'Assigned employee (partial name is fine).' },
  location: { type: 'string', description: 'Area / locality the buyer wants (partial match).' },
  created_from: { type: 'string', description: 'Lead arrived on/after this IST date, YYYY-MM-DD.' },
  created_to: { type: 'string', description: 'Lead arrived on/before this IST date, YYYY-MM-DD.' },
  query: { type: 'string', description: 'Search customer name, phone, email or project, or a lead reference code like L-00012.' },
  budget_min: { type: 'number', description: 'Buyer budget at least this many rupees.' },
  budget_max: { type: 'number', description: 'Buyer budget at most this many rupees.' },
  follow_up: { type: 'string', enum: ['overdue', 'today', 'this_week'], description: 'Follow-up timing filter.' },
  open_only: { type: 'boolean', description: 'Exclude won and lost leads.' },
};

const TOOLS = [
  {
    name: 'business_overview',
    description: 'Headline numbers right now: total/open leads, leads by stage, new today/this month, won this month, overdue follow-ups, properties, hunting properties (sourcing pipeline), employees.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'count_leads',
    description: 'Exact lead counts, optionally grouped. Use this for any "how many" question instead of counting rows.',
    parameters: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['none', 'stage', 'source', 'employee', 'team', 'month', 'day', 'location', 'research_level', 'priority', 'client_status'], description: 'How to break the count down.' },
        ...LEAD_FILTER_PROPS,
      },
    },
  },
  {
    name: 'find_leads',
    description: 'List matching leads (max 25) plus the exact total that matched.',
    parameters: {
      type: 'object',
      properties: {
        ...LEAD_FILTER_PROPS,
        sort: { type: 'string', enum: ['newest', 'oldest', 'budget_high', 'budget_low', 'follow_up'] },
        limit: { type: 'number', description: '1–25, default 15.' },
      },
    },
  },
  {
    name: 'lead_details',
    description: 'Full detail for one lead: contact, requirement, owner, recent activities and stage changes.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'The lead id or its reference code like L-00012.' },
        customer_name: { type: 'string', description: 'Used when the id is unknown; returns candidates if several match.' },
      },
    },
  },
  {
    name: 'employee_performance',
    description: 'Per-employee results for a period: leads received, contacted, site visits, won, lost, calls logged, overdue follow-ups now.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'IST date YYYY-MM-DD (default: first day of this month).' },
        to: { type: 'string', description: 'IST date YYYY-MM-DD (default: today).' },
        employee_name: { type: 'string', description: 'Limit to one employee (partial name).' },
      },
    },
  },
  {
    name: 'list_employees',
    description: 'Everyone on the team: name, role, team, active, taking new leads, availability.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_properties',
    description: 'Listed properties in the catalogue with price, stage and configuration (max 25) plus total matched.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, society, builder or area, or a property reference code like P-00012.' },
        construction_status: { type: 'string', enum: ['under_construction', 'ready_to_move'], description: 'Ready to move in or still under construction. Builder stages (EOI, nearing possession) are Projects, not properties.' },
        listing_type: { type: 'string', enum: ['sell', 'rent'] },
        plots_only: { type: 'boolean', description: 'Only plots / land.' },
        tenant_preference: { type: 'string', enum: ['families', 'bachelors', 'anyone'], description: 'Rentals only.' },
        pet_friendly: { type: 'boolean', description: 'Rentals only.' },
        vacant_only: { type: 'boolean', description: 'Rentals that are not currently occupied.' },
        bhk: { type: 'number' },
        price_max: { type: 'number', description: 'Rupees.' },
        price_min: { type: 'number', description: 'Rupees.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'hunting_overview',
    description: 'Property-hunting team: sourced properties by stage, follow-ups due or overdue, and the most recently updated ones.',
    parameters: { type: 'object', properties: { employee_name: { type: 'string' } } },
  },
  {
    name: 'find_projects',
    description: 'Builder projects (EOI to ready to move) with stage, launch month, possession, RERA, token variants with amounts and advantages, pre-launch vs post-launch benefits, and flat counts (max 25) plus total matched.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Project name, builder or area.' },
        stage: { type: 'string', enum: ['eoi_phase', 'under_construction', 'nearing_possession', 'ready_to_move'] },
        kind: { type: 'string', enum: ['building', 'plots', 'villas'], description: 'building = flats.' },
        segment: { type: 'string', enum: ['luxury', 'affordable'] },
        has_token: { type: 'boolean', description: 'Only projects that offer a booking token.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'property_keys',
    description: 'Who holds the keys of properties: each key with its custody (with owner, with an employee, or deposited at the office / key box), who and when. Use for "who has the key of X" or "which keys are with employees".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Property name, society or area.' },
        status: { type: 'string', enum: ['owner', 'employee', 'deposited'], description: 'Only keys in this custody state.' },
        employee_name: { type: 'string', description: 'Keys currently held by this employee.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'delayed_tasks',
    description: 'To Do tasks that are past their due date and not done, with the employee, days late and which manager/admin was told (level 1 = manager, level 2 = admin after 3 days).',
    parameters: { type: 'object', properties: { employee_name: { type: 'string' }, limit: { type: 'number' } } },
  },
];

async function runTool(env, name, a = {}) {
  const DB = env.DB;
  if (name === 'business_overview') {
    const [totals, stages, hunt, props, people] = await Promise.all([
      DB.prepare(`SELECT COUNT(*) total,
          SUM(stage NOT IN ('won','lost')) open,
          SUM(${istDay('created_at')} = ${IST_TODAY}) new_today,
          SUM(strftime('%Y-%m', created_at, '+330 minutes') = strftime('%Y-%m', 'now', '+330 minutes')) new_this_month,
          SUM(assigned_user_id IS NULL AND stage NOT IN ('won','lost')) unassigned_open,
          SUM(next_follow_up_at < datetime('now') AND stage NOT IN ('won','lost')) overdue_follow_ups
        FROM leads`).first(),
      DB.prepare('SELECT stage, COUNT(*) n FROM leads GROUP BY stage').all(),
      DB.prepare(`SELECT COUNT(*) total, SUM(stage NOT IN ('listed','dropped')) open FROM hunting_targets`).first(),
      DB.prepare(`SELECT COUNT(*) n FROM properties WHERE COALESCE(pipeline,'catalog') = 'catalog' AND is_active = 1`).first(),
      DB.prepare('SELECT COUNT(*) n, SUM(is_active) active FROM users').first(),
    ]);
    const won = await DB.prepare(`SELECT COUNT(*) n FROM lead_stage_history WHERE to_stage = 'won'
      AND strftime('%Y-%m', created_at, '+330 minutes') = strftime('%Y-%m', 'now', '+330 minutes')`).first();
    return {
      leads: { ...totals, won_this_month: won?.n ?? 0, by_stage: Object.fromEntries(stages.results.map((r) => [r.stage, r.n])) },
      catalogue_properties: props?.n ?? 0,
      projects: (await DB.prepare('SELECT COUNT(*) n FROM projects').first())?.n ?? 0,
      delayed_tasks: (await DB.prepare(`SELECT COUNT(*) n FROM tasks WHERE completed_at IS NULL AND due_date IS NOT NULL AND due_date < ${IST_TODAY}`).first())?.n ?? 0,
      hunting_targets: hunt,
      employees: people,
    };
  }

  if (name === 'count_leads') {
    const binds = [];
    const where = leadFilters(a, binds);
    const GROUPS = {
      stage: 'l.stage', source: 'l.source', employee: "COALESCE(u.name, 'Unassigned')", team: "COALESCE(t.name, 'No team')",
      month: "strftime('%Y-%m', l.created_at, '+330 minutes')", day: istDay('l.created_at'),
      location: "COALESCE(NULLIF(trim(l.location), ''), 'Not given')", research_level: "COALESCE(l.research_level, 'not ranked')",
      priority: 'l.priority', client_status: "COALESCE(l.client_status, 'not set')",
    };
    const g = GROUPS[a.group_by];
    if (!g) {
      const r = await DB.prepare(`SELECT COUNT(*) n ${LEAD_FROM} ${where}`).bind(...binds).first();
      return { count: r?.n ?? 0 };
    }
    // Group by the expression itself (D1 resolves a bare alias to a column first).
    const r = await DB.prepare(`SELECT ${g} AS k, COUNT(*) n ${LEAD_FROM} ${where} GROUP BY ${g} ORDER BY n DESC LIMIT 40`).bind(...binds).all();
    return { total: r.results.reduce((s, x) => s + x.n, 0), groups: r.results.map((x) => ({ [a.group_by]: x.k, count: x.n })) };
  }

  if (name === 'find_leads') {
    const binds = [];
    const where = leadFilters(a, binds);
    const ORDER = {
      newest: 'l.created_at DESC', oldest: 'l.created_at ASC',
      budget_high: 'COALESCE(l.budget_max, l.budget_min) DESC NULLS LAST', budget_low: 'COALESCE(l.budget_min, l.budget_max) ASC NULLS LAST',
      follow_up: 'l.next_follow_up_at IS NULL, l.next_follow_up_at ASC',
    }[a.sort] || 'l.created_at DESC';
    const [rows, total] = await Promise.all([
      DB.prepare(`SELECT l.*, u.name employee, t.name team,
          strftime('%Y-%m-%d %H:%M', l.created_at, '+330 minutes') created_ist,
          strftime('%Y-%m-%d %H:%M', l.next_follow_up_at, '+330 minutes') follow_ist
        ${LEAD_FROM} ${where} ORDER BY ${ORDER} LIMIT ${clampLimit(a.limit)}`).bind(...binds).all(),
      DB.prepare(`SELECT COUNT(*) n ${LEAD_FROM} ${where}`).bind(...binds).first(),
    ]);
    return { total_matching: total?.n ?? 0, shown: rows.results.length, leads: rows.results.map(leadRow) };
  }

  if (name === 'lead_details') {
    let lead = null;
    const sel = `SELECT l.*, u.name employee, t.name team,
        strftime('%Y-%m-%d %H:%M', l.created_at, '+330 minutes') created_ist,
        strftime('%Y-%m-%d %H:%M', l.next_follow_up_at, '+330 minutes') follow_ist ${LEAD_FROM}`;
    if (a.lead_id) lead = await DB.prepare(`${sel} WHERE l.id = ?1 OR l.lead_code = ?2`).bind(String(a.lead_id), recordCode(a.lead_id, 'L') || '').first();
    else if (a.customer_name) {
      const r = await DB.prepare(`${sel} WHERE l.customer_name LIKE ?1 ORDER BY l.created_at DESC LIMIT 6`).bind(like(a.customer_name)).all();
      if (r.results.length > 1) return { multiple_matches: r.results.map(leadRow), note: 'Ask which one, or call again with lead_id.' };
      lead = r.results[0] || null;
    }
    if (!lead) return { found: false };
    const [acts, stages] = await Promise.all([
      DB.prepare(`SELECT a.type, a.subject, a.body, u.name by_employee,
          strftime('%Y-%m-%d %H:%M', a.created_at, '+330 minutes') at_ist, a.completed_at IS NOT NULL done
        FROM lead_activities a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.lead_id = ?1 ORDER BY a.created_at DESC LIMIT 8`).bind(lead.id).all(),
      DB.prepare(`SELECT h.from_stage, h.to_stage, h.note, u.name by_employee,
          strftime('%Y-%m-%d %H:%M', h.created_at, '+330 minutes') at_ist
        FROM lead_stage_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.lead_id = ?1 ORDER BY h.id DESC LIMIT 6`).bind(lead.id).all(),
    ]);
    return { found: true, lead: { ...leadRow(lead), email: lead.email, client_status: lead.client_status }, recent_activities: acts.results, stage_changes: stages.results };
  }

  if (name === 'employee_performance') {
    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const from = isDate(a.from) ? a.from : todayIst.slice(0, 8) + '01';
    const to = isDate(a.to) ? a.to : todayIst;
    const binds = [from, to];
    let who = '';
    if (a.employee_name) { binds.push(like(a.employee_name)); who = 'AND u.name LIKE ?3'; }
    const inRange = (col) => `${istDay(col)} BETWEEN ?1 AND ?2`;
    const r = await DB.prepare(`SELECT u.name employee, u.role,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_user_id = u.id AND ${inRange('l.created_at')}) leads_received,
        (SELECT COUNT(DISTINCT h.lead_id) FROM lead_stage_history h WHERE h.actor_user_id = u.id AND h.to_stage IN ('contacted','qualified') AND ${inRange('h.created_at')}) contacted,
        (SELECT COUNT(DISTINCT h.lead_id) FROM lead_stage_history h WHERE h.actor_user_id = u.id AND h.to_stage = 'site_visited' AND ${inRange('h.created_at')}) site_visits,
        (SELECT COUNT(DISTINCT h.lead_id) FROM lead_stage_history h WHERE h.actor_user_id = u.id AND h.to_stage = 'won' AND ${inRange('h.created_at')}) won,
        (SELECT COUNT(DISTINCT h.lead_id) FROM lead_stage_history h WHERE h.actor_user_id = u.id AND h.to_stage = 'lost' AND ${inRange('h.created_at')}) lost,
        (SELECT COUNT(*) FROM lead_activities x WHERE x.actor_user_id = u.id AND x.type = 'call' AND ${inRange('x.created_at')}) calls_logged,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_user_id = u.id AND l.next_follow_up_at < datetime('now') AND l.stage NOT IN ('won','lost')) overdue_follow_ups_now
      FROM users u WHERE u.is_active = 1 ${who} ORDER BY won DESC, leads_received DESC LIMIT 40`).bind(...binds).all();
    return { period_ist: { from, to }, employees: r.results };
  }

  if (name === 'list_employees') {
    const r = await DB.prepare(`SELECT u.name, u.role, t.name team, u.is_active active, u.accepts_leads, u.availability
      FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.is_active DESC, u.name`).all();
    return { count: r.results.length, employees: r.results };
  }

  if (name === 'find_properties') {
    const binds = []; const where = [`COALESCE(p.pipeline,'catalog') = 'catalog'`, 'p.is_active = 1'];
    const add = (sql, v) => { binds.push(v); where.push(sql.replaceAll('?', '?' + binds.length)); };
    if (a.query) { binds.push(like(a.query)); const i = binds.length; const code = recordCode(a.query, 'P'); if (code) binds.push(code); where.push(`(p.name LIKE ?${i} OR p.society_name LIKE ?${i} OR p.developer LIKE ?${i} OR p.locality LIKE ?${i} OR p.location LIKE ?${i}${code ? ` OR p.property_code = ?${binds.length}` : ''})`); }
    if (a.construction_status) add('p.construction_status = ?', String(a.construction_status));
    if (a.listing_type) add('p.listing_type = ?', String(a.listing_type));
    if (Number(a.bhk) > 0) { binds.push(Number(a.bhk)); binds.push(`%${Number(a.bhk)}%`); where.push(`(p.bedroom_count = ?${binds.length - 1} OR p.bedrooms LIKE ?${binds.length})`); }
    if (a.plots_only) where.push(`(lower(COALESCE(p.property_type,'')) LIKE '%plot%' OR lower(COALESCE(p.property_type,'')) LIKE '%land%')`);
    if (a.tenant_preference) add(`p.listing_type = 'rent' AND (p.tenant_preference = ? OR p.tenant_preference = 'anyone')`, String(a.tenant_preference));
    if (a.pet_friendly === true) where.push(`p.listing_type = 'rent' AND p.pet_friendly = 'yes'`);
    if (a.vacant_only) where.push(`p.listing_type = 'rent' AND p.occupied = 'no'`);
    if (Number(a.price_max) > 0) add('COALESCE(p.price_expected, p.budget_min, p.budget_max) <= ?', Number(a.price_max));
    if (Number(a.price_min) > 0) add('COALESCE(p.price_expected, p.budget_max, p.budget_min) >= ?', Number(a.price_min));
    const w = 'WHERE ' + where.join(' AND ');
    const [rows, total] = await Promise.all([
      DB.prepare(`SELECT p.* FROM properties p ${w} ORDER BY p.created_at DESC LIMIT ${clampLimit(a.limit)}`).bind(...binds).all(),
      DB.prepare(`SELECT COUNT(*) n FROM properties p ${w}`).bind(...binds).first(),
    ]);
    return {
      total_matching: total?.n ?? 0,
      properties: rows.results.map((p) => ({
        property_id_code: p.property_code, name: p.name, builder: p.developer, area: [p.locality, p.location].filter(Boolean).join(', '),
        type: p.property_type, configuration: p.bedrooms || (p.bedroom_count ? p.bedroom_count + ' BHK' : null),
        stage: p.construction_status, listing: p.listing_type, available: p.availability !== 'no',
        price: inr(p.price_expected) || budgetText(p.budget_min, p.budget_max), carpet_sqft: p.carpet_area_sqft,
        possession: p.completion_month, amenities: p.amenities ? String(p.amenities).slice(0, 160) : null,
        ...(p.listing_type === 'rent' ? {
          rent_per_month: inr(p.price_expected), furnishing: p.furnishing, tenant_preference: p.tenant_preference,
          occupied: p.occupied, pet_friendly: p.pet_friendly, security_deposit: inr(p.security_deposit),
          lock_in_months: p.lock_in_months, available_from: p.available_from,
        } : {}),
        ...(p.plot_area ? {
          plot_area: `${p.plot_area} ${{ sqft: 'sq ft', sqyd: 'sq yd', guntha: 'guntha', acre: 'acre' }[p.plot_area_unit] || 'sq ft'}`,
          plot_dimensions: p.plot_dimensions, facing: p.plot_facing, road_width_ft: p.plot_road_width,
          corner_plot: p.plot_corner, boundary_wall: p.plot_boundary_wall, land_use: p.plot_land_use, clear_title: p.plot_clear_title,
        } : {}),
      })),
    };
  }

  if (name === 'find_projects') {
    const binds = []; const where = ['1=1'];
    const add = (sql, v) => { binds.push(v); where.push(sql.replaceAll('?', '?' + binds.length)); };
    if (a.query) { binds.push(like(a.query)); const i = binds.length; where.push(`(p.name LIKE ?${i} OR p.developer LIKE ?${i} OR p.locality LIKE ?${i} OR p.location LIKE ?${i})`); }
    if (a.stage) add('p.construction_status = ?', String(a.stage));
    if (a.kind) add('p.kind = ?', String(a.kind));
    if (a.segment) add('p.segment = ?', String(a.segment));
    if (a.has_token) where.push('EXISTS (SELECT 1 FROM project_tokens t WHERE t.project_id = p.id)');
    const w = 'WHERE ' + where.join(' AND ');
    const [rows, total] = await Promise.all([
      DB.prepare(`SELECT p.* FROM projects p ${w} ORDER BY p.created_at DESC LIMIT ${clampLimit(a.limit)}`).bind(...binds).all(),
      DB.prepare(`SELECT COUNT(*) n FROM projects p ${w}`).bind(...binds).first(),
    ]);
    const ids = rows.results.map((r) => r.id);
    const inIds = ids.map((_, i) => '?' + (i + 1)).join(',');
    const [tokens, units, configs] = ids.length ? await Promise.all([
      DB.prepare(`SELECT project_id, name, amount, refundable, advantages FROM project_tokens WHERE project_id IN (${inIds}) ORDER BY sort_order`).bind(...ids).all(),
      DB.prepare(`SELECT project_id, status, COUNT(*) n FROM project_units WHERE project_id IN (${inIds}) GROUP BY project_id, status`).bind(...ids).all(),
      DB.prepare(`SELECT project_id, bhk, price FROM project_configurations WHERE project_id IN (${inIds}) ORDER BY sort_order`).bind(...ids).all(),
    ]) : [{ results: [] }, { results: [] }, { results: [] }];
    const list = (v) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };
    return {
      total_matching: total?.n ?? 0,
      projects: rows.results.map((p) => {
        const u = Object.fromEntries(units.results.filter((x) => x.project_id === p.id).map((x) => [x.status, x.n]));
        const prices = configs.results.filter((c) => c.project_id === p.id && c.price).map((c) => c.price);
        return {
          name: p.name, builder: p.developer, area: [p.locality, p.location].filter(Boolean).join(', '),
          stage: p.construction_status, kind: p.kind === 'building' ? 'flats' : p.kind, segment: p.segment,
          launch: p.launch_month || p.expected_launch || null, possession_year: p.possession_year, completion: p.possession_by,
          rera: p.rera_registered === 1 ? (p.rera_number || 'registered') : p.rera_registered === 0 ? 'in process' : null,
          towers: p.tower_count, land: p.land_parcel_area, sample_flat_ready: p.sample_flat_ready == null ? null : !!p.sample_flat_ready,
          configurations: configs.results.filter((c) => c.project_id === p.id).map((c) => c.bhk + (c.price ? ' ' + inr(c.price) : '')),
          price_from: prices.length ? inr(Math.min(...prices)) : null,
          tokens: tokens.results.filter((t) => t.project_id === p.id).map((t) => ({ name: t.name, amount: inr(t.amount), refundable: t.refundable == null ? null : !!t.refundable, advantages: list(t.advantages) })),
          pre_vs_post_launch: list(p.launch_benefits),
          units: { available: u.available ?? 0, booked: u.booked ?? 0, sold: u.sold ?? 0 },
        };
      }),
    };
  }

  if (name === 'property_keys') {
    const binds = []; const where = [`COALESCE(p.pipeline,'catalog') = 'catalog'`];
    const add = (sql, v) => { binds.push(v); where.push(sql.replaceAll('?', '?' + binds.length)); };
    if (a.query) { binds.push(like(a.query)); const i = binds.length; where.push(`(p.name LIKE ?${i} OR p.society_name LIKE ?${i} OR p.locality LIKE ?${i})`); }
    if (a.status) add('k.status = ?', String(a.status));
    if (a.employee_name) add(`k.status = 'employee' AND k.held_by_name LIKE ?`, like(a.employee_name));
    const w = 'WHERE ' + where.join(' AND ');
    const [rows, total] = await Promise.all([
      DB.prepare(`SELECT p.name property, k.label, k.copies, k.status, k.held_by_name, k.taken_at, k.deposit_place, k.deposited_by, k.deposited_at
          FROM property_keys k JOIN properties p ON p.id = k.property_id ${w} ORDER BY p.name, k.sort_order LIMIT ${clampLimit(a.limit, 25)}`).bind(...binds).all(),
      DB.prepare(`SELECT COUNT(*) n FROM property_keys k JOIN properties p ON p.id = k.property_id ${w}`).bind(...binds).first(),
    ]);
    return {
      total_matching: total?.n ?? 0,
      keys: rows.results.map((k) => ({
        property: k.property, key: k.label, copies: k.copies,
        custody: { owner: 'with the owner', employee: 'with an employee', deposited: 'deposited with us' }[k.status] || k.status,
        ...(k.status === 'employee' ? { held_by: k.held_by_name, since: k.taken_at } : {}),
        ...(k.status === 'deposited' ? { deposited_at: k.deposit_place, deposited_by: k.deposited_by, on: k.deposited_at } : {}),
      })),
    };
  }

  if (name === 'delayed_tasks') {
    const binds = []; let who = '';
    if (a.employee_name) { binds.push(like(a.employee_name)); who = 'AND u.name LIKE ?1'; }
    const from = `FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to_user_id LEFT JOIN users ue ON ue.id = t.escalated_to_user_id
      WHERE t.completed_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ${IST_TODAY} ${who}`;
    const [rows, total] = await Promise.all([
      DB.prepare(`SELECT t.title, u.name employee, t.due_date, CAST(julianday(${IST_TODAY}) - julianday(t.due_date) AS INTEGER) days_late,
          CASE WHEN t.escalated_to_user_id = 'super-admin' THEN 'the admin' ELSE ue.name END told, t.escalated_at, t.escalated2_at
          ${from} ORDER BY t.due_date LIMIT ${clampLimit(a.limit)}`).bind(...binds).all(),
      DB.prepare(`SELECT COUNT(*) n ${from}`).bind(...binds).first(),
    ]);
    return {
      total_delayed: total?.n ?? 0,
      tasks: rows.results.map((t) => ({
        task: t.title, employee: t.employee, due: t.due_date, days_late: t.days_late,
        manager_told: t.told || null, admin_also_told: !!t.escalated2_at,
      })),
    };
  }

  if (name === 'hunting_overview') {
    const binds = []; let who = '';
    if (a.employee_name) { binds.push(like(a.employee_name)); who = 'AND u.name LIKE ?1'; }
    const from = `FROM hunting_targets h LEFT JOIN users u ON u.id = h.assigned_user_id WHERE 1=1 ${who}`;
    const [stages, due, recent] = await Promise.all([
      DB.prepare(`SELECT h.stage, COUNT(*) n ${from} GROUP BY h.stage`).bind(...binds).all(),
      DB.prepare(`SELECT SUM(h.next_follow_up_at < datetime('now')) overdue, SUM(${istDay('h.next_follow_up_at')} = ${IST_TODAY}) due_today
        ${from} AND h.stage NOT IN ('listed','dropped')`).bind(...binds).first(),
      DB.prepare(`SELECT h.name, h.stage, h.locality, h.location, h.asking_price, u.name employee,
          strftime('%Y-%m-%d', h.updated_at, '+330 minutes') updated_ist ${from} ORDER BY h.updated_at DESC LIMIT 10`).bind(...binds).all(),
    ]);
    return {
      by_stage: Object.fromEntries(HUNT_STAGES.map((s) => [s, stages.results.find((r) => r.stage === s)?.n ?? 0])),
      follow_ups: { overdue: due?.overdue ?? 0, due_today: due?.due_today ?? 0 },
      recently_updated: recent.results.map((r) => ({ ...r, asking_price: inr(r.asking_price) })),
    };
  }
  return { error: 'Unknown tool ' + name };
}

// ---------------------------------------------------------------- Gemini
function systemPrompt(workspace) {
  const now = new Date(Date.now() + 330 * 60000);
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
  return `You are Anna, the private data assistant for ${workspace || 'the company'}, a real-estate agency CRM. Only the super administrator talks to you. If asked your name, say you are Anna.
Today is ${weekday}, ${today} (India time, IST). Resolve "this month", "last week", "yesterday" etc. into exact IST dates before calling tools.

Accuracy rules — these matter more than anything else:
- Every number, name, date and amount you state must come from a tool result in this conversation. Never estimate or invent.
- Every lead has a reference code (lead_id_code, e.g. L-00012) and every property one too (property_id_code, e.g. P-00012). Mention the code next to a lead or property you name; a code the user gives can be passed as the query (or as lead_id to lead_details).
- For "how many" questions use count_leads or business_overview (exact counts). Never count rows from a list yourself; find_leads shows at most 25 rows but reports total_matching.
- If the tools cannot answer, say plainly that you don't have that data. If a request is ambiguous (e.g. two leads with the same name), ask a short question.
- You can only read data. If asked to change something, say it must be done in the app.
- Properties are individual listings (sale or rent, incl. plots); Projects are builder developments with tokens and pre/post-launch benefits — use find_projects for those. Use property_keys for who holds keys, delayed_tasks for late To Do items.

Style: answer in the language the user used (English, Hindi or Hinglish). Be brief — lead with the direct answer, then at most a few short "- " bullet points. Plain text only (no tables, no headings, no bold). Money as ₹ with L / Cr, as the tools give it. Stage names in plain words (site_visit_scheduled → visit scheduled).`;
}

async function gemini(env, body) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  return data;
}

/** Adds this call's tokens to today's meter and returns the call's cost in USD. */
async function meter(env, usage, extra = {}) {
  const input = usage?.promptTokenCount ?? 0;
  const cached = usage?.cachedContentTokenCount ?? 0;
  const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  const usd = ((input - cached) * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6;
  await env.DB.prepare(`INSERT INTO ai_usage (day, requests, input_tokens, cached_tokens, output_tokens, cost_usd)
      VALUES (${IST_TODAY}, ?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(day) DO UPDATE SET requests = requests + ?1, input_tokens = input_tokens + ?2,
        cached_tokens = cached_tokens + ?3, output_tokens = output_tokens + ?4, cost_usd = cost_usd + ?5`)
    .bind(extra.requests ?? 0, input, cached, output, usd).run();
  return usd;
}

async function todayUsage(env) {
  const r = await env.DB.prepare(`SELECT requests, input_tokens, cached_tokens, output_tokens, cost_usd FROM ai_usage WHERE day = ${IST_TODAY}`).first();
  const m = await env.DB.prepare(`SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(cost_usd),0) cost_usd FROM ai_usage WHERE substr(day,1,7) = substr(${IST_TODAY},1,7)`).first();
  return { today: r || { requests: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 }, month: m };
}

function guard(env, actor) {
  if (actor?.role !== 'super_admin') return fail('Anna is only available to the super administrator.', 403);
  if (!env.GEMINI_API_KEY) return fail('Anna is not switched on yet — add GEMINI_API_KEY (wrangler secret put GEMINI_API_KEY).', 503);
  return null;
}
async function overDailyLimit(env) {
  const limit = Number(env.ASSISTANT_DAILY_LIMIT) || 400;
  const r = await env.DB.prepare(`SELECT requests FROM ai_usage WHERE day = ${IST_TODAY}`).first();
  return (r?.requests ?? 0) >= limit ? limit : 0;
}

/** Keep the most recent turns that fit the budget; text only, roles user/model. */
function trimHistory(history) {
  const out = []; let chars = 0;
  for (const m of (Array.isArray(history) ? history : []).slice(-10).reverse()) {
    const text = String(m?.text || '').slice(0, 2000);
    if (!text || !['user', 'model'].includes(m.role)) continue;
    if (chars + text.length > MAX_HISTORY_CHARS) break;
    chars += text.length; out.unshift({ role: m.role, parts: [{ text }] });
  }
  while (out.length && out[0].role !== 'user') out.shift(); // must start with the user
  return out;
}

export async function handleAssistantChat(request, env, actor, workspaceName) {
  const denied = guard(env, actor); if (denied) return denied;
  const limit = await overDailyLimit(env);
  if (limit) return fail(`Anna’s daily limit reached (${limit} questions). It resets at midnight IST.`, 429);
  const body = await request.json().catch(() => null);
  const message = String(body?.message || '').trim().slice(0, 2000);
  if (!message) return fail('Ask a question first.', 422);

  const contents = [...trimHistory(body.history), { role: 'user', parts: [{ text: message }] }];
  const request0 = {
    systemInstruction: { parts: [{ text: systemPrompt(workspaceName) }] },
    tools: [{ functionDeclarations: TOOLS }],
    generationConfig: { maxOutputTokens: 800 },
  };
  let usd = 0; const used = [];
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const data = await gemini(env, { ...request0, contents });
      usd += await meter(env, data.usageMetadata, { requests: round === 0 ? 1 : 0 });
      const content = data.candidates?.[0]?.content;
      const parts = content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length || round === MAX_TOOL_ROUNDS) {
        const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
        return json({ reply: text || "I couldn't find an answer to that in the CRM data.", tools_used: used, cost_usd: usd, usage: await todayUsage(env) });
      }
      // Send the model's turn back verbatim (keeps thought signatures), then the results.
      contents.push(content);
      const results = await Promise.all(calls.map(async ({ functionCall: fc }) => {
        used.push(fc.name);
        let result;
        try { result = await runTool(env, fc.name, fc.args || {}); } catch (e) { result = { error: 'Tool failed: ' + e.message }; }
        return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { result } } };
      }));
      contents.push({ role: 'user', parts: results });
    }
  } catch (e) {
    return fail('Anna ran into an error: ' + e.message, 502);
  }
  return fail('No answer.', 502);
}

/** Voice → text. The CRM's own names are passed as spelling hints for accuracy. */
export async function handleAssistantTranscribe(request, env, actor) {
  const denied = guard(env, actor); if (denied) return denied;
  const limit = await overDailyLimit(env);
  if (limit) return fail(`Anna’s daily limit reached (${limit} questions). It resets at midnight IST.`, 429);
  const body = await request.json().catch(() => null);
  const audio = String(body?.audio || '');
  const mime = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/aac', 'audio/flac'].includes(body?.mime) ? body.mime : 'audio/wav';
  if (!audio || audio.length > MAX_AUDIO_BYTES * 1.37) return fail('Recording is empty or too long (max ~45 seconds).', 422);

  const [people, projects, places] = await Promise.all([
    env.DB.prepare('SELECT name FROM users WHERE is_active = 1 LIMIT 60').all(),
    env.DB.prepare(`SELECT DISTINCT name FROM (SELECT project_name name FROM leads WHERE project_name IS NOT NULL
      UNION SELECT name FROM properties) WHERE name <> '' LIMIT 60`).all(),
    env.DB.prepare(`SELECT DISTINCT name FROM (SELECT location name FROM leads WHERE location IS NOT NULL
      UNION SELECT locality FROM properties WHERE locality IS NOT NULL) WHERE name <> '' LIMIT 60`).all(),
  ]);
  const hints = [...people.results, ...projects.results, ...places.results].map((r) => r.name).join(', ');
  try {
    const data = await gemini(env, {
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: mime, data: audio } },
        { text: `Transcribe this voice question to a real-estate CRM exactly as spoken (English, Hindi or Hinglish; keep Hindi in Latin script if spoken in Hinglish). Names that may appear — use these spellings when they match: ${hints}. Output only the transcript, nothing else. If there is no speech, output nothing.` },
      ] }],
      generationConfig: { maxOutputTokens: 300 },
    });
    await meter(env, data.usageMetadata);
    const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    return json({ text });
  } catch (e) {
    return fail('Transcription error: ' + e.message, 502);
  }
}

export async function handleAssistantStatus(env, actor) {
  if (actor?.role !== 'super_admin') return fail('Not available.', 403);
  return json({ enabled: Boolean(env.GEMINI_API_KEY), model: env.GEMINI_MODEL || DEFAULT_MODEL, daily_limit: Number(env.ASSISTANT_DAILY_LIMIT) || 400, usage: await todayUsage(env) });
}

export { runTool as _runToolForTests };
