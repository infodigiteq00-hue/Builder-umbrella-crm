/**
 * Post-Sales core (wave 3, H1) — token / booking, transactions (T-00001),
 * transaction parties and the transaction history log. Tables: bookings,
 * transactions, transaction_parties, transaction_events (migration 0067).
 *
 * A token / booking is money paid to block a unit: it is NOT a closure. The
 * deal lives on as a transaction that walks token → documents → agreement →
 * registration → possession → closed (or cancelled).
 *
 * Lead stage rule (conservative, so a token is never counted as a sale):
 *   - recording a token or starting a transaction lifts an earlier lead to
 *     'negotiation' (detail "final approval") at most — never to won;
 *   - the lead becomes won / "booked" once the agreement is signed
 *     (transaction stage agreement, registration or possession);
 *   - won / "won" when the transaction is closed;
 *   - cancelling the last live transaction puts a won lead back to negotiation.
 *
 * Who may do what:
 *   token     — record / change: whoever may update the lead, or `transaction.write`
 *   txn read  — `transaction.read` / `transaction.write`, the coordinator or
 *               relationship manager, or anyone who may read the linked lead
 *               (an agent sees their own leads' transactions)
 *   txn start — from a token: whoever may update the lead, or `transaction.write`;
 *               without a token (manual): `transaction.write` only
 *   txn edit  — `transaction.write` (stage, commercials, people, milestones, parties)
 *
 * Routes (wired from src/index.js → routeTransactions):
 *   GET/POST  /api/leads/:id/bookings          tokens on a lead (+ its transactions)
 *   PATCH     /api/bookings/:id                edit / mark refunded or cancelled
 *   POST/GET  /api/bookings/:id/receipt        receipt photo / PDF in R2 (signed-in readers only)
 *   GET/POST  /api/transactions                list (q, stage, type, coordinator, overdue) / create
 *   GET/PATCH /api/transactions/:id            { transaction, parties, events, lead, property, project, booking }
 *   POST      /api/transactions/:id/parties    PATCH / DELETE /api/transactions/:id/parties/:partyId
 */

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);
async function bodyJson(request) {
  try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}
// Helpers that live in src/index.js, handed over by routeTransactions(…, deps).
let has, raiseAlert, canReadLead, canUpdateLead, parseMoney, actorUserId, recordCodeQuery;

