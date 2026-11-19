/**
 * Post-Sales workstreams (wave 3, H2) — the NOC tracker and the legal / bank /
 * registration / possession checklist of a transaction, the readiness check
 * before registration, the Post-Sales dashboard and the daily overdue alerts.
 * Tables: transaction_nocs, transaction_tasks (migration 0068). The
 * transactions table itself belongs to H1 (migration 0067).
 *
 * Who may do what:
 *   read  — `transaction.read` (or `transaction.write`), or the transaction's
 *           coordinator / relationship manager
 *   write — `transaction.write`, or the transaction's coordinator
 *
 * Routes (wired from src/index.js → routeTransactionWorkstreams):
 *   GET    /api/transactions/:id/workstreams   NOCs + tasks + readiness + meta
 *   POST   /api/transactions/:id/nocs          add an NOC
 *   POST   /api/transactions/:id/tasks         add a checklist item
 *   POST   /api/transactions/:id/checklist     load the default checklist { type }
 *   PATCH  /api/transaction-nocs/:id           edit an NOC
 *   POST   /api/transaction-nocs/:id/log       add a query / correspondence entry { text }
 *   DELETE /api/transaction-nocs/:id
 *   PATCH  /api/transaction-tasks/:id          edit a checklist item
 *   DELETE /api/transaction-tasks/:id
 *   GET    /api/postsales/dashboard            tiles + lists for the Post-Sales dashboard
 */

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);

