// Equipment payroll (vendor statements): preview, blockers, generate, life cycle, exports (§5.9; BR-30..BR-36).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const { businessNow } = require('../../utils/businessDate');
const { diffMinutes } = require('../../utils/dateTime');
const { toDecimalString } = require('../../utils/money');
const P = require('../../services/equipment/eqPayrollService');
const statements = require('../../services/equipment/eqStatements');
const S = require('../../services/equipment/eqSettlement');

const SCOPE = {
  start_date: v.date({ required: true }), end_date: v.date({ required: true }),
  vendor_id: v.id(), equipment_id: v.id(), site_id: v.id(), currency: v.currency(),
  accept_blockers: v.bool({ default: false }), accept_reason: v.string({ max: 500 }),
  // "Add previous balances": the unpaid balance of older finalized batches of the same vendors moves into this batch
  carry_forward: v.bool({ default: false }),
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
  const [s] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [[...new Set(items.flatMap((i) => [i.site_id, ...(i.site_allocation || []).map((a) => a.site_id)]))]]);
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
    site_allocation: it.site_allocation ? it.site_allocation.map((a) => ({ site_id: a.site_id, site_code: names.site[a.site_id]?.site_code, hours: a.hours, share_pct: a.share_pct, amount: toDecimalString(a.amount_cents) })) : null,
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
  // balances still owed on older finalized batches of the same vendors (offered as "Add previous balances")
  const carry = [];
  for (const cur of [...new Set(items.map((i) => i.currency))]) {
    const vendorIds = [...new Set(items.filter((i) => i.currency === cur).map((i) => i.vendor_id))];
    carry.push(...(await S.carryCandidates(conn, { vendorIds, currency: cur, beforeDate: scope.start_date })).map(({ amount_cents: _c, ...x }) => x));
  }
  res.json({ status: 'success', data: { scope, totals: summarize(items), blockers, warnings, items: items.map((i) => itemView(i, names)), carry_forward: carry } });
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
       supersedes_batch_id, supersede_reason, total_equipment, total_gross, total_deductions, total_net, generated_by_user_id, settings_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [scope.start_date, scope.end_date, scope.vendor_id || null, scope.equipment_id || null, scope.site_id || null, currency,
      extra.version_number || 1, extra.supersedes_batch_id || null, extra.supersede_reason || null,
      new Set(items.map((i) => i.equipment_id)).size, toDecimalString(totals.g), toDecimalString(totals.d), toDecimalString(totals.n),
      req.user.user_id, JSON.stringify(await P.billingSettings())]);
  if (extra.accept_reason) await conn.execute('UPDATE eq_payroll_batches SET accept_blockers_reason = ? WHERE eq_batch_id = ?', [extra.accept_reason, b.insertId]);
  const batchId = b.insertId;
  const labels = await labelsFor(conn, items);
  for (const it of items) {
    const [ir] = await conn.execute(
      `INSERT INTO eq_payroll_items (eq_batch_id, equipment_id, vendor_id, site_id, rate_card_id, rate_snapshot, billing_mode, days_recorded, worked_days,
         work_hours, overtime_hours, standby_hours, breakdown_hours, topup_hours, gross_amount, deductions_amount, net_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, it.equipment_id, it.vendor_id, it.site_id, it.rate_card_id,
        JSON.stringify({ ...it.rate_snapshot, months: it.months, monthly_calc: it.monthly_calc || null, fuel_diff: it.fuel_diff || null, site_allocation: it.site_allocation || null, labels: labels(it) }), it.billing_mode,
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
           operator_name, work_minutes, overtime_minutes, standby_minutes, standby_credit_minutes, breakdown_minutes, break_minutes, topup_minutes, meter_start, meter_end, sheet_row_no, paper_status, calc_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, ir.insertId, r.eq_attendance_id, r.record_date, r.day_status, r.check_in_time, r.check_out_time, r.operator_name || null,
          pr.work, pr.ot, pr.standby, pr.credit ?? null, pr.breakdown, pr.brk, pr.topup, r.meter_start, r.meter_end, r.sheet_row_no, r.paper_status,
          P.calcDetail(r) ? JSON.stringify(P.calcDetail(r)) : null]);
    }
  }
  return batchId;
}

/** Monthly bases are not tied to rows: never bill the same machine/site twice for overlapping periods. */
async function assertNoOverlappingMonthly(conn, scope, items, excludeBatchId) {
  for (const it of items.filter((i) => i.billing_mode === 'Monthly')) {
    const [rows] = await conn.execute(
      `SELECT b.eq_batch_id, b.start_date, b.end_date FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
       WHERE i.equipment_id = ? AND i.billing_mode = 'Monthly' AND b.status IN ('Generated','Paid')
         AND b.start_date <= ? AND b.end_date >= ? AND b.eq_batch_id <> ? LIMIT 1`,
      [it.equipment_id, scope.end_date, scope.start_date, excludeBatchId || 0]);
    if (rows[0]) {
      throw AppError.conflict('OVERLAPPING_BATCH', `A monthly machine in this scope is already billed by batch #${rows[0].eq_batch_id} (${rows[0].start_date} to ${rows[0].end_date}).`, rows[0]);
    }
  }
}