export const BOOKING_RECIPIENTS = ['builder', 'owner', 'atlantic'];
export const TXN_TYPES = ['resale', 'builder_sale', 'rental', 'commercial'];
export const TXN_STAGES = ['token_received', 'documents', 'agreement', 'registration', 'possession', 'closed', 'cancelled'];
const TXN_STAGE_LABEL = { token_received: 'Token received', documents: 'Documents', agreement: 'Agreement', registration: 'Registration', possession: 'Possession', closed: 'Closed', cancelled: 'Cancelled' };
const TXN_BOOKED_STAGES = ['agreement', 'registration', 'possession'];
export const TXN_PARTY_ROLES = ['buyer', 'seller', 'co_owner', 'legal_heir', 'poa_holder', 'other'];
const TXN_MILESTONES = ['mou', 'documents', 'agreement', 'registration', 'possession'];
const TXN_DATE_FIELDS = TXN_MILESTONES.flatMap((m) => [`target_${m}_on`, `actual_${m}_on`]);
const TXN_TEXT_FIELDS = { unit_label: 160, payment_schedule_note: 4000, brokerage_note: 4000, cancel_reason: 1000 };
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const RECEIPT_EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const LEAD_STAGE_ORDER = ['new', 'contact_attempted', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visited', 'proposal', 'negotiation', 'won'];

const txnText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
/** 'YYYY-MM-DD' | null (cleared) | undefined (not sent); false = invalid. */
function txnDate(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return false;
  const d = new Date(v.trim() + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v.trim() ? false : v.trim();
}
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const actorName = (actor) => actor?.name || 'Someone';
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export function canReadTransaction(actor, txn, lead) {
  if (has(actor, 'transaction.read') || has(actor, 'transaction.write')) return true;
  if (actor.id && (txn.coordinator_user_id === actor.id || txn.relationship_manager_user_id === actor.id)) return true;
  return Boolean(lead && canReadLead(actor, lead));
}
/** WHERE fragment on aliases t (transactions) / l (leads); '' = everything. */
function transactionScope(actor, bind) {
  if (has(actor, 'transaction.read') || has(actor, 'transaction.write') || has(actor, 'lead.read_all')) return '';
  const me = bind(actor.id);
  const parts = [`t.coordinator_user_id = ${me}`, `t.relationship_manager_user_id = ${me}`];
  if (has(actor, 'lead.read_own')) parts.push(`l.assigned_user_id = ${me}`);
  if (has(actor, 'lead.read_team') && actor.team_id) parts.push(`l.team_id = ${bind(actor.team_id)}`);
  return `(${parts.join(' OR ')})`;
}
/** Next milestone still open (in order) with a target date, and whether any open target is past. */
function txnNextTarget(t) {
  if (t.status !== 'open') return { next_target: null, overdue: false, overdue_count: 0 };
  const today = istToday();
  let next = null; let overdueCount = 0;
  for (const m of TXN_MILESTONES) {
    const target = t[`target_${m}_on`];
    if (!target || t[`actual_${m}_on`]) continue;
    if (target < today) overdueCount++;
    if (!next) next = { milestone: m, date: target };
  }
  return { next_target: next, overdue: overdueCount > 0, overdue_count: overdueCount };
}
const shapeTransaction = (t) => (t ? { ...t, ...txnNextTarget(t) } : t);

async function txnActiveUser(env, id) {
  if (id === undefined) return undefined;
  if (id === null || id === '') return null;
  const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?1 AND is_active = 1').bind(String(id)).first();
  return u ? u.id : false;
}
const txnEvent = (env, txnId, actor, kind, fromValue = null, toValue = null, note = null) => env.DB.prepare(
  'INSERT INTO transaction_events (transaction_id, kind, from_value, to_value, note, actor_user_id, actor_name) VALUES (?1,?2,?3,?4,?5,?6,?7)'
).bind(txnId, kind, fromValue, toValue, note, actorUserId(actor), actorName(actor));

/** Lead stage move caused by a token / transaction, logged like a manual move. Returns statements. */
function leadStageMove(env, lead, actor, toStage, subStatus, note) {
  if (!lead || (lead.stage === toStage && (lead.sub_status || null) === subStatus)) return [];
  const status = toStage === 'won' ? 'converted' : toStage === 'lost' ? 'dead' : lead.assigned_user_id ? 'in_process' : 'new';
  return [
    env.DB.prepare('UPDATE leads SET stage = ?2, sub_status = ?3, status = ?4 WHERE id = ?1').bind(lead.id, toStage, subStatus, status),
    env.DB.prepare('INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, actor_user_id, note, sub_status) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(lead.id, lead.stage, toStage, actor.id, note, subStatus),
  ];
}
/** Lift an early lead to negotiation (never lowers a lead, never touches won / lost). */
function leadToNegotiation(env, lead, actor, note) {
  if (!lead || ['won', 'lost'].includes(lead.stage)) return [];
  if (lead.stage !== 'nurture' && LEAD_STAGE_ORDER.indexOf(lead.stage) >= LEAD_STAGE_ORDER.indexOf('negotiation')) return [];
  return leadStageMove(env, lead, actor, 'negotiation', 'final_approval', note);
}
const leadNote = (env, leadId, actor, subject) => env.DB.prepare("INSERT INTO lead_activities (id, lead_id, actor_user_id, type, subject) VALUES (?1,?2,?3,'note',?4)")
  .bind(crypto.randomUUID(), leadId, actor.id, subject.slice(0, 300));

// ----------------------------------------------------------------- bookings
function shapeBooking(b) {
  if (!b) return b;
  const { receipt_r2_key, ...rest } = b;
  return { ...rest, has_receipt: Boolean(receipt_r2_key) };
}
const BOOKING_SELECT = `SELECT b.*, p.name AS property_name, p.property_code, pj.name AS project_name, u.name AS created_by_name,
    (SELECT t.id FROM transactions t WHERE t.booking_id = b.id ORDER BY t.created_at DESC LIMIT 1) AS transaction_id,
    (SELECT t.txn_code FROM transactions t WHERE t.booking_id = b.id ORDER BY t.created_at DESC LIMIT 1) AS txn_code
  FROM bookings b
  LEFT JOIN properties p ON p.id = b.property_id
  LEFT JOIN projects pj ON pj.id = b.project_id
  LEFT JOIN users u ON u.id = b.created_by_user_id`;

async function handleLeadBookings(env, leadId, actor) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(leadId).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canReadLead(actor, lead) && !has(actor, 'transaction.read') && !has(actor, 'transaction.write')) return fail('You do not have permission to view this lead.', 403);
  const [bookings, txns] = await Promise.all([
    env.DB.prepare(`${BOOKING_SELECT} WHERE b.lead_id = ?1 ORDER BY b.created_at DESC`).bind(leadId).all(),
    env.DB.prepare(`SELECT t.id, t.txn_code, t.stage, t.status, t.txn_type, t.agreed_price, t.booking_id, t.created_at, c.name AS coordinator_name
                      FROM transactions t LEFT JOIN users c ON c.id = t.coordinator_user_id WHERE t.lead_id = ?1 ORDER BY t.created_at DESC`).bind(leadId).all(),
  ]);
  return json({
    bookings: (bookings.results ?? []).map(shapeBooking),
    transactions: txns.results ?? [],
    can_record: Boolean(canUpdateLead(actor, lead) || has(actor, 'transaction.write')),
    can_write_transactions: has(actor, 'transaction.write'),
  });
}

async function handleCreateBooking(request, env, leadId, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(leadId).first();
  if (!lead) return fail('Lead not found.', 404);
  if (!canUpdateLead(actor, lead) && !has(actor, 'transaction.write')) return fail('You do not have permission to record a token on this lead.', 403);
  const amount = parseMoney(body.amount);
  if (!amount || amount <= 0) return fail('Enter the token amount, e.g. 1,00,000 or 1 L.', 422);
  if (amount > 1e11) return fail('That token amount looks too large — please check it.', 422);
  const propertyId = txnText(body.property_id, 80);
  const projectId = txnText(body.project_id, 80);
  if (!propertyId && !projectId) return fail('Choose the property or project the token is for.', 422);
  const place = propertyId
    ? await env.DB.prepare('SELECT name FROM properties WHERE id = ?1').bind(propertyId).first()
    : await env.DB.prepare('SELECT name FROM projects WHERE id = ?1').bind(projectId).first();
  if (!place) return fail(propertyId ? 'That property was not found.' : 'That project was not found.', 422);
  if (propertyId && projectId && !(await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?1').bind(projectId).first())) return fail('That project was not found.', 422);
  const paidOn = txnDate(body.paid_on);
  if (paidOn === false) return fail('Date paid must be a valid date.', 422);
  if (paidOn && paidOn > istToday()) return fail('Date paid cannot be in the future.', 422);
  const recipient = body.recipient == null || body.recipient === '' ? null : String(body.recipient);
  if (recipient && !BOOKING_RECIPIENTS.includes(recipient)) return fail('Choose who received the token: builder, owner or Atlantic.', 422);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bookings (id, lead_id, property_id, project_id, unit_label, amount, paid_on, payer_name, recipient, payment_reference, refund_terms, note, created_by_user_id)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
      .bind(id, leadId, propertyId, projectId, txnText(body.unit_label, 160), amount, paidOn ?? null, txnText(body.payer_name, 160) || lead.customer_name || null, recipient,
        txnText(body.payment_reference, 160), txnText(body.refund_terms, 2000), txnText(body.note, 2000), actorUserId(actor)),
    leadNote(env, leadId, actor, `Token of ${rupees(amount)} recorded for ${place.name}`),
    ...leadToNegotiation(env, lead, actor, 'Token recorded'),
  ]);
  await raiseAlert(env, {
    importance: 'normal', to: { roles: ['transaction_coordinator', 'sales_head'] },
    title: `Token of ${rupees(amount)} recorded — ${lead.customer_name || lead.lead_code || 'a lead'}`,
    body: [place.name, lead.lead_code].filter(Boolean).join(' · ') || null, link: { kind: 'lead', id: leadId },
  });
  const booking = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?1`).bind(id).first();
  return json({ booking: shapeBooking(booking) }, 201);
}

async function loadBookingWithLead(env, bookingId) {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1').bind(bookingId).first();
  if (!booking) return {};
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(booking.lead_id).first();
  return { booking, lead };
}
const canChangeBooking = (actor, lead) => Boolean((lead && canUpdateLead(actor, lead)) || has(actor, 'transaction.write'));

async function handleUpdateBooking(request, env, bookingId, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const { booking, lead } = await loadBookingWithLead(env, bookingId);
  if (!booking) return fail('Token not found.', 404);
  if (!canChangeBooking(actor, lead)) return fail('You do not have permission to change this token.', 403);
  const sets = []; const binds = [bookingId];
  const set = (col, v) => { binds.push(v); sets.push(`${col} = ?${binds.length}`); };
  if (body.status !== undefined) {
    if (!['recorded', 'refunded', 'cancelled'].includes(body.status)) return fail('A token can be marked refunded or cancelled.', 422);
    if (body.status === 'recorded' && booking.status === 'transaction_created') return fail('This token already has a transaction.', 409);
    set('status', body.status);
    set('status_note', txnText(body.status_note, 1000));
  }
  if (body.amount !== undefined) {
    const amount = parseMoney(body.amount);
    if (!amount || amount <= 0) return fail('Enter the token amount.', 422);
    set('amount', amount);
  }
  if (body.paid_on !== undefined) {
    const d = txnDate(body.paid_on);
    if (d === false) return fail('Date paid must be a valid date.', 422);
    set('paid_on', d);
  }
  if (body.recipient !== undefined) {
    if (body.recipient !== null && !BOOKING_RECIPIENTS.includes(body.recipient)) return fail('Choose who received the token: builder, owner or Atlantic.', 422);
    set('recipient', body.recipient);
  }
  for (const [k, max] of [['payer_name', 160], ['payment_reference', 160], ['refund_terms', 2000], ['note', 2000], ['unit_label', 160]]) {
    if (body[k] !== undefined) set(k, txnText(body[k], max));
  }
  if (!sets.length) return fail('Nothing to change.', 422);
  const stmts = [env.DB.prepare(`UPDATE bookings SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?1`).bind(...binds)];
  if (body.status && body.status !== booking.status && body.status !== 'recorded') {
    const why = txnText(body.status_note, 200);
    stmts.push(leadNote(env, booking.lead_id, actor, `Token of ${rupees(booking.amount)} marked ${body.status}${why ? ': ' + why : ''}`));
  }
  await env.DB.batch(stmts);
  const row = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?1`).bind(bookingId).first();
  return json({ booking: shapeBooking(row) });
}

