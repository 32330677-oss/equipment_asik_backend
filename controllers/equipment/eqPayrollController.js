// Equipment invoices (decisions of 13-14 Oct 2026): preview, overlap check, generate, issue, keep up to date, cancel,
// re-issue after a withdrawal from finance, exports. Hand-over to finance, withdrawal and debit / credit notes are in
// eqFinanceController. The app does not record payments: finance pays outside it.
//
// One invoice batch = a period + one vendor (or every vendor) + its machines (all, or chosen by hand) + one currency.
// Two ACTIVE batches never cover the same machine on the same day (eq_invoice_coverage). Life of a batch:
//   Draft (no number) -> Issued (VI / MI / FD numbers; kept up to date with the SAME numbers while in the office)
//   -> HandedOver (locked) -> Returned (signed withdrawal; Admin) -> re-issued with NEW numbers, or cancelled.
'use strict';

const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const { businessNow, businessToday, addDays } = require('../../utils/businessDate');
const { toDecimalString } = require('../../utils/money');
const { currentUser } = require('../../utils/requestContext');
const P = require('../../services/equipment/eqPayrollService');
const statements = require('../../services/equipment/eqStatements');
const certificate = require('../../services/equipment/eqCertificateXlsx');
const lock = require('../../services/equipment/eqLock');

const day = (d) => (d ? String(d).slice(0, 10) : null);
const isAdmin = (req) => req.user.role === 'Admin';

const SCOPE = {
  start_date: v.date({ required: true }), end_date: v.date({ required: true }),
  vendor_id: v.id(), equipment_id: v.id(), site_id: v.id(), currency: v.currency(),
  // 11 Oct 2026: several machines of ONE vendor chosen by hand (empty = the whole scope)
  equipment_ids: v.ids(),
  // take the chosen machines out of other DRAFT batches (they are cancelled, or recalculated without them)
  take_from_drafts: v.bool({ default: false }),
  accept_blockers: v.bool({ default: false }), accept_reason: v.string({ max: 500 }),
  // 12 Oct 2026: monthly machines whose extra hours cover their missing hours, decided by the Admin: ["<equipment_id>|YYYY-MM"]
  offsets: v.any(),
};

/** "1,2,3" in a query string -> [1,2,3] (GET routes). */
function queryIds(q) {
  const out = { ...q };
  if (typeof out.equipment_ids === 'string') out.equipment_ids = out.equipment_ids.split(',').map((x) => x.trim()).filter(Boolean);
  if (typeof out.offsets === 'string') out.offsets = out.offsets.split(',');
  if (Array.isArray(out.equipment_ids) && !out.equipment_ids.length) delete out.equipment_ids;
  return out;
}

/**
 * Validates a scope. equipment_ids needs the vendor, and every machine must be that vendor's (422). The old single
 * equipment_id still works (a list of one).
 */
async function checkScope(conn, input) {
  const scope = validate(input, SCOPE);
  scope.offsets = P.normalizeOffsets(scope.offsets);
  if (scope.equipment_id && !scope.equipment_ids) scope.equipment_ids = [scope.equipment_id];
  if (scope.equipment_ids) {
    scope.equipment_ids = [...new Set(scope.equipment_ids)].sort((a, b) => a - b);
    if (!scope.vendor_id) {
      if (scope.equipment_ids.length > 1) throw AppError.validation({ vendor_id: 'is required when several machines are chosen' });
    } else {
      const [own] = await conn.query('SELECT equipment_id FROM eq_equipment WHERE vendor_id = ? AND equipment_id IN (?)', [scope.vendor_id, scope.equipment_ids]);
      if (own.length !== scope.equipment_ids.length) {
        throw new AppError(422, 'MACHINE_OTHER_VENDOR', 'Every chosen machine must belong to the chosen vendor.', { equipment_ids: scope.equipment_ids.filter((x) => !own.some((o) => o.equipment_id === x)) });
      }
    }
    scope.equipment_id = scope.equipment_ids.length === 1 && !scope.vendor_id ? scope.equipment_ids[0] : null;
  }
  if (scope.end_date < scope.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
  return scope;
}

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
  const [e] = await conn.query('SELECT e.equipment_id, e.equipment_code, e.machine_label, t.type_name FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id WHERE e.equipment_id IN (?)', [eq]);
  for (const r of e) names.eq[r.equipment_id] = r;
  const [s] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [[...new Set(items.flatMap((i) => [i.site_id, ...(i.site_allocation || []).map((a) => a.site_id)]))]]);
  for (const r of s) names.site[r.site_id] = r;
  const [vd] = await conn.query('SELECT vendor_id, vendor_code, vendor_name FROM eq_vendors WHERE vendor_id IN (?)', [[...new Set(items.map((i) => i.vendor_id))]]);
  for (const r of vd) names.vendor[r.vendor_id] = r;
  return names;
}

