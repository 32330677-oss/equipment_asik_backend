// Invoices and finance (decisions of 13-14 Oct 2026): hand-over to finance, withdrawal from finance (signed
// acknowledgement), and debit / credit notes. The app does not record payments.
//
//   POST  /payroll/handovers                 Admin: hand invoices (issued or returned) and notes over to finance
//   GET   /payroll/handovers                 list;   GET /payroll/handovers/:id(.pdf)
//   POST  /payroll/batches/:id/withdraw      Admin: an invoice comes back from finance (WD-...); the Admin may then change it
//   POST  /payroll/notes/:id/withdraw        Admin: same for a note
//   GET   /payroll/withdrawals/:id.pdf       the acknowledgement to sign
//   notes: GET/POST /payroll/notes, GET/PUT /payroll/notes/:id, PATCH .../issue, PATCH .../cancel, GET .../pdf
'use strict';

const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const { businessNow, businessToday } = require('../../utils/businessDate');
const P = require('../../services/equipment/eqPayrollService');
const lock = require('../../services/equipment/eqLock');
const pdf = require('../../services/equipment/eqFinancePdf');
const pay = require('./eqPayrollController');

const day = (d) => (d ? String(d).slice(0, 10) : null);
const isAdmin = (req) => req.user.role === 'Admin';
const adminOnly = (req, what) => { if (!isAdmin(req)) throw AppError.forbidden('ADMIN_ONLY', `Only the Admin ${what}.`); };
const idList = (x) => (Array.isArray(x) ? [...new Set(x.map(Number))].filter((n) => Number.isInteger(n) && n > 0) : []);

function sendPdf(res, { buffer, fileName }) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
}

// ======================================================================= notes
const NOTE_FIELDS = {
  kind: v.enumOf(['Debit', 'Credit']),
  vendor_id: v.id(), equipment_id: v.id(), currency: v.currency(),
  amount: v.number({ min: 0.01, max: 999999999999, decimals: 2 }),
  reason: v.string({ min: 5, max: 1000 }), note_date: v.date(),
  period_from: v.date(), period_to: v.date(), ref_batch_id: v.id(),
};

async function loadNote(conn, id, lockRow = false) {
  const [[n]] = await conn.execute(`SELECT * FROM eq_notes WHERE note_id = ?${lockRow ? ' FOR UPDATE' : ''}`, [id]);
  if (!n) throw AppError.notFound('Note');
  return n;
}

async function noteView(conn, id) {
  const [[n]] = await conn.execute(
    `SELECT n.*, vd.vendor_name, vd.vendor_code, vd.tax_number, e.equipment_code, e.machine_label, e.plate_number, u.full_name AS created_by, iu.full_name AS issued_by,
       (SELECT h.handover_no FROM eq_handovers h WHERE h.handover_id = n.handover_id) AS handover_no,
       (SELECT w.withdrawal_no FROM eq_withdrawals w WHERE w.withdrawal_id = n.withdrawal_id) AS withdrawal_no
     FROM eq_notes n JOIN eq_vendors vd ON vd.vendor_id = n.vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = n.equipment_id
     JOIN users u ON u.user_id = n.created_by_user_id LEFT JOIN users iu ON iu.user_id = n.issued_by_user_id WHERE n.note_id = ?`, [id]);
  if (!n) throw AppError.notFound('Note');
  let ref = null;
  if (n.ref_batch_id) {
    const [[r]] = await conn.execute(
      `SELECT b.eq_batch_id, b.start_date, b.end_date, b.status, b.is_finalized,
         (SELECT x.invoice_no FROM eq_invoices x WHERE x.eq_batch_id = b.eq_batch_id AND x.vendor_id = ? AND x.kind = 'Vendor' ORDER BY x.invoice_id LIMIT 1) AS invoice_no
       FROM eq_payroll_batches b WHERE b.eq_batch_id = ?`, [n.vendor_id, n.ref_batch_id]);
    ref = r ? { ...r, state: lock.stateOf(r) } : null;
  }
  return { ...n, ref_invoice: ref, actions: noteActions(n) };
}

function noteActions(n) {
  const { currentUser } = require('../../utils/requestContext');
  const u = currentUser(); const role = u ? u.role : 'Admin';
  const office = role === 'Admin' || role === 'Accountant';
  const admin = role === 'Admin';
  return {
    edit: (n.status === 'Draft' && office) || (['Issued', 'Returned'].includes(n.status) && admin),
    issue: n.status === 'Draft' && admin,
    cancel: (n.status === 'Draft' && office) || (['Issued', 'Returned'].includes(n.status) && admin),
    hand_over: ['Issued', 'Returned'].includes(n.status) && admin,
    withdraw: n.status === 'HandedOver' && admin,
  };
}