async function handleUploadBookingReceipt(request, env, bookingId, actor) {
  if (!env.IMAGES) return fail('File storage is not configured on this deployment (missing R2 binding).', 503);
  const { booking, lead } = await loadBookingWithLead(env, bookingId);
  if (!booking) return fail('Token not found.', 404);
  if (!canChangeBooking(actor, lead)) return fail('You do not have permission to change this token.', 403);
  let form;
  try { form = await request.formData(); } catch { return fail('Send the receipt as multipart/form-data with a "file" field.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file provided.', 422);
  if (!Object.hasOwn(RECEIPT_EXTENSION, file.type)) return fail('The receipt must be a photo (JPEG, PNG, WEBP) or a PDF.', 422);
  if (file.size > MAX_RECEIPT_BYTES) return fail(`The receipt must be under ${MAX_RECEIPT_BYTES / (1024 * 1024)} MB.`, 422);
  const key = `bookings/${bookingId}/${crypto.randomUUID()}.${RECEIPT_EXTENSION[file.type]}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await env.DB.prepare("UPDATE bookings SET receipt_r2_key = ?2, receipt_content_type = ?3, updated_at = datetime('now') WHERE id = ?1").bind(bookingId, key, file.type).run();
  if (booking.receipt_r2_key) await env.IMAGES.delete(booking.receipt_r2_key).catch(() => {});
  return json({ ok: true, has_receipt: true }, 201);
}

/** Receipts carry payment details, so unlike property photos they need a signed-in reader. */
async function handleServeBookingReceipt(env, bookingId, actor) {
  const { booking, lead } = await loadBookingWithLead(env, bookingId);
  if (!booking || !booking.receipt_r2_key) return fail('Receipt not found.', 404);
  const txn = await env.DB.prepare('SELECT * FROM transactions WHERE booking_id = ?1 LIMIT 1').bind(bookingId).first();
  if (!(lead && canReadLead(actor, lead)) && !(txn && canReadTransaction(actor, txn, lead)) && !has(actor, 'transaction.read')) return fail('You do not have permission to view this receipt.', 403);
  if (!env.IMAGES) return fail('File storage is not configured on this deployment.', 503);
  const object = await env.IMAGES.get(booking.receipt_r2_key);
  if (!object) return fail('Receipt not found.', 404);
  return new Response(object.body, { headers: { 'content-type': booking.receipt_content_type || 'application/octet-stream', 'cache-control': 'private, no-store' } });
}

// ------------------------------------------------------------- transactions
const TXN_SELECT = `SELECT t.*, l.customer_name, l.phone AS customer_phone, l.lead_code, l.assigned_user_id AS lead_owner_user_id,
    p.name AS property_name, p.property_code, pj.name AS project_name,
    c.name AS coordinator_name, rm.name AS relationship_manager_name,
    (SELECT group_concat(tp.name, ', ') FROM transaction_parties tp WHERE tp.transaction_id = t.id AND tp.role = 'buyer') AS buyer_names
  FROM transactions t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN properties p ON p.id = t.property_id
  LEFT JOIN projects pj ON pj.id = t.project_id
  LEFT JOIN users c ON c.id = t.coordinator_user_id
  LEFT JOIN users rm ON rm.id = t.relationship_manager_user_id`;

async function handleListTransactions(request, env, actor) {
  const url = new URL(request.url);
  const binds = [];
  const bind = (v) => { binds.push(v); return `?${binds.length}`; };
  const scope = transactionScope(actor, bind);
  const where = scope ? [scope] : [];
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (q) {
    const like = bind(`%${q.toLowerCase()}%`);
    const code = recordCodeQuery(q, 'T'); const leadCode = recordCodeQuery(q, 'L'); const propCode = recordCodeQuery(q, 'P');
    where.push(`(lower(t.txn_code) LIKE ${like} OR lower(COALESCE(l.customer_name,'')) LIKE ${like} OR COALESCE(l.phone,'') LIKE ${like}
      OR lower(COALESCE(l.lead_code,'')) LIKE ${like} OR lower(COALESCE(p.property_code,'')) LIKE ${like}
      OR lower(COALESCE(p.name,'')) LIKE ${like} OR lower(COALESCE(pj.name,'')) LIKE ${like} OR lower(COALESCE(t.unit_label,'')) LIKE ${like}
      OR EXISTS (SELECT 1 FROM transaction_parties tp WHERE tp.transaction_id = t.id AND (lower(tp.name) LIKE ${like} OR COALESCE(tp.phone,'') LIKE ${like}))
      ${code ? `OR t.txn_code = ${bind(code)}` : ''} ${leadCode ? `OR l.lead_code = ${bind(leadCode)}` : ''} ${propCode ? `OR p.property_code = ${bind(propCode)}` : ''})`);
  }
  const type = url.searchParams.get('type');
  if (type && TXN_TYPES.includes(type)) where.push(`t.txn_type = ${bind(type)}`);
  const coordinator = url.searchParams.get('coordinator');
  if (coordinator === 'none') where.push('t.coordinator_user_id IS NULL');
  else if (coordinator === 'me') where.push(`t.coordinator_user_id = ${bind(actor.id)}`);
  else if (coordinator) where.push(`t.coordinator_user_id = ${bind(coordinator)}`);
  const leadId = url.searchParams.get('lead_id');
  if (leadId) where.push(`t.lead_id = ${bind(leadId)}`);
  // Counts per stage ignore the stage filter so the tiles always show the whole picture.
  const countBinds = binds.slice();
  const baseWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const stage = url.searchParams.get('stage');
  const listWhere = [...where];
  if (stage === 'open') listWhere.push("t.status = 'open'");
  else if (stage && TXN_STAGES.includes(stage)) listWhere.push(`t.stage = ${bind(stage)}`);
  const [list, counts] = await Promise.all([
    env.DB.prepare(`${TXN_SELECT} ${listWhere.length ? 'WHERE ' + listWhere.join(' AND ') : ''} ORDER BY (t.status = 'open') DESC, t.updated_at DESC LIMIT 300`).bind(...binds).all(),
    env.DB.prepare(`SELECT t.stage, COUNT(*) AS n FROM transactions t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN properties p ON p.id = t.property_id
                      LEFT JOIN projects pj ON pj.id = t.project_id ${baseWhere} GROUP BY t.stage`).bind(...countBinds).all(),
  ]);
  const byStage = Object.fromEntries((counts.results ?? []).map((r) => [r.stage, r.n]));
  let rows = (list.results ?? []).map(shapeTransaction);
  if (url.searchParams.get('overdue') === '1') rows = rows.filter((r) => r.overdue);
  return json({ transactions: rows, counts: byStage, can_write: has(actor, 'transaction.write') });
}

async function loadTransactionBundle(env, id) {
  const transaction = await env.DB.prepare(`${TXN_SELECT} WHERE t.id = ?1 OR t.txn_code = ?1`).bind(id).first();
  if (!transaction) return null;
  const [parties, events, lead, property, project, booking] = await Promise.all([
    env.DB.prepare('SELECT * FROM transaction_parties WHERE transaction_id = ?1 ORDER BY sort_order, created_at').bind(transaction.id).all(),
    env.DB.prepare('SELECT * FROM transaction_events WHERE transaction_id = ?1 ORDER BY id DESC LIMIT 200').bind(transaction.id).all(),
    transaction.lead_id ? env.DB.prepare(`SELECT l.id, l.lead_code, l.customer_name, l.phone, l.email, l.stage, l.sub_status, l.status, l.assigned_user_id, l.team_id, l.project_name, l.location, u.name AS assigned_user_name
                                             FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id WHERE l.id = ?1`).bind(transaction.lead_id).first() : null,
    transaction.property_id ? env.DB.prepare(`SELECT id, property_code, name, property_type, listing_type, category, location, locality, sub_locality, society_name, house_no, developer,
                                                     price_expected, expected_rent, construction_status FROM properties WHERE id = ?1`).bind(transaction.property_id).first() : null,
    transaction.project_id ? env.DB.prepare('SELECT id, name, developer, location, locality, construction_status FROM projects WHERE id = ?1').bind(transaction.project_id).first() : null,
    transaction.booking_id ? env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?1`).bind(transaction.booking_id).first() : null,
  ]);
  return { transaction: shapeTransaction(transaction), parties: parties.results ?? [], events: events.results ?? [], lead, property, project, booking: shapeBooking(booking) };
}