function itemView(it, names) {
  return {
    equipment_id: it.equipment_id, equipment_code: names.eq[it.equipment_id]?.equipment_code, machine_label: names.eq[it.equipment_id]?.machine_label || null, type_name: names.eq[it.equipment_id]?.type_name,
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

// ======================================================================= overlap (14 Oct 2026)
const INVOICE_NO = `(SELECT x.invoice_no FROM eq_invoices x LEFT JOIN eq_invoice_cancellations xc ON xc.invoice_id = x.invoice_id
   WHERE x.eq_batch_id = b.eq_batch_id AND x.kind = 'Vendor' AND x.status = 'Issued' AND xc.invoice_id IS NULL ORDER BY x.invoice_id LIMIT 1)`;

/** The parts of [start, end] not taken by the given ranges ({from, to}), as [{from, to}]. */
function freeRanges(start, end, taken) {
  const list = taken.map((t) => ({ from: day(t.from) < start ? start : day(t.from), to: day(t.to) > end ? end : day(t.to) }))
    .filter((t) => t.from <= t.to).sort((a, b) => a.from.localeCompare(b.from));
  const out = [];
  let cur = start;
  for (const t of list) {
    if (t.from > cur) out.push({ from: cur, to: addDays(t.from, -1) });
    if (t.to >= cur) cur = addDays(t.to, 1);
  }
  if (cur <= end) out.push({ from: cur, to: end });
  return out;
}

/**
 * Active invoices (draft or numbered) that already cover these machines on [start, end] (siteId null = any site),
 * per machine with the free parts of the period: [{ equipment_id, equipment_code, label, conflicts: [...], free: [...] }].
 * lockRows: the machines are locked (FOR UPDATE) so two people cannot invoice the same days at the same moment.
 */
async function overlapsFor(conn, { equipmentIds, start, end, siteId = null, excludeBatchIds = [], lockRows = false }) {
  const ids = [...new Set((equipmentIds || []).map(Number))].filter(Boolean);
  if (!ids.length) return [];
  if (lockRows) await conn.query('SELECT equipment_id FROM eq_equipment WHERE equipment_id IN (?) ORDER BY equipment_id FOR UPDATE', [ids]);
  const [rows] = await conn.query(
    `SELECT c.equipment_id, e.equipment_code, e.machine_label, t.type_name, c.start_date AS c_from, c.end_date AS c_to, c.site_id, s.site_code,
       b.eq_batch_id, b.status, b.is_finalized, b.version_number, ${INVOICE_NO} AS invoice_no
     FROM eq_invoice_coverage c JOIN eq_payroll_batches b ON b.eq_batch_id = c.eq_batch_id
     JOIN eq_equipment e ON e.equipment_id = c.equipment_id JOIN eq_types t ON t.type_id = e.type_id LEFT JOIN sites s ON s.site_id = c.site_id
     WHERE c.equipment_id IN (?) AND ${lock.ACTIVE} AND b.eq_batch_id NOT IN (?) AND c.start_date <= ? AND c.end_date >= ?
       AND (? IS NULL OR c.site_id IS NULL OR c.site_id = ?)
     ORDER BY e.equipment_code, c.start_date`,
    [ids, excludeBatchIds.length ? excludeBatchIds : [0], end, start, siteId ?? null, siteId ?? null]);
  const byMachine = new Map();
  for (const r of rows) {
    const m = byMachine.get(r.equipment_id) || { equipment_id: r.equipment_id, equipment_code: r.equipment_code, label: r.machine_label || `${r.equipment_code} ${r.type_name}`, conflicts: [] };
    m.conflicts.push({
      eq_batch_id: r.eq_batch_id, state: lock.stateOf(r), invoice_no: r.invoice_no || null, version_number: r.version_number,
      start_date: day(r.c_from), end_date: day(r.c_to), site_code: r.site_code || null,
    });
    byMachine.set(r.equipment_id, m);
  }
  return [...byMachine.values()].map((m) => ({ ...m, free: freeRanges(start, end, m.conflicts.map((c) => ({ from: c.start_date, to: c.end_date }))) }));
}

function overlapError(overlaps) {
  const STATE = { draft: 'draft', issued: 'issued', handed_over: 'handed over to finance', returned: 'withdrawn from finance' };
  const text = overlaps.map((m) => `${m.label}: ${m.conflicts.map((c) => `${c.invoice_no || `draft #${c.eq_batch_id}`} (${STATE[c.state] || c.state}) ${c.start_date} to ${c.end_date}`).join(', ')}`
    + `${m.free.length ? `; free: ${m.free.map((f) => `${f.from} to ${f.to}`).join(', ')}` : '; nothing free in this period'}`).join(' | ');
  return AppError.conflict('PERIOD_OVERLAP', `Some machines already have an invoice in this period. ${text}`, { overlaps });
}

/** The machines a scope will cover: the ones billed + the ones chosen by hand. */
function coveredMachines(scope, items) {
  return [...new Set([...items.map((i) => i.equipment_id), ...(machineList(scope) || []), ...(scope.equipment_id ? [scope.equipment_id] : [])])];
}

// ======================================================================= preview / coverage / blockers
exports.preview = async (req, res) => {
  const conn = pool;
  const scope = await checkScope(conn, req.body);
  const blockers = await P.blockers(conn, scope);
  const { items, warnings } = await P.calculate(conn, scope);
  const names = await namesFor(conn, items);
  const overlaps = await overlapsFor(conn, { equipmentIds: coveredMachines(scope, items), start: scope.start_date, end: scope.end_date, siteId: scope.site_id || null });
  res.json({ status: 'success', data: { scope, totals: summarize(items), blockers, warnings, overlaps, items: items.map((i) => itemView(i, names)) } });
};

/**
 * Machines of one vendor in a period, for "New invoice": per machine, what an invoice would bill now (ready), the
 * invoices that already cover part of the period (overlaps, with the free parts), and what blocks it.
 */
exports.coverage = async (req, res) => {
  const q = validate(req.query, { vendor_id: v.id({ required: true }), start_date: v.date({ required: true }), end_date: v.date({ required: true }), site_id: v.id() });
  if (q.end_date < q.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
  const [machines] = await pool.query(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.plate_number, t.type_name FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id
     WHERE e.vendor_id = ? AND (
       EXISTS (SELECT 1 FROM eq_site_assignments a WHERE a.equipment_id = e.equipment_id AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?))
       OR EXISTS (SELECT 1 FROM eq_attendance ea WHERE ea.equipment_id = e.equipment_id AND ea.record_date BETWEEN ? AND ? AND ea.status <> 'Cancelled')
       OR EXISTS (SELECT 1 FROM eq_fuel_issues f WHERE f.equipment_id = e.equipment_id AND f.issue_date BETWEEN ? AND ? AND f.is_cancelled = 0)
       OR EXISTS (SELECT 1 FROM eq_adjustments ad WHERE ad.equipment_id = e.equipment_id AND ad.adjustment_date BETWEEN ? AND ? AND ad.status = 'Active')
       OR EXISTS (SELECT 1 FROM eq_delivery_notes dn WHERE dn.equipment_id = e.equipment_id AND dn.note_date BETWEEN ? AND ? AND dn.status = 'Active'))
     ORDER BY e.equipment_code`,
    [q.vendor_id, q.end_date, q.start_date, q.start_date, q.end_date, q.start_date, q.end_date, q.start_date, q.end_date, q.start_date, q.end_date]);
  const overlaps = await overlapsFor(pool, { equipmentIds: machines.map((m) => m.equipment_id), start: q.start_date, end: q.end_date, siteId: q.site_id || null });
  const out = [];
  for (const m of machines) {
    const scope = { start_date: q.start_date, end_date: q.end_date, vendor_id: q.vendor_id, equipment_ids: [m.equipment_id], site_id: q.site_id || undefined };
    const [[card]] = await pool.query(
      `SELECT billing_mode FROM eq_rate_cards WHERE equipment_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY effective_from DESC LIMIT 1`, [m.equipment_id, q.end_date, q.start_date]);
    const ready = { rows: 0, monthly_days: 0, fuel: 0, adjustments: 0, dnr: 0, net: [] };
    let calcError = null;
    try {
      const { items } = await P.calculate(pool, scope);
      for (const it of items) {
        ready.rows += it.per_row ? it.per_row.length : 0;
        ready.monthly_days += it.monthly_days ? it.monthly_days.length : 0;
        ready.fuel += it.lines.filter((l) => l.line_type === 'Fuel').length;
        ready.adjustments += it.lines.filter((l) => l.line_type === 'Adjustment').length;
        ready.dnr += it.lines.filter((l) => l.line_type === 'DeliveryNote').length;
        ready.net.push({ currency: it.currency, net: toDecimalString(it.net_cents) });
      }
    } catch (e) {
      if (!e.isAppError) throw e;
      calcError = { code: e.code, message: e.message };
    }
    const blockers = {};
    for (const b of await P.blockers(pool, scope)) if (b.blocking) blockers[b.code.toLowerCase()] = b.count;
    if (calcError) blockers[calcError.code.toLowerCase()] = 1;
    const ov = overlaps.find((x) => x.equipment_id === m.equipment_id);
    const isReady = !ov && ready.rows + ready.monthly_days + ready.fuel + ready.adjustments + ready.dnr > 0;
    out.push({
      equipment_id: m.equipment_id, label: m.machine_label || `${m.equipment_code} ${m.type_name}`, equipment_code: m.equipment_code, plate: m.plate_number,
      billing_mode: card ? card.billing_mode : null, ready, is_ready: isReady,
      overlaps: ov ? ov.conflicts : [], free: ov ? ov.free : [{ from: q.start_date, to: q.end_date }],
      in_draft: ov ? [...new Set(ov.conflicts.filter((c) => c.state === 'draft').map((c) => c.eq_batch_id))] : [],
      blockers, calc_error: calcError,
    });
  }
  res.json({ status: 'success', data: out });
};

exports.blockers = async (req, res) => {
  const scope = await checkScope(pool, queryIds(req.query));
  res.json({ status: 'success', data: await P.blockers(pool, scope) });
};

/**
 * Names as they are TODAY, frozen into the item: an old invoice keeps the vendor / machine / site names
 * it was issued with even if they are renamed later.
 */
async function labelsFor(conn, items) {
  const eq = [...new Set(items.map((i) => i.equipment_id))];
  const [e] = await conn.query(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.plate_number, e.make, e.model, t.type_name, t.type_name_ar, vd.vendor_id, vd.vendor_name, vd.vendor_code, vd.tax_number, vd.vendor_type, vd.national_id
     FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id WHERE e.equipment_id IN (?)`, [eq]);
  const [st] = await conn.query('SELECT site_id, site_code, site_name, project_name FROM sites WHERE site_id IN (?)', [[...new Set(items.map((i) => i.site_id))]]);
  const E = Object.fromEntries(e.map((x) => [x.equipment_id, x])); const S = Object.fromEntries(st.map((x) => [x.site_id, x]));
  return (it) => {
    const m = E[it.equipment_id] || {}; const si = S[it.site_id] || {};
    return {
      equipment_code: m.equipment_code, machine_label: m.machine_label || null, plate_number: m.plate_number, type_name: m.type_name, type_name_ar: m.type_name_ar, make: m.make, model: m.model,
      vendor_name: m.vendor_name, vendor_code: m.vendor_code, vendor_tax_number: m.tax_number, vendor_type: m.vendor_type, vendor_national_id: m.national_id, site_code: si.site_code, site_name: si.site_name,
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
    [scope.start_date, scope.end_date, scope.vendor_id || null, machineList(scope) ? null : (scope.equipment_id || null), scope.site_id || null, currency,
      extra.version_number || 1, extra.supersedes_batch_id || null, extra.supersede_reason || null,
      new Set(items.map((i) => i.equipment_id)).size, toDecimalString(totals.g), toDecimalString(totals.d), toDecimalString(totals.n),
      req.user.user_id, JSON.stringify(await P.billingSettings())]);
  if (extra.accept_reason) await conn.execute('UPDATE eq_payroll_batches SET accept_blockers_reason = ? WHERE eq_batch_id = ?', [extra.accept_reason, b.insertId]);
  const batchId = b.insertId;
  // the Admin's offset decisions that apply to this batch (a month of a monthly machine it bills)
  const billed = new Set(items.filter((i) => i.billing_mode === 'Monthly').flatMap((i) => (i.months || []).map((m) => `${i.equipment_id}|${m.month}`)));
  const offsets = P.normalizeOffsets(scope.offsets).filter((k) => billed.has(k));
  if (offsets.length) await conn.execute('UPDATE eq_payroll_batches SET offset_months = ? WHERE eq_batch_id = ?', [JSON.stringify(offsets), batchId]);
  // machines chosen by hand (11 Oct 2026); empty = the whole scope
  for (const eid of machineList(scope) || []) await conn.execute('INSERT INTO eq_payroll_batch_machines (eq_batch_id, equipment_id) VALUES (?, ?)', [batchId, eid]);
  // the period of each machine this batch covers (14 Oct 2026): no other active invoice may cover it
  for (const eid of coveredMachines(scope, items)) {
    await conn.execute('INSERT INTO eq_invoice_coverage (eq_batch_id, equipment_id, site_id, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
      [batchId, eid, scope.site_id || null, scope.start_date, scope.end_date]);
  }
  const labels = await labelsFor(conn, items);
  for (const it of items) {
    const [ir] = await conn.execute(
      `INSERT INTO eq_payroll_items (eq_batch_id, equipment_id, vendor_id, site_id, rate_card_id, rate_snapshot, billing_mode, days_recorded, worked_days,
         work_hours, overtime_hours, standby_hours, breakdown_hours, topup_hours, gross_amount, deductions_amount, net_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, it.equipment_id, it.vendor_id, it.site_id, it.rate_card_id,
        JSON.stringify({ ...it.rate_snapshot, months: it.months, monthly_calc: it.monthly_calc || null, monthly_prev: it.monthly_prev || null, monthly_terms: it.monthly_terms || null,
          monthly_offset: it.monthly_offset || null,
          fuel_diff: it.fuel_diff || null, site_allocation: it.site_allocation || null, labels: labels(it) }), it.billing_mode,
        it.days_recorded, it.worked_days, hoursOf(it.work_minutes), hoursOf(it.overtime_minutes), hoursOf(it.standby_minutes),
        hoursOf(it.breakdown_minutes), hoursOf(it.topup_minutes), toDecimalString(it.gross_cents), toDecimalString(it.deductions_cents), toDecimalString(it.net_cents)]);
    for (const l of it.lines) {
      await conn.execute(
        `INSERT INTO eq_payroll_lines (eq_item_id, line_type, quantity, unit, unit_price, amount, source_table, source_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ir.insertId, l.line_type, l.quantity, l.unit, (l.unit_price_exact ?? l.unit_price_cents / 100).toFixed(3), toDecimalString(l.amount_cents), l.source_table || null, l.source_id || null, l.note || null]);
    }
    // each deployed day of a monthly machine is billed by one batch only (11 Oct 2026)
    for (const md of it.monthly_days || []) {
      await conn.execute('INSERT INTO eq_payroll_monthly_days (eq_batch_id, eq_item_id, equipment_id, day, site_id) VALUES (?, ?, ?, ?, ?)',
        [batchId, ir.insertId, it.equipment_id, md.day, md.site_id]);
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

/** The machines chosen by hand for a scope (a list kept on the batch), or null for the whole scope. */
function machineList(scope) {
  if (!scope.equipment_ids || !scope.equipment_ids.length) return null;
  if (scope.equipment_ids.length === 1 && !scope.vendor_id) return null; // the old single-machine scope (scope_equipment_id)
  return scope.equipment_ids;
}

/** Machines of the scope that sit in another DRAFT batch over the same days. */
async function draftsHolding(conn, scope, excludeBatchId = 0) {
  const machines = P.scopeMachines(scope);
  if (!machines) return [];
  const [rows] = await conn.query(
    `SELECT DISTINCT b.eq_batch_id, c.equipment_id FROM eq_invoice_coverage c JOIN eq_payroll_batches b ON b.eq_batch_id = c.eq_batch_id
     WHERE b.status = 'Generated' AND b.is_finalized = 0 AND b.eq_batch_id <> ? AND c.equipment_id IN (?)
       AND c.start_date <= ? AND c.end_date >= ?`, [excludeBatchId || 0, machines, scope.end_date, scope.start_date]);
  return rows;
}

/**
 * take_from_drafts: the chosen machines leave the other DRAFT batches that hold them, inside the same transaction —
 * a draft left with none of its machines is deleted, otherwise it is recalculated (new version) without them.
 */
async function takeFromDrafts(conn, req, scope) {
  const held = await draftsHolding(conn, scope);
  const out = [];
  for (const batchId of [...new Set(held.map((x) => x.eq_batch_id))]) {
    const old = await loadBatch(conn, batchId, true);
    const [cov] = await conn.execute('SELECT equipment_id FROM eq_invoice_coverage WHERE eq_batch_id = ?', [batchId]);
    const taken = held.filter((x) => x.eq_batch_id === batchId).map((x) => x.equipment_id);
    const left = cov.map((x) => x.equipment_id).filter((x) => !taken.includes(x));
    const why = `machines moved to a new invoice (${taken.map((x) => `#${x}`).join(', ')})`;
    if (!left.length) {
      await doVoid(conn, req, batchId, why);
      out.push({ eq_batch_id: batchId, action: 'voided' });
    } else {
      const vendorId = old.scope_vendor_id || (await conn.query('SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?', [left[0]]))[0][0].vendor_id;
      const r = await doSupersede(conn, req, batchId, why, true, { vendor_id: vendorId, equipment_ids: left, equipment_id: null });
      out.push({ eq_batch_id: batchId, action: 'recalculated', new_batch_id: r.id });
    }
  }
  return out;
}

async function generateInTx(conn, req, scope, extraIn = {}) {
  let extra = extraIn;
  let moved = [];
  if (scope.take_from_drafts && !extra.supersedes_batch_id) moved = await takeFromDrafts(conn, req, scope);
  const blockers = await P.blockers(conn, { ...scope, exclude_batch_id: extra.supersedes_batch_id });
  const blocking = blockers.filter((b) => b.blocking);
  const hard = blocking.find((b) => b.code === 'MONTHLY_MULTI_SITE'); // wrong hours due: never accepted
  if (hard) throw AppError.conflict('MONTHLY_MULTI_SITE', hard.message, { blockers: [hard] });
  if (blocking.length && !scope.accept_blockers) {
    throw AppError.conflict('BLOCKERS_PRESENT', 'Some rows of this scope cannot be invoiced yet. Fix them or confirm with accept_blockers = true.', { blockers: blocking });
  }
  const acceptReason = (scope.accept_reason || extra.supersede_reason || '').trim();
  if (blocking.length && acceptReason.length < 5) {
    throw AppError.validation({ accept_reason: 'say why the invoice is generated while some rows cannot be invoiced yet (at least 5 characters)' });
  }
  if (blocking.length) extra = { ...extra, accept_reason: `${blocking.map((b) => b.code).join(', ')}: ${acceptReason}`.slice(0, 500) };
  const { items: all, warnings } = await P.calculate(conn, { ...scope, lock: true, exclude_batch_id: extra.supersedes_batch_id });
  const items = pickCurrency(all, scope.currency);
  if (!items.length) throw AppError.conflict('NOTHING_TO_PAY', 'Nothing to invoice in this scope and period.');
  // 14 Oct 2026: a machine is never in two active invoices over the same days
  const overlaps = await overlapsFor(conn, {
    equipmentIds: coveredMachines(scope, items), start: scope.start_date, end: scope.end_date, siteId: scope.site_id || null,
    excludeBatchIds: extra.supersedes_batch_id ? [extra.supersedes_batch_id] : [], lockRows: true,
  });
  if (overlaps.length) throw overlapError(overlaps);
  const id = await persistBatch(conn, req, scope, items, extra);
  for (const m of moved) warnings.push({ code: m.action === 'voided' ? 'DRAFT_VOIDED' : 'DRAFT_RECALCULATED', ...m,
    message: m.action === 'voided' ? `Draft #${m.eq_batch_id} was deleted (its machines moved here).` : `Draft #${m.eq_batch_id} was recalculated without the machines moved here (new #${m.new_batch_id}).` });
  const negative = items.filter((i) => i.net_cents < 0).map((i) => i.equipment_id);
  if (negative.length) warnings.push({ code: 'NEGATIVE_NET', equipment_ids: negative });
  return { id, warnings, accepted_blockers: blocking.map((b) => b.code) };
}

/** Only the Admin decides that extra hours cover missing hours (12 Oct 2026). */
function assertOffsetsAllowed(req, offsets) {
  if (offsets && offsets.length && req.user.role !== 'Admin') {
    throw AppError.forbidden('OFFSET_ADMIN_ONLY', 'Only the Admin decides that extra hours cover missing hours. Generate without it; the Admin can decide on the draft.');
  }
}

exports.generate = async (req, res) => {
  const scope = await checkScope(pool, req.body);
  assertOffsetsAllowed(req, scope.offsets);
  const out = await withTransaction(async (conn) => {
    const r = await generateInTx(conn, req, scope);
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate', newValues: { scope, accepted_blockers: r.accepted_blockers },
      reason: r.accepted_blockers.length ? scope.accept_reason : null, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

async function loadBatch(conn, id, lockRow = false) {
  const [rows] = await conn.execute(`SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?${lockRow ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Invoice');
  return rows[0];
}
exports.loadBatch = loadBatch;

const isIssued = (b) => b.status === 'Generated' && Number(b.is_finalized) === 1;
const isDraft = (b) => b.status === 'Generated' && !Number(b.is_finalized);

// ======================================================================= official numbers
/**
 * Official numbers of a batch that no longer stands: kept, never reused, marked cancelled — its own numbers and the
 * numbers reserved for it anywhere in its version chain.
 */
async function cancelInvoices(conn, batchId, reason, userId) {
  const chain = await versionChainBack(conn, batchId);
  await conn.query(
    `INSERT IGNORE INTO eq_invoice_cancellations (invoice_id, reason, cancelled_by_user_id, cancelled_at)
     SELECT invoice_id, ?, ?, ? FROM eq_invoices WHERE kind IN ('Vendor','Machine','FuelDiff')
       AND (eq_batch_id = ? OR (eq_batch_id IN (?) AND status = 'Withdrawn'))`, [String(reason).slice(0, 500), userId, businessNow(), batchId, chain]);
}

/** This batch and the versions it replaces (walking back supersedes_batch_id). */
async function versionChainBack(conn, batchId) {
  const ids = []; let cur = batchId;
  while (cur && !ids.includes(cur)) {
    ids.push(cur);
    const [[b]] = await conn.execute('SELECT supersedes_batch_id FROM eq_payroll_batches WHERE eq_batch_id = ?', [cur]);
    cur = b ? b.supersedes_batch_id : null;
  }
  return ids;
}

/** Numbers reserved (Withdrawn) in this batch's version chain and not cancelled: they are given back when it is issued. */
async function withdrawnInChain(conn, batchId) {
  const chain = await versionChainBack(conn, batchId);
  const [rows] = await conn.query(
    `SELECT i.* FROM eq_invoices i LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id
     WHERE i.eq_batch_id IN (?) AND i.status = 'Withdrawn' AND c.invoice_id IS NULL AND i.kind IN ('Vendor','Machine','FuelDiff')
     ORDER BY i.invoice_id FOR UPDATE`, [chain]);
  return rows;
}

/** The numbers of an issued batch are reserved (Withdrawn) for its next calculation (same invoice, same numbers). */
async function withdrawInvoices(conn, batchId) {
  await conn.execute(
    `UPDATE eq_invoices i LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id SET i.status = 'Withdrawn'
     WHERE i.eq_batch_id = ? AND i.kind IN ('Vendor','Machine','FuelDiff') AND c.invoice_id IS NULL`, [batchId]);
}

const INVOICE_PREFIX = { Vendor: 'VI', Machine: 'MI', FuelDiff: 'FD', DebitNote: 'DN', CreditNote: 'CN', Handover: 'HO', Withdrawal: 'WD' };

/** Next number of a sequence (kind + year), never reused. */
async function nextNo(conn, kind, year) {
  await conn.execute('INSERT IGNORE INTO eq_invoice_counters (kind, year, last_seq) VALUES (?, ?, 0)', [kind, year]);
  const [[c]] = await conn.execute('SELECT last_seq FROM eq_invoice_counters WHERE kind = ? AND year = ? FOR UPDATE', [kind, year]);
  const seq = Number(c.last_seq) + 1;
  await conn.execute('UPDATE eq_invoice_counters SET last_seq = ? WHERE kind = ? AND year = ?', [seq, kind, year]);
  return { seq, no: `${INVOICE_PREFIX[kind]}-${year}-${String(seq).padStart(5, '0')}` };
}
exports.nextNo = nextNo;

/**
 * Official numbers given when a batch is issued: one vendor invoice per vendor, one machine invoice per item, and one
 * fuel-difference statement per item with a fuel price difference. A number reserved in this version chain (the same
 * invoice brought up to date) is given back to the same vendor (and machine) first; what is left reserved afterwards
 * belongs to a machine that left the invoice and is cancelled.
 */
async function issueInvoices(conn, batchId, currency, now, userId = null) {
  const year = Number(String(now).slice(0, 4));
  const reserved = await withdrawnInChain(conn, batchId);
  const takeReserved = (kind, vendorId, equipmentId) => {
    const k = reserved.findIndex((x) => x.kind === kind && x.vendor_id === vendorId && (kind === 'Vendor' || x.equipment_id === equipmentId));
    return k < 0 ? null : reserved.splice(k, 1)[0];
  };
  const [items] = await conn.execute('SELECT eq_item_id, equipment_id, vendor_id, net_amount FROM eq_payroll_items WHERE eq_batch_id = ? ORDER BY vendor_id, eq_item_id', [batchId]);
  const [fd] = await conn.execute(
    `SELECT l.eq_item_id, SUM(l.amount) AS amount FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     WHERE i.eq_batch_id = ? AND l.line_type = 'FuelPriceDifference' GROUP BY l.eq_item_id`, [batchId]);
  const insert = async (kind, vendorId, equipmentId, itemId, amount) => {
    const back = takeReserved(kind, vendorId, equipmentId);
    if (back) {
      await conn.execute(
        "UPDATE eq_invoices SET eq_batch_id = ?, eq_item_id = ?, currency = ?, amount = ?, status = 'Issued', reissued_at = ? WHERE invoice_id = ?",
        [batchId, itemId, currency, amount, now, back.invoice_id]);
      return;
    }
    const n = await nextNo(conn, kind, year);
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
  for (const w of reserved) {
    await conn.execute('INSERT IGNORE INTO eq_invoice_cancellations (invoice_id, reason, cancelled_by_user_id, cancelled_at) VALUES (?, ?, ?, ?)',
      [w.invoice_id, `Not in invoice batch #${batchId} any more (the machine / vendor left the invoice)`, userId, now]);
  }
}

// ======================================================================= checks before issue / hand-over
/** Rows of the batch's period not approved yet (Draft, Submitted, Rejected): they must be approved or rejected first. */
async function notApprovedOf(conn, batch, scopeOverride = {}) {
  const scope = { ...(await P.batchScope(conn, batch)), ...scopeOverride, exclude_batch_id: batch.eq_batch_id };
  const list = await P.blockers(conn, scope);
  return list.find((b) => b.code === 'NOT_APPROVED') || null;
}

function notApprovedError(b, what) {
  return AppError.conflict('ROWS_NOT_APPROVED', `${b.count} attendance row(s) of this period are not approved yet. Approve or reject them before ${what}.`, { blockers: [b] });
}
exports.notApprovedOf = notApprovedOf;
exports.notApprovedError = notApprovedError;

/**
 * Monthly machines (12 Oct 2026): the invoices of one machine in one month are linked (extra hours, cover, overtime
 * are counted on the whole month). Changing or cancelling an earlier one changes the later ones: refused while a later
 * one of the same month is handed over to finance (or withdrawn, for a non-Admin).
 */
async function assertMonthLinkFree(conn, batch) {
  const [items] = await conn.execute("SELECT DISTINCT equipment_id FROM eq_payroll_items WHERE eq_batch_id = ? AND billing_mode = 'Monthly'", [batch.eq_batch_id]);
  if (!items.length) return;
  const monthEnd = `${day(batch.end_date).slice(0, 7)}-31`;
  const [rows] = await conn.query(
    `SELECT DISTINCT b.eq_batch_id, b.status, b.is_finalized, b.start_date, b.end_date, ${INVOICE_NO} AS invoice_no
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.equipment_id IN (?) AND i.billing_mode = 'Monthly' AND ${lock.ACTIVE} AND b.eq_batch_id <> ?
       AND b.start_date > ? AND b.start_date <= ?`,
    [items.map((x) => x.equipment_id), batch.eq_batch_id, day(batch.end_date), monthEnd]);
  const b = rows.find((x) => lock.denies(x));
  if (b) {
    throw AppError.conflict('MONTH_LINKED', `A later invoice of the same month for a monthly machine (${b.invoice_no || `#${b.eq_batch_id}`}, ${day(b.start_date)} to ${day(b.end_date)}) `
      + 'is handed over to finance: the month is counted as a whole, so this invoice cannot change. Withdraw that invoice first, or make a debit / credit note.',
    { eq_batch_id: b.eq_batch_id, invoice_no: b.invoice_no || null });
  }
}
exports.assertMonthLinkFree = assertMonthLinkFree;

// ======================================================================= detail / list
/** What the current role may do on this batch now (the app shows these buttons; the server checks again). */
function actionsFor(b, role) {
  const st = lock.stateOf(b);
  const office = role === 'Admin' || role === 'Accountant';
  const admin = role === 'Admin';
  return {
    recalculate: st === 'draft' && office,
    delete_draft: st === 'draft' && office,
    issue: st === 'draft' && office,
    refresh: st === 'issued' && office,
    cancel: (st === 'issued' || st === 'returned') && admin,
    hand_over: (st === 'issued' || st === 'returned') && admin,
    withdraw: st === 'handed_over' && admin,
    reissue: st === 'returned' && admin,
    notes: (st === 'issued' || st === 'handed_over' || st === 'returned') && office,
  };
}

async function batchDetail(conn, id, { withDrift = true } = {}) {
  const batch = await loadBatch(conn, id);
  const [items] = await conn.execute(
    `SELECT i.*, e.equipment_code, e.machine_label, t.type_name, vd.vendor_name, vd.vendor_code, s.site_code, s.site_name
     FROM eq_payroll_items i JOIN eq_equipment e ON e.equipment_id = i.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     JOIN eq_vendors vd ON vd.vendor_id = i.vendor_id JOIN sites s ON s.site_id = i.site_id
     WHERE i.eq_batch_id = ? ORDER BY vd.vendor_name, e.equipment_code, s.site_code`, [id]);
  const [lines] = await conn.execute(
    'SELECT l.* FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id WHERE i.eq_batch_id = ? ORDER BY l.eq_line_id', [id]);
  const byItem = {};
  for (const l of lines) (byItem[l.eq_item_id] = byItem[l.eq_item_id] || []).push(l);
  const [[u]] = await conn.execute('SELECT full_name FROM users WHERE user_id = ?', [batch.generated_by_user_id]);
  const state = lock.stateOf(batch);
  // a draft shows what changed; an issued invoice is brought up to date silently (the app calls /refresh)
  const reasons = withDrift && (state === 'draft' || state === 'issued' || state === 'returned') ? await P.batchDrift(conn, batch) : [];
  const [invoices] = await conn.execute(
    `SELECT i.*, c.reason AS cancel_reason, c.cancelled_at, (c.invoice_id IS NOT NULL) AS cancelled
     FROM eq_invoices i LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id WHERE i.eq_batch_id = ? ORDER BY i.kind, i.seq`, [id]);
  for (const x of invoices) x.cancelled = Boolean(Number(x.cancelled));
  const allocSites = [...new Set(items.flatMap((i) => ((P.parseJson(i.rate_snapshot) || {}).site_allocation || []).map((a) => a.site_id)))];
  const [sc] = allocSites.length ? await conn.query('SELECT site_id, site_code FROM sites WHERE site_id IN (?)', [allocSites]) : [[]];
  const siteCode = Object.fromEntries(sc.map((x) => [x.site_id, x.site_code]));
  const [chosen] = await conn.execute(
    `SELECT m.equipment_id, e.equipment_code, e.machine_label, e.plate_number FROM eq_payroll_batch_machines m JOIN eq_equipment e ON e.equipment_id = m.equipment_id
     WHERE m.eq_batch_id = ? ORDER BY e.equipment_code`, [id]);
  let handover = null;
  if (batch.handover_id) {
    const [[ho]] = await conn.execute(
      'SELECT h.handover_id, h.handover_no, h.handed_on, h.receiver_name, u.full_name AS by_name FROM eq_handovers h JOIN users u ON u.user_id = h.created_by_user_id WHERE h.handover_id = ?',
      [batch.handover_id]);
    handover = ho || null;
  }
  let withdrawal = null;
  if (batch.withdrawal_id) {
    const [[wd]] = await conn.execute(
      'SELECT w.*, u.full_name AS by_name FROM eq_withdrawals w JOIN users u ON u.user_id = w.created_by_user_id WHERE w.withdrawal_id = ?', [batch.withdrawal_id]);
    withdrawal = wd ? { ...wd, was_paid: Boolean(Number(wd.was_paid)) } : null;
  }
  const [notes] = await conn.query(
    `SELECT n.*, e.equipment_code, e.machine_label FROM eq_notes n LEFT JOIN eq_equipment e ON e.equipment_id = n.equipment_id
     WHERE n.ref_batch_id IN (?) AND n.status <> 'Cancelled' ORDER BY n.note_id`, [await versionChainBack(conn, id)]);
  let replacedBy = null;
  if (batch.replaced_by_batch_id) {
    const [[r]] = await conn.execute(
      "SELECT invoice_no FROM eq_invoices WHERE eq_batch_id = ? AND kind = 'Vendor' AND status = 'Issued' ORDER BY invoice_id LIMIT 1", [batch.replaced_by_batch_id]);
    replacedBy = { eq_batch_id: batch.replaced_by_batch_id, invoice_no: r ? r.invoice_no : null };
  }
  let replaces = null;
  if (batch.supersedes_batch_id) {
    const [[prev]] = await conn.execute('SELECT eq_batch_id, status FROM eq_payroll_batches WHERE eq_batch_id = ?', [batch.supersedes_batch_id]);
    if (prev && prev.status === 'Replaced') {
      const [[r]] = await conn.execute("SELECT invoice_no FROM eq_invoices WHERE eq_batch_id = ? AND kind = 'Vendor' ORDER BY invoice_id LIMIT 1", [prev.eq_batch_id]);
      replaces = { eq_batch_id: prev.eq_batch_id, invoice_no: r ? r.invoice_no : null };
    }
  }
  const live = (x) => !x.cancelled && x.status !== 'Withdrawn';
  const vendorInvoices = invoices.filter((x) => live(x) && x.kind === 'Vendor');
  const me = currentUser();
  return {
    ...batch, settings_snapshot: P.parseJson(batch.settings_snapshot) || null, is_finalized: Boolean(Number(batch.is_finalized)),
    state, offset_months: P.normalizeOffsets(P.parseJson(batch.offset_months) || []),
    scope_machines: chosen,
    generated_by: u ? u.full_name : null,
    // draft: "Recalculate"; issued: brought up to date with the same numbers (the app calls /refresh by itself)
    stale: reasons.length > 0, needs_refresh: state === 'issued' && reasons.length > 0, stale_reasons: reasons,
    invoices, vendor_invoice_no: vendorInvoices.map((x) => x.invoice_no).join(', ') || null,
    handover, withdrawal, notes, replaced_by: replacedBy, replaces,
    actions: actionsFor(batch, me ? me.role : 'Admin'),
    items: items.map((i) => {
      const snap = P.parseJson(i.rate_snapshot) || {};
      const inv = (kind) => (invoices.find((x) => live(x) && x.kind === kind && x.eq_item_id === i.eq_item_id) || {}).invoice_no || null;
      return {
        ...i, ...(snap.labels || {}), rate_snapshot: snap, lines: byItem[i.eq_item_id] || [],
        fuel_difference: (byItem[i.eq_item_id] || []).filter((l) => l.line_type === 'FuelPriceDifference').reduce((a, l) => a + Number(l.amount), 0).toFixed(2),
        site_allocation: snap.site_allocation ? snap.site_allocation.map((a) => ({ site_id: a.site_id, site_code: siteCode[a.site_id], hours: a.hours, share_pct: a.share_pct, amount: (a.amount_cents / 100).toFixed(2) })) : null,
        invoice_no: inv('Machine'), fuel_invoice_no: inv('FuelDiff'),
        vendor_invoice_no: (vendorInvoices.find((x) => x.vendor_id === i.vendor_id) || {}).invoice_no || null,
      };
    }),
  };
}
exports.batchDetail = batchDetail;

const STATE_FILTER = {
  Draft: "b.status = 'Generated' AND b.is_finalized = 0",
  Issued: "b.status = 'Generated' AND b.is_finalized = 1",
  HandedOver: "b.status = 'HandedOver'",
  Returned: "b.status = 'Returned'",
  Cancelled: "b.status = 'Voided'",
  Replaced: "b.status = 'Replaced'",
  Active: lock.ACTIVE,
};

exports.list = async (req, res) => {
  const where = ["b.status <> 'Superseded'"]; const params = [];
  const f = (c, ...vals) => { where.push(c); params.push(...vals); };
  const state = String(req.query.state || '');
  if (STATE_FILTER[state]) where.push(STATE_FILTER[state]);
  if (req.query.vendor_id) f('(b.scope_vendor_id = ? OR EXISTS (SELECT 1 FROM eq_payroll_items i WHERE i.eq_batch_id = b.eq_batch_id AND i.vendor_id = ?))', Number(req.query.vendor_id), Number(req.query.vendor_id));
  if (req.query.equipment_id) f('EXISTS (SELECT 1 FROM eq_invoice_coverage c WHERE c.eq_batch_id = b.eq_batch_id AND c.equipment_id = ?)', Number(req.query.equipment_id));
  if (req.query.from) f('b.end_date >= ?', String(req.query.from));
  if (req.query.to) f('b.start_date <= ?', String(req.query.to));
  if (req.query.q) {
    const t = `%${String(req.query.q).trim()}%`;
    f(`(EXISTS (SELECT 1 FROM eq_invoices x WHERE x.eq_batch_id = b.eq_batch_id AND x.invoice_no LIKE ?)
        OR EXISTS (SELECT 1 FROM eq_invoice_coverage c JOIN eq_equipment e ON e.equipment_id = c.equipment_id WHERE c.eq_batch_id = b.eq_batch_id AND (e.equipment_code LIKE ? OR e.machine_label LIKE ?)))`, t, t, t);
  }
  const [rows] = await pool.query(
    `SELECT b.*, vd.vendor_name AS scope_vendor_name, e.equipment_code AS scope_equipment_code, s.site_code AS scope_site_code, u.full_name AS generated_by,
       (SELECT COUNT(*) FROM eq_payroll_batch_machines m WHERE m.eq_batch_id = b.eq_batch_id) AS scope_machine_count,
       ${INVOICE_NO} AS vendor_invoice_no,
       (SELECT h.handover_no FROM eq_handovers h WHERE h.handover_id = b.handover_id) AS handover_no
     FROM eq_payroll_batches b LEFT JOIN eq_vendors vd ON vd.vendor_id = b.scope_vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = b.scope_equipment_id
     LEFT JOIN sites s ON s.site_id = b.scope_site_id JOIN users u ON u.user_id = b.generated_by_user_id
     WHERE ${where.join(' AND ')} ORDER BY b.start_date DESC, b.eq_batch_id DESC LIMIT 500`, params);
  res.json({ status: 'success', data: rows.map((r) => ({ ...r, is_finalized: Number(r.is_finalized) === 1, state: lock.stateOf(r) })) });
};

/**
 * Invoice register (14 Oct 2026): per vendor, its invoices (newest period first) with their machine invoices and the
 * debit / credit notes linked to each, then the vendor's general notes. Filters: vendor_id, equipment_id, from, to,
 * state, q (a number or a machine). Internal versions (Superseded) are never listed.
 */
exports.register = async (req, res) => {
  const q = validate(req.query, { vendor_id: v.id(), equipment_id: v.id(), from: v.date(), to: v.date(), state: v.string({ max: 20 }), q: v.string({ max: 60 }) });
  const where = ["b.status <> 'Superseded'"]; const params = [];
  if (STATE_FILTER[q.state]) where.push(STATE_FILTER[q.state]);
  if (q.vendor_id) { where.push('i.vendor_id = ?'); params.push(q.vendor_id); }
  if (q.equipment_id) { where.push('EXISTS (SELECT 1 FROM eq_payroll_items i2 WHERE i2.eq_batch_id = b.eq_batch_id AND i2.vendor_id = i.vendor_id AND i2.equipment_id = ?)'); params.push(q.equipment_id); }
  if (q.from) { where.push('b.end_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('b.start_date <= ?'); params.push(q.to); }
  if (q.q) {
    const t = `%${q.q}%`;
    where.push(`(EXISTS (SELECT 1 FROM eq_invoices x WHERE x.eq_batch_id = b.eq_batch_id AND x.vendor_id = i.vendor_id AND x.invoice_no LIKE ?)
      OR EXISTS (SELECT 1 FROM eq_notes n WHERE n.ref_batch_id = b.eq_batch_id AND n.note_no LIKE ?)
      OR EXISTS (SELECT 1 FROM eq_payroll_items i3 JOIN eq_equipment e3 ON e3.equipment_id = i3.equipment_id WHERE i3.eq_batch_id = b.eq_batch_id AND i3.vendor_id = i.vendor_id AND (e3.equipment_code LIKE ? OR e3.machine_label LIKE ?)))`);
    params.push(t, t, t, t);
  }
  const [rows] = await pool.query(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.currency, b.status, b.is_finalized, b.version_number, b.finalized_at, b.handed_over_at, b.returned_at,
       b.replaced_by_batch_id, b.supersedes_batch_id, i.vendor_id, vd.vendor_name, vd.vendor_code,
       COUNT(DISTINCT i.equipment_id) AS machines, SUM(i.gross_amount) AS gross, SUM(i.deductions_amount) AS deductions, SUM(i.net_amount) AS net,
       (SELECT h.handover_no FROM eq_handovers h WHERE h.handover_id = b.handover_id) AS handover_no,
       (SELECT h.handed_on FROM eq_handovers h WHERE h.handover_id = b.handover_id) AS handed_on
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id JOIN eq_vendors vd ON vd.vendor_id = i.vendor_id
     WHERE ${where.join(' AND ')}
     GROUP BY b.eq_batch_id, i.vendor_id ORDER BY vd.vendor_name, b.start_date DESC, b.eq_batch_id DESC LIMIT 1000`, params);
  const batchIds = [...new Set(rows.map((r) => r.eq_batch_id))];
  const [nums] = batchIds.length ? await pool.query(
    `SELECT x.eq_batch_id, x.vendor_id, x.kind, x.invoice_no, x.amount, x.equipment_id, e.equipment_code, e.machine_label, (c.invoice_id IS NOT NULL) AS cancelled, x.status
     FROM eq_invoices x LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id LEFT JOIN eq_equipment e ON e.equipment_id = x.equipment_id
     WHERE x.eq_batch_id IN (?) AND x.kind IN ('Vendor','Machine','FuelDiff') ORDER BY x.kind DESC, x.invoice_no`, [batchIds]) : [[]];
  const vendorIds = [...new Set(rows.map((r) => r.vendor_id).concat(q.vendor_id ? [q.vendor_id] : []))];
  const [notes] = vendorIds.length ? await pool.query(
    `SELECT n.*, e.equipment_code, e.machine_label FROM eq_notes n LEFT JOIN eq_equipment e ON e.equipment_id = n.equipment_id
     WHERE n.vendor_id IN (?) ${q.equipment_id ? 'AND (n.equipment_id = ? OR n.equipment_id IS NULL)' : ''} ORDER BY n.note_date DESC, n.note_id DESC`,
    q.equipment_id ? [vendorIds, q.equipment_id] : [vendorIds]) : [[]];
  // a note linked to an older calculation of an invoice follows the invoice
  const [links] = await pool.query('SELECT eq_batch_id, supersedes_batch_id FROM eq_payroll_batches WHERE supersedes_batch_id IS NOT NULL');
  const nextOf = new Map(links.map((l) => [l.supersedes_batch_id, l.eq_batch_id]));
  const listed = new Set(batchIds);
  const finalRef = (id) => {
    let cur = id; const seen = new Set();
    while (cur && !listed.has(cur) && nextOf.has(cur) && !seen.has(cur)) { seen.add(cur); cur = nextOf.get(cur); }
    return cur;
  };
  const out = new Map();
  for (const r of rows) {
    const vgrp = out.get(r.vendor_id) || { vendor_id: r.vendor_id, vendor_name: r.vendor_name, vendor_code: r.vendor_code, invoices: [], general_notes: [] };
    const mine = nums.filter((x) => x.eq_batch_id === r.eq_batch_id && x.vendor_id === r.vendor_id && x.status === 'Issued');
    const vi = mine.find((x) => x.kind === 'Vendor');
    vgrp.invoices.push({
      eq_batch_id: r.eq_batch_id, state: lock.stateOf(r), start_date: day(r.start_date), end_date: day(r.end_date), currency: r.currency,
      version_number: r.version_number, machines: Number(r.machines), gross: r.gross, deductions: r.deductions, net: r.net,
      vendor_invoice_no: vi ? vi.invoice_no : null, cancelled: vi ? Boolean(Number(vi.cancelled)) : false,
      machine_invoices: mine.filter((x) => x.kind === 'Machine').map((x) => ({ invoice_no: x.invoice_no, equipment_id: x.equipment_id, equipment_code: x.equipment_code, machine_label: x.machine_label, amount: x.amount })),
      fuel_statements: mine.filter((x) => x.kind === 'FuelDiff').map((x) => ({ invoice_no: x.invoice_no, equipment_code: x.equipment_code, amount: x.amount })),
      issued_at: r.finalized_at, handover_no: r.handover_no, handed_on: day(r.handed_on), returned_at: r.returned_at,
      replaced_by_batch_id: r.replaced_by_batch_id,
      notes: notes.filter((n) => n.vendor_id === r.vendor_id && n.ref_batch_id && finalRef(n.ref_batch_id) === r.eq_batch_id),
    });
    out.set(r.vendor_id, vgrp);
  }
  for (const n of notes) {
    if (n.ref_batch_id && listed.has(finalRef(n.ref_batch_id))) continue;
    if (q.state || q.from || q.to || q.q) continue; // general notes are listed only without filters on invoices
    const vgrp = out.get(n.vendor_id) || { vendor_id: n.vendor_id, vendor_name: null, vendor_code: null, invoices: [], general_notes: [] };
    if (!vgrp.vendor_name) {
      const [[vd]] = await pool.query('SELECT vendor_name, vendor_code FROM eq_vendors WHERE vendor_id = ?', [n.vendor_id]);
      Object.assign(vgrp, vd || {});
    }
    vgrp.general_notes.push(n);
    out.set(n.vendor_id, vgrp);
  }
  res.json({ status: 'success', data: [...out.values()].sort((a, b) => String(a.vendor_name).localeCompare(String(b.vendor_name))) });
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
    `SELECT s.*, i.equipment_id, e.equipment_code, e.machine_label, i.site_id FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     JOIN eq_equipment e ON e.equipment_id = i.equipment_id WHERE s.eq_batch_id = ?${extra} ORDER BY e.equipment_code, s.record_date`, params);
  res.json({ status: 'success', data: rows });
};

// ======================================================================= issue
/**
 * Manual changes this batch pays, shown to the person who issues it: rows edited after approval, late entries, manual
 * adjustments, standby hours decided, fuel issues / rate cards / delivery notes changed after creation, accepted blockers,
 * monthly exceptions and offsets.
 */
async function reviewSummaryOf(conn, batch) {
  const id = batch.eq_batch_id;
  const items = [];
  const [edited] = await conn.query(
    `SELECT a.eq_attendance_id, a.record_date, a.sheet_row_no, e.equipment_code, a.admin_edit_reason, a.admin_edit_at, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.admin_edit_by_user_id WHERE s.eq_batch_id = ? AND a.edited_after_approval = 1 ORDER BY a.record_date`, [id]);
  for (const r of edited) items.push({ kind: 'edited_after_approval', ref: `${r.equipment_code} ${day(r.record_date)} row #${r.sheet_row_no}`, by: r.by_name, at: r.admin_edit_at, reason: r.admin_edit_reason });
  const [late] = await conn.query(
    `SELECT a.record_date, a.sheet_row_no, a.late_entry_days, a.late_entry_reason, e.equipment_code, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.recorded_by_user_id WHERE s.eq_batch_id = ? AND a.late_entry = 1 ORDER BY a.record_date`, [id]);
  for (const r of late) items.push({ kind: 'late_entry', ref: `${r.equipment_code} ${day(r.record_date)} row #${r.sheet_row_no} (${r.late_entry_days} days late)`, by: r.by_name, reason: r.late_entry_reason });
  const [credits] = await conn.query(
    `SELECT a.record_date, e.equipment_code, a.standby_credit_minutes, a.standby_credit_note, a.standby_credit_at, u.full_name AS by_name
     FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     LEFT JOIN users u ON u.user_id = a.standby_credit_by_user_id WHERE s.eq_batch_id = ? AND s.standby_credit_minutes IS NOT NULL ORDER BY a.record_date`, [id]);
  for (const r of credits) items.push({ kind: 'standby_hours', ref: `${r.equipment_code} ${day(r.record_date)}: ${(Number(r.standby_credit_minutes) / 60).toFixed(2)} h`, by: r.by_name, at: r.standby_credit_at, reason: r.standby_credit_note });
  const [adj] = await conn.query(
    `SELECT ad.adjustment_id, ad.adjustment_type, ad.amount, ad.currency, ad.reason, ad.created_at, e.equipment_code, u.full_name AS by_name
     FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_adjustments ad ON ad.adjustment_id = l.source_id
     JOIN eq_equipment e ON e.equipment_id = ad.equipment_id LEFT JOIN users u ON u.user_id = ad.created_by_user_id
     WHERE i.eq_batch_id = ? AND l.source_table = 'eq_adjustments' ORDER BY ad.adjustment_id`, [id]);
  for (const r of adj) items.push({ kind: 'adjustment', ref: `${r.equipment_code} ${r.adjustment_type} ${Number(r.amount).toFixed(2)} ${r.currency}`, by: r.by_name, at: r.created_at, reason: r.reason });
  const [fuel] = await conn.query(
    `SELECT DISTINCT f.fuel_issue_id, f.issue_date, e.equipment_code FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     JOIN eq_fuel_issues f ON f.fuel_issue_id = l.source_id JOIN eq_equipment e ON e.equipment_id = f.equipment_id
     WHERE i.eq_batch_id = ? AND l.source_table = 'eq_fuel_issues'
       AND EXISTS (SELECT 1 FROM audit_logs x WHERE x.table_name = 'eq_fuel_issues' AND x.record_id = f.fuel_issue_id AND x.action_type = 'update')`, [id]);
  for (const r of fuel) items.push({ kind: 'fuel_changed', ref: `${r.equipment_code} fuel issue #${r.fuel_issue_id} (${day(r.issue_date)}) changed after it was recorded` });
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
  for (const r of dns) items.push({ kind: 'delivery_note_changed', ref: `${r.equipment_code} delivery note ${r.dn_number} (${day(r.note_date)}) changed after it was recorded` });
  if (batch.accept_blockers_reason) items.push({ kind: 'accepted_blockers', ref: batch.accept_blockers_reason });
  const [monthly] = await conn.query(
    `SELECT i.rate_snapshot, e.equipment_code FROM eq_payroll_items i JOIN eq_equipment e ON e.equipment_id = i.equipment_id
     WHERE i.eq_batch_id = ? AND i.billing_mode = 'Monthly' ORDER BY e.equipment_code`, [id]);
  for (const m of monthly) {
    const snap = P.parseJson(m.rate_snapshot) || {};
    for (const t of snap.monthly_terms || []) {
      const parts = [];
      if (t.amount_source === 'manual') parts.push(`amount ${Number(t.amount).toFixed(2)}`);
      if (t.divisor_source === 'manual') parts.push(`divided by ${t.divisor} days`);
      if (t.hourly_source === 'manual') parts.push(`hourly price ${Number(t.hourly).toFixed(2)}`);
      if (parts.length) items.push({ kind: 'monthly_exception', ref: `${m.equipment_code} ${t.month}: ${parts.join(', ')}` });
    }
    for (const x of snap.monthly_calc || []) {
      const h = (val) => Number(val || 0).toFixed(2);
      if (Number(x.offset_hours) !== 0) {
        items.push({ kind: 'monthly_offset', ref: `${m.equipment_code} ${x.month}: ${h(x.offset_hours)} h of extra hours cover missing hours (${h(x.month_missing_hours)} h missing in the month)` });
      } else if (Number(x.offset_possible_hours) > 0) {
        items.push({ kind: 'monthly_offset_not_used', ref: `${m.equipment_code} ${x.month}: ${h(x.offset_possible_hours)} h of extra hours could cover missing hours and are NOT used`
          + `${x.overtime_paid ? ' (paid as overtime instead)' : ' (kept unpaid for a later invoice of the month)'}` });
      }
    }
  }
  return { eq_batch_id: id, items };
}

exports.reviewSummary = async (req, res) => {
  const id = parseId(req.params.id);
  const b = await loadBatch(pool, id);
  res.json({ status: 'success', data: await reviewSummaryOf(pool, b) });
};

async function assertMayIssue(req) {
  if (req.user.role === 'Accountant' && await settings.getBool('payroll_finalize_admin_only')) {
    throw AppError.forbidden('FORBIDDEN_ROLE', 'Only an Admin may issue invoices (setting payroll_finalize_admin_only).');
  }
}

/**
 * Issue a draft: official numbers (VI, MI, FD). Refused while rows of the period are not approved (approve or reject
 * them first: the app lists them with the buttons), while the draft must be recalculated, or before the period ends.
 */
exports.finalize = async (req, res) => {
  const id = parseId(req.params.id);
  await assertMayIssue(req);
  const { acknowledge_changes: ack } = validate(req.body || {}, { acknowledge_changes: v.bool({ default: false }) });
  await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    if (!isDraft(b)) throw AppError.conflict('BATCH_STATE', 'Only a draft can be issued.');
    if (day(b.end_date) > businessToday()) throw AppError.conflict('PERIOD_NOT_ENDED', `The period ends on ${day(b.end_date)}: an invoice is issued once its period has ended (keep it as a draft until then).`);
    const drift = await P.batchDrift(conn, b);
    if (drift.length) throw AppError.conflict('BATCH_STALE', 'Something that changes the amounts changed after this draft was calculated. Recalculate it first.', { reasons: drift });
    const na = await notApprovedOf(conn, b);
    if (na) throw notApprovedError(na, 'issuing the invoice');
    const summary = await reviewSummaryOf(conn, b);
    if (summary.items.length && !ack) {
      throw AppError.conflict('CHANGES_NOT_ACKNOWLEDGED', `This invoice pays ${summary.items.length} manual change(s) (edits after approval, adjustments, standby hours, price changes...). Review them and confirm.`, summary);
    }
    const now = businessNow();
    await conn.execute('UPDATE eq_payroll_batches SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = ? WHERE eq_batch_id = ?', [req.user.user_id, now, id]);
    await issueInvoices(conn, id, b.currency, now, req.user.user_id);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'issue', newValues: { acknowledged_changes: summary.items.length }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await batchDetail(pool, id) });
};

// ======================================================================= new calculation of the same batch
/**
 * A new calculation (version) of a batch, inside the caller's transaction (the caller sets the old one's status).
 * The notes linked to the old version follow. Used by "Recalculate" (draft), the silent update of an issued invoice
 * (same numbers) and the re-issue of a returned one (new numbers).
 */
async function newVersion(conn, req, old, reason, acceptBlockers, scopeOverride = null) {
  const scope = { ...(await P.batchScope(conn, old)), ...(scopeOverride || {}), currency: old.currency, accept_blockers: acceptBlockers };
  // the open problems accepted on it stay accepted, with the same reason
  if (old.accept_blockers_reason) {
    scope.accept_blockers = true;
    scope.accept_reason = reason || String(old.accept_blockers_reason).replace(/^[A-Z_]+(, [A-Z_]+)*: /, '');
  }
  const r = await generateInTx(conn, req, scope, { version_number: Number(old.version_number) + 1, supersedes_batch_id: old.eq_batch_id, supersede_reason: reason || null });
  await conn.execute('UPDATE eq_notes SET ref_batch_id = ? WHERE ref_batch_id = ?', [r.id, old.eq_batch_id]);
  return r;
}

/** Draft: "Recalculate" (reason optional). */
async function doSupersede(conn, req, id, reason, acceptBlockers, scopeOverride = null) {
  const old = await loadBatch(conn, id, true);
  if (!isDraft(old)) throw AppError.conflict('BATCH_STATE', 'Only a draft is recalculated this way; an issued invoice is brought up to date by itself.');
  const r = await newVersion(conn, req, old, reason, acceptBlockers, scopeOverride);
  await conn.execute("UPDATE eq_payroll_batches SET status = 'Superseded' WHERE eq_batch_id = ?", [id]);
  await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'superseded', newValues: { by: r.id }, reason: reason || null, ...audit.ctx(req) });
  await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'generate_version', newValues: { supersedes: id }, reason: reason || null, ...audit.ctx(req) });
  return r;
}

const moneyOf = (rows) => rows.map((i) => ({ equipment_code: i.equipment_code, site_code: i.site_code, net: i.net_amount }));
const ITEM_MONEY = `SELECT i.net_amount, e.equipment_code, s.site_code FROM eq_payroll_items i JOIN eq_equipment e ON e.equipment_id = i.equipment_id
  JOIN sites s ON s.site_id = i.site_id WHERE i.eq_batch_id = ?`;

/**
 * Issued (not handed over): brought up to date with the SAME numbers (decisions of 13-14 Oct 2026). Nothing on the
 * invoice says it changed; the audit keeps who, when, why, the amounts before / after and what changed.
 * Returns { id, unchanged } — unchanged when nothing changed (no new version).
 */
async function doRefresh(conn, req, id, { reason = null, offsets = null } = {}) {
  const old = await loadBatch(conn, id, true);
  if (!isIssued(old)) {
    throw AppError.conflict('BATCH_STATE', old.status === 'HandedOver'
      ? 'This invoice is handed over to finance: withdraw it first (signed acknowledgement), or make a debit / credit note.'
      : 'Only an issued invoice is brought up to date this way.');
  }
  const was = P.normalizeOffsets(P.parseJson(old.offset_months) || []);
  const offsetsChange = offsets !== null && JSON.stringify(was) !== JSON.stringify(P.normalizeOffsets(offsets));
  const drift = await P.batchDrift(conn, old);
  if (!drift.length && !offsetsChange) return { id, unchanged: true, warnings: [] };
  await assertMonthLinkFree(conn, old);
  const na = await notApprovedOf(conn, old, offsetsChange ? { offsets } : {});
  if (na) throw notApprovedError(na, 'the invoice can be brought up to date');
  const [before] = await conn.execute(ITEM_MONEY, [id]);
  const why = reason || 'Brought up to date (data changed before the hand-over)';
  const r = await newVersion(conn, req, old, why, Boolean(old.accept_blockers_reason), offsetsChange ? { offsets } : null);
  await conn.execute("UPDATE eq_payroll_batches SET status = 'Superseded' WHERE eq_batch_id = ?", [id]);
  await withdrawInvoices(conn, id);
  // the same invoice: same numbers, same issue date and person
  await conn.execute('UPDATE eq_payroll_batches SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = ? WHERE eq_batch_id = ?',
    [old.finalized_by_user_id, old.finalized_at, r.id]);
  await issueInvoices(conn, r.id, old.currency, businessNow(), req.user.user_id);
  const [after] = await conn.execute(ITEM_MONEY, [r.id]);
  const [[nb]] = await conn.execute('SELECT total_net FROM eq_payroll_batches WHERE eq_batch_id = ?', [r.id]);
  const [nos] = await conn.execute("SELECT invoice_no FROM eq_invoices WHERE eq_batch_id = ? AND kind = 'Vendor' AND status = 'Issued'", [r.id]);
  await audit.log(conn, {
    table: 'eq_payroll_batches', id: r.id, action: 'invoice_updated', relatedType: 'eq_payroll_batches', relatedId: id,
    oldValues: { eq_batch_id: id, total_net: old.total_net, machines: moneyOf(before) },
    newValues: { eq_batch_id: r.id, total_net: nb.total_net, machines: moneyOf(after), invoice_no: nos.map((x) => x.invoice_no).join(', '), changes: drift.slice(0, 50), offsets: offsetsChange ? offsets : undefined },
    changedFields: { total_net: [old.total_net, nb.total_net] }, reason: why, ...audit.ctx(req),
  });
  return { id: r.id, unchanged: false, warnings: r.warnings };
}
exports.doRefresh = doRefresh;

/** Brings an issued invoice up to date if needed (own transaction). Returns the current batch id. */
async function ensureFresh(req, id) {
  const b = await loadBatch(pool, id);
  if (!isIssued(b)) return id;
  const drift = await P.batchDrift(pool, b);
  if (!drift.length) return id;
  const r = await withTransaction((conn) => doRefresh(conn, req, id));
  return r.id;
}
exports.ensureFresh = ensureFresh;

exports.refresh = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body || {}, { reason: v.string({ max: 500 }) });
  const r = await withTransaction((conn) => doRefresh(conn, req, id, { reason: d.reason || null }));
  res.json({ status: 'success', data: await batchDetail(pool, r.id), unchanged: r.unchanged, warnings: r.warnings });
};

/**
 * Admin: re-issue an invoice withdrawn from finance, with NEW numbers. The old one becomes Replaced (its numbers are
 * kept as cancelled, never reused); nothing is printed about it on the new invoice — the app shows the link.
 */
exports.reissue = async (req, res) => {
  const id = parseId(req.params.id);
  if (!isAdmin(req)) throw AppError.forbidden('ADMIN_ONLY', 'Only the Admin re-issues an invoice withdrawn from finance.');
  const d = validate(req.body || {}, { reason: v.string({ required: true, min: 3, max: 500 }) });
  const out = await withTransaction(async (conn) => {
    const old = await loadBatch(conn, id, true);
    if (old.status !== 'Returned') throw AppError.conflict('BATCH_STATE', 'Only an invoice withdrawn from finance is re-issued with new numbers.');
    await assertMonthLinkFree(conn, old);
    const na = await notApprovedOf(conn, old);
    if (na) throw notApprovedError(na, 're-issuing the invoice');
    const r = await newVersion(conn, req, old, d.reason, Boolean(old.accept_blockers_reason));
    const now = businessNow();
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Replaced', replaced_by_batch_id = ? WHERE eq_batch_id = ?", [r.id, id]);
    await cancelInvoices(conn, id, `Withdrawn from finance and re-issued as invoice batch #${r.id}: ${d.reason}`, req.user.user_id);
    await conn.execute('UPDATE eq_payroll_batches SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = ? WHERE eq_batch_id = ?', [req.user.user_id, now, r.id]);
    await issueInvoices(conn, r.id, old.currency, now, req.user.user_id);
    await audit.log(conn, { table: 'eq_payroll_batches', id, action: 'replaced', newValues: { by: r.id }, reason: d.reason, ...audit.ctx(req) });
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'reissue', oldValues: { eq_batch_id: id, total_net: old.total_net },
      newValues: { replaces: id }, reason: d.reason, relatedType: 'eq_payroll_batches', relatedId: id, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

// ======================================================================= cancel
/**
 * Cancels a batch (inside the caller's transaction). Draft: deleted (no number). Issued or returned: Admin, reason
 * required; its numbers are kept as cancelled. Handed over: refused (withdraw it from finance first).
 */
async function doVoid(conn, req, id, reason) {
  const b = await loadBatch(conn, id, true);
  const st = lock.stateOf(b);
  if (st === 'handed_over') throw AppError.conflict('INVOICE_HANDED_OVER', 'This invoice is handed over to finance: withdraw it first (signed acknowledgement).');
  if (!['draft', 'issued', 'returned'].includes(st)) throw AppError.conflict('BATCH_STATE', 'This invoice is already cancelled or replaced.');
  if (st !== 'draft') {
    if (!isAdmin(req)) throw AppError.forbidden('ADMIN_ONLY', 'Only the Admin cancels an issued invoice.');
    if (!reason || String(reason).trim().length < 3) throw AppError.validation({ reason: 'is required to cancel an issued invoice (at least 3 characters)' });
    await assertMonthLinkFree(conn, b);
  }
  await conn.execute("UPDATE eq_payroll_batches SET status = 'Voided', voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE eq_batch_id = ?", [req.user.user_id, businessNow(), reason || null, id]);
  await cancelInvoices(conn, id, `Invoice batch #${id} cancelled${reason ? `: ${reason}` : ''}`, req.user.user_id);
  await audit.log(conn, { table: 'eq_payroll_batches', id, action: st === 'draft' ? 'delete_draft' : 'cancel', reason: reason || null, ...audit.ctx(req) });
  return { id };
}

exports.void = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body || {}, { reason: v.string({ max: 500 }) });
  await withTransaction((conn) => doVoid(conn, req, id, (d.reason || '').trim() || null));
  res.json({ status: 'success', data: await batchDetail(pool, id, { withDrift: false }) });
};

/** Draft: "Recalculate" — a new version with the current data (reason optional). */
exports.supersede = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body || {}, { reason: v.string({ max: 500 }), accept_blockers: v.bool({ default: false }) });
  const out = await withTransaction((conn) => doSupersede(conn, req, id, (d.reason || '').trim() || null, d.accept_blockers));
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

/**
 * Admin: which monthly machines use their extra hours to cover missing hours (12 Oct 2026). A draft is recalculated;
 * an issued invoice is brought up to date with the same numbers.
 */
exports.setOffsets = async (req, res) => {
  const id = parseId(req.params.id);
  if (req.user.role !== 'Admin') throw AppError.forbidden('OFFSET_ADMIN_ONLY', 'Only the Admin decides that extra hours cover missing hours.');
  const d = validate(req.body || {}, { offsets: v.any(), reason: v.string({ max: 500 }) });
  const offsets = P.normalizeOffsets(d.offsets);
  const out = await withTransaction(async (conn) => {
    const b = await loadBatch(conn, id, true);
    const was = P.normalizeOffsets(P.parseJson(b.offset_months) || []);
    if (JSON.stringify(was) === JSON.stringify(offsets)) throw AppError.validation({ offsets: 'nothing changed' });
    const why = (d.reason || '').trim() || `extra hours ${offsets.length ? `cover missing hours: ${offsets.join(', ')}` : 'no longer cover missing hours'}`;
    let r;
    if (isDraft(b)) r = await doSupersede(conn, req, id, why, Boolean(b.accept_blockers_reason), { offsets });
    else if (isIssued(b)) r = await doRefresh(conn, req, id, { reason: why, offsets });
    else throw AppError.conflict('BATCH_STATE', 'The decision changes on a draft or an issued invoice only (withdraw a handed-over invoice first).');
    await audit.log(conn, { table: 'eq_payroll_batches', id: r.id, action: 'offset_decision', oldValues: { offsets: was }, newValues: { offsets }, reason: why, ...audit.ctx(req) });
    return r;
  });
  res.status(201).json({ status: 'success', data: await batchDetail(pool, out.id), warnings: out.warnings });
};

exports.versions = async (req, res) => {
  const id = parseId(req.params.id);
  const chain = [];
  let cur = await loadBatch(pool, id);
  while (cur.supersedes_batch_id) cur = await loadBatch(pool, cur.supersedes_batch_id);
  for (;;) {
    chain.push({ eq_batch_id: cur.eq_batch_id, version_number: cur.version_number, status: cur.status, state: lock.stateOf(cur), is_finalized: Boolean(Number(cur.is_finalized)),
      total_net: cur.total_net, generated_at: cur.generated_at, supersede_reason: cur.supersede_reason });
    const [[next]] = await pool.execute('SELECT * FROM eq_payroll_batches WHERE supersedes_batch_id = ?', [cur.eq_batch_id]);
    if (!next) break;
    cur = next;
  }
  res.json({ status: 'success', data: chain });
};

// ======================================================================= exports
/** An issued invoice is printed up to date (same numbers); the X-Batch-Id header says which batch was printed. */
exports.exportPdf = async (req, res) => {
  const id = await ensureFresh(req, parseId(req.params.id));
  const view = ['summary', 'vendor', 'machine', 'fueldiff'].includes(req.query.view) ? req.query.view : 'summary';
  const detail = await batchDetail(pool, id, { withDrift: false });
  const opts = { view, vendorId: req.query.vendor_id ? Number(req.query.vendor_id) : null, equipmentId: req.query.equipment_id ? Number(req.query.equipment_id) : null,
    hide: statements.hideOptions(req.query.hide) };
  const { buffer, fileName } = await statements.batchPdf(pool, detail, opts, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.set('X-Batch-Id', String(id));
  res.send(buffer);
};

exports.exportXlsx = async (req, res) => {
  const id = await ensureFresh(req, parseId(req.params.id));
  const detail = await batchDetail(pool, id, { withDrift: false });
  const buffer = await statements.batchXlsx(pool, detail);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="equipment-invoices-batch-${id}-v${detail.version_number}.xlsx"`);
  res.set('X-Batch-Id', String(id));
  res.send(buffer);
};

/**
 * Vendor invoice as an Excel payment certificate (the company's format, with the logo): a summary sheet of the vendor
 * and one certificate sheet per machine. vendor_id (required when the batch has several vendors), equipment_id (one machine).
 */
exports.certificateXlsx = async (req, res) => {
  const id = await ensureFresh(req, parseId(req.params.id));
  const q = validate(req.query, { vendor_id: v.id(), equipment_id: v.id() });
  const detail = await batchDetail(pool, id, { withDrift: false });
  const vendors = [...new Set(detail.items.map((i) => i.vendor_id))];
  const vendorId = q.vendor_id || (vendors.length === 1 ? vendors[0] : null);
  if (!vendorId) throw AppError.validation({ vendor_id: 'choose the vendor (this invoice batch has several)' });
  const { buffer, fileName } = await certificate.vendorWorkbook(pool, detail, { vendorId, equipmentId: q.equipment_id || null, user: req.user });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  res.set('X-Batch-Id', String(id));
  res.send(buffer);
};

/** Provisional statement (no batch): machine or vendor, any period. */
async function provisional(req, res, kind) {
  const id = parseId(req.params.id);
  const q = validate(req.query, {
    from: v.date({ required: true }), to: v.date({ required: true }), currency: v.currency(),
    // to see the amounts before the office approves: Submitted days are counted too, and marked on the PDF
    include_unapproved: v.bool({ default: false }),
    hide: v.any(),
  });
  const scope = { start_date: q.from, end_date: q.to, [kind === 'machine' ? 'equipment_id' : 'vendor_id']: id, include_submitted: q.include_unapproved };
  const { items } = await P.calculate(pool, scope);
  const chosen = pickCurrency(items, q.currency);
  if (!chosen.length) {
    const where = kind === 'machine' ? 'e.equipment_id = ?' : 'e.vendor_id = ?';
    const [[w]] = await pool.query(
      `SELECT SUM(ea.status = 'Submitted') AS submitted, SUM(ea.status IN ('Draft','Rejected')) AS drafts, MIN(ea.record_date) AS first_day, MAX(ea.record_date) AS last_day
       FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id WHERE ${where} AND ea.record_date BETWEEN ? AND ? AND ea.status IN ('Draft','Submitted','Rejected')`,
      [id, q.from, q.to]);
    const sub = Number(w.submitted || 0); const dr = Number(w.drafts || 0);
    if (!q.include_unapproved && sub > 0) {
      throw AppError.conflict('NOTHING_APPROVED', `Nothing approved yet in this period: ${sub} day(s) are waiting for the office's approval (${day(w.first_day)} to ${day(w.last_day)}). Approve them in Attendance review, or open the statement again with "Include days not approved yet".`, { submitted: sub, drafts: dr });
    }
    if (dr > 0) throw AppError.conflict('NOTHING_SUBMITTED', `Nothing to count yet: ${dr} day(s) are still Draft (not submitted by the supervisor).`, { drafts: dr });
    throw AppError.conflict('NOTHING_TO_PAY', 'Nothing to invoice in this period (no recorded day, or already in an invoice).');
  }
  const unapproved = q.include_unapproved ? chosen.reduce((a, it) => a + (it.per_row || []).filter((p) => p.row && p.row.status !== 'Approved').length, 0) : 0;
  const { buffer, fileName } = await statements.provisionalPdf(pool, { kind, scope, items: chosen, unapproved, hide: statements.hideOptions(q.hide) }, req.user);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
}
exports.provisionalMachine = (req, res) => provisional(req, res, 'machine');
exports.provisionalVendor = (req, res) => provisional(req, res, 'vendor');

exports._test = { freeRanges, actionsFor, coveredMachines, machineList };