export const NOC_TYPES = { society: 'Society NOC', builder: 'Builder NOC', authority: 'MIDC / authority NOC', bank: 'Bank NOC', other: 'Other NOC' };
export const NOC_STATUSES = {
  not_assessed: 'Not assessed', not_started: 'Not started', documents_pending: 'Documents pending', ready_to_submit: 'Ready to submit',
  submitted: 'Submitted', query_raised: 'Query raised', resubmission_required: 'Resubmission required',
  approved: 'Approved', rejected: 'Rejected', not_applicable: 'Not applicable',
};
const NOC_CLOSED = ['approved', 'not_applicable'];
export const WORKSTREAMS = {
  commercial: 'Commercial confirmation', documents: 'Document collection', mou: 'MOU / term sheet', bank: 'Bank process',
  legal: 'Legal review', registration: 'Sale deed / Registration', possession: 'Possession', finance: 'Finance close',
};
/** Items that must be finished before the registration appointment. */
const PRE_REGISTRATION = ['commercial', 'documents', 'mou', 'bank', 'legal'];
export const TASK_STATUSES = { pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', not_applicable: 'Not applicable' };
const TASK_OPEN = ['pending', 'in_progress', 'blocked'];
const TXN_TYPES = { resale: 'Resale', builder_sale: 'Builder sale', rental: 'Rental', commercial: 'Commercial' };

/** Default NOC checklist by type (editable once added). */
const NOC_CHECKLISTS = {
  society: ['Application letter to the society', 'Maintenance dues cleared till date', 'Share certificate copy', 'Society managing committee approval', 'Transfer fee paid'],
  builder: ['Request letter to the builder', 'All builder dues cleared', 'Allotment letter / agreement copy', 'Builder transfer charges paid'],
  authority: ['Application on the MIDC / authority portal', 'Lease deed and allotment copy', 'Transfer charges paid', 'Site inspection (if asked)'],
  bank: ['Loan account statement', 'Foreclosure / outstanding letter', 'Bank NOC to sell / transfer', 'Original documents release list'],
  other: ['Application submitted', 'Charges paid'],
};

/** Checklist templates by transaction type: k = key (for depends), ws = workstream, d = due in N days from loading, dep = k of the prerequisite. */
const T = (k, ws, title, d, dep) => ({ k, ws, title, d, dep });
const TEMPLATES = {
  resale: [
    T('c1', 'commercial', 'Confirm final price and payment terms with buyer and seller', 2),
    T('c2', 'commercial', 'Token amount received and receipt shared', 3, 'c1'),
    T('d1', 'documents', "Collect seller's title documents (previous agreements, Index II)", 5),
    T('d2', 'documents', 'Collect share certificate and maintenance receipts', 5),
    T('d3', 'documents', 'Collect buyer and seller KYC (PAN, Aadhaar, photos)', 5),
    T('d4', 'documents', 'Collect property tax and electricity bill receipts', 7),
    T('m1', 'mou', 'Draft the MOU / term sheet', 4, 'c1'),
    T('m2', 'mou', 'Buyer and seller sign the MOU', 7, 'm1'),
    T('b1', 'bank', "Buyer's home loan sanction letter", 14),
    T('b2', 'bank', "Seller's loan outstanding letter / foreclosure amount", 10),
    T('b3', 'bank', 'Bank legal and technical valuation done', 18, 'b1'),
    T('b4', 'bank', 'Loan disbursement cheque / DD ready', 25, 'b3'),
    T('l1', 'legal', 'Title search report (30 years)', 12, 'd1'),
    T('l2', 'legal', 'Lawyer approves the draft sale deed', 18, 'l1'),
    T('r1', 'registration', 'Pay stamp duty and registration fee', 24, 'l2'),
    T('r2', 'registration', 'Book the sub-registrar appointment', 24),
    T('r3', 'registration', 'Register the sale deed', 28, 'r1'),
    T('p1', 'possession', 'Society transfer of share certificate', 35, 'r3'),
    T('p2', 'possession', 'Electricity and property tax name change', 40, 'r3'),
    T('p3', 'possession', 'Hand over keys and possession letter', 30, 'r3'),
    T('f1', 'finance', 'Collect brokerage from both sides', 30, 'r3'),
    T('f2', 'finance', 'Raise the invoice and close the file', 32, 'f1'),
  ],
  builder_sale: [
    T('c1', 'commercial', 'Confirm unit, price and payment plan with the builder', 2),
    T('c2', 'commercial', 'Booking amount paid and receipt received', 3, 'c1'),
    T('d1', 'documents', 'Collect buyer KYC (PAN, Aadhaar, photos)', 4),
    T('d2', 'documents', "Builder's allotment letter and cost sheet", 7, 'c2'),
    T('d3', 'documents', 'RERA registration and approved plan copies', 7),
    T('m1', 'mou', 'Booking form / cost sheet signed', 5, 'c1'),
    T('b1', 'bank', 'Home loan sanction letter', 14),
    T('b2', 'bank', "Bank approval for the builder's project", 14),
    T('b3', 'bank', 'Loan disbursement as per the payment plan', 30, 'b1'),
    T('l1', 'legal', 'Lawyer reviews the agreement for sale draft', 12, 'd2'),
    T('r1', 'registration', 'Pay stamp duty and registration fee', 20, 'l1'),
    T('r2', 'registration', 'Register the agreement for sale', 25, 'r1'),
    T('p1', 'possession', 'Possession letter and keys from the builder', 60, 'r2'),
    T('p2', 'possession', 'Society / maintenance account set up', 65, 'p1'),
    T('f1', 'finance', 'Collect brokerage from the builder', 40, 'r2'),
    T('f2', 'finance', 'Raise the invoice and close the file', 42, 'f1'),
  ],
  rental: [
    T('c1', 'commercial', 'Agree rent, deposit, lock-in and start date', 1),
    T('d1', 'documents', 'Collect owner and tenant KYC', 2),
    T('d2', 'documents', "Owner's ownership proof (Index II / agreement)", 2),
    T('m1', 'mou', 'Token amount and offer letter signed', 2, 'c1'),
    T('b1', 'bank', 'Security deposit transfer confirmed', 5, 'm1'),
    T('l1', 'legal', 'Draft the leave and licence agreement', 3, 'c1'),
    T('l2', 'legal', 'Tenant police verification', 5, 'd1'),
    T('r1', 'registration', 'Register the leave and licence agreement (biometric)', 6, 'l1'),
    T('p1', 'possession', 'Inventory list signed and keys handed over', 7, 'r1'),
    T('f1', 'finance', "Collect brokerage (one month's rent)", 8, 'r1'),
    T('f2', 'finance', 'Raise the invoice and close the file', 9, 'f1'),
  ],
  commercial: [
    T('c1', 'commercial', 'Confirm price / rent, escalation and fit-out period', 3),
    T('d1', 'documents', 'Company KYC (PAN, GST, board resolution)', 5),
    T('d2', 'documents', "Owner's title documents", 5),
    T('m1', 'mou', 'Term sheet / letter of intent signed', 7, 'c1'),
    T('b1', 'bank', 'Loan or funding confirmed (if any)', 15),
    T('l1', 'legal', 'Due diligence and title report', 15, 'd2'),
    T('l2', 'legal', 'Zoning and occupancy certificate check', 15),
    T('l3', 'legal', 'Lawyer approves the final agreement', 20, 'l1'),
    T('r1', 'registration', 'Pay stamp duty and register the agreement', 25, 'l3'),
    T('p1', 'possession', 'Fit-out handover and keys', 30, 'r1'),
    T('f1', 'finance', 'Collect brokerage', 32, 'r1'),
    T('f2', 'finance', 'Raise the GST invoice and close the file', 34, 'f1'),
  ],
};

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const userIdOf = (actor) => (actor.id === 'super-admin' ? null : actor.id);
function parseList(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
async function bodyOf(request) {
  try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}
function cleanChecklist(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 40).map((i) => ({ label: text(i?.label, 200), done: !!i?.done })).filter((i) => i.label);
}

async function loadTxn(env, id) {
  try { return await env.DB.prepare('SELECT * FROM transactions WHERE id = ?1').bind(id).first(); }
  catch (e) { if (/no such table/i.test(String(e?.message))) return null; throw e; } // transactions table not created yet
}
const canRead = (actor, txn, has) => has(actor, 'transaction.read') || has(actor, 'transaction.write') ||
  (!!actor.id && (txn.coordinator_user_id === actor.id || txn.relationship_manager_user_id === actor.id));
const canWrite = (actor, txn, has) => has(actor, 'transaction.write') || (!!actor.id && txn.coordinator_user_id === actor.id);

async function validUser(env, id) {
  if (!id) return true;
  return !!await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first();
}

function shapeNoc(n, today) {
  const open = !NOC_CLOSED.includes(n.status);
  const overdue = open && isDate(n.target_date) && n.target_date < today;
  return {
    ...n, checklist: parseList(n.checklist), log: parseList(n.log),
    type_name: n.noc_type === 'other' && n.type_label ? n.type_label : NOC_TYPES[n.noc_type] || n.noc_type,
    status_label: NOC_STATUSES[n.status] || n.status, open, overdue, days_overdue: overdue ? daysBetween(n.target_date, today) : 0,
  };
}
function shapeTasks(rows, today) {
  const byId = new Map(rows.map((t) => [t.id, t]));
  return rows.map((t) => {
    const dep = t.depends_on_task_id ? byId.get(t.depends_on_task_id) : null;
    const open = TASK_OPEN.includes(t.status);
    const overdue = open && isDate(t.due_date) && t.due_date < today;
    return {
      ...t, open, overdue, days_overdue: overdue ? daysBetween(t.due_date, today) : 0,
      workstream_label: WORKSTREAMS[t.workstream] || t.workstream, status_label: TASK_STATUSES[t.status] || t.status,
      waiting_for: open && dep && !['done', 'not_applicable'].includes(dep.status) ? dep.title : null,
    };
  });
}
function readiness(txn, nocs, tasks) {
  const items = [
    ...tasks.filter((t) => PRE_REGISTRATION.includes(t.workstream) && t.status !== 'not_applicable')
      .map((t) => ({ kind: 'task', id: t.id, label: t.title, group: t.workstream_label, status: t.status_label, open: t.status !== 'done' })),
    ...nocs.filter((n) => n.status !== 'not_applicable')
      .map((n) => ({ kind: 'noc', id: n.id, label: n.type_name, group: 'NOCs', status: n.status_label, open: n.status !== 'approved' })),
  ];
  const open = items.filter((i) => i.open);
  return {
    registration_on: txn.target_registration_on || null, registered_on: txn.actual_registration_on || null,
    total: items.length, done: items.length - open.length, ready: items.length > 0 && open.length === 0,
    open: open.map(({ open: _o, ...i }) => i),
  };
}

async function workstreamsFor(env, txn) {
  const today = istToday();
  const [n, t] = await env.DB.batch([
    env.DB.prepare(`SELECT n.*, u.name AS coordinator_name FROM transaction_nocs n LEFT JOIN users u ON u.id = n.coordinator_user_id
                     WHERE n.transaction_id = ?1 ORDER BY n.created_at`).bind(txn.id),
    env.DB.prepare(`SELECT k.*, u.name AS owner_name FROM transaction_tasks k LEFT JOIN users u ON u.id = k.owner_user_id
                     WHERE k.transaction_id = ?1 ORDER BY k.sort_order, k.created_at`).bind(txn.id),
  ]);
  const nocs = n.results.map((r) => shapeNoc(r, today));
  const tasks = shapeTasks(t.results, today);
  return { nocs, tasks, readiness: readiness(txn, nocs, tasks) };
}

const META = {
  noc_types: NOC_TYPES, noc_statuses: NOC_STATUSES, noc_checklists: NOC_CHECKLISTS, workstreams: WORKSTREAMS,
  task_statuses: TASK_STATUSES, txn_types: TXN_TYPES, pre_registration: PRE_REGISTRATION,
  templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.length])),
};