async function handleGetTransaction(env, id, actor) {
  const bundle = await loadTransactionBundle(env, id);
  if (!bundle) return fail('Transaction not found.', 404);
  if (!canReadTransaction(actor, bundle.transaction, bundle.lead)) return fail('You do not have permission to view this transaction.', 403);
  return json({ ...bundle, can_write: has(actor, 'transaction.write') });
}

function parsePartyInput(p) {
  if (!p || typeof p !== 'object') return { error: 'Each person needs a role and a name.' };
  const name = txnText(p.name, 160);
  if (!name) return { error: 'Each person needs a name.' };
  const role = p.role || 'buyer';
  if (!TXN_PARTY_ROLES.includes(role)) return { error: 'Choose a role: buyer, seller, co-owner, legal heir, POA holder or other.' };
  const email = txnText(p.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `"${email}" does not look like an email address.` };
  const phone = txnText(p.phone, 40);
  if (phone && !/^\+?[\d][\d\s-]{5,}$/.test(phone)) return { error: `"${phone}" does not look like a phone number.` };
  return { party: { role, name, phone, email, note: txnText(p.note, 500) } };
}

async function handleCreateTransaction(request, env, actor) {
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  let booking = null; let lead = null;
  if (body.booking_id) {
    booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1').bind(String(body.booking_id)).first();
    if (!booking) return fail('Token not found.', 404);
    lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(booking.lead_id).first();
    if (!has(actor, 'transaction.write') && !(lead && canUpdateLead(actor, lead))) return fail('You do not have permission to start a transaction for this token.', 403);
    if (booking.status !== 'recorded') return fail(booking.status === 'transaction_created' ? 'This token already has a transaction.' : `This token is ${booking.status}.`, 409);
  } else {
    if (!has(actor, 'transaction.write')) return fail('Only transaction coordinators and managers can start a transaction without a token.', 403);
    if (body.lead_id) {
      lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(String(body.lead_id)).first();
      if (!lead) return fail('Lead not found.', 404);
    }
  }
  const propertyId = txnText(body.property_id, 80) ?? booking?.property_id ?? null;
  const projectId = txnText(body.project_id, 80) ?? booking?.project_id ?? null;
  if (!propertyId && !projectId) return fail('Choose the property or project for this transaction.', 422);
  const property = propertyId ? await env.DB.prepare('SELECT id, name, listing_type, category FROM properties WHERE id = ?1').bind(propertyId).first() : null;
  if (propertyId && !property) return fail('That property was not found.', 422);
  const project = projectId ? await env.DB.prepare('SELECT id, name FROM projects WHERE id = ?1').bind(projectId).first() : null;
  if (projectId && !project) return fail('That project was not found.', 422);
  const txnType = body.txn_type || (property?.listing_type === 'rent' ? 'rental' : property?.category === 'commercial' ? 'commercial' : project && !property ? 'builder_sale' : 'resale');
  if (!TXN_TYPES.includes(txnType)) return fail('Type must be resale, builder sale, rental or commercial.', 422);
  const agreedPrice = body.agreed_price == null || body.agreed_price === '' ? null : parseMoney(body.agreed_price);
  if (agreedPrice !== null && !(agreedPrice > 0)) return fail('Agreed price must be an amount in rupees, e.g. 85,00,000 or 85 L.', 422);
  const coordinator = await txnActiveUser(env, body.coordinator_user_id);
  if (coordinator === false) return fail('Choose an active employee as the transaction coordinator.', 422);
  const rm = await txnActiveUser(env, body.relationship_manager_user_id === undefined ? (lead?.assigned_user_id ?? actorUserId(actor)) : body.relationship_manager_user_id);
  if (rm === false) return fail('Choose an active employee as the relationship manager.', 422);
  const dates = {};
  for (const f of TXN_DATE_FIELDS) {
    const d = txnDate(body[f]);
    if (d === false) return fail(`${f.replace(/_on$/, '').replace(/_/g, ' ')} date is not a valid date.`, 422);
    dates[f] = d ?? null;
  }
  const parties = [];
  for (const p of Array.isArray(body.parties) ? body.parties.slice(0, 30) : []) {
    const r = parsePartyInput(p);
    if (r.error) return fail(r.error, 422);
    parties.push(r.party);
  }
  if (!parties.length && lead?.customer_name) parties.push({ role: 'buyer', name: lead.customer_name, phone: lead.phone || null, email: lead.email || null, note: null });

  const id = crypto.randomUUID();
  // The code is worked out inside the INSERT itself; D1 serialises writes and the UNIQUE index is the safety net.
  const nextCode = "(SELECT printf('T-%05d', COALESCE(MAX(CAST(substr(txn_code, 3) AS INTEGER)), 0) + 1) FROM transactions)";
  const dateBinds = TXN_DATE_FIELDS.map((_, i) => `?${13 + i}`).join(', ');
  const insert = env.DB.prepare(`INSERT INTO transactions (id, txn_code, lead_id, property_id, project_id, booking_id, unit_label, txn_type, stage, status, agreed_price,
        payment_schedule_note, brokerage_note, relationship_manager_user_id, coordinator_user_id, ${TXN_DATE_FIELDS.join(', ')}, stage_changed_at, created_by_user_id)
      VALUES (?1, ${nextCode}, ?2, ?3, ?4, ?5, ?6, ?7, 'token_received', 'open', ?8, ?9, ?10, ?11, ?12, ${dateBinds}, datetime('now'), ?${13 + TXN_DATE_FIELDS.length})`)
    .bind(id, lead?.id ?? null, propertyId, projectId, booking?.id ?? null, txnText(body.unit_label, 160) ?? booking?.unit_label ?? null, txnType, agreedPrice,
      txnText(body.payment_schedule_note, 4000), txnText(body.brokerage_note, 4000), rm ?? null, coordinator ?? null, ...TXN_DATE_FIELDS.map((f) => dates[f]), actorUserId(actor));
  const rest = [
    txnEvent(env, id, actor, 'created', null, 'token_received', booking ? `Started from a token of ${rupees(booking.amount)}` : 'Started without a token'),
    ...parties.map((p, i) => env.DB.prepare('INSERT INTO transaction_parties (id, transaction_id, role, name, phone, email, note, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
      .bind(crypto.randomUUID(), id, p.role, p.name, p.phone, p.email, p.note, i)),
    ...(booking ? [env.DB.prepare("UPDATE bookings SET status = 'transaction_created', updated_at = datetime('now') WHERE id = ?1 AND status = 'recorded'").bind(booking.id)] : []),
  ];
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    try { await env.DB.batch([insert, ...rest]); ok = true; }
    catch (e) { if (!/UNIQUE/i.test(String(e?.message || e))) throw e; }
  }
  if (!ok) return fail('Could not allocate a transaction code — please try again.', 503);
  const code = await env.DB.prepare('SELECT txn_code FROM transactions WHERE id = ?1').bind(id).first('txn_code');
  if (lead) await env.DB.batch([leadNote(env, lead.id, actor, `Transaction ${code} started`), ...leadToNegotiation(env, lead, actor, `Transaction ${code} started`)]);
  if (coordinator && coordinator !== actorUserId(actor)) {
    await raiseAlert(env, {
      importance: 'medium', to: { userIds: [coordinator] }, title: `Transaction ${code} assigned to you`,
      body: [lead?.customer_name, property?.name || project?.name].filter(Boolean).join(' · ') || null, link: { kind: 'transaction', id },
    });
  }
  return json(await loadTransactionBundle(env, id), 201);
}