/** The vendor's contracts give the allowed currencies; a machine must be the vendor's. */
async function checkNote(conn, d) {
  const [[vd]] = await conn.execute('SELECT vendor_id FROM eq_vendors WHERE vendor_id = ?', [d.vendor_id]);
  if (!vd) throw AppError.validation({ vendor_id: 'unknown vendor' });
  if (d.equipment_id) {
    const [[m]] = await conn.execute('SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?', [d.equipment_id]);
    if (!m || m.vendor_id !== d.vendor_id) throw AppError.validation({ equipment_id: 'must be a machine of this vendor' });
  }
  const [cur] = await conn.execute('SELECT DISTINCT currency FROM eq_vendor_contracts WHERE vendor_id = ?', [d.vendor_id]);
  if (cur.length && !cur.some((c) => c.currency === d.currency)) throw AppError.validation({ currency: `must be a currency of the vendor's contracts (${cur.map((c) => c.currency).join(', ')})` });
  if (d.period_from && d.period_to && d.period_to < d.period_from) throw AppError.validation({ period_to: 'must be on or after period_from' });
  if (d.ref_batch_id) {
    const [[b]] = await conn.execute(
      `SELECT b.eq_batch_id FROM eq_payroll_batches b WHERE b.eq_batch_id = ? AND ${lock.ACTIVE} AND b.is_finalized = 1
         AND EXISTS (SELECT 1 FROM eq_payroll_items i WHERE i.eq_batch_id = b.eq_batch_id AND i.vendor_id = ?)`, [d.ref_batch_id, d.vendor_id]);
    if (!b) throw AppError.validation({ ref_batch_id: 'must be an issued invoice of this vendor' });
  }
}

exports.listNotes = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.vendor_id) f('n.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.equipment_id) f('n.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.ref_batch_id) f('n.ref_batch_id = ?', Number(req.query.ref_batch_id));
  if (req.query.status) f('n.status = ?', String(req.query.status));
  if (req.query.q) f('n.note_no LIKE ?', `%${String(req.query.q).trim()}%`);
  const [rows] = await pool.query(
    `SELECT n.*, vd.vendor_name, e.equipment_code, e.machine_label FROM eq_notes n JOIN eq_vendors vd ON vd.vendor_id = n.vendor_id
     LEFT JOIN eq_equipment e ON e.equipment_id = n.equipment_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY n.note_date DESC, n.note_id DESC LIMIT 500`, params);
  res.json({ status: 'success', data: rows.map((n) => ({ ...n, actions: noteActions(n) })) });
};

exports.getNote = async (req, res) => res.json({ status: 'success', data: await noteView(pool, parseId(req.params.id)) });