// ------------------------------------------------------------------ NOCs

async function nocFields(env, b, existing) {
  const sets = {};
  if (b.noc_type !== undefined) { if (!NOC_TYPES[b.noc_type]) return { error: 'Choose the NOC type.' }; sets.noc_type = b.noc_type; }
  if (b.type_label !== undefined) sets.type_label = text(b.type_label, 80);
  if (b.issuing_party !== undefined) sets.issuing_party = text(b.issuing_party, 160);
  if (b.coordinator_user_id !== undefined) {
    const id = b.coordinator_user_id || null;
    if (!await validUser(env, id)) return { error: 'That coordinator was not found.' };
    sets.coordinator_user_id = id;
  }
  if (b.checklist !== undefined) { const c = cleanChecklist(b.checklist); if (!c) return { error: 'Checklist must be a list.' }; sets.checklist = JSON.stringify(c); }
  for (const k of ['applied_on', 'target_date', 'completed_on']) {
    if (b[k] === undefined) continue;
    if (b[k] && !isDate(b[k])) return { error: 'Dates must look like 2026-10-31.' };
    sets[k] = b[k] || null;
  }
  if (b.charges !== undefined) {
    const v = b.charges === null || b.charges === '' ? null : Math.round(Number(b.charges));
    if (v !== null && (!Number.isFinite(v) || v < 0)) return { error: 'Charges must be an amount in rupees.' };
    sets.charges = v;
  }
  if (b.payment_note !== undefined) sets.payment_note = text(b.payment_note, 500);
  if (b.evidence_note !== undefined) sets.evidence_note = text(b.evidence_note, 1000);
  if (b.status !== undefined) {
    if (!NOC_STATUSES[b.status]) return { error: 'Choose a valid NOC status.' };
    sets.status = b.status;
    if (b.status === 'approved' && !(sets.completed_on || existing?.completed_on)) sets.completed_on = istToday();
  }
  return { sets };
}