async function handleUpdateTransaction(request, env, id, actor) {
  if (!has(actor, 'transaction.write')) return fail('Only transaction coordinators and managers can change a transaction.', 403);
  const body = await bodyJson(request);
  if (!body) return fail('JSON object required.', 400);
  const txn = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?1').bind(id).first();
  if (!txn) return fail('Transaction not found.', 404);
  const sets = []; const binds = [id]; const stmts = []; const changed = [];
  const set = (col, v) => { binds.push(v); sets.push(`${col} = ?${binds.length}`); };
  const note = txnText(body.note, 1000);

  let stage = txn.stage;
  if (body.stage !== undefined && body.stage !== txn.stage) {
    if (!TXN_STAGES.includes(body.stage)) return fail(`Stage must be one of: ${TXN_STAGES.map((s) => TXN_STAGE_LABEL[s]).join(', ')}.`, 422);
    stage = body.stage;
    if (stage === 'cancelled' && !txnText(body.cancel_reason, 1000) && !note) return fail('Please say why this transaction is being cancelled.', 422);
    set('stage', stage);
    set('status', stage === 'closed' ? 'closed' : stage === 'cancelled' ? 'cancelled' : 'open');
    sets.push("stage_changed_at = datetime('now')");
    stmts.push(txnEvent(env, id, actor, 'stage', txn.stage, stage, note || txnText(body.cancel_reason, 1000)));
  }
  if (body.txn_type !== undefined && body.txn_type !== txn.txn_type) {
    if (!TXN_TYPES.includes(body.txn_type)) return fail('Type must be resale, builder sale, rental or commercial.', 422);
    set('txn_type', body.txn_type); changed.push(['txn_type', txn.txn_type, body.txn_type]);
  }
  if (body.agreed_price !== undefined) {
    const v = body.agreed_price == null || body.agreed_price === '' ? null : parseMoney(body.agreed_price);
    if (v !== null && !(v > 0)) return fail('Agreed price must be an amount in rupees, e.g. 85,00,000 or 85 L.', 422);
    if (v !== txn.agreed_price) { set('agreed_price', v); changed.push(['agreed_price', txn.agreed_price, v]); }
  }
  for (const [k, max] of Object.entries(TXN_TEXT_FIELDS)) {
    if (body[k] === undefined) continue;
    const v = txnText(body[k], max);
    if (v !== txn[k]) { set(k, v); changed.push([k, txn[k], v]); }
  }
  for (const [k, label] of [['coordinator_user_id', 'transaction coordinator'], ['relationship_manager_user_id', 'relationship manager']]) {
    if (body[k] === undefined) continue;
    const u = await txnActiveUser(env, body[k]);
    if (u === false) return fail(`Choose an active employee as the ${label}.`, 422);
    if (u !== txn[k]) { set(k, u); changed.push([k, txn[k], u]); }
  }
  for (const f of TXN_DATE_FIELDS) {
    const d = txnDate(body[f]);
    if (d === undefined) continue;
    if (d === false) return fail(`${f.replace(/_on$/, '').replace(/_/g, ' ')} date is not a valid date.`, 422);
    if (d !== txn[f]) { set(f, d); stmts.push(txnEvent(env, id, actor, 'milestone', txn[f], d, f)); }
  }
  for (const [field, from, to] of changed) stmts.push(txnEvent(env, id, actor, 'update', from == null ? null : String(from), to == null ? null : String(to), field));
  if (!sets.length) return json({ ...(await loadTransactionBundle(env, id)), can_write: true });
  sets.push("updated_at = datetime('now')");
  stmts.unshift(env.DB.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds));

  // The lead follows the deal (rule at the top of this file).
  const lead = txn.lead_id ? await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(txn.lead_id).first() : null;
  if (lead && stage !== txn.stage) {
    const why = `Transaction ${txn.txn_code}: ${TXN_STAGE_LABEL[stage]}`;
    if (stage === 'closed') stmts.push(...leadStageMove(env, lead, actor, 'won', 'won', why));
    else if (TXN_BOOKED_STAGES.includes(stage) && lead.stage !== 'won') stmts.push(...leadStageMove(env, lead, actor, 'won', 'booked', why));
    else if (stage === 'cancelled' && lead.stage === 'won') {
      const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE lead_id = ?1 AND id <> ?2 AND status <> 'cancelled'").bind(lead.id, id).first('n');
      if (!others) stmts.push(...leadStageMove(env, lead, actor, 'negotiation', null, why));
    }
    stmts.push(leadNote(env, lead.id, actor, why + (note ? ' — ' + note : '')));
  }
  await env.DB.batch(stmts);

  const newCoordinator = changed.find(([f]) => f === 'coordinator_user_id')?.[2];
  if (newCoordinator && newCoordinator !== actorUserId(actor)) {
    await raiseAlert(env, { importance: 'medium', to: { userIds: [newCoordinator] }, title: `Transaction ${txn.txn_code} assigned to you`, link: { kind: 'transaction', id } });
  }
  return json({ ...(await loadTransactionBundle(env, id)), can_write: true });
}

