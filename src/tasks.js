/**
 * To-do tasks (Microsoft To Do style) — every signed-in person has their own
 * tasks; managers assign to their own team, admins / the super admin to
 * anyone. Who may do what:
 *   see      — assignee, creator, the assignee's team manager, admins
 *   finish   — assignee, creator, manager of the assignee, admins
 *   personal — assignee sets My Day, Important, own list, steps, notes
 *   manage   — creator / manager of the assignee / admins: title, due,
 *              repeat, assignee, linked lead; delete
 * The client computes the smart lists (My Day, Planned...) from GET /api/tasks.
 */

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (message, status = 400) => json({ error: message }, status);

const SUPER_ID = 'super-admin';
const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];
const COLORS = ['blue', 'purple', 'green', 'orange', 'pink', 'teal', 'red'];
const isAdmin = (a) => a.role === 'admin' || a.role === 'super_admin' || a.role === 'sales_head'; // sales head: whole department (0060)
const isHead = (a) => a.role === 'manager' || a.role === 'team_leader'; // team-scoped heads (0060)
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function userById(env, id) {
  if (id === SUPER_ID) return { id: SUPER_ID, name: 'Super administrator', role: 'super_admin', team_id: null, is_active: 1 };
  return env.DB.prepare('SELECT id, name, role, team_id, is_active FROM users WHERE id = ?1').bind(id).first();
}
/** Managers reach people in their own team; admins reach everyone. */
function canReach(actor, target) {
  if (!target) return false;
  if (target.id === actor.id || isAdmin(actor)) return true;
  return isHead(actor) && actor.team_id && target.team_id === actor.team_id;
}

/** Visibility filter (SQL) for tasks the actor may see. */
function scopeSql(actor, binds) {
  if (isAdmin(actor)) return '1=1';
  binds.push(actor.id);
  const me = `?${binds.length}`;
  if (isHead(actor) && actor.team_id) {
    binds.push(actor.team_id);
    return `(t.assigned_to_user_id = ${me} OR t.created_by_user_id = ${me}
      OR t.assigned_to_user_id IN (SELECT id FROM users WHERE team_id = ?${binds.length}))`;
  }
  return `(t.assigned_to_user_id = ${me} OR t.created_by_user_id = ${me})`;
}

const TASK_SELECT = `SELECT t.*,
    CASE WHEN t.assigned_to_user_id = 'super-admin' THEN 'Super administrator' ELSE ua.name END AS assigned_to_name,
    CASE WHEN t.created_by_user_id = 'super-admin' THEN 'Super administrator' ELSE uc.name END AS created_by_name,
    CASE WHEN t.escalated_to_user_id = 'super-admin' THEN 'Super administrator' ELSE ue.name END AS escalated_to_name,
    CASE WHEN t.nudged_by_user_id = 'super-admin' THEN 'Super administrator' ELSE un.name END AS nudged_by_name,
    l.customer_name AS lead_name, tl.name AS list_name
  FROM tasks t
  LEFT JOIN users ua ON ua.id = t.assigned_to_user_id
  LEFT JOIN users uc ON uc.id = t.created_by_user_id
  LEFT JOIN users ue ON ue.id = t.escalated_to_user_id
  LEFT JOIN users un ON un.id = t.nudged_by_user_id
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN task_lists tl ON tl.id = t.list_id`;
const shape = (t) => ({ ...t, steps: (() => { try { return JSON.parse(t.steps || '[]'); } catch { return []; } })(), important: !!t.important });