async function createNoc(request, env, actor, txn) {
  const b = await bodyOf(request);
  if (!b) return fail('Send the NOC details.', 422);
  const type = b.noc_type || 'society';
  if (!NOC_TYPES[type]) return fail('Choose the NOC type.', 422);
  if (b.checklist === undefined) b.checklist = NOC_CHECKLISTS[type].map((label) => ({ label, done: false }));
  const { sets, error } = await nocFields(env, { status: 'not_assessed', ...b, noc_type: type }, null);
  if (error) return fail(error, 422);
  const id = crypto.randomUUID();
  const cols = Object.keys(sets);
  await env.DB.prepare(`INSERT INTO transaction_nocs (id, transaction_id, created_by_user_id, ${cols.join(', ')})
                        VALUES (?1, ?2, ?3, ${cols.map((_, i) => '?' + (i + 4)).join(', ')})`)
    .bind(id, txn.id, userIdOf(actor), ...cols.map((c) => sets[c])).run();
  return json({ ok: true, id, ...(await workstreamsFor(env, txn)) }, 201);
}

async function loadNocWithTxn(env, id) {
  const noc = await env.DB.prepare('SELECT * FROM transaction_nocs WHERE id = ?1').bind(id).first();
  return noc ? { noc, txn: await loadTxn(env, noc.transaction_id) } : {};
}

async function updateNoc(request, env, actor, id, has) {
  const { noc, txn } = await loadNocWithTxn(env, id);
  if (!noc || !txn) return fail('NOC not found.', 404);
  if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
  const b = await bodyOf(request);
  if (!b) return fail('Send the changes.', 422);
  const { sets, error } = await nocFields(env, b, noc);
  if (error) return fail(error, 422);
  const cols = Object.keys(sets);
  if (cols.length) {
    await env.DB.prepare(`UPDATE transaction_nocs SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(', ')}, updated_at = datetime('now') WHERE id = ?1`)
      .bind(id, ...cols.map((c) => sets[c])).run();
  }
  return json({ ok: true, ...(await workstreamsFor(env, txn)) });
}

async function addNocLog(request, env, actor, id, has) {
  const { noc, txn } = await loadNocWithTxn(env, id);
  if (!noc || !txn) return fail('NOC not found.', 404);
  if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
  const b = await bodyOf(request);
  const t = text(b?.text, 2000);
  if (!t) return fail('Write the query or reply first.', 422);
  const entry = { at: new Date().toISOString(), by: userIdOf(actor), by_name: actor.name || 'Someone', text: t };
  // Appended in SQL so two people logging at once never overwrite each other.
  await env.DB.prepare(`UPDATE transaction_nocs SET log = json_insert(CASE WHEN json_valid(log) THEN log ELSE '[]' END, '$[#]', json(?2)), updated_at = datetime('now') WHERE id = ?1`)
    .bind(id, JSON.stringify(entry)).run();
  return json({ ok: true, ...(await workstreamsFor(env, txn)) });
}

async function deleteNoc(env, actor, id, has) {
  const { noc, txn } = await loadNocWithTxn(env, id);
  if (!noc || !txn) return fail('NOC not found.', 404);
  if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
  await env.DB.prepare('DELETE FROM transaction_nocs WHERE id = ?1').bind(id).run();
  return json({ ok: true, ...(await workstreamsFor(env, txn)) });
}

// ----------------------------------------------------------------- tasks