async function handleTransactionParties(request, env, txnId, partyId, actor) {
  if (!has(actor, 'transaction.write')) return fail('Only transaction coordinators and managers can change the people on a transaction.', 403);
  const txn = await env.DB.prepare('SELECT id FROM transactions WHERE id = ?1').bind(txnId).first();
  if (!txn) return fail('Transaction not found.', 404);
  const touch = env.DB.prepare("UPDATE transactions SET updated_at = datetime('now') WHERE id = ?1").bind(txnId);
  const done = async (status = 200) => json({ ...(await loadTransactionBundle(env, txnId)), can_write: true }, status);
  if (!partyId) {
    if (request.method !== 'POST') return fail('Use POST.', 405);
    const r = parsePartyInput(await bodyJson(request));
    if (r.error) return fail(r.error, 422);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM transaction_parties WHERE transaction_id = ?1').bind(txnId).first('n');
    if (count >= 30) return fail('A transaction can list up to 30 people.', 422);
    const p = r.party;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO transaction_parties (id, transaction_id, role, name, phone, email, note, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(crypto.randomUUID(), txnId, p.role, p.name, p.phone, p.email, p.note, count),
      txnEvent(env, txnId, actor, 'party', null, p.name, `Added ${p.role.replace('_', ' ')}`), touch,
    ]);
    return done(201);
  }
  const party = await env.DB.prepare('SELECT * FROM transaction_parties WHERE id = ?1 AND transaction_id = ?2').bind(partyId, txnId).first();
  if (!party) return fail('Person not found on this transaction.', 404);
  if (request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM transaction_parties WHERE id = ?1').bind(partyId),
      txnEvent(env, txnId, actor, 'party', party.name, null, `Removed ${party.role.replace('_', ' ')}`), touch,
    ]);
    return done();
  }
  if (request.method === 'PATCH') {
    const body = await bodyJson(request);
    if (!body) return fail('JSON object required.', 400);
    const r = parsePartyInput({ ...party, ...body });
    if (r.error) return fail(r.error, 422);
    const p = r.party;
    await env.DB.batch([
      env.DB.prepare('UPDATE transaction_parties SET role = ?2, name = ?3, phone = ?4, email = ?5, note = ?6 WHERE id = ?1').bind(partyId, p.role, p.name, p.phone, p.email, p.note),
      txnEvent(env, txnId, actor, 'party', party.name, p.name, `Updated ${p.role.replace('_', ' ')}`), touch,
    ]);
    return done();
  }
  return fail('Use PATCH or DELETE.', 405);
}