async function loadTask(env, actor, id) {
  const binds = [id];
  const t = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?1 AND ${scopeSql(actor, binds)}`).bind(...binds).first();
  return t ? shape(t) : null;
}
async function roleOn(env, actor, t) {
  const assignee = await userById(env, t.assigned_to_user_id);
  const manage = isAdmin(actor) || t.created_by_user_id === actor.id || (isHead(actor) && canReach(actor, assignee));
  return { manage, personal: t.assigned_to_user_id === actor.id, finish: manage || t.assigned_to_user_id === actor.id };
}

function cleanSteps(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 50).map((s) => ({ id: String(s?.id || crypto.randomUUID()).slice(0, 40), title: text(s?.title, 200), done: !!s?.done })).filter((s) => s.title);
}
async function ownListOrNull(env, listId, ownerId) {
  if (!listId) return null;
  const l = await env.DB.prepare('SELECT id FROM task_lists WHERE id = ?1 AND owner_user_id = ?2').bind(String(listId), ownerId).first();
  return l ? l.id : null;
}
/** Next due date for a repeating task (YYYY-MM-DD). */
function nextDue(due, repeat) {
  const d = new Date((due || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (repeat === 'weekdays') { do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay())); }
  return d.toISOString().slice(0, 10);
}

// ---- delayed-task escalation ----
/*
 * WORKFLOW: when an employee's task is delayed, tell their head.
 *  1. Delayed = not completed and due_date < today (IST).
 *  2. Head = manager of the assignee's team (teams.manager_user_id, else an
 *     active manager-role user in that team). If the assignee IS that manager,
 *     is an admin, or has no team head, the head is the admin ('super-admin').
 *     A task assigned to the super admin has nobody above it.
 *  3. Level 1: the first time a task is seen delayed, tasks.escalated_at +
 *     escalated_to_user_id are stamped. That one row is the whole record: the
 *     notification feed (index.js, 'task_delayed' sources), the To Do badge /
 *     toast (handleTaskSummary) and the head's Delayed view all read it, so
 *     the head is told exactly once per delay.
 *  4. Level 2: still open ESCALATE_AFTER_DAYS (3) days late -> escalated2_* is
 *     stamped for the admin (the head's head). Skipped when the head is
 *     already the admin.
 *  5. Heads can nudge the assignee (PATCH {nudge:true} -> nudged_at; the
 *     assignee gets a toast) or reassign / open the task from the Delayed view.
 *  6. Changing the due date, reassigning or reopening clears every stamp
 *     (resetEscalation) so a new delay escalates again; finishing keeps them
 *     as history.
 *  7. Triggers (all idempotent, guarded by `escalated_at IS NULL`): every
 *     GET /api/tasks and GET /api/tasks/summary poll, and the daily
 *     scheduled() job (08:00 IST) via escalateDelayedTasks(env). Nothing is
 *     emailed; the daily digest only lists delayed items (delayedTasksForDigest).
 *  Visibility: heads see their own people's delays (scopeSql), admins all.
 */
const ESCALATE_AFTER_DAYS = 3;
const ESCALATION_BATCH = 200;
// ---- alerts hook (wave3): index.js installs raiseAlert here (avoids a circular import) ----
let raiseTaskAlert = null;
export function setTaskAlertHook(fn) { raiseTaskAlert = fn; }
/** Level 1 -> medium alert to the head; level 2 -> high alert to the admins.
 *  Only rows this pass actually stamped (batch changes > 0), so each delay alerts once. */
async function alertEscalated(env, rows, results, level) {
  if (!raiseTaskAlert) return;
  for (const [i, r] of rows.entries()) {
    if (!results?.[i]?.meta?.changes) continue;
    const who = r.assignee_name || 'Someone';
    await raiseTaskAlert(env, level === 1
      ? { importance: 'medium', to: { userIds: [r.head] }, title: `${who}’s task is overdue`, body: r.title, link: { kind: 'task', id: r.id } }
      : { importance: 'high', to: {}, title: `${who}’s task is still not done (${ESCALATE_AFTER_DAYS}+ days late)`, body: r.title, link: { kind: 'task', id: r.id } });
  }
}
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const ymdAdd = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/** Adds the "clear every escalation / nudge stamp" assignments once to `sets`. */
function resetEscalation(sets) {
  if (sets.includes('escalated_at = NULL')) return;
  sets.push('escalated_at = NULL', 'escalated_to_user_id = NULL', 'escalated2_at = NULL', 'escalated2_to_user_id = NULL', 'nudged_at = NULL', 'nudged_by_user_id = NULL');
}

/** Stamps every newly delayed task (level 1) and every task that has stayed
 *  delayed for ESCALATE_AFTER_DAYS (level 2). Safe to call as often as you like. */
export async function escalateDelayedTasks(env) {
  const today = istToday();
  const fresh = (await env.DB.prepare(`SELECT t.id, t.title, au.name AS assignee_name, t.assigned_to_user_id AS assignee, au.role, tm.manager_user_id AS mgr, mu.is_active AS mgr_active,
        (SELECT m.id FROM users m WHERE m.team_id = au.team_id AND m.role = 'manager' AND m.is_active = 1 AND m.id <> t.assigned_to_user_id ORDER BY m.id LIMIT 1) AS team_mgr
      FROM tasks t
      LEFT JOIN users au ON au.id = t.assigned_to_user_id
      LEFT JOIN teams tm ON tm.id = au.team_id
      LEFT JOIN users mu ON mu.id = tm.manager_user_id
      WHERE t.completed_at IS NULL AND t.due_date < ?1 AND t.escalated_at IS NULL AND t.assigned_to_user_id <> ?2
      LIMIT ${ESCALATION_BATCH}`).bind(today, SUPER_ID).all()).results || [];
  let level1 = 0; let level2 = 0;
  if (fresh.length) {
    const up = env.DB.prepare(`UPDATE tasks SET escalated_at = datetime('now'), escalated_to_user_id = ?2 WHERE id = ?1 AND escalated_at IS NULL AND completed_at IS NULL`);
    const done1 = await env.DB.batch(fresh.map((r) => {
      const admin = r.role === 'admin' || r.role === 'super_admin';
      const own = r.mgr && r.mgr_active && r.mgr !== r.assignee ? r.mgr : null;
      return up.bind(r.id, (r.head = !admin && (own || r.team_mgr) || SUPER_ID));
    }));
    level1 = fresh.length;
    await alertEscalated(env, fresh, done1, 1);
  }
  const late = (await env.DB.prepare(`SELECT id, title, (SELECT u.name FROM users u WHERE u.id = tasks.assigned_to_user_id) AS assignee_name FROM tasks WHERE completed_at IS NULL AND due_date <= ?1 AND escalated_at IS NOT NULL AND escalated2_at IS NULL
      AND escalated_to_user_id <> ?2 LIMIT ${ESCALATION_BATCH}`).bind(ymdAdd(today, -ESCALATE_AFTER_DAYS), SUPER_ID).all()).results || [];
  if (late.length) {
    const up = env.DB.prepare(`UPDATE tasks SET escalated2_at = datetime('now'), escalated2_to_user_id = ?2 WHERE id = ?1 AND escalated2_at IS NULL AND completed_at IS NULL`);
    const done2 = await env.DB.batch(late.map((r) => up.bind(r.id, SUPER_ID)));
    level2 = late.length;
    await alertEscalated(env, late, done2, 2);
  }
  return { level1, level2 };
}
/** Reads must never fail because of the escalation pass. */
const escalateQuietly = (env) => escalateDelayedTasks(env).catch((e) => console.error('Task escalation failed:', e));

/** For the daily digest (content only, nothing is sent from here): returns a
 *  function user -> { own, team } of delayed items (max 10 each plus counts). */
export async function delayedTasksForDigest(env) {
  const today = istToday();
  const rows = (await env.DB.prepare(`SELECT t.title, t.due_date, t.assigned_to_user_id AS assignee, t.escalated_to_user_id AS head, ua.name AS assignee_name, ua.team_id
      FROM tasks t LEFT JOIN users ua ON ua.id = t.assigned_to_user_id
      WHERE t.completed_at IS NULL AND t.due_date < ?1 ORDER BY t.due_date LIMIT 1000`).bind(today).all()).results || [];
  const item = (r) => ({ title: r.title, who: r.assignee_name || 'Super administrator', days_late: daysBetween(r.due_date, today) });
  const pack = (list) => ({ count: list.length, items: list.slice(0, 10).map(item) });
  return (u) => {
    const admin = u.role === 'admin' || u.role === 'super_admin';
    const own = rows.filter((r) => r.assignee === u.id);
    const team = rows.filter((r) => r.assignee !== u.id && (admin || r.head === u.id || (isHead(u) && u.team_id && r.team_id === u.team_id)));
    return { own: pack(own), team: pack(team), count: own.length + team.length };
  };
}

// ------------------------------------------------------------------ handlers
export async function handleListTasks(request, env, actor) {
  await escalateQuietly(env);
  const url = new URL(request.url);
  const binds = [];
  const where = scopeSql(actor, binds);
  // Completed tasks older than 60 days drop off unless asked for.
  const old = url.searchParams.get('completed') === 'all' ? '' : `AND (t.completed_at IS NULL OR t.completed_at >= datetime('now', '-60 days'))`;
  const [tasks, lists] = await Promise.all([
    env.DB.prepare(`${TASK_SELECT} WHERE ${where} ${old} ORDER BY t.completed_at IS NOT NULL, t.created_at DESC LIMIT 2000`).bind(...binds).all(),
    env.DB.prepare('SELECT id, name, color, created_at FROM task_lists WHERE owner_user_id = ?1 ORDER BY created_at').bind(actor.id).all(),
  ]);
  return json({ me: actor.id, tasks: tasks.results.map(shape), lists: lists.results });
}

export async function handleCreateTask(request, env, actor) {
  const b = await request.json().catch(() => null);
  const title = text(b?.title, 300);
  if (!title) return fail('Give the task a title.', 422);
  const assigneeId = b.assigned_to_user_id ? String(b.assigned_to_user_id) : actor.id;
  const assignee = await userById(env, assigneeId);
  if (!assignee || !assignee.is_active) return fail('That person was not found or is inactive.', 422);
  if (!canReach(actor, assignee)) return fail(isHead(actor) ? 'You can only assign tasks to people in your team.' : 'Only managers and admins can assign tasks to others.', 403);
  if (b.due_date && !isDate(b.due_date)) return fail('Due date must be YYYY-MM-DD.', 422);
  if (b.lead_id && !await env.DB.prepare('SELECT id FROM leads WHERE id = ?1').bind(String(b.lead_id)).first()) return fail('Lead not found.', 422);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO tasks (id, title, notes, steps, due_date, repeat, important, my_day_date, list_id, lead_id, assigned_to_user_id, created_by_user_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
    .bind(id, title, text(b.notes, 4000) || null, JSON.stringify(cleanSteps(b.steps) || []), b.due_date || null,
      REPEATS.includes(b.repeat) ? b.repeat : null, b.important ? 1 : 0, isDate(b.my_day_date) && assigneeId === actor.id ? b.my_day_date : null,
      assigneeId === actor.id ? await ownListOrNull(env, b.list_id, actor.id) : null, b.lead_id || null, assigneeId, actor.id)
    .run();
  return json({ task: await loadTask(env, actor, id) }, 201);
}

export async function handleUpdateTask(request, env, taskId, actor) {
  const t = await loadTask(env, actor, taskId);
  if (!t) return fail('Task not found.', 404);
  const can = await roleOn(env, actor, t);
  const b = await request.json().catch(() => null);
  if (!b) return fail('JSON object required.', 400);
  const sets = []; const binds = [taskId];
  const set = (col, v) => { binds.push(v); sets.push(`${col} = ?${binds.length}`); };
  const denied = (what) => fail(`You can't change the ${what} of a task someone else assigned to you.`, 403);

  if ('title' in b) { if (!can.manage) return denied('title'); const v = text(b.title, 300); if (!v) return fail('Give the task a title.', 422); set('title', v); }
  if ('due_date' in b) { if (!can.manage) return denied('due date'); if (b.due_date && !isDate(b.due_date)) return fail('Due date must be YYYY-MM-DD.', 422); set('due_date', b.due_date || null); if ((b.due_date || null) !== (t.due_date || null)) resetEscalation(sets); }
  if ('repeat' in b) { if (!can.manage) return denied('repeat'); set('repeat', REPEATS.includes(b.repeat) ? b.repeat : null); }
  if ('lead_id' in b) {
    if (!can.manage) return denied('linked lead');
    if (b.lead_id && !await env.DB.prepare('SELECT id FROM leads WHERE id = ?1').bind(String(b.lead_id)).first()) return fail('Lead not found.', 422);
    set('lead_id', b.lead_id || null);
  }
  if ('assigned_to_user_id' in b && b.assigned_to_user_id !== t.assigned_to_user_id) {
    if (!can.manage) return denied('assignee');
    const u = await userById(env, String(b.assigned_to_user_id));
    if (!u || !u.is_active || !canReach(actor, u)) return fail('You cannot assign this task to that person.', 403);
    set('assigned_to_user_id', u.id); set('list_id', null); set('my_day_date', null); resetEscalation(sets);
  }
  if ('notes' in b) { if (!can.finish) return denied('notes'); set('notes', text(b.notes, 4000) || null); }
  if ('steps' in b) { if (!can.finish) return denied('steps'); set('steps', JSON.stringify(cleanSteps(b.steps) || [])); }
  if ('important' in b) { if (!can.personal && !can.manage) return denied('importance'); set('important', b.important ? 1 : 0); }
  if ('my_day_date' in b) { if (!can.personal) return fail('Only the person doing the task can add it to their My Day.', 403); set('my_day_date', isDate(b.my_day_date) ? b.my_day_date : null); }
  if ('list_id' in b) { if (!can.personal) return fail('Only the person doing the task can move it to their list.', 403); set('list_id', await ownListOrNull(env, b.list_id, actor.id)); }

  let spawned = null;
  if ('completed' in b) {
    if (!can.finish) return fail('Only the person it is assigned to (or whoever assigned it) can complete this task.', 403);
    if (b.completed && !t.completed_at) {
      sets.push(`completed_at = datetime('now')`); set('completed_by_user_id', actor.id);
      // Repeating task: the next one appears as this one is ticked off.
      if (t.repeat) {
        spawned = crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO tasks (id, title, notes, steps, due_date, repeat, important, list_id, lead_id, assigned_to_user_id, created_by_user_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
          .bind(spawned, t.title, t.notes, JSON.stringify(t.steps.map((s) => ({ ...s, done: false }))), nextDue(t.due_date, t.repeat), t.repeat,
            t.important ? 1 : 0, t.list_id, t.lead_id, t.assigned_to_user_id, t.created_by_user_id).run();
        set('repeat', null); // the finished copy no longer repeats
      }
    } else if (!b.completed && t.completed_at) { sets.push('completed_at = NULL', 'completed_by_user_id = NULL', 'cleared_at = NULL'); resetEscalation(sets); }
  }
  // Nudge (delayed-task workflow): the head sends the assignee a reminder, at most once an hour.
  if (b.nudge) {
    if (!can.manage || t.assigned_to_user_id === actor.id) return fail('Only the person who manages this task can send a reminder.', 403);
    if (t.completed_at) return fail('This task is already done.', 422);
    if (t.nudged_at && Date.now() - Date.parse(t.nudged_at.replace(' ', 'T') + 'Z') < 3600000) return fail('You just sent a reminder. Give it a little while.', 429);
    sets.push(`nudged_at = datetime('now')`); set('nudged_by_user_id', actor.id);
  }
  if (!sets.length) return json({ task: t });
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds).run();
  return json({ task: await loadTask(env, actor, taskId), next_task: spawned ? await loadTask(env, actor, spawned) : null });
}