/** A new note is a draft (no number): the Admin issues it. Admin or Accountant. */
exports.createNote = async (req, res) => {
  const d = validate(req.body, { ...NOTE_FIELDS, kind: v.enumOf(['Debit', 'Credit'], { required: true }), vendor_id: v.id({ required: true }),
    currency: v.currency({ required: true }), amount: v.number({ required: true, min: 0.01, max: 999999999999, decimals: 2 }),
    reason: v.string({ required: true, min: 5, max: 1000 }) });
  const id = await withTransaction(async (conn) => {
    await checkNote(conn, d);
    const [r] = await conn.execute(
      `INSERT INTO eq_notes (kind, vendor_id, equipment_id, currency, amount, reason, note_date, period_from, period_to, ref_batch_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.kind, d.vendor_id, d.equipment_id || null, d.currency, d.amount.toFixed(2), d.reason, d.note_date || businessToday(),
        d.period_from || null, d.period_to || null, d.ref_batch_id || null, req.user.user_id, businessNow()]);
    await audit.log(conn, { table: 'eq_notes', id: r.insertId, action: 'create', newValues: d, ...audit.ctx(req) });
    return r.insertId;
  });
  res.status(201).json({ status: 'success', data: await noteView(pool, id) });
};

/** Draft: Admin or Accountant. Issued or returned (not handed over): Admin, same number, kept in the audit. */
exports.updateNote = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, NOTE_FIELDS);
  await withTransaction(async (conn) => {
    const before = await loadNote(conn, id, true);
    if (before.status === 'HandedOver') throw AppError.conflict('NOTE_HANDED_OVER', 'This note is handed over to finance: withdraw it first (signed acknowledgement).');
    if (before.status === 'Cancelled') throw AppError.conflict('BATCH_STATE', 'This note is cancelled.');
    if (before.status !== 'Draft') adminOnly(req, 'changes an issued note');
    const next = { ...before, ...d };
    await checkNote(conn, next);
    const keys = Object.keys(d);
    if (!keys.length) return;
    await conn.execute(`UPDATE eq_notes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE note_id = ?`, [...keys.map((k) => (k === 'amount' ? Number(d[k]).toFixed(2) : d[k])), id]);
    const after = await loadNote(conn, id);
    await audit.log(conn, { table: 'eq_notes', id, action: before.status === 'Draft' ? 'update' : 'update_issued', oldValues: before, newValues: after, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await noteView(pool, id) });
};

/** Admin: the note gets its official number (DN- / CN-), never reused. */
exports.issueNote = async (req, res) => {
  const id = parseId(req.params.id);
  adminOnly(req, 'issues a debit / credit note');
  await withTransaction(async (conn) => {
    const n = await loadNote(conn, id, true);
    if (n.status !== 'Draft') throw AppError.conflict('BATCH_STATE', 'Only a draft note is issued.');
    const now = businessNow();
    const no = await pay.nextNo(conn, n.kind === 'Debit' ? 'DebitNote' : 'CreditNote', Number(now.slice(0, 4)));
    await conn.execute("UPDATE eq_notes SET status = 'Issued', note_no = ?, issued_at = ?, issued_by_user_id = ? WHERE note_id = ?", [no.no, now, req.user.user_id, id]);
    await audit.log(conn, { table: 'eq_notes', id, action: 'issue', newValues: { note_no: no.no }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await noteView(pool, id) });
};

/** Draft: deleted (Admin or Accountant). Issued / returned: Admin, reason required, the number stays cancelled. */
exports.cancelNote = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body || {}, { reason: v.string({ max: 500 }) });
  await withTransaction(async (conn) => {
    const n = await loadNote(conn, id, true);
    if (n.status === 'HandedOver') throw AppError.conflict('NOTE_HANDED_OVER', 'This note is handed over to finance: withdraw it first (signed acknowledgement).');
    if (n.status === 'Cancelled') return;
    if (n.status !== 'Draft') {
      adminOnly(req, 'cancels an issued note');
      if (!reason || reason.length < 3) throw AppError.validation({ reason: 'is required to cancel an issued note' });
    }
    await conn.execute("UPDATE eq_notes SET status = 'Cancelled', cancelled_at = ?, cancelled_by_user_id = ?, cancel_reason = ? WHERE note_id = ?",
      [businessNow(), req.user.user_id, reason || null, id]);
    await audit.log(conn, { table: 'eq_notes', id, action: n.status === 'Draft' ? 'delete_draft' : 'cancel', reason: reason || null, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await noteView(pool, id) });
};

exports.notePdf = async (req, res) => sendPdf(res, await pdf.notePdf(await noteView(pool, parseId(req.params.id)), req.user));

// ======================================================================= hand-over
/**
 * Admin: invoices (issued, or withdrawn and unchanged) and notes (issued / returned) go to finance under one numbered
 * hand-over sheet. An issued invoice is brought up to date first (same numbers); rows of its period must be approved,
 * and the signed monthly sheets uploaded when eq_finalize_requires_scan is on.
 */
exports.handOver = async (req, res) => {
  adminOnly(req, 'hands invoices over to finance');
  const d = validate(req.body || {}, {
    batch_ids: v.any(), note_ids: v.any(), handed_on: v.date(), receiver_name: v.string({ required: true, min: 2, max: 255 }), note: v.string({ max: 500 }),
  });
  const batchIds = idList(d.batch_ids); const noteIds = idList(d.note_ids);
  if (!batchIds.length && !noteIds.length) throw AppError.validation({ batch_ids: 'choose at least one invoice or note' });
  const handedOn = d.handed_on || businessToday();
  if (handedOn > businessToday()) throw AppError.validation({ handed_on: 'cannot be in the future' });
  const id = await withTransaction(async (conn) => {
    const lines = [];
    const batchesDone = [];
    for (const bid0 of batchIds) {
      let b = await pay.loadBatch(conn, bid0, true);
      const st = lock.stateOf(b);
      if (st === 'issued') {
        const r = await pay.doRefresh(conn, req, bid0); // same numbers; nothing changes when nothing changed
        if (!r.unchanged) b = await pay.loadBatch(conn, r.id, true);
      } else if (st === 'returned') {
        if ((await P.batchDrift(conn, b)).length) {
          throw AppError.conflict('REISSUE_FIRST', `Invoice batch #${b.eq_batch_id} changed after it was withdrawn from finance: re-issue it (new numbers) before handing it over again.`, { eq_batch_id: b.eq_batch_id });
        }
      } else {
        throw AppError.conflict('BATCH_STATE', `Invoice batch #${bid0} cannot be handed over (${st}).`, { eq_batch_id: bid0 });
      }
      const na = await pay.notApprovedOf(conn, b);
      if (na) throw pay.notApprovedError(na, 'the hand-over');
      if (await settings.getBool('eq_finalize_requires_scan')) {
        const [rows] = await conn.execute('SELECT eq_attendance_id FROM eq_payroll_attendance_snapshot WHERE eq_batch_id = ?', [b.eq_batch_id]);
        const missing = await P.sheetsMissingScan(conn, rows.map((r) => r.eq_attendance_id));
        if (missing.length) {
          throw AppError.conflict('SCAN_MISSING',
            `Upload the signed monthly sheet before the hand-over: ${missing.slice(0, 5).map((m) => `${m.sheet_code} (rows to ${m.needed_row}, uploaded to ${m.scanned_row})`).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
            { sheets: missing, eq_batch_id: b.eq_batch_id });
        }
      }
      const [vis] = await conn.execute(
        `SELECT x.invoice_no, x.vendor_id, x.amount, x.currency, vd.vendor_name FROM eq_invoices x JOIN eq_vendors vd ON vd.vendor_id = x.vendor_id
         LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id
         WHERE x.eq_batch_id = ? AND x.kind = 'Vendor' AND x.status = 'Issued' AND c.invoice_id IS NULL ORDER BY x.invoice_id`, [b.eq_batch_id]);
      for (const x of vis) {
        lines.push({ eq_batch_id: b.eq_batch_id, note_id: null, vendor_id: x.vendor_id, doc_no: x.invoice_no, currency: x.currency, amount: x.amount, kind: 'invoice', vendor_name: x.vendor_name,
          period: `${day(b.start_date)} - ${day(b.end_date)}` });
      }
      batchesDone.push(b);
    }
    const notesDone = [];
    for (const nid of noteIds) {
      const n = await loadNote(conn, nid, true);
      if (!['Issued', 'Returned'].includes(n.status)) throw AppError.conflict('BATCH_STATE', `Note #${nid} cannot be handed over (${n.status}): issue it first.`);
      const [[vd]] = await conn.execute('SELECT vendor_name FROM eq_vendors WHERE vendor_id = ?', [n.vendor_id]);
      lines.push({ eq_batch_id: null, note_id: nid, vendor_id: n.vendor_id, doc_no: n.note_no, currency: n.currency, kind: n.kind, vendor_name: vd ? vd.vendor_name : '',
        amount: (n.kind === 'Credit' ? -Number(n.amount) : Number(n.amount)).toFixed(2), period: n.period_from ? `${day(n.period_from)} - ${day(n.period_to || n.period_from)}` : '' });
      notesDone.push(n);
    }
    const now = businessNow();
    const no = await pay.nextNo(conn, 'Handover', Number(now.slice(0, 4)));
    const [h] = await conn.execute('INSERT INTO eq_handovers (handover_no, handed_on, receiver_name, note, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [no.no, handedOn, d.receiver_name, d.note || null, req.user.user_id, now]);
    let k = 0;
    for (const l of lines) {
      k += 1;
      await conn.execute('INSERT INTO eq_handover_items (handover_id, line_no, eq_batch_id, note_id, vendor_id, doc_no, currency, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [h.insertId, k, l.eq_batch_id, l.note_id, l.vendor_id, l.doc_no, l.currency, l.amount]);
    }
    for (const b of batchesDone) {
      await conn.execute("UPDATE eq_payroll_batches SET status = 'HandedOver', handed_over_at = ?, handover_id = ? WHERE eq_batch_id = ?", [now, h.insertId, b.eq_batch_id]);
      await audit.log(conn, { table: 'eq_payroll_batches', id: b.eq_batch_id, action: 'hand_over', oldValues: { status: b.status }, newValues: { status: 'HandedOver', handover_no: no.no, receiver: d.receiver_name }, ...audit.ctx(req) });
    }
    for (const n of notesDone) {
      await conn.execute("UPDATE eq_notes SET status = 'HandedOver', handed_over_at = ?, handover_id = ? WHERE note_id = ?", [now, h.insertId, n.note_id]);
      await audit.log(conn, { table: 'eq_notes', id: n.note_id, action: 'hand_over', newValues: { handover_no: no.no, receiver: d.receiver_name }, ...audit.ctx(req) });
    }
    await audit.log(conn, { table: 'eq_handovers', id: h.insertId, action: 'create', newValues: { handover_no: no.no, documents: lines.map((l) => l.doc_no) }, ...audit.ctx(req) });
    return h.insertId;
  });
  res.status(201).json({ status: 'success', data: await handoverView(pool, id) });
};

async function handoverView(conn, id) {
  const [[h]] = await conn.execute(
    'SELECT h.*, u.full_name AS by_name FROM eq_handovers h JOIN users u ON u.user_id = h.created_by_user_id WHERE h.handover_id = ?', [id]);
  if (!h) throw AppError.notFound('Hand-over');
  const [lines] = await conn.execute(
    `SELECT hi.*, vd.vendor_name, b.start_date, b.end_date, n.kind AS note_kind, n.period_from, n.period_to
     FROM eq_handover_items hi JOIN eq_vendors vd ON vd.vendor_id = hi.vendor_id LEFT JOIN eq_payroll_batches b ON b.eq_batch_id = hi.eq_batch_id
     LEFT JOIN eq_notes n ON n.note_id = hi.note_id WHERE hi.handover_id = ? ORDER BY hi.line_no`, [id]);
  return {
    ...h,
    lines: lines.map((l) => ({
      ...l, kind: l.note_id ? l.note_kind : 'invoice',
      period: l.eq_batch_id ? `${day(l.start_date)} - ${day(l.end_date)}` : (l.period_from ? `${day(l.period_from)} - ${day(l.period_to || l.period_from)}` : ''),
    })),
  };
}

exports.listHandovers = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT h.*, u.full_name AS by_name, (SELECT COUNT(*) FROM eq_handover_items hi WHERE hi.handover_id = h.handover_id) AS documents
     FROM eq_handovers h JOIN users u ON u.user_id = h.created_by_user_id ORDER BY h.handover_id DESC LIMIT 300`);
  res.json({ status: 'success', data: rows });
};
exports.getHandover = async (req, res) => res.json({ status: 'success', data: await handoverView(pool, parseId(req.params.id)) });
exports.handoverPdf = async (req, res) => sendPdf(res, await pdf.handoverPdf(await handoverView(pool, parseId(req.params.id)), req.user));

// ======================================================================= withdrawal
const WITHDRAW = {
  reason: v.string({ required: true, min: 5, max: 1000 }), finance_person: v.string({ required: true, min: 2, max: 255 }),
  withdrawn_on: v.date(), was_paid: v.bool({ default: false }), paid_amount: v.number({ min: 0, max: 999999999999, decimals: 2 }),
};

function checkWithdraw(d) {
  if (d.withdrawn_on && d.withdrawn_on > businessToday()) throw AppError.validation({ withdrawn_on: 'cannot be in the future' });
  if (!d.was_paid && d.paid_amount) throw AppError.validation({ paid_amount: 'only when it was paid' });
}

/** Admin: an invoice handed over comes back from finance (signed acknowledgement WD-...). The Admin may then change it. */
exports.withdrawBatch = async (req, res) => {
  const id = parseId(req.params.id);
  adminOnly(req, 'withdraws an invoice from finance');
  const d = validate(req.body || {}, WITHDRAW);
  checkWithdraw(d);
  const wid = await withTransaction(async (conn) => {
    const b = await pay.loadBatch(conn, id, true);
    if (b.status !== 'HandedOver') throw AppError.conflict('BATCH_STATE', 'Only an invoice handed over to finance can be withdrawn.');
    const now = businessNow();
    const no = await pay.nextNo(conn, 'Withdrawal', Number(now.slice(0, 4)));
    const [w] = await conn.execute(
      `INSERT INTO eq_withdrawals (withdrawal_no, eq_batch_id, handover_id, reason, finance_person, withdrawn_on, was_paid, paid_amount, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no.no, id, b.handover_id || null, d.reason, d.finance_person, d.withdrawn_on || businessToday(), d.was_paid ? 1 : 0,
        d.was_paid && d.paid_amount !== undefined && d.paid_amount !== null ? Number(d.paid_amount).toFixed(2) : null, req.user.user_id, now]);
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Returned', returned_at = ?, withdrawal_id = ? WHERE eq_batch_id = ?", [now, w.insertId, id]);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'withdraw_from_finance', oldValues: { status: 'HandedOver' },
      newValues: { status: 'Returned', withdrawal_no: no.no, finance_person: d.finance_person, was_paid: d.was_paid, paid_amount: d.paid_amount ?? null }, reason: d.reason, ...audit.ctx(req) });
    return w.insertId;
  });
  res.status(201).json({ status: 'success', data: await pay.batchDetail(pool, id), withdrawal_id: wid });
};