async function generateInTx(conn, req, scope, extraIn = {}) {
  let extra = extraIn;
  const blockers = await P.blockers(conn, { ...scope, exclude_batch_id: extra.supersedes_batch_id });
  const blocking = blockers.filter((b) => P.BLOCKING.includes(b.code));
  const hard = blocking.find((b) => b.code === 'MONTHLY_MULTI_SITE'); // wrong hours due: never accepted
  if (hard) throw AppError.conflict('MONTHLY_MULTI_SITE', hard.message, { blockers: [hard] });
  if (blocking.length && !scope.accept_blockers) {
    throw AppError.conflict('BLOCKERS_PRESENT', 'Some rows of this scope cannot be paid yet. Fix them or confirm with accept_blockers = true.', { blockers: blocking });
  }
  const acceptReason = (scope.accept_reason || extra.supersede_reason || '').trim();
  if (blocking.length && acceptReason.length < 5) {
    throw AppError.validation({ accept_reason: 'say why the batch is generated while some rows cannot be paid yet (at least 5 characters)' });
  }
  if (blocking.length) extra = { ...extra, accept_reason: `${blocking.map((b) => b.code).join(', ')}: ${acceptReason}`.slice(0, 500) };
  const { items: all, warnings } = await P.calculate(conn, { ...scope, lock: true, exclude_batch_id: extra.supersedes_batch_id });
  const items = pickCurrency(all, scope.currency);
  if (!items.length) throw AppError.conflict('NOTHING_TO_PAY', 'Nothing to pay in this scope and period.');
  await assertNoOverlappingMonthly(conn, scope, items, extra.supersedes_batch_id);
  const id = await persistBatch(conn, req, scope, items, extra);
  const negative = items.filter((i) => i.net_cents < 0).map((i) => i.equipment_id);
  if (negative.length) warnings.push({ code: 'NEGATIVE_NET', equipment_ids: negative });
  let carried = [];
  if (scope.carry_forward && !extra.supersedes_batch_id) {
    carried = await S.applyCarryForward(conn, { toBatchId: id, vendorIds: [...new Set(items.map((i) => i.vendor_id))], currency: items[0].currency,
      beforeDate: scope.start_date, userId: req.user.user_id, ip: req.ip });
    if (carried.length) {
      warnings.push({ code: 'PREVIOUS_BALANCES_ADDED', count: carried.length, message: `${carried.length} unpaid balance(s) added: ${carried.map((c) => `${c.from_batch_id ? `#${c.from_batch_id}` : `opening balance #${c.opening_balance_id}`} ${c.vendor_name} ${c.amount}`).join(', ')}.` });
    }
  }
  return { id, warnings, accepted_blockers: blocking.map((b) => b.code), carried: carried.map(({ amount_cents: _c, ...x }) => x) };
}