/** POST /api/tasks/clear-completed {ids?} — hides the caller's own finished
 * tasks from their lists (cleared_at). Nothing is deleted: whoever assigned
 * them and the team stats still see them. Without ids, clears them all. */
export async function handleClearCompletedTasks(request, env, actor) {
  const b = await request.json().catch(() => ({}));
  const ids = Array.isArray(b?.ids) ? b.ids.map(String).slice(0, 500) : null;
  if (ids && !ids.length) return json({ cleared: 0 });
  const binds = [actor.id, ...(ids || [])];
  const only = ids ? `AND id IN (${ids.map((_, i) => '?' + (i + 2)).join(', ')})` : '';
  const r = await env.DB.prepare(`UPDATE tasks SET cleared_at = datetime('now')
      WHERE assigned_to_user_id = ?1 AND completed_at IS NOT NULL AND cleared_at IS NULL ${only}`).bind(...binds).run();
  return json({ cleared: r.meta?.changes ?? 0 });
}

export async function handleDeleteTask(env, taskId, actor) {
  const t = await loadTask(env, actor, taskId);
  if (!t) return fail('Task not found.', 404);
  const can = await roleOn(env, actor, t);
  if (!can.manage) return fail('Only whoever created or assigned this task can delete it.', 403);
  await env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(taskId).run();
  return json({ ok: true });
}