exports.withdrawNote = async (req, res) => {
  const id = parseId(req.params.id);
  adminOnly(req, 'withdraws a note from finance');
  const d = validate(req.body || {}, WITHDRAW);
  checkWithdraw(d);
  const wid = await withTransaction(async (conn) => {
    const n = await loadNote(conn, id, true);
    if (n.status !== 'HandedOver') throw AppError.conflict('BATCH_STATE', 'Only a note handed over to finance can be withdrawn.');
    const now = businessNow();
    const no = await pay.nextNo(conn, 'Withdrawal', Number(now.slice(0, 4)));
    const [w] = await conn.execute(
      `INSERT INTO eq_withdrawals (withdrawal_no, note_id, handover_id, reason, finance_person, withdrawn_on, was_paid, paid_amount, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no.no, id, n.handover_id || null, d.reason, d.finance_person, d.withdrawn_on || businessToday(), d.was_paid ? 1 : 0,
        d.was_paid && d.paid_amount !== undefined && d.paid_amount !== null ? Number(d.paid_amount).toFixed(2) : null, req.user.user_id, now]);
    await conn.execute("UPDATE eq_notes SET status = 'Returned', returned_at = ?, withdrawal_id = ? WHERE note_id = ?", [now, w.insertId, id]);
    await audit.log(conn, { table: 'eq_notes', id, action: 'withdraw_from_finance', newValues: { withdrawal_no: no.no, finance_person: d.finance_person, was_paid: d.was_paid }, reason: d.reason, ...audit.ctx(req) });
    return w.insertId;
  });
  res.status(201).json({ status: 'success', data: await noteView(pool, id), withdrawal_id: wid });
};

exports.withdrawalPdf = async (req, res) => {
  const id = parseId(req.params.id);
  const [[w]] = await pool.execute(
    `SELECT w.*, u.full_name AS by_name, (SELECT h.handover_no FROM eq_handovers h WHERE h.handover_id = w.handover_id) AS handover_no
     FROM eq_withdrawals w JOIN users u ON u.user_id = w.created_by_user_id WHERE w.withdrawal_id = ?`, [id]);
  if (!w) throw AppError.notFound('Withdrawal');
  let doc;
  if (w.eq_batch_id) {
    const [lines] = await pool.execute(
      `SELECT x.invoice_no, x.amount, x.currency, vd.vendor_name, b.start_date, b.end_date FROM eq_invoices x JOIN eq_vendors vd ON vd.vendor_id = x.vendor_id
       JOIN eq_payroll_batches b ON b.eq_batch_id = x.eq_batch_id WHERE x.eq_batch_id = ? AND x.kind = 'Vendor' ORDER BY x.invoice_id`, [w.eq_batch_id]);
    doc = {
      doc_kind: 'Vendor invoice', doc_no: lines.map((l) => l.invoice_no).join(', '), vendor_name: [...new Set(lines.map((l) => l.vendor_name))].join(', '),
      currency: lines[0] ? lines[0].currency : '', amount: lines.reduce((a, l) => a + Number(l.amount), 0), period: lines[0] ? `${day(lines[0].start_date)} - ${day(lines[0].end_date)}` : '',
    };
  } else {
    const n = await noteView(pool, w.note_id);
    doc = { doc_kind: n.kind === 'Debit' ? 'Debit note' : 'Credit note', doc_no: n.note_no, vendor_name: n.vendor_name, currency: n.currency, amount: n.amount,
      period: n.period_from ? `${day(n.period_from)} - ${day(n.period_to || n.period_from)}` : '' };
  }
  sendPdf(res, await pdf.withdrawalPdf({ ...w, ...doc, was_paid: Boolean(Number(w.was_paid)) }, req.user));
};