async function taskFields(env, b, txnId, selfId) {
  const sets = {};
  if (b.workstream !== undefined) { if (!WORKSTREAMS[b.workstream]) return { error: 'Choose the workstream.' }; sets.workstream = b.workstream; }
  if (b.title !== undefined) { const t = text(b.title, 200); if (!t) return { error: 'Give the item a title.' }; sets.title = t; }
  if (b.owner_user_id !== undefined) {
    const id = b.owner_user_id || null;
    if (!await validUser(env, id)) return { error: 'That owner was not found.' };
    sets.owner_user_id = id;
  }
  if (b.due_date !== undefined) { if (b.due_date && !isDate(b.due_date)) return { error: 'Dates must look like 2026-10-31.' }; sets.due_date = b.due_date || null; }
  if (b.depends_on_task_id !== undefined) {
    const dep = b.depends_on_task_id || null;
    if (dep) {
      if (dep === selfId) return { error: 'An item cannot wait for itself.' };
      const rows = (await env.DB.prepare('SELECT id, depends_on_task_id FROM transaction_tasks WHERE transaction_id = ?1').bind(txnId).all()).results;
      const parent = new Map(rows.map((r) => [r.id, r.depends_on_task_id]));
      if (!parent.has(dep)) return { error: 'That item is not part of this transaction.' };
      // No circles: walking up from the new prerequisite must never reach this item.
      for (let cur = dep, hops = 0; cur && hops < 200; cur = parent.get(cur), hops++) if (cur === selfId) return { error: 'That would make the two items wait for each other.' };
    }
    sets.depends_on_task_id = dep;
  }
  if (b.status !== undefined) {
    if (!TASK_STATUSES[b.status]) return { error: 'Choose a valid status.' };
    sets.status = b.status;
    sets.completed_at = b.status === 'done' ? new Date().toISOString() : null;
    if (b.status !== 'blocked' && b.blocked_reason === undefined) sets.blocked_reason = null;
  }
  if (b.blocked_reason !== undefined) sets.blocked_reason = text(b.blocked_reason, 500);
  if (b.evidence_note !== undefined) sets.evidence_note = text(b.evidence_note, 1000);
  return { sets };
}

async function createTask(request, env, actor, txn) {
  const b = await bodyOf(request);
  if (!b || !text(b.title, 200)) return fail('Give the item a title.', 422);
  const { sets, error } = await taskFields(env, { workstream: 'commercial', ...b }, txn.id, null);
  if (error) return fail(error, 422);
  const id = crypto.randomUUID();
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM transaction_tasks WHERE transaction_id = ?1').bind(txn.id).first();
  sets.sort_order = (max?.m || 0) + 1;
  const cols = Object.keys(sets);
  await env.DB.prepare(`INSERT INTO transaction_tasks (id, transaction_id, created_by_user_id, ${cols.join(', ')})
                        VALUES (?1, ?2, ?3, ${cols.map((_, i) => '?' + (i + 4)).join(', ')})`)
    .bind(id, txn.id, userIdOf(actor), ...cols.map((c) => sets[c])).run();
  return json({ ok: true, id, ...(await workstreamsFor(env, txn)) }, 201);
}

async function loadTaskWithTxn(env, id) {
  const task = await env.DB.prepare('SELECT * FROM transaction_tasks WHERE id = ?1').bind(id).first();
  return task ? { task, txn: await loadTxn(env, task.transaction_id) } : {};
}

async function updateTask(request, env, actor, id, has) {
  const { task, txn } = await loadTaskWithTxn(env, id);
  if (!task || !txn) return fail('Item not found.', 404);
  if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
  const b = await bodyOf(request);
  if (!b) return fail('Send the changes.', 422);
  if (b.status === task.status) delete b.status; // keep completed_at when nothing changed
  const { sets, error } = await taskFields(env, b, txn.id, id);
  if (error) return fail(error, 422);
  const cols = Object.keys(sets);
  if (cols.length) {
    await env.DB.prepare(`UPDATE transaction_tasks SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(', ')}, updated_at = datetime('now') WHERE id = ?1`)
      .bind(id, ...cols.map((c) => sets[c])).run();
  }
  return json({ ok: true, ...(await workstreamsFor(env, txn)) });
}

async function deleteTask(env, actor, id, has) {
  const { task, txn } = await loadTaskWithTxn(env, id);
  if (!task || !txn) return fail('Item not found.', 404);
  if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
  await env.DB.batch([
    env.DB.prepare('UPDATE transaction_tasks SET depends_on_task_id = NULL WHERE depends_on_task_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM transaction_tasks WHERE id = ?1').bind(id),
  ]);
  return json({ ok: true, ...(await workstreamsFor(env, txn)) });
}