export async function handleTaskListWrite(request, env, actor, listId) {
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM task_lists WHERE id = ?1 AND owner_user_id = ?2').bind(listId, actor.id).run();
    return json({ ok: true });
  }
  const b = await request.json().catch(() => null);
  const name = text(b?.name, 60);
  if (!name) return fail('Give the list a name.', 422);
  const color = COLORS.includes(b?.color) ? b.color : 'blue';
  if (listId) {
    const r = await env.DB.prepare('UPDATE task_lists SET name = ?3, color = ?4 WHERE id = ?1 AND owner_user_id = ?2').bind(listId, actor.id, name, color).run();
    if (!r.meta?.changes) return fail('List not found.', 404);
    return json({ list: { id: listId, name, color } });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO task_lists (id, owner_user_id, name, color) VALUES (?1, ?2, ?3, ?4)').bind(id, actor.id, name, color).run();
  return json({ list: { id, name, color } }, 201);
}

/** Per-person scoreboard for managers/admins: open, overdue, done in range, on time. */
export async function handleTaskStats(request, env, actor) {
  if (!isAdmin(actor) && !isHead(actor)) return fail('Only managers and admins can see team task progress.', 403);
  const url = new URL(request.url);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today.slice(0, 8) + '01';
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  const people = isAdmin(actor)
    ? (await env.DB.prepare(`SELECT u.id, u.name, u.role, t.name team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.is_active = 1 ORDER BY t.name, u.name`).all()).results
    : (await env.DB.prepare(`SELECT u.id, u.name, u.role, t.name team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.is_active = 1 AND u.team_id = ?1 ORDER BY u.name`).bind(actor.team_id || '__none__').all()).results;
  if (!people.length) return json({ period: { from, to }, people: [] });
  const ids = people.map((p) => p.id);
  const ph = ids.map((_, i) => `?${i + 4}`).join(',');
  const r = await env.DB.prepare(`SELECT assigned_to_user_id id,
      SUM(completed_at IS NULL) open,
      SUM(completed_at IS NULL AND due_date < ?3) overdue,
      SUM(completed_at IS NULL AND due_date = ?3) due_today,
      SUM(completed_at IS NOT NULL AND date(completed_at, '+330 minutes') BETWEEN ?1 AND ?2) done,
      SUM(completed_at IS NOT NULL AND date(completed_at, '+330 minutes') BETWEEN ?1 AND ?2 AND (due_date IS NULL OR date(completed_at, '+330 minutes') <= due_date)) on_time,
      SUM(date(created_at, '+330 minutes') BETWEEN ?1 AND ?2) assigned
    FROM tasks WHERE assigned_to_user_id IN (${ph}) GROUP BY assigned_to_user_id`).bind(from, to, today, ...ids).all();
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  return json({
    period: { from, to },
    people: people.map((p) => ({ ...p, open: 0, overdue: 0, due_today: 0, done: 0, on_time: 0, assigned: 0, ...(by[p.id] || {}), id: p.id })),
  });
}