exports.generate = async (req, res) => {
  const scope = validate(req.body, SCOPE);
  const out = await withTransaction(async (conn) => {
    const r = await generateInTx(conn, req, scope);
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate', newValues: { scope, accepted_blockers: r.accepted_blockers, carried_forward: r.carried },
      reason: r.accepted_blockers.length ? scope.accept_reason : null, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

async function loadBatch(conn, id, lock = false) {
  const [rows] = await conn.execute(`SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Payroll batch');
  return rows[0];
}

/** Stale = generating the same scope now would give different amounts or rows (see eqPayrollService.batchDrift). */
async function staleReasons(conn, batch) {
  return P.batchDrift(conn, batch);
}
async function isStale(conn, batch) {
  return (await staleReasons(conn, batch)).length > 0;
}

/** Official numbers of a batch that no longer stands (voided or superseded): kept, never reused, marked cancelled. */
async function cancelInvoices(conn, batchId, reason, userId) {
  await conn.execute(
    `INSERT IGNORE INTO eq_invoice_cancellations (invoice_id, reason, cancelled_by_user_id, cancelled_at)
     SELECT invoice_id, ?, ?, ? FROM eq_invoices WHERE eq_batch_id = ? AND kind IN ('Vendor','Machine','FuelDiff')`, [reason, userId, businessNow(), batchId]);
}

/**
 * A finalized batch with official corrections is never replaced or voided: the corrected rows would be billed again
 * while their debit / credit note adjustment still pays the difference (paid twice).
 */
async function assertNoCorrections(conn, batchId) {
  const [[c]] = await conn.execute(
    "SELECT correction_id, request_status FROM eq_attendance_corrections WHERE locked_batch_id = ? AND request_status IN ('Requested','Reviewed','Approved') LIMIT 1", [batchId]);
  if (c) {
    throw AppError.conflict('BATCH_HAS_CORRECTIONS', `Correction #${c.correction_id} (${c.request_status}) is based on this batch. It cannot be voided or replaced; settle further differences with corrections.`,
      { correction_id: c.correction_id });
  }
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
  const reasons = batch.status === 'Generated' && !Number(batch.is_finalized) ? await staleReasons(conn, batch) : [];
  const stale = reasons.length > 0;
  const [invoices] = await conn.execute(
    `SELECT i.*, c.reason AS cancel_reason, c.cancelled_at, (c.invoice_id IS NOT NULL) AS cancelled
     FROM eq_invoices i LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id WHERE i.eq_batch_id = ? ORDER BY i.kind, i.seq`, [id]);
  for (const x of invoices) x.cancelled = Boolean(Number(x.cancelled));
  const allocSites = [...new Set(items.flatMap((i) => ((P.parseJson(i.rate_snapshot) || {}).site_allocation || []).map((a) => a.site_id)))];
  const [sc] = allocSites.length ? await conn.query('SELECT site_id, site_code FROM sites WHERE site_id IN (?)', [allocSites]) : [[]];
  const siteCode = Object.fromEntries(sc.map((x) => [x.site_id, x.site_code]));
  const [requests] = await conn.execute(
    `SELECT r.*, u.full_name AS requested_by, d.full_name AS decided_by FROM eq_batch_requests r JOIN users u ON u.user_id = r.requested_by_user_id
     LEFT JOIN users d ON d.user_id = r.decided_by_user_id WHERE r.eq_batch_id = ? ORDER BY r.request_id DESC`, [id]);
  const undoHours = await settings.getInt('eq_paid_undo_hours');
  const money = await S.balances(conn, batch);
  const allPayments = money.vendors.flatMap((x) => x.payments);
  const undo = paidUndoState(batch, undoHours, { total: allPayments.length, markPaid: allPayments.filter((p) => p.status === 'Active' && p.source === 'MarkPaid').length });
  return {
    ...batch, settings_snapshot: P.parseJson(batch.settings_snapshot) || null, is_finalized: Boolean(Number(batch.is_finalized)),
    finalize_admin_only: await settings.getBool('payroll_finalize_admin_only'), paid_undo: undo,
    settlement: { vendors: money.vendors, totals: money.totals, payment_status: money.payment_status, legacy_paid: money.legacy_paid, payable: money.payable },
    requests, pending_request: requests.find((r) => r.status === 'Pending') || null,
    generated_by: u ? u.full_name : null, stale, stale_reasons: reasons, invoices,
    items: items.map((i) => {
      const snap = P.parseJson(i.rate_snapshot) || {};
      const inv = (kind) => (invoices.find((x) => x.kind === kind && x.eq_item_id === i.eq_item_id) || {}).invoice_no || null;
      return {
        ...i, ...(snap.labels || {}), rate_snapshot: snap, lines: byItem[i.eq_item_id] || [],
        fuel_difference: (byItem[i.eq_item_id] || []).filter((l) => l.line_type === 'FuelPriceDifference').reduce((a, l) => a + Number(l.amount), 0).toFixed(2),
        site_allocation: snap.site_allocation ? snap.site_allocation.map((a) => ({ site_id: a.site_id, site_code: siteCode[a.site_id], hours: a.hours, share_pct: a.share_pct, amount: (a.amount_cents / 100).toFixed(2) })) : null,
        invoice_no: inv('Machine'), fuel_invoice_no: inv('FuelDiff'),
        vendor_invoice_no: (invoices.find((x) => x.kind === 'Vendor' && x.vendor_id === i.vendor_id) || {}).invoice_no || null,
      };
    }),
  };
}
exports.batchDetail = batchDetail;

/**
 * Can Mark Paid still be undone? Only within eq_paid_undo_hours of marking it, only while no payment reference exists,
 * and only when the batch was closed by Mark paid (a batch paid by recorded payments: reverse the wrong payment instead).
 */
function paidUndoState(batch, hours, pay = { total: 0, markPaid: 0 }) {
  if (batch.status !== 'Paid') return { possible: false, reason: 'not_paid' };
  if (batch.payment_reference) return { possible: false, reason: 'payment_reference' };
  if (pay.total > 0 && pay.markPaid === 0) return { possible: false, reason: 'paid_by_payments' };
  if (!batch.paid_marked_at) return { possible: false, reason: 'marked_before_rule' };
  const marked = String(batch.paid_marked_at).slice(0, 19).replace('T', ' ');
  const minutes = diffMinutes(marked, businessNow());
  const left = hours * 60 - minutes;
  if (hours <= 0 || left <= 0) return { possible: false, reason: 'window_passed', window_hours: hours };
  return { possible: true, window_hours: hours, minutes_left: left };
}

exports.list = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.status) f('b.status = ?', String(req.query.status));
  if (req.query.vendor_id) f('b.scope_vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.from) f('b.end_date >= ?', String(req.query.from));
  if (req.query.to) f('b.start_date <= ?', String(req.query.to));
  const [rows] = await pool.query(
    `SELECT b.*, vd.vendor_name AS scope_vendor_name, e.equipment_code AS scope_equipment_code, s.site_code AS scope_site_code, u.full_name AS generated_by,
       (SELECT COUNT(*) FROM eq_batch_requests r WHERE r.eq_batch_id = b.eq_batch_id AND r.status = 'Pending') AS pending_requests,
       (SELECT COUNT(*) FROM eq_payments p WHERE p.eq_batch_id = b.eq_batch_id) AS payments_count,
       (SELECT COALESCE(SUM(p.amount), 0) FROM eq_payments p WHERE p.eq_batch_id = b.eq_batch_id AND p.status = 'Active') AS paid_total,
       (SELECT COALESCE(SUM(c.amount), 0) FROM eq_payment_carryovers c WHERE c.to_batch_id = b.eq_batch_id AND c.status = 'Active') AS carried_in_total,
       (SELECT COALESCE(SUM(c.amount), 0) FROM eq_payment_carryovers c WHERE c.from_batch_id = b.eq_batch_id AND c.status = 'Active') AS carried_out_total
     FROM eq_payroll_batches b LEFT JOIN eq_vendors vd ON vd.vendor_id = b.scope_vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = b.scope_equipment_id
     LEFT JOIN sites s ON s.site_id = b.scope_site_id JOIN users u ON u.user_id = b.generated_by_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.eq_batch_id DESC LIMIT 500`, params);
  res.json({ status: 'success', data: rows.map(listRow) });
};

/** Money summary of a batch in the list (whole batch; the detail gives it per vendor). */
function listRow(r) {
  const fin = Number(r.is_finalized) === 1;
  const c = (x) => Math.round(Number(x || 0) * 100);
  const legacy = r.status === 'Paid' && Number(r.payments_count) === 0;
  const due = c(r.total_net) + c(r.carried_in_total);
  const balance = legacy ? 0 : Math.max(0, due - c(r.paid_total) - c(r.carried_out_total));
  let paymentStatus = null;
  if (fin && (r.status === 'Generated' || r.status === 'Paid')) {
    if (r.status === 'Paid') paymentStatus = 'Paid';
    else if (balance <= 0 && c(r.carried_out_total) > 0) paymentStatus = 'CarriedForward';
    else if (balance <= 0) paymentStatus = 'Paid';
    else paymentStatus = c(r.paid_total) > 0 || c(r.carried_out_total) > 0 ? 'PartiallyPaid' : 'Unpaid';
  }
  return { ...r, is_finalized: fin, balance: toDecimalString(balance), payment_status: paymentStatus };
}

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
  const { acknowledge_changes: ack } = validate(req.body || {}, { acknowledge_changes: v.bool({ default: false }) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Generated' || Number(b.is_finalized)) throw AppError.conflict('BATCH_STATE', `Batch is ${b.status}${Number(b.is_finalized) ? ' (finalized)' : ''}.`);
    const drift = await staleReasons(conn, b);
    if (drift.length) throw AppError.conflict('BATCH_STALE', 'Something that changes the amounts changed after this batch was generated. Void it and generate again.', { reasons: drift });
    if (await settings.getBool('eq_finalize_requires_scan')) {
      const [rows] = await conn.execute('SELECT eq_attendance_id FROM eq_payroll_attendance_snapshot WHERE eq_batch_id = ?', [id]);
      const missing = await P.sheetsMissingScan(conn, rows.map((r) => r.eq_attendance_id));
      if (missing.length) {
        throw AppError.conflict('SCAN_MISSING',
          `Upload the signed monthly sheet before finalizing: ${missing.slice(0, 5).map((m) => `${m.sheet_code} (rows to ${m.needed_row}, uploaded to ${m.scanned_row})`).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
          { sheets: missing });
      }
    }
    // what people changed by hand that this batch pays: the person who finalizes sees it and confirms it (four eyes)
    const summary = await reviewSummaryOf(conn, b);
    if (summary.items.length && !ack) {
      throw AppError.conflict('CHANGES_NOT_ACKNOWLEDGED', `This batch pays ${summary.items.length} manual change(s) (edits after approval, adjustments, standby hours, price changes...). Review them and confirm.`, summary);
    }
    const now = businessNow();
    await conn.execute('UPDATE eq_payroll_batches SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = ? WHERE eq_batch_id = ?', [req.user.user_id, now, id]);
    await issueInvoices(conn, id, b.currency, now);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'finalize', newValues: { acknowledged_changes: summary.items.length }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

/**
 * Mark paid = pay the REMAINING balance of every vendor of the batch in full (after any partial payments). Each vendor
 * gets a payment voucher for what was still owed, so the payments always add up to the invoice.
 */
exports.markPaid = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayFinalize(req);
  const { paid_at, payment_reference, method } = validate(req.body, { paid_at: v.datetime(), payment_reference: v.string({ max: 100 }), method: v.enumOf(S.METHODS) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Generated' || !Number(b.is_finalized)) throw AppError.conflict('BATCH_STATE', 'Only a finalized, unpaid batch can be marked paid.');
    const now = businessNow();
    const at = paid_at || now;
    const money = await S.balances(conn, b);
    const open = money._vendors.filter((x) => x._balance > 0);
    if (!open.length && money._totals.out > 0) throw AppError.conflict('NOTHING_TO_PAY', 'Nothing is left to pay on this batch: the rest was carried to a later batch.');
    const vouchers = [];
    for (const x of open) {
      const p = await S.recordPayment(conn, b, { vendorId: x.vendor_id, amountCents: x._balance, paidOn: String(at).slice(0, 10), method: method || 'BankTransfer',
        reference: payment_reference || null, note: 'Remaining balance paid in full (Mark paid)', source: 'MarkPaid', userId: req.user.user_id, ip: req.ip });
      vouchers.push(p.voucher_no);
    }
    if (payment_reference) await conn.execute('UPDATE eq_payroll_batches SET payment_reference = ? WHERE eq_batch_id = ?', [payment_reference, id]);
    const status = await S.refreshStatus(conn, id, { userId: req.user.user_id, paidAt: at, ip: req.ip });
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'mark_paid', oldValues: { status: 'Generated' },
      newValues: { status, paid_at: at, payment_reference: payment_reference || null, vouchers }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

const PAYMENT = {
  vendor_id: v.id({ required: true }), amount: v.number({ required: true, min: 0.01, max: 999999999999, decimals: 2 }),
  paid_on: v.date(), method: v.enumOf(S.METHODS, { default: 'BankTransfer' }), reference: v.string({ max: 100 }), note: v.string({ max: 500 }),
};

/**
 * Partial (or full) payment of one vendor's invoice on a FINALIZED batch: an official payment voucher is issued, the invoice
 * itself never changes, and the statement of account shows what is left. No over-payment. When every vendor balance reaches
 * 0 the batch becomes Paid by itself. Admin or Accountant (no approval step).
 */
exports.recordPayment = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, PAYMENT);
  const payment = await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    const p = await S.recordPayment(conn, b, { vendorId: d.vendor_id, amountCents: Math.round(d.amount * 100), paidOn: d.paid_on || businessNow().slice(0, 10),
      method: d.method, reference: d.reference || null, note: d.note || null, userId: req.user.user_id, ip: req.ip });
    const today = businessNow().slice(0, 10);
    await S.refreshStatus(conn, id, { userId: req.user.user_id, paidAt: p.paid_on === today ? businessNow() : `${p.paid_on} 00:00:00`, ip: req.ip });
    return p;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, id), payment });
};

/**
 * Reverse a payment recorded by mistake (kept, marked Reversed, with the reason). Admin at any time; the Accountant only
 * a payment they recorded, within eq_paid_undo_hours. The batch goes back to "waiting for payment" if needed.
 */
exports.reversePayment = async (req, res) => {
  const pid = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 5, max: 500 }) });
  const batchId = await withTransaction(async (conn) => {
    const [[p]] = await conn.execute('SELECT * FROM eq_payments WHERE payment_id = ?', [pid]);
    if (!p) throw AppError.notFound('Payment');
    if (req.user.role !== 'Admin') {
      const hours = await settings.getInt('eq_paid_undo_hours');
      const age = diffMinutes(String(p.created_at).slice(0, 19).replace('T', ' '), businessNow());
      if (p.created_by_user_id !== req.user.user_id || age > hours * 60) {
        throw AppError.forbidden('FORBIDDEN_ROLE', `Only the Admin may reverse this payment (an Accountant may reverse their own payment within ${hours} hours).`);
      }
    }
    await S.reversePayment(conn, pid, { reason, userId: req.user.user_id, ip: req.ip });
    return p.eq_batch_id;
  });
  res.json({ status: 'success', data: await batchDetail(pool, batchId) });
};

/** Payment voucher (أمر صرف) of one payment. */
exports.voucherPdf = async (req, res) => {
  const pid = parseId(req.params.id);
  const [[p]] = await pool.execute(
    `SELECT p.*, u.full_name AS created_by, r.full_name AS reversed_by, vd.vendor_name, vd.vendor_code, vd.tax_number, b.start_date, b.end_date, b.version_number, i.invoice_no
     FROM eq_payments p JOIN users u ON u.user_id = p.created_by_user_id LEFT JOIN users r ON r.user_id = p.reversed_by_user_id
     JOIN eq_vendors vd ON vd.vendor_id = p.vendor_id JOIN eq_payroll_batches b ON b.eq_batch_id = p.eq_batch_id
     LEFT JOIN eq_invoices i ON i.invoice_id = p.invoice_id WHERE p.payment_id = ?`, [pid]);
  if (!p) throw AppError.notFound('Payment');
  const { buffer, fileName } = await statements.voucherPdf(pool, p, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
};

/** Statement of account of one vendor on a batch: invoice + carried in - payments - carried out = balance (the invoice is unchanged). */
exports.accountStatementPdf = async (req, res) => {
  const id = parseId(req.params.id);
  const { vendor_id: vendorId } = validate(req.query, { vendor_id: v.id({ required: true }) });
  const b = await loadBatch(pool, id);
  if (!Number(b.is_finalized)) throw AppError.conflict('BATCH_STATE', 'A statement of account exists once the batch is finalized (invoice issued).');
  const money = await S.balances(pool, b);
  const vendor = money.vendors.find((x) => x.vendor_id === vendorId);
  if (!vendor) throw AppError.notFound('Vendor in this batch');
  const { buffer, fileName } = await statements.accountStatementPdf(pool, { batch: b, vendor, paymentStatus: money.payment_status }, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
};

/**
 * Undo a Mark Paid done by mistake (decision of 6 Oct 2026): Admin (or whoever may mark paid), reason required, only within
 * eq_paid_undo_hours of marking it and only while no payment reference was recorded. Afterwards: official Correction.
 */
exports.undoPaid = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayFinalize(req);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 5, max: 500 }) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    const [pays] = await conn.execute('SELECT payment_id, status, source FROM eq_payments WHERE eq_batch_id = ? FOR UPDATE', [id]);
    const markPaid = pays.filter((p) => p.status === 'Active' && p.source === 'MarkPaid');
    const state = paidUndoState(b, await settings.getInt('eq_paid_undo_hours'), { total: pays.length, markPaid: markPaid.length });
    if (!state.possible) {
      const why = {
        not_paid: 'This batch is not marked paid.',
        paid_by_payments: 'This batch was paid by recorded payments, not by "Mark paid": reverse the wrong payment instead (Payments section).',
        payment_reference: 'A payment reference is recorded: the payment really happened. Settle any difference with an official Correction.',
        marked_before_rule: 'This batch was marked paid before undo was possible. Settle any difference with an official Correction.',
        window_passed: `Mark Paid can only be undone within ${state.window_hours} hours. Settle any difference with an official Correction.`,
      }[state.reason];
      throw AppError.conflict('UNDO_PAID_NOT_ALLOWED', why, state);
    }
    if (markPaid.length) {
      // the vouchers issued by Mark paid are reversed (kept); partial payments made before stay
      for (const p of markPaid) await S.reversePayment(conn, p.payment_id, { reason: `Mark paid undone: ${reason}`, userId: req.user.user_id, ip: req.ip });
      await conn.execute('UPDATE eq_payroll_batches SET paid_undo_count = paid_undo_count + 1 WHERE eq_batch_id = ?', [id]);
    } else {
      // marked paid before payments were recorded (legacy): only the status goes back
      await conn.execute(
        "UPDATE eq_payroll_batches SET status = 'Generated', paid_by_user_id = NULL, paid_at = NULL, paid_marked_at = NULL, paid_undo_count = paid_undo_count + 1 WHERE eq_batch_id = ?",
        [id]);
    }
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'undo_paid', oldValues: { status: 'Paid', paid_at: b.paid_at, paid_by_user_id: b.paid_by_user_id, paid_marked_at: b.paid_marked_at },
      newValues: { status: 'Generated' }, reason, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id), message: 'Payment mark removed. The batch is finalized and waiting for payment again.' });
};

/** Record the bank / cheque reference of a paid batch. Once recorded, Mark Paid can no longer be undone. */
exports.setPaymentReference = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayFinalize(req);
  const d = validate(req.body, { payment_reference: v.string({ required: true, max: 100 }), reason: v.string({ max: 500 }) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (b.status !== 'Paid') throw AppError.conflict('BATCH_STATE', 'Only a paid batch has a payment reference.');
    if (b.payment_reference && b.payment_reference !== d.payment_reference && (!d.reason || d.reason.trim().length < 5)) {
      throw AppError.validation({ reason: 'say why the payment reference changes (at least 5 characters)' });
    }
    await conn.execute('UPDATE eq_payroll_batches SET payment_reference = ? WHERE eq_batch_id = ?', [d.payment_reference, id]);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'payment_reference', oldValues: { payment_reference: b.payment_reference },
      newValues: { payment_reference: d.payment_reference }, reason: d.reason || null, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

/**
 * Manual changes this batch pays, for the person who finalizes it: rows edited after approval, late entries, manual
 * adjustments and correction settlements, standby hours decided, fuel issues and rate cards changed after creation,
 * and the blockers accepted at generation.
 */
async function reviewSummaryOf(conn, batch) {
  const id = batch.eq_batch_id;
  const items = [];
  const [edited] = await conn.query(
    `SELECT a.eq_attendance_id, a.record_date, a.sheet_row_no, e.equipment_code, a.admin_edit_reason, a.admin_edit_at, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.admin_edit_by_user_id WHERE s.eq_batch_id = ? AND a.edited_after_approval = 1 ORDER BY a.record_date`, [id]);
  for (const r of edited) items.push({ kind: 'edited_after_approval', ref: `${r.equipment_code} ${String(r.record_date).slice(0, 10)} row #${r.sheet_row_no}`, by: r.by_name, at: r.admin_edit_at, reason: r.admin_edit_reason });
  const [late] = await conn.query(
    `SELECT a.record_date, a.sheet_row_no, a.late_entry_days, a.late_entry_reason, e.equipment_code, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.recorded_by_user_id WHERE s.eq_batch_id = ? AND a.late_entry = 1 ORDER BY a.record_date`, [id]);
  for (const r of late) items.push({ kind: 'late_entry', ref: `${r.equipment_code} ${String(r.record_date).slice(0, 10)} row #${r.sheet_row_no} (${r.late_entry_days} days late)`, by: r.by_name, reason: r.late_entry_reason });
  const [credits] = await conn.query(
    `SELECT a.record_date, e.equipment_code, a.standby_credit_minutes, a.standby_credit_note, a.standby_credit_at, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.standby_credit_by_user_id WHERE s.eq_batch_id = ? AND s.standby_credit_minutes IS NOT NULL ORDER BY a.record_date`, [id]);
  for (const r of credits) items.push({ kind: 'standby_hours', ref: `${r.equipment_code} ${String(r.record_date).slice(0, 10)}: ${(Number(r.standby_credit_minutes) / 60).toFixed(2)} h`, by: r.by_name, at: r.standby_credit_at, reason: r.standby_credit_note });
  const [adj] = await conn.query(
    `SELECT ad.adjustment_id, ad.adjustment_type, ad.amount, ad.currency, ad.reason, ad.correction_id, ad.created_at, e.equipment_code, u.full_name AS by_name
     FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_adjustments ad ON ad.adjustment_id = l.source_id
     JOIN eq_equipment e ON e.equipment_id = ad.equipment_id LEFT JOIN users u ON u.user_id = ad.created_by_user_id
     WHERE i.eq_batch_id = ? AND l.source_table = 'eq_adjustments' ORDER BY ad.adjustment_id`, [id]);
  for (const r of adj) {
    items.push({ kind: r.correction_id ? 'correction_settlement' : 'adjustment', ref: `${r.equipment_code} ${r.adjustment_type} ${Number(r.amount).toFixed(2)} ${r.currency}`,
      by: r.by_name, at: r.created_at, reason: r.reason });
  }
  const [fuel] = await conn.query(
    `SELECT DISTINCT f.fuel_issue_id, f.issue_date, e.equipment_code FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     JOIN eq_fuel_issues f ON f.fuel_issue_id = l.source_id JOIN eq_equipment e ON e.equipment_id = f.equipment_id
     WHERE i.eq_batch_id = ? AND l.source_table = 'eq_fuel_issues'
       AND EXISTS (SELECT 1 FROM audit_logs x WHERE x.table_name = 'eq_fuel_issues' AND x.record_id = f.fuel_issue_id AND x.action_type = 'update')`, [id]);
  for (const r of fuel) items.push({ kind: 'fuel_changed', ref: `${r.equipment_code} fuel issue #${r.fuel_issue_id} (${String(r.issue_date).slice(0, 10)}) changed after it was recorded` });
  const [cards] = await conn.query(
    `SELECT DISTINCT i.rate_card_id, e.equipment_code FROM eq_payroll_items i JOIN eq_equipment e ON e.equipment_id = i.equipment_id
     WHERE i.eq_batch_id = ? AND i.rate_card_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM audit_logs x WHERE x.table_name = 'eq_rate_cards' AND x.record_id = i.rate_card_id AND x.action_type = 'update')`, [id]);
  for (const r of cards) items.push({ kind: 'rate_card_changed', ref: `${r.equipment_code} rate card #${r.rate_card_id} was edited after creation (see its history)` });
  const [dns] = await conn.query(
    `SELECT DISTINCT dn.delivery_note_id, dn.dn_number, dn.note_date, e.equipment_code FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     JOIN eq_delivery_notes dn ON dn.delivery_note_id = l.source_id JOIN eq_equipment e ON e.equipment_id = dn.equipment_id
     WHERE i.eq_batch_id = ? AND l.source_table = 'eq_delivery_notes'
       AND EXISTS (SELECT 1 FROM audit_logs x WHERE x.table_name = 'eq_delivery_notes' AND x.record_id = dn.delivery_note_id AND x.action_type = 'update')`, [id]);
  for (const r of dns) items.push({ kind: 'delivery_note_changed', ref: `${r.equipment_code} delivery note ${r.dn_number} (${String(r.note_date).slice(0, 10)}) changed after it was recorded` });
  const [carried] = await conn.query(
    `SELECT c.from_batch_id, c.opening_balance_id, ob.description AS ob_description, c.amount, c.currency, vd.vendor_name, u.full_name AS by_name, c.created_at
     FROM eq_payment_carryovers c JOIN eq_vendors vd ON vd.vendor_id = c.vendor_id LEFT JOIN eq_opening_balances ob ON ob.opening_balance_id = c.opening_balance_id
     JOIN users u ON u.user_id = c.created_by_user_id WHERE c.to_batch_id = ? AND c.status = 'Active'`, [id]);
  for (const r of carried) {
    const from = r.from_batch_id ? `still owed on batch #${r.from_batch_id}` : `opening balance #${r.opening_balance_id} (from before the system: ${r.ob_description})`;
    items.push({ kind: r.from_batch_id ? 'previous_balance' : 'opening_balance', ref: `${r.vendor_name}: ${Number(r.amount).toFixed(2)} ${r.currency} ${from}`, by: r.by_name, at: r.created_at });
  }
  if (batch.accept_blockers_reason) items.push({ kind: 'accepted_blockers', ref: batch.accept_blockers_reason });
  return { eq_batch_id: id, items };
}

exports.reviewSummary = async (req, res) => {
  const id = parseId(req.params.id);
  const b = await loadBatch(pool, id);
  res.json({ status: 'success', data: await reviewSummaryOf(pool, b) });
};

/** Voids a Generated batch (inside the caller's transaction). */
async function doVoid(conn, req, id, reason) {
  const b = await loadBatch(conn, id, true);
  if (b.status !== 'Generated') throw AppError.conflict('BATCH_STATE', `A ${b.status} batch cannot be voided.`);
  if (Number(b.is_finalized)) await assertNoCorrections(conn, id);
  await S.assertNoMoneyMoved(conn, id);
  await conn.execute("UPDATE eq_payroll_batches SET status = 'Voided', voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE eq_batch_id = ?", [req.user.user_id, businessNow(), reason, id]);
  if (Number(b.is_finalized)) await cancelInvoices(conn, id, `Batch voided: ${reason}`, req.user.user_id);
  // balances carried INTO this batch are owed again on their own batches
  await S.releaseCarryIns(conn, id, { reason: `batch #${id} voided: ${reason}`, userId: req.user.user_id, ip: req.ip });
  await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'void', reason, ...audit.ctx(req) });
  return { id };
}

/** Replaces a finalized, unpaid batch by a recalculated version (inside the caller's transaction). */
async function doSupersede(conn, req, id, reason, acceptBlockers) {
  const old = await loadBatch(conn, id, true);
  if (old.status === 'Paid') throw AppError.conflict('BATCH_PAID', 'A paid batch is never recalculated. Settle any difference with an official Correction (debit / credit note).');
  if (!Number(old.is_finalized) || old.status !== 'Generated') throw AppError.conflict('BATCH_STATE', 'Only a finalized, unpaid batch can be superseded.');
  await assertNoCorrections(conn, id);
  await S.assertNoMoneyMoved(conn, id);
  const scope = { start_date: old.start_date, end_date: old.end_date, vendor_id: old.scope_vendor_id, equipment_id: old.scope_equipment_id, site_id: old.scope_site_id, currency: old.currency, accept_blockers: acceptBlockers };
  const r = await generateInTx(conn, req, scope, { version_number: Number(old.version_number) + 1, supersedes_batch_id: id, supersede_reason: reason });
  await conn.execute("UPDATE eq_payroll_batches SET status = 'Superseded' WHERE eq_batch_id = ?", [id]);
  // balances carried into the old version follow the new version
  const [nv] = await conn.execute('SELECT DISTINCT vendor_id FROM eq_payroll_items WHERE eq_batch_id = ?', [r.id]);
  await S.moveCarryIns(conn, id, r.id, nv.map((x) => x.vendor_id), { reason: `replaced by version #${r.id}`, userId: req.user.user_id, ip: req.ip });
  await cancelInvoices(conn, id, `Replaced by batch #${r.id} (version ${Number(old.version_number) + 1}): ${reason}`, req.user.user_id);
  await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'superseded', newValues: { by: r.id }, reason, ...audit.ctx(req) });
  await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate_version', newValues: { supersedes: id }, reason, ...audit.ctx(req) });
  return r;
}

/**
 * When only the Admin closes payroll, an Accountant cannot undo a FINALIZED batch alone: the void / new version is
 * stored as a request and runs when an Admin approves it. Returns the request, or null when the user may act now.
 */
async function requestIfNeeded(conn, req, id, action, reason, acceptBlockers) {
  if (req.user.role !== 'Accountant' || !(await settings.getBool('payroll_finalize_admin_only'))) return null;
  const b = await loadBatch(conn, id, true);
  if (!Number(b.is_finalized)) return null;
  if (b.status !== 'Generated') throw AppError.conflict('BATCH_STATE', `A ${b.status} batch cannot be ${action === 'void' ? 'voided' : 'replaced'}.`);
  await assertNoCorrections(conn, id);
  await S.assertNoMoneyMoved(conn, id);
  const [[open]] = await conn.execute("SELECT request_id FROM eq_batch_requests WHERE eq_batch_id = ? AND status = 'Pending' LIMIT 1", [id]);
  if (open) throw AppError.conflict('REQUEST_PENDING', `Request #${open.request_id} for this batch is already waiting for the Admin.`);
  const [r] = await conn.execute(
    'INSERT INTO eq_batch_requests (eq_batch_id, action, reason, accept_blockers, requested_by_user_id, requested_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, action, reason, acceptBlockers ? 1 : 0, req.user.user_id, businessNow()]);
  await audit.log(conn, { table: 'eq_payroll_batches', id, action: `request_${action}`, reason, newValues: { request_id: r.insertId }, ...audit.ctx(req) });
  return { request_id: r.insertId, action, status: 'Pending' };
}

exports.void = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }) });
  const request = await withTransaction(async (conn) => {
    const rq = await requestIfNeeded(conn, req, id, 'void', reason, false);
    if (!rq) await doVoid(conn, req, id, reason);
    return rq;
  });
  if (request) return res.status(202).json({ status: 'success', data: await batchDetail(pool, id), message: 'The batch is finalized: your request was sent to the Admin for approval.' });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