/** Add the template's items that are not there yet (same workstream + title), so loading twice is harmless. */
async function loadChecklist(request, env, actor, txn) {
  const b = (await bodyOf(request)) || {};
  const type = b.type || txn.txn_type || 'resale';
  const template = TEMPLATES[type];
  if (!template) return fail('Choose resale, builder sale, rental or commercial.', 422);
  const existing = (await env.DB.prepare('SELECT id, workstream, title, sort_order FROM transaction_tasks WHERE transaction_id = ?1').bind(txn.id).all()).results;
  const keyOf = (ws, title) => ws + '|' + title.toLowerCase();
  const have = new Map(existing.map((r) => [keyOf(r.workstream, r.title), r.id]));
  const idFor = new Map();
  for (const item of template) idFor.set(item.k, have.get(keyOf(item.ws, item.title)) || crypto.randomUUID());
  let order = existing.reduce((m, r) => Math.max(m, r.sort_order || 0), 0);
  const today = istToday();
  const owner = txn.coordinator_user_id || null;
  const stmts = [];
  for (const item of template) {
    if (have.has(keyOf(item.ws, item.title))) continue;
    stmts.push(env.DB.prepare(`INSERT INTO transaction_tasks (id, transaction_id, workstream, title, owner_user_id, due_date, depends_on_task_id, template_key, sort_order, created_by_user_id)
                               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(idFor.get(item.k), txn.id, item.ws, item.title, owner, item.d != null ? addDays(today, item.d) : null,
        item.dep ? idFor.get(item.dep) : null, type + ':' + item.k, ++order, userIdOf(actor)));
  }
  // Prerequisites are inserted before the items that wait for them (template order), so FKs hold.
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, added: stmts.length, ...(await workstreamsFor(env, txn)) });
}

// -------------------------------------------------------------- dashboard

async function tableExists(env, name) {
  return !!await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1`).bind(name).first();
}

const TXN_LABEL_SQL = `COALESCE(t.txn_code, '') AS txn_code, t.id AS transaction_id, t.stage, t.txn_type,
  COALESCE(l.customer_name, '') AS client_name, COALESCE(NULLIF(t.unit_label, ''), p.name, pr.name, '') AS place`;
const TXN_JOINS = `LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN properties p ON p.id = t.property_id LEFT JOIN projects pr ON pr.id = t.project_id`;

async function dashboard(env, actor, has, raiseAlert) {
  if (!has(actor, 'transaction.read') && !has(actor, 'transaction.write')) return fail('Only the Post-Sales team can see this dashboard.', 403);
  if (!await tableExists(env, 'transactions')) return json({ ready: false, stages: [], overdue_nocs: [], blocked_tasks: [], registrations: [], due_tasks: [], missing_documents: null, tiles: {} });
  // Overdue alerts also go out on read (deduplicated per day), so a missed cron run is caught up.
  await alertOverdueWorkstreams(env, raiseAlert).catch((e) => console.error('workstream alerts failed', e));
  const today = istToday();
  const week = addDays(today, 7);
  const fortnight = addDays(today, 14);
  const OPEN = `t.status = 'open'`;
  const [stages, nocs, blocked, regs, due] = await env.DB.batch([
    env.DB.prepare(`SELECT t.stage, COUNT(*) AS n FROM transactions t WHERE ${OPEN} GROUP BY t.stage`),
    env.DB.prepare(`SELECT n.id, n.noc_type, n.type_label, n.status, n.target_date, u.name AS coordinator_name, ${TXN_LABEL_SQL}
                      FROM transaction_nocs n JOIN transactions t ON t.id = n.transaction_id ${TXN_JOINS}
                      LEFT JOIN users u ON u.id = n.coordinator_user_id
                     WHERE ${OPEN} AND n.status NOT IN ('approved', 'not_applicable') AND n.target_date IS NOT NULL AND n.target_date < ?1
                     ORDER BY n.target_date LIMIT 100`).bind(today),
    env.DB.prepare(`SELECT k.id, k.title, k.workstream, k.blocked_reason, k.due_date, u.name AS owner_name,
                           d.title AS dep_title, d.status AS dep_status, ${TXN_LABEL_SQL}
                      FROM transaction_tasks k JOIN transactions t ON t.id = k.transaction_id ${TXN_JOINS}
                      LEFT JOIN users u ON u.id = k.owner_user_id LEFT JOIN transaction_tasks d ON d.id = k.depends_on_task_id
                     WHERE ${OPEN} AND k.status = 'blocked' ORDER BY k.due_date IS NULL, k.due_date LIMIT 100`),
    env.DB.prepare(`SELECT t.target_registration_on AS registration_on, ${TXN_LABEL_SQL},
                           (SELECT COUNT(*) FROM transaction_tasks k WHERE k.transaction_id = t.id AND k.workstream IN ('commercial','documents','mou','bank','legal') AND k.status IN ('pending','in_progress','blocked')) AS open_tasks,
                           (SELECT COUNT(*) FROM transaction_tasks k WHERE k.transaction_id = t.id AND k.workstream IN ('commercial','documents','mou','bank','legal') AND k.status <> 'not_applicable') AS all_tasks,
                           (SELECT COUNT(*) FROM transaction_nocs n WHERE n.transaction_id = t.id AND n.status NOT IN ('approved','not_applicable')) AS open_nocs,
                           (SELECT COUNT(*) FROM transaction_nocs n WHERE n.transaction_id = t.id AND n.status <> 'not_applicable') AS all_nocs
                      FROM transactions t ${TXN_JOINS}
                     WHERE ${OPEN} AND t.actual_registration_on IS NULL AND t.target_registration_on IS NOT NULL AND t.target_registration_on <= ?1
                     ORDER BY t.target_registration_on LIMIT 100`).bind(fortnight),
    env.DB.prepare(`SELECT k.id, k.title, k.workstream, k.status, k.due_date, u.name AS owner_name, ${TXN_LABEL_SQL}
                      FROM transaction_tasks k JOIN transactions t ON t.id = k.transaction_id ${TXN_JOINS}
                      LEFT JOIN users u ON u.id = k.owner_user_id
                     WHERE ${OPEN} AND k.status IN ('pending','in_progress','blocked') AND k.due_date IS NOT NULL AND k.due_date <= ?1
                     ORDER BY k.due_date LIMIT 150`).bind(week),
  ]);

  // Missing documents: open "Document collection" items, plus documents sent back (rejected) in document control (H3) when it exists.
  const docTasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM transaction_tasks k JOIN transactions t ON t.id = k.transaction_id
                                           WHERE t.status = 'open' AND k.workstream = 'documents' AND k.status IN ('pending','in_progress','blocked')`).first();
  let rejectedDocs = null;
  if (await tableExists(env, 'documents')) {
    rejectedDocs = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM documents d
        WHERE d.review_status = 'rejected' AND ((d.entity_type = 'transaction' AND d.entity_id IN (SELECT id FROM transactions WHERE status = 'open'))
           OR (d.entity_type = 'noc' AND d.entity_id IN (SELECT n.id FROM transaction_nocs n JOIN transactions t ON t.id = n.transaction_id WHERE t.status = 'open')))`)
      .first().catch(() => null))?.n ?? null;
  }

  const overdueNocs = nocs.results.map((n) => ({ ...n, type_name: n.noc_type === 'other' && n.type_label ? n.type_label : NOC_TYPES[n.noc_type] || n.noc_type, status_label: NOC_STATUSES[n.status] || n.status, days_overdue: daysBetween(n.target_date, today) }));
  const blockedTasks = blocked.results.map((k) => ({
    ...k, workstream_label: WORKSTREAMS[k.workstream] || k.workstream,
    blocked_by: k.dep_title && !['done', 'not_applicable'].includes(k.dep_status) ? `Waiting for “${k.dep_title}”` : k.blocked_reason || 'No reason given',
  }));
  const registrations = regs.results.map((r) => {
    const open = r.open_tasks + r.open_nocs, total = r.all_tasks + r.all_nocs;
    return { ...r, open_items: open, total_items: total, ready: total > 0 && open === 0, days_left: daysBetween(today, r.registration_on) };
  });
  const dueTasks = due.results.map((k) => ({ ...k, workstream_label: WORKSTREAMS[k.workstream] || k.workstream, status_label: TASK_STATUSES[k.status] || k.status, overdue: k.due_date < today }));
  const stageRows = stages.results;
  return json({
    ready: true, today,
    tiles: {
      active: stageRows.reduce((s, r) => s + r.n, 0), overdue_nocs: overdueNocs.length, blocked_tasks: blockedTasks.length,
      registrations: registrations.length, due_tasks: dueTasks.length, missing_documents: (docTasks?.n || 0) + (rejectedDocs || 0),
    },
    stages: stageRows, overdue_nocs: overdueNocs, blocked_tasks: blockedTasks, registrations, due_tasks: dueTasks,
    missing_documents: { collection_items: docTasks?.n || 0, rejected_documents: rejectedDocs },
  });
}