/** Light poll for the badge + "new task from X" toast. */
export async function handleTaskSummary(request, env, actor) {
  const since = new URL(request.url).searchParams.get('since');
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  await escalateQuietly(env);
  const counts = await env.DB.prepare(`SELECT SUM(due_date < ?2) overdue, SUM(due_date = ?2) due_today, COUNT(*) open
    FROM tasks WHERE assigned_to_user_id = ?1 AND completed_at IS NULL`).bind(actor.id, today).first();
  const fresh = since
    ? (await env.DB.prepare(`${TASK_SELECT} WHERE t.assigned_to_user_id = ?1 AND t.created_by_user_id <> ?1 AND t.created_at > ?2 AND t.completed_at IS NULL ORDER BY t.created_at DESC LIMIT 5`)
      .bind(actor.id, String(since)).all()).results.map((t) => ({ id: t.id, title: t.title, by: t.created_by_name }))
    : [];
  return json({ overdue: counts?.overdue ?? 0, due_today: counts?.due_today ?? 0, open: counts?.open ?? 0, new_assigned: fresh, now: new Date().toISOString().replace('T', ' ').slice(0, 19), ...(await delayedSummary(env, actor, since, today)) });
}

/** Delayed-task part of the poll: team_delayed = open delayed tasks of the
 *  people this head looks after; new_delayed = escalations addressed to this
 *  person since `since` (toast); nudged = reminders sent to this person. */