/** Router hook: a Response for booking / transaction-core routes, else null. */
export async function routeTransactions(request, env, actor, path, deps) {
  if (!/^\/api\/(transactions|bookings)(\/|$)|^\/api\/leads\/[^/]+\/bookings$/.test(path)) return null;
  ({ has, raiseAlert, canReadLead, canUpdateLead, parseMoney, actorUserId, recordCodeQuery } = deps);
  const m = request.method;
  const leadBookings = path.match(/^\/api\/leads\/([^/]+)\/bookings$/);
  if (leadBookings && m === 'GET') return handleLeadBookings(env, leadBookings[1], actor);
  if (leadBookings && m === 'POST') return handleCreateBooking(request, env, leadBookings[1], actor);
  const booking = path.match(/^\/api\/bookings\/([^/]+)(\/receipt)?$/);
  if (booking && !booking[2] && m === 'PATCH') return handleUpdateBooking(request, env, booking[1], actor);
  if (booking && booking[2] && m === 'POST') return handleUploadBookingReceipt(request, env, booking[1], actor);
  if (booking && booking[2] && m === 'GET') return handleServeBookingReceipt(env, booking[1], actor);
  if (path === '/api/transactions' && m === 'GET') return handleListTransactions(request, env, actor);
  if (path === '/api/transactions' && m === 'POST') return handleCreateTransaction(request, env, actor);
  const parties = path.match(/^\/api\/transactions\/([^/]+)\/parties(?:\/([^/]+))?$/);
  if (parties) return handleTransactionParties(request, env, parties[1], parties[2] || null, actor);
  const txn = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (txn && m === 'GET') return handleGetTransaction(env, txn[1], actor);
  if (txn && m === 'PATCH') return handleUpdateTransaction(request, env, txn[1], actor);
  return null;
}