// ---------------------------------------------------------- daily alerts

/**
 * Overdue NOCs and checklist items → raiseAlert to the item's coordinator /
 * owner and the transaction coordinator. Medium; high when more than 3 days
 * late. At most one alert per item per (IST) day: last_alerted_on is claimed
 * with a conditional UPDATE first, so the cron and an on-read run never both send.
 */
export async function alertOverdueWorkstreams(env, raiseAlert) {
  const today = istToday();
  let nocs, tasks;
  try {
    [nocs, tasks] = await env.DB.batch([
      env.DB.prepare(`SELECT n.id, n.noc_type, n.type_label, n.status, n.target_date, n.coordinator_user_id, t.id AS transaction_id, t.txn_code, t.coordinator_user_id AS txn_coordinator
                        FROM transaction_nocs n JOIN transactions t ON t.id = n.transaction_id
                       WHERE t.status = 'open' AND n.status NOT IN ('approved', 'not_applicable') AND n.target_date IS NOT NULL AND n.target_date < ?1
                         AND (n.last_alerted_on IS NULL OR n.last_alerted_on < ?1) LIMIT 300`).bind(today),
      env.DB.prepare(`SELECT k.id, k.title, k.due_date, k.owner_user_id, t.id AS transaction_id, t.txn_code, t.coordinator_user_id AS txn_coordinator
                        FROM transaction_tasks k JOIN transactions t ON t.id = k.transaction_id
                       WHERE t.status = 'open' AND k.status IN ('pending', 'in_progress', 'blocked') AND k.due_date IS NOT NULL AND k.due_date < ?1
                         AND (k.last_alerted_on IS NULL OR k.last_alerted_on < ?1) LIMIT 300`).bind(today),
    ]);
  } catch (e) { console.error('workstream alerts: tables missing?', e); return { nocs: 0, tasks: 0 }; }
  const claim = async (table, id) => (await env.DB.prepare(`UPDATE ${table} SET last_alerted_on = ?1 WHERE id = ?2 AND (last_alerted_on IS NULL OR last_alerted_on < ?1)`).bind(today, id).run()).meta?.changes > 0;
  const recipients = (...ids) => [...new Set(ids.filter(Boolean))];
  const late = (d) => { const n = daysBetween(d, today); return { n, words: n === 1 ? '1 day' : `${n} days` }; };
  let sentNocs = 0, sentTasks = 0;
  for (const n of nocs.results) {
    if (!await claim('transaction_nocs', n.id)) continue;
    const { n: days, words } = late(n.target_date);
    const name = n.noc_type === 'other' && n.type_label ? n.type_label : NOC_TYPES[n.noc_type] || 'NOC';
    await raiseAlert(env, {
      importance: days > 3 ? 'high' : 'medium', to: { userIds: recipients(n.coordinator_user_id, n.txn_coordinator) },
      title: `${name} is overdue · ${n.txn_code || 'transaction'}`,
      body: `${words} past the target date (${n.target_date}). Status: ${NOC_STATUSES[n.status] || n.status}.`,
      link: { kind: 'transaction', id: n.transaction_id },
    });
    sentNocs++;
  }
  for (const k of tasks.results) {
    if (!await claim('transaction_tasks', k.id)) continue;
    const { n: days, words } = late(k.due_date);
    await raiseAlert(env, {
      importance: days > 3 ? 'high' : 'medium', to: { userIds: recipients(k.owner_user_id, k.txn_coordinator) },
      title: `Overdue: ${k.title} · ${k.txn_code || 'transaction'}`,
      body: `${words} past the due date (${k.due_date}).`,
      link: { kind: 'transaction', id: k.transaction_id },
    });
    sentTasks++;
  }
  return { nocs: sentNocs, tasks: sentTasks };
}