async function delayedSummary(env, actor, since, today) {
  const out = { team_delayed: 0, new_delayed: [], nudged: [] };
  try {
    const admin = isAdmin(actor);
    if (admin || (isHead(actor) && actor.team_id)) {
      const binds = [actor.id, today]; let scope = '1=1';
      if (!admin) { binds.push(actor.team_id); scope = 'assigned_to_user_id IN (SELECT id FROM users WHERE team_id = ?3)'; }
      out.team_delayed = (await env.DB.prepare(`SELECT COUNT(*) n FROM tasks WHERE completed_at IS NULL AND due_date < ?2 AND assigned_to_user_id <> ?1 AND ${scope}`).bind(...binds).first())?.n ?? 0;
    }
    if (since) {
      if (admin || isHead(actor)) {
        out.new_delayed = (await env.DB.prepare(`SELECT t.id, t.title, t.due_date, COALESCE(ua.name, 'Super administrator') AS who
            FROM tasks t LEFT JOIN users ua ON ua.id = t.assigned_to_user_id
            WHERE t.completed_at IS NULL AND (
              (t.escalated_at > ?2 AND (t.escalated_to_user_id = ?1 OR (?3 = 1 AND t.escalated_to_user_id = 'super-admin')))
              OR (?3 = 1 AND t.escalated2_at > ?2))
            ORDER BY t.due_date LIMIT 5`).bind(actor.id, String(since), admin ? 1 : 0).all()).results
          .map((r) => ({ id: r.id, title: r.title, who: r.who, days_late: Math.max(1, daysBetween(r.due_date, today)) }));
      }
      out.nudged = (await env.DB.prepare(`SELECT t.id, t.title, CASE WHEN t.nudged_by_user_id = 'super-admin' THEN 'Super administrator' ELSE un.name END AS by_name
          FROM tasks t LEFT JOIN users un ON un.id = t.nudged_by_user_id
          WHERE t.assigned_to_user_id = ?1 AND t.completed_at IS NULL AND t.nudged_at > ?2 ORDER BY t.nudged_at DESC LIMIT 5`).bind(actor.id, String(since)).all()).results
        .map((r) => ({ id: r.id, title: r.title, by: r.by_name || 'Your manager' }));
    }
  } catch (e) { console.error('Delayed summary failed:', e); }
  return out;
}
