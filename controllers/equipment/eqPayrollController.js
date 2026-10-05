// Equipment payroll (vendor statements): preview, blockers, generate, life cycle, exports (§5.9; BR-30..BR-36).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const { businessNow } = require('../../utils/businessDate');
const { toDecimalString } = require('../../utils/money');
const P = require('../../services/equipment/eqPayrollService');
const statements = require('../../services/equipment/eqStatements');

const SCOPE = {
  start_date: v.date({ required: true }), end_date: v.date({ required: true }),
  vendor_id: v.id(), equipment_id: v.id(), site_id: v.id(), currency: v.currency(),
  accept_blockers: v.bool({ default: false }),
};

function hoursOf(min) { return (Number(min || 0) / 60).toFixed(2); }

function summarize(items) {
  const byCur = {};
  for (const it of items) {
    const c = (byCur[it.currency] = byCur[it.currency] || { currency: it.currency, machines: new Set(), vendors: new Set(), gross_cents: 0, deductions_cents: 0, net_cents: 0, work_minutes: 0 });
    c.machines.add(it.equipment_id); c.vendors.add(it.vendor_id);
    c.gross_cents += it.gross_cents; c.deductions_cents += it.deductions_cents; c.net_cents += it.net_cents; c.work_minutes += it.work_minutes;
  }
  return Object.values(byCur).map((c) => ({
    currency: c.currency, machines: c.machines.size, vendors: c.vendors.size, work_hours: hoursOf(c.work_minutes),
    gross: toDecimalString(c.gross_cents), deductions: toDecimalString(c.deductions_cents), net: toDecimalString(c.net_cents),
  }));
}

async function namesFor(conn, items) {
  const eq = [...new Set(items.map((i) => i.equipment_id))];
  const names = { eq: {}, site: {}, vendor: {} };
  if (!eq.length) return names;
  const [e] = await conn.query('SELECT e.equipment_id, e.equipment_code, t.type_name FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id WHERE e.equipment_id IN (?)', [eq]);
  for (const r of e) names.eq[r.equipment_id] = r;
  const [s] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [[...new Set(items.map((i) => i.site_id))]]);
  for (const r of s) names.site[r.site_id] = r;
  const [vd] = await conn.query('SELECT vendor_id, vendor_code, vendor_name FROM eq_vendors WHERE vendor_id IN (?)', [[...new Set(items.map((i) => i.vendor_id))]]);
  for (const r of vd) names.vendor[r.vendor_id] = r;
  return names;
}

function itemView(it, names) {
  return {
    equipment_id: it.equipment_id, equipment_code: names.eq[it.equipment_id]?.equipment_code, type_name: names.eq[it.equipment_id]?.type_name,
    vendor_id: it.vendor_id, vendor_name: names.vendor[it.vendor_id]?.vendor_name, site_id: it.site_id, site_code: names.site[it.site_id]?.site_code,
    currency: it.currency, billing_mode: it.billing_mode, rate_card_id: it.rate_card_id,
    days_recorded: it.days_recorded, worked_days: it.worked_days, work_hours: hoursOf(it.work_minutes), overtime_hours: hoursOf(it.overtime_minutes),
    standby_hours: hoursOf(it.standby_minutes), breakdown_hours: hoursOf(it.breakdown_minutes), topup_hours: hoursOf(it.topup_minutes),
    gross: toDecimalString(it.gross_cents), deductions: toDecimalString(it.deductions_cents), net: toDecimalString(it.net_cents),
    lines: it.lines.map((l) => ({ line_type: l.line_type, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price_exact ?? l.unit_price_cents / 100, amount: toDecimalString(l.amount_cents), note: l.note || null })),
    monthly_calc: it.monthly_calc || null,
    fuel_difference: it.fuel_diff ? toDecimalString(it.lines.filter((l) => l.line_type === 'FuelPriceDifference').reduce((a, l) => a + l.amount_cents, 0)) : null,
  };
}

function pickCurrency(items, currency) {
  const currencies = [...new Set(items.map((i) => i.currency))];
  if (currency) return items.filter((i) => i.currency === currency);
  if (currencies.length > 1) throw AppError.conflict('MIXED_CURRENCY', `The scope has several currencies (${currencies.join(', ')}). Choose one.`, { currencies });
  return items;
}