// ------------------------------------------------------------------ router

/** Returns a Response for workstream routes, or null so the main router carries on. */
export async function routeTransactionWorkstreams(request, env, actor, path, { has, raiseAlert }) {
  if (!path.startsWith('/api/transaction') && path !== '/api/postsales/dashboard') return null;
  const m = request.method;
  if (path === '/api/postsales/dashboard' && m === 'GET') return dashboard(env, actor, has, raiseAlert);

  const txnMatch = path.match(/^\/api\/transactions\/([^/]+)\/(workstreams|nocs|tasks|checklist)$/);
  if (txnMatch) {
    const [, txnId, what] = txnMatch;
    const allowed = (what === 'workstreams' && m === 'GET') || (what !== 'workstreams' && m === 'POST');
    if (!allowed) return null;
    const txn = await loadTxn(env, txnId);
    if (!txn) return fail('Transaction not found.', 404);
    if (what === 'workstreams') {
      if (!canRead(actor, txn, has)) return fail('You cannot see this transaction.', 403);
      return json({ ...(await workstreamsFor(env, txn)), meta: META, can_write: canWrite(actor, txn, has) });
    }
    if (!canWrite(actor, txn, has)) return fail('You cannot change this transaction.', 403);
    if (what === 'nocs') return createNoc(request, env, actor, txn);
    if (what === 'tasks') return createTask(request, env, actor, txn);
    return loadChecklist(request, env, actor, txn);
  }
  const nocMatch = path.match(/^\/api\/transaction-nocs\/([^/]+)(\/log)?$/);
  if (nocMatch) {
    if (nocMatch[2] && m === 'POST') return addNocLog(request, env, actor, nocMatch[1], has);
    if (!nocMatch[2] && m === 'PATCH') return updateNoc(request, env, actor, nocMatch[1], has);
    if (!nocMatch[2] && m === 'DELETE') return deleteNoc(env, actor, nocMatch[1], has);
    return null;
  }
  const taskMatch = path.match(/^\/api\/transaction-tasks\/([^/]+)$/);
  if (taskMatch) {
    if (m === 'PATCH') return updateTask(request, env, actor, taskMatch[1], has);
    if (m === 'DELETE') return deleteTask(env, actor, taskMatch[1], has);
  }
  return null;
}