exports.supersede = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason, accept_blockers } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }), accept_blockers: v.bool({ default: false }) });
  const out = await withTransaction(async (conn) => {
    const rq = await requestIfNeeded(conn, req, id, 'supersede', reason, accept_blockers);
    if (rq) return { request: rq };
    return doSupersede(conn, req, id, reason, accept_blockers);
  });
  if (out.request) return res.status(202).json({ status: 'success', data: await batchDetail(pool, id), message: 'The batch is finalized: your request was sent to the Admin for approval.' });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

async function loadRequest(conn, rid) {
  const [[r]] = await conn.execute('SELECT * FROM eq_batch_requests WHERE request_id = ? FOR UPDATE', [rid]);
  if (!r) throw AppError.notFound('Request');
  if (r.status !== 'Pending') throw AppError.conflict('INVALID_STATE', `This request is ${r.status}.`);
  return r;
}

/** Admin: approve an Accountant's void / new-version request; the action runs now, in the Admin's name. */
exports.approveRequest = async (req, res) => {
  const rid = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ max: 500 }) });
  const out = await withTransaction(async (conn) => {
    const r = await loadRequest(conn, rid);
    const reason = `${r.reason} (requested by the accountant, approved by the Admin${note ? `: ${note}` : ''})`;
    const result = r.action === 'void' ? await doVoid(conn, req, r.eq_batch_id, reason) : await doSupersede(conn, req, r.eq_batch_id, reason, Boolean(r.accept_blockers));
    await conn.execute("UPDATE eq_batch_requests SET status = 'Approved', decided_by_user_id = ?, decided_at = ?, decision_note = ?, result_batch_id = ? WHERE request_id = ?",
      [req.user.user_id, businessNow(), note || null, r.action === 'supersede' ? result.id : null, rid]);
    return { batchId: r.action === 'supersede' ? result.id : r.eq_batch_id, warnings: result.warnings };
  });
  res.json({ status: 'success', data: await batchDetail(pool, out.batchId), warnings: out.warnings });
};

exports.rejectRequest = async (req, res) => {
  const rid = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, min: 3, max: 500 }) });
  const batchId = await withTransaction(async (conn) => {
    const r = await loadRequest(conn, rid);
    await conn.execute("UPDATE eq_batch_requests SET status = 'Rejected', decided_by_user_id = ?, decided_at = ?, decision_note = ? WHERE request_id = ?",
      [req.user.user_id, businessNow(), note, rid]);
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.eq_batch_id, action: `reject_${r.action}_request`, reason: note, ...audit.ctx(req) });
    return r.eq_batch_id;
  });
  res.json({ status: 'success', data: await batchDetail(pool, batchId) });
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