exports.preview = async (req, res) => {
  const scope = validate(req.body, SCOPE);
  const conn = pool;
  const blockers = await P.blockers(conn, scope);
  const { items, warnings } = await P.calculate(conn, scope);
  const names = await namesFor(conn, items);
  res.json({ status: 'success', data: { scope, totals: summarize(items), blockers, warnings, items: items.map((i) => itemView(i, names)) } });
};

exports.blockers = async (req, res) => {
  const scope = validate(req.query, SCOPE);
  res.json({ status: 'success', data: await P.blockers(pool, scope) });
};

/**
 * Names as they are TODAY, frozen into the item: an old invoice keeps the vendor / machine / site names
 * it was issued with even if they are renamed later.
 */
async function labelsFor(conn, items) {
  const eq = [...new Set(items.map((i) => i.equipment_id))];
  const [e] = await conn.query(
    `SELECT e.equipment_id, e.equipment_code, e.plate_number, e.make, e.model, t.type_name, t.type_name_ar, vd.vendor_id, vd.vendor_name, vd.vendor_code, vd.tax_number
     FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id WHERE e.equipment_id IN (?)`, [eq]);
  const [st] = await conn.query('SELECT site_id, site_code, site_name, project_name FROM sites WHERE site_id IN (?)', [[...new Set(items.map((i) => i.site_id))]]);
  const E = Object.fromEntries(e.map((x) => [x.equipment_id, x])); const S = Object.fromEntries(st.map((x) => [x.site_id, x]));
  return (it) => {
    const m = E[it.equipment_id] || {}; const si = S[it.site_id] || {};
    return {
      equipment_code: m.equipment_code, plate_number: m.plate_number, type_name: m.type_name, type_name_ar: m.type_name_ar, make: m.make, model: m.model,
      vendor_name: m.vendor_name, vendor_code: m.vendor_code, vendor_tax_number: m.tax_number, site_code: si.site_code, site_name: si.site_name,
      project_name: si.project_name, contract_number: it.rate_snapshot && it.rate_snapshot.contract_number,
    };
  };
}

/** Writes a batch from a calculation (inside the caller's transaction). */
async function persistBatch(conn, req, scope, items, extra = {}) {
  const currency = items[0].currency;
  const totals = items.reduce((t, i) => ({ g: t.g + i.gross_cents, d: t.d + i.deductions_cents, n: t.n + i.net_cents }), { g: 0, d: 0, n: 0 });
  const [b] = await conn.execute(
    `INSERT INTO eq_payroll_batches (start_date, end_date, scope_vendor_id, scope_equipment_id, scope_site_id, currency, version_number,
       supersedes_batch_id, supersede_reason, total_equipment, total_gross, total_deductions, total_net, generated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [scope.start_date, scope.end_date, scope.vendor_id || null, scope.equipment_id || null, scope.site_id || null, currency,
      extra.version_number || 1, extra.supersedes_batch_id || null, extra.supersede_reason || null,
      new Set(items.map((i) => i.equipment_id)).size, toDecimalString(totals.g), toDecimalString(totals.d), toDecimalString(totals.n),
      req.user.user_id]);
  const batchId = b.insertId;
  const labels = await labelsFor(conn, items);
  for (const it of items) {
    const [ir] = await conn.execute(
      `INSERT INTO eq_payroll_items (eq_batch_id, equipment_id, vendor_id, site_id, rate_card_id, rate_snapshot, billing_mode, days_recorded, worked_days,
         work_hours, overtime_hours, standby_hours, breakdown_hours, topup_hours, gross_amount, deductions_amount, net_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, it.equipment_id, it.vendor_id, it.site_id, it.rate_card_id,
        JSON.stringify({ ...it.rate_snapshot, months: it.months, monthly_calc: it.monthly_calc || null, fuel_diff: it.fuel_diff || null, labels: labels(it) }), it.billing_mode,
        it.days_recorded, it.worked_days, hoursOf(it.work_minutes), hoursOf(it.overtime_minutes), hoursOf(it.standby_minutes),
        hoursOf(it.breakdown_minutes), hoursOf(it.topup_minutes), toDecimalString(it.gross_cents), toDecimalString(it.deductions_cents), toDecimalString(it.net_cents)]);
    for (const l of it.lines) {
      await conn.execute(
        `INSERT INTO eq_payroll_lines (eq_item_id, line_type, quantity, unit, unit_price, amount, source_table, source_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ir.insertId, l.line_type, l.quantity, l.unit, (l.unit_price_exact ?? l.unit_price_cents / 100).toFixed(3), toDecimalString(l.amount_cents), l.source_table || null, l.source_id || null, l.note || null]);
    }
    for (const pr of it.per_row) {
      const r = pr.row;
      await conn.execute(
        `INSERT INTO eq_payroll_attendance_snapshot (eq_batch_id, eq_item_id, eq_attendance_id, record_date, day_status, check_in_time, check_out_time,
           operator_name, work_minutes, overtime_minutes, standby_minutes, breakdown_minutes, break_minutes, topup_minutes, meter_start, meter_end, sheet_row_no, paper_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, ir.insertId, r.eq_attendance_id, r.record_date, r.day_status, r.check_in_time, r.check_out_time, r.operator_name || null,
          pr.work, pr.ot, pr.standby, pr.breakdown, pr.brk, pr.topup, r.meter_start, r.meter_end, r.sheet_row_no, r.paper_status]);
    }
  }
  return batchId;
}

/** Monthly bases are not tied to rows: never bill the same machine/site twice for overlapping periods. */
async function assertNoOverlappingMonthly(conn, scope, items, excludeBatchId) {
  for (const it of items.filter((i) => i.billing_mode === 'Monthly')) {
    const [rows] = await conn.execute(
      `SELECT b.eq_batch_id, b.start_date, b.end_date FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
       WHERE i.equipment_id = ? AND i.site_id = ? AND i.billing_mode = 'Monthly' AND b.status IN ('Generated','Paid')
         AND b.start_date <= ? AND b.end_date >= ? AND b.eq_batch_id <> ? LIMIT 1`,
      [it.equipment_id, it.site_id, scope.end_date, scope.start_date, excludeBatchId || 0]);
    if (rows[0]) {
      throw AppError.conflict('OVERLAPPING_BATCH', `A monthly machine in this scope is already billed by batch #${rows[0].eq_batch_id} (${rows[0].start_date} to ${rows[0].end_date}).`, rows[0]);
    }
  }
}

async function generateInTx(conn, req, scope, extra = {}) {
  const blockers = await P.blockers(conn, { ...scope, exclude_batch_id: extra.supersedes_batch_id });
  const blocking = blockers.filter((b) => P.BLOCKING.includes(b.code));
  if (blocking.length && !scope.accept_blockers) {
    throw AppError.conflict('BLOCKERS_PRESENT', 'Some rows of this scope cannot be paid yet. Fix them or confirm with accept_blockers = true.', { blockers: blocking });
  }
  const { items: all, warnings } = await P.calculate(conn, { ...scope, lock: true, exclude_batch_id: extra.supersedes_batch_id });
  const items = pickCurrency(all, scope.currency);
  if (!items.length) throw AppError.conflict('NOTHING_TO_PAY', 'Nothing to pay in this scope and period.');
  await assertNoOverlappingMonthly(conn, scope, items, extra.supersedes_batch_id);
  const id = await persistBatch(conn, req, scope, items, extra);
  const negative = items.filter((i) => i.net_cents < 0).map((i) => i.equipment_id);
  if (negative.length) warnings.push({ code: 'NEGATIVE_NET', equipment_ids: negative });
  return { id, warnings, accepted_blockers: blocking.map((b) => b.code) };
}

exports.generate = async (req, res) => {
  const scope = validate(req.body, SCOPE);
  const out = await withTransaction(async (conn) => {
    const r = await generateInTx(conn, req, scope);
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate', newValues: { scope, accepted_blockers: r.accepted_blockers }, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

async function loadBatch(conn, id, lock = false) {
  const [rows] = await conn.execute(`SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Payroll batch');
  return rows[0];
}

async function isStale(conn, batch) {
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS n FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id
     WHERE s.eq_batch_id = ? AND a.updated_at > ?`, [batch.eq_batch_id, batch.generated_at]);
  return Number(r.n) > 0;
}

async function batchDetail(conn, id) {
  const batch = await loadBatch(conn, id);
  const [items] = await conn.execute(
    `SELECT i.*, e.equipment_code, t.type_name, vd.vendor_name, vd.vendor_code, s.site_code, s.site_name
     FROM eq_payroll_items i JOIN eq_equipment e ON e.equipment_id = i.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     JOIN eq_vendors vd ON vd.vendor_id = i.vendor_id JOIN sites s ON s.site_id = i.site_id
     WHERE i.eq_batch_id = ? ORDER BY vd.vendor_name, e.equipment_code, s.site_code`, [id]);
  const [lines] = await conn.execute(
    'SELECT l.* FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id WHERE i.eq_batch_id = ? ORDER BY l.eq_line_id', [id]);
  const byItem = {};
  for (const l of lines) (byItem[l.eq_item_id] = byItem[l.eq_item_id] || []).push(l);
  const [[u]] = await conn.execute('SELECT full_name FROM users WHERE user_id = ?', [batch.generated_by_user_id]);
  const stale = batch.status === 'Generated' && !Number(batch.is_finalized) ? await isStale(conn, batch) : false;
  const [invoices] = await conn.execute('SELECT * FROM eq_invoices WHERE eq_batch_id = ? ORDER BY kind, seq', [id]);
  return {
    ...batch, is_finalized: Boolean(Number(batch.is_finalized)), generated_by: u ? u.full_name : null, stale, invoices,
    items: items.map((i) => {
      const snap = P.parseJson(i.rate_snapshot) || {};
      const inv = (kind) => (invoices.find((x) => x.kind === kind && x.eq_item_id === i.eq_item_id) || {}).invoice_no || null;
      return {
        ...i, ...(snap.labels || {}), rate_snapshot: snap, lines: byItem[i.eq_item_id] || [],
        fuel_difference: (byItem[i.eq_item_id] || []).filter((l) => l.line_type === 'FuelPriceDifference').reduce((a, l) => a + Number(l.amount), 0).toFixed(2),
        invoice_no: inv('Machine'), fuel_invoice_no: inv('FuelDiff'),
        vendor_invoice_no: (invoices.find((x) => x.kind === 'Vendor' && x.vendor_id === i.vendor_id) || {}).invoice_no || null,
      };
    }),
  };
}
exports.batchDetail = batchDetail;

exports.list = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.status) f('b.status = ?', String(req.query.status));
  if (req.query.vendor_id) f('b.scope_vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.from) f('b.end_date >= ?', String(req.query.from));
  if (req.query.to) f('b.start_date <= ?', String(req.query.to));
  const [rows] = await pool.query(
    `SELECT b.*, vd.vendor_name AS scope_vendor_name, e.equipment_code AS scope_equipment_code, s.site_code AS scope_site_code, u.full_name AS generated_by
     FROM eq_payroll_batches b LEFT JOIN eq_vendors vd ON vd.vendor_id = b.scope_vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = b.scope_equipment_id
     LEFT JOIN sites s ON s.site_id = b.scope_site_id JOIN users u ON u.user_id = b.generated_by_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.eq_batch_id DESC LIMIT 500`, params);
  res.json({ status: 'success', data: rows.map((r) => ({ ...r, is_finalized: Boolean(Number(r.is_finalized)) })) });
};

exports.get = async (req, res) => {
  res.json({ status: 'success', data: await batchDetail(pool, parseId(req.params.id)) });
};

exports.rows = async (req, res) => {
  const id = parseId(req.params.id);
  await loadBatch(pool, id);
  const params = [id]; let extra = '';
  if (req.query.equipment_id) { extra = ' AND i.equipment_id = ?'; params.push(Number(req.query.equipment_id)); }
  const [rows] = await pool.query(
    `SELECT s.*, i.equipment_id, e.equipment_code, i.site_id FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     JOIN eq_equipment e ON e.equipment_id = i.equipment_id WHERE s.eq_batch_id = ?${extra} ORDER BY e.equipment_code, s.record_date`, params);
  res.json({ status: 'success', data: rows });
};

const INVOICE_PREFIX = { Vendor: 'VI', Machine: 'MI', FuelDiff: 'FD' };

/** Next number of a sequence (kind + year), never reused even if the batch is voided later. */
async function nextInvoiceNo(conn, kind, year) {
  await conn.execute('INSERT IGNORE INTO eq_invoice_counters (kind, year, last_seq) VALUES (?, ?, 0)', [kind, year]);
  const [[c]] = await conn.execute('SELECT last_seq FROM eq_invoice_counters WHERE kind = ? AND year = ? FOR UPDATE', [kind, year]);
  const seq = Number(c.last_seq) + 1;
  await conn.execute('UPDATE eq_invoice_counters SET last_seq = ? WHERE kind = ? AND year = ?', [seq, kind, year]);
  return { seq, no: `${INVOICE_PREFIX[kind]}-${year}-${String(seq).padStart(5, '0')}` };
}

/**
 * Official numbers given when a batch is finalized: one vendor invoice per vendor, one machine invoice per item,
 * and one fuel-difference statement per item that has a fuel price difference.
 */
async function issueInvoices(conn, batchId, currency, now) {
  const year = Number(String(now).slice(0, 4));
  const [items] = await conn.execute('SELECT eq_item_id, equipment_id, vendor_id, net_amount FROM eq_payroll_items WHERE eq_batch_id = ? ORDER BY vendor_id, eq_item_id', [batchId]);
  const [fd] = await conn.execute(
    `SELECT l.eq_item_id, SUM(l.amount) AS amount FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     WHERE i.eq_batch_id = ? AND l.line_type = 'FuelPriceDifference' GROUP BY l.eq_item_id`, [batchId]);
  const insert = async (kind, vendorId, equipmentId, itemId, amount) => {
    const n = await nextInvoiceNo(conn, kind, year);
    await conn.execute(
      `INSERT INTO eq_invoices (invoice_no, kind, year, seq, eq_batch_id, vendor_id, equipment_id, eq_item_id, currency, amount, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [n.no, kind, year, n.seq, batchId, vendorId, equipmentId, itemId, currency, amount, now]);
  };
  for (const vid of [...new Set(items.map((i) => i.vendor_id))]) {
    const total = items.filter((i) => i.vendor_id === vid).reduce((a, i) => a + Math.round(Number(i.net_amount) * 100), 0);
    await insert('Vendor', vid, null, null, toDecimalString(total));
  }
  for (const i of items) await insert('Machine', i.vendor_id, i.equipment_id, i.eq_item_id, i.net_amount);
  for (const f of fd) {
    const i = items.find((x) => x.eq_item_id === f.eq_item_id);
    await insert('FuelDiff', i.vendor_id, i.equipment_id, i.eq_item_id, f.amount);
  }
}

async function assertMayFinalize(req) {
  if (req.user.role === 'Accountant' && await settings.getBool('payroll_finalize_admin_only')) {
    throw AppError.forbidden('FORBIDDEN_ROLE', 'Only an Admin may finalize or mark paid (setting payroll_finalize_admin_only).');
  }
}

exports.finalize = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayFinalize(req);
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Generated' || Number(b.is_finalized)) throw AppError.conflict('BATCH_STATE', `Batch is ${b.status}${Number(b.is_finalized) ? ' (finalized)' : ''}.`);
    if (await isStale(conn, b)) throw AppError.conflict('BATCH_STALE', 'Some rows changed after this batch was generated. Void it and generate again.');
    if (await settings.getBool('eq_finalize_requires_scan')) {
      const [rows] = await conn.execute('SELECT eq_attendance_id FROM eq_payroll_attendance_snapshot WHERE eq_batch_id = ?', [id]);
      const missing = await P.sheetsMissingScan(conn, rows.map((r) => r.eq_attendance_id));
      if (missing.length) {
        throw AppError.conflict('SCAN_MISSING',
          `Upload the signed monthly sheet before finalizing: ${missing.slice(0, 5).map((m) => `${m.sheet_code} (rows to ${m.needed_row}, uploaded to ${m.scanned_row})`).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
          { sheets: missing });
      }
    }
    const now = businessNow();
    await conn.execute('UPDATE eq_payroll_batches SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = ? WHERE eq_batch_id = ?', [req.user.user_id, now, id]);
    await issueInvoices(conn, id, b.currency, now);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'finalize', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

exports.markPaid = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayFinalize(req);
  const { paid_at } = validate(req.body, { paid_at: v.datetime() });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Generated' || !Number(b.is_finalized)) throw AppError.conflict('BATCH_STATE', 'Only a finalized, unpaid batch can be marked paid.');
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Paid', paid_by_user_id = ?, paid_at = ? WHERE eq_batch_id = ?", [req.user.user_id, paid_at || businessNow(), id]);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'mark_paid', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

exports.void = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Generated') throw AppError.conflict('BATCH_STATE', `A ${b.status} batch cannot be voided.`);
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Voided', voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE eq_batch_id = ?", [req.user.user_id, businessNow(), reason, id]);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'void', reason, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

exports.supersede = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason, accept_blockers } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }), accept_blockers: v.bool({ default: false }) });
  const out = await withTransaction(async (conn) => {
    const old = await loadBatch(conn, id, true);
    if (!Number(old.is_finalized) || !['Generated', 'Paid'].includes(old.status)) throw AppError.conflict('BATCH_STATE', 'Only a finalized batch can be superseded.');
    const scope = { start_date: old.start_date, end_date: old.end_date, vendor_id: old.scope_vendor_id, equipment_id: old.scope_equipment_id, site_id: old.scope_site_id, currency: old.currency, accept_blockers };
    const r = await generateInTx(conn, req, scope, { version_number: Number(old.version_number) + 1, supersedes_batch_id: id, supersede_reason: reason });
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Superseded' WHERE eq_batch_id = ?", [id]);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'superseded', newValues: { by: r.id }, reason, ...audit.ctx(req) });
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate_version', newValues: { supersedes: id }, reason, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

exports.versions = async (req, res) => {
  const id = parseId(req.params.id);
  const chain = [];
  let cur = await loadBatch(pool, id);
  // walk back to the first version
  while (cur.supersedes_batch_id) cur = await loadBatch(pool, cur.supersedes_batch_id);
  // walk forward
  for (;;) {
    chain.push({ eq_batch_id: cur.eq_batch_id, version_number: cur.version_number, status: cur.status, is_finalized: Boolean(Number(cur.is_finalized)), total_net: cur.total_net, generated_at: cur.generated_at, supersede_reason: cur.supersede_reason });
    const [[next]] = await pool.execute('SELECT * FROM eq_payroll_batches WHERE supersedes_batch_id = ?', [cur.eq_batch_id]);
    if (!next) break;
    cur = next;
  }
  res.json({ status: 'success', data: chain });
};

// ------------------------------------------------------------------ exports
exports.exportPdf = async (req, res) => {
  const id = parseId(req.params.id);
  const view = ['summary', 'vendor', 'machine', 'fueldiff'].includes(req.query.view) ? req.query.view : 'summary';
  const detail = await batchDetail(pool, id);
  const opts = { view, vendorId: req.query.vendor_id ? Number(req.query.vendor_id) : null, equipmentId: req.query.equipment_id ? Number(req.query.equipment_id) : null };
  const { buffer, fileName } = await statements.batchPdf(pool, detail, opts, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
};

exports.exportXlsx = async (req, res) => {
  const id = parseId(req.params.id);
  const detail = await batchDetail(pool, id);
  const buffer = await statements.batchXlsx(pool, detail);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="equipment-payroll-batch-${id}-v${detail.version_number}.xlsx"`);
  res.send(buffer);
};

/** Provisional statement (no batch): machine or vendor, any period. */
async function provisional(req, res, kind) {
  const id = parseId(req.params.id);
  const q = validate(req.query, { from: v.date({ required: true }), to: v.date({ required: true }), currency: v.currency() });
  const scope = { start_date: q.from, end_date: q.to, [kind === 'machine' ? 'equipment_id' : 'vendor_id']: id };
  const { items } = await P.calculate(pool, scope);
  const chosen = pickCurrency(items, q.currency);
  if (!chosen.length) throw AppError.conflict('NOTHING_TO_PAY', 'Nothing payable in this period.');
  const { buffer, fileName } = await statements.provisionalPdf(pool, { kind, scope, items: chosen }, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
}
exports.provisionalMachine = (req, res) => provisional(req, res, 'machine');
exports.provisionalVendor = (req, res) => provisional(req, res, 'vendor');
