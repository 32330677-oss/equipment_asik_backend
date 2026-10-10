// DNR (Delivery Note Registry): per-unit prices of an EXISTING vendor (per trip, ton, m3 ...) and the delivery notes
// billed with them. Admin and Accountant only. A machine may also have a time rate card at the same time: both are paid,
// each by its own item of the payroll (the same machine can transport and do another job).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { businessToday, businessNow } = require('../../utils/businessDate');
const { overlapsSql } = require('../../utils/ranges');
const C = require('../../services/equipment/eqCommon');
const lock = require('../../services/equipment/eqLock');
const D = require('../../services/equipment/eqDnr');

const PRICE = (o = {}) => v.number({ min: 0.001, max: 99999999, decimals: 3, ...o });
const QTY = (o = {}) => v.number({ min: 0.001, max: 9999999, decimals: 3, ...o });
const day = (d) => (d ? String(d).slice(0, 10) : null);

// ------------------------------------------------------------------ DNR prices
const RATE_COLS = `r.*, vc.currency, vc.contract_number, vd.vendor_name, vd.vendor_code, e.equipment_code, e.machine_label,
  (SELECT COUNT(*) FROM eq_delivery_notes dn WHERE dn.dnr_rate_id = r.dnr_rate_id AND dn.status = 'Active') AS notes_count,
  (SELECT MAX(dn.note_date) FROM eq_delivery_notes dn WHERE dn.dnr_rate_id = r.dnr_rate_id AND dn.status = 'Active') AS last_note_date`;
const RATE_FROM = `FROM eq_dnr_rates r JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = r.vendor_contract_id
  JOIN eq_vendors vd ON vd.vendor_id = r.vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = r.equipment_id`;

function rateView(r) {
  return { ...r, effective_from: day(r.effective_from), effective_to: day(r.effective_to), notes_count: Number(r.notes_count || 0),
    last_note_date: day(r.last_note_date), applies_to: r.equipment_id ? 'machine' : 'vendor' };
}

async function rateRow(conn, id) {
  const [[r]] = await conn.query(`SELECT ${RATE_COLS} ${RATE_FROM} WHERE r.dnr_rate_id = ?`, [id]);
  if (!r) throw AppError.notFound('DNR price');
  return rateView(r);
}

exports.listRates = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.vendor_id) f('r.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.equipment_id) {
    // prices usable by this machine: its own, and those for every machine of its vendor
    where.push('(r.equipment_id = ? OR (r.equipment_id IS NULL AND r.vendor_id = (SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?)))');
    params.push(Number(req.query.equipment_id), Number(req.query.equipment_id));
  }
  if (req.query.status) f('r.status = ?', String(req.query.status));
  if (req.query.on) { where.push('r.effective_from <= ? AND (r.effective_to IS NULL OR r.effective_to >= ?)'); params.push(String(req.query.on), String(req.query.on)); }
  const [rows] = await pool.query(`SELECT ${RATE_COLS} ${RATE_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.status, vd.vendor_name, r.item_name, r.effective_from DESC LIMIT 1000`, params);
  res.json({ status: 'success', data: rows.map(rateView) });
};

exports.listMachineRates = async (req, res) => {
  const id = parseId(req.params.id);
  const m = await C.loadMachine(pool, id);
  const [rows] = await pool.query(`SELECT ${RATE_COLS} ${RATE_FROM}
    WHERE r.vendor_id = ? AND (r.equipment_id IS NULL OR r.equipment_id = ?) ORDER BY r.status, r.item_name, r.effective_from DESC`, [m.vendor_id, id]);
  res.json({ status: 'success', data: rows.map(rateView) });
};

/** Same item (name + unit) for the same machine / vendor scope must not have two prices on one date. */
async function assertNoOverlap(conn, { vendorId, equipmentId, itemName, unit, from, to, exceptId = 0 }) {
  const [clash] = await conn.execute(
    `SELECT dnr_rate_id, effective_from, effective_to FROM eq_dnr_rates
     WHERE vendor_id = ? AND ${equipmentId ? 'equipment_id = ?' : 'equipment_id IS NULL'} AND LOWER(item_name) = LOWER(?) AND unit = ?
       AND status = 'Active' AND dnr_rate_id <> ? AND ${overlapsSql('', 'effective_from', 'effective_to')}`,
    [vendorId, ...(equipmentId ? [equipmentId] : []), itemName, unit, exceptId, to || null, from]);
  if (clash.length) {
    throw AppError.conflict('DNR_RATE_OVERLAP', `"${itemName}" (${unit}) already has a price on some of these dates (#${clash[0].dnr_rate_id}). Close it first, or use another name.`, { conflicts: clash });
  }
}

function assertInsideContract(contract, from, to) {
  const cs = day(contract.start_date); const ce = day(contract.end_date);
  if (from < cs || (ce && (!to || to > ce))) {
    throw AppError.conflict('DNR_RATE_OUTSIDE_CONTRACT', `DNR price dates must be inside the contract (${cs} to ${ce || 'open'}).`);
  }
}

exports.createRates = async (req, res) => {
  const d = validate(req.body, {
    vendor_contract_id: v.id({ required: true }), equipment_id: v.id(), effective_from: v.date({ required: true }), effective_to: v.date(),
    notes: v.string({ max: 500 }), items: v.any({ required: true }),
  });
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 30) throw AppError.validation({ items: 'give 1 to 30 items (name, unit, price)' });
  const items = d.items.map((it, i) => {
    try {
      return validate(it, { item_name: v.string({ required: true, max: 255 }), unit: v.enumOf(D.UNITS, { required: true }), unit_price: PRICE({ required: true }) });
    } catch (e) {
      throw AppError.validation(Object.fromEntries(Object.entries((e.details && e.details.fields) || {}).map(([k, m]) => [`items[${i}].${k}`, m])));
    }
  });
  if (d.effective_to && d.effective_to < d.effective_from) throw AppError.validation({ effective_to: 'must be on or after effective_from' });
  const names = items.map((x) => `${x.item_name.toLowerCase()}|${x.unit}`);
  if (new Set(names).size !== names.length) throw AppError.validation({ items: 'the same item and unit is listed twice' });
  const created = await withTransaction(async (conn) => {
    const contract = await C.loadContract(conn, d.vendor_contract_id);
    if (contract.status === 'Terminated') throw AppError.conflict('CONTRACT_TERMINATED', 'This contract is terminated.');
    if (d.equipment_id) {
      const m = await C.loadMachine(conn, d.equipment_id);
      if (m.vendor_id !== contract.vendor_id) throw AppError.badRequest('CONTRACT_OTHER_VENDOR', 'The contract belongs to another vendor than the machine.');
    }
    assertInsideContract(contract, d.effective_from, d.effective_to || null);
    const out = [];
    for (const it of items) {
      await assertNoOverlap(conn, { vendorId: contract.vendor_id, equipmentId: d.equipment_id || null, itemName: it.item_name, unit: it.unit, from: d.effective_from, to: d.effective_to || null });
      const [r] = await conn.execute(
        `INSERT INTO eq_dnr_rates (vendor_id, vendor_contract_id, equipment_id, item_name, unit, unit_price, effective_from, effective_to, notes, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [contract.vendor_id, contract.vendor_contract_id, d.equipment_id || null, it.item_name, it.unit, it.unit_price, d.effective_from, d.effective_to || null, d.notes || null, req.user.user_id]);
      const row = await rateRow(conn, r.insertId);
      await audit.log(conn, { table: 'eq_dnr_rates', id: r.insertId, action: 'create', newValues: row, ...audit.ctx(req) });
      out.push(row);
    }
    return out;
  });
  res.status(201).json({ status: 'success', data: created });
};

exports.updateRate = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    item_name: v.string({ max: 255 }), unit: v.enumOf(D.UNITS), unit_price: PRICE(), effective_from: v.date(), effective_to: v.date(),
    notes: v.string({ max: 500 }), reason: v.string({ max: 500 }),
  });
  const reason = d.reason ? d.reason.trim() : ''; delete d.reason;
  const after = await withTransaction(async (conn) => {
    const before = await D.loadRate(conn, id, true);
    if (before.status !== 'Active') throw AppError.conflict('DNR_RATE_CANCELLED', 'This DNR price is cancelled.');
    const view = await rateRow(conn, id);
    const differs = (k) => {
      if (d[k] === undefined) return false;
      if (k === 'unit_price') return Number(d[k]) !== Number(before[k]);
      return String(d[k]) !== String(k === 'effective_from' ? day(before[k]) : before[k]);
    };
    const changesPrice = ['item_name', 'unit', 'unit_price', 'effective_from'].some(differs);
    if (view.notes_count > 0 && changesPrice) {
      throw AppError.conflict('DNR_RATE_USED', `${view.notes_count} delivery note(s) use this price. Close it on a date and add a new price from the next day (old notes keep their price).`);
    }
    const next = { item_name: before.item_name, unit: before.unit, unit_price: before.unit_price, effective_from: day(before.effective_from), effective_to: day(before.effective_to), notes: before.notes, ...d };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'effective_to') && (req.body.effective_to === null || req.body.effective_to === '')) next.effective_to = null;
    if (next.effective_to && next.effective_to < next.effective_from) throw AppError.validation({ effective_to: 'must be on or after effective_from' });
    if (view.last_note_date && next.effective_to && next.effective_to < view.last_note_date) {
      throw AppError.conflict('DNR_RATE_USED', `Delivery notes up to ${view.last_note_date} use this price: it cannot end before that day.`);
    }
    const contract = await C.loadContract(conn, before.vendor_contract_id);
    assertInsideContract(contract, next.effective_from, next.effective_to);
    await assertNoOverlap(conn, { vendorId: before.vendor_id, equipmentId: before.equipment_id, itemName: next.item_name, unit: next.unit, from: next.effective_from, to: next.effective_to, exceptId: id });
    await conn.execute('UPDATE eq_dnr_rates SET item_name = ?, unit = ?, unit_price = ?, effective_from = ?, effective_to = ?, notes = ? WHERE dnr_rate_id = ?',
      [next.item_name, next.unit, next.unit_price, next.effective_from, next.effective_to, next.notes || null, id]);
    const row = await rateRow(conn, id);
    await audit.log(conn, { table: 'eq_dnr_rates', id, action: 'update', oldValues: view, newValues: row, reason: reason || null, ...audit.ctx(req) });
    return row;
  });
  res.json({ status: 'success', data: after });
};

exports.closeRate = async (req, res) => {
  const id = parseId(req.params.id);
  const { effective_to } = validate(req.body, { effective_to: v.date({ required: true }) });
  const row = await withTransaction(async (conn) => {
    const before = await D.loadRate(conn, id, true);
    const view = await rateRow(conn, id);
    if (effective_to < day(before.effective_from)) throw AppError.validation({ effective_to: 'must be on or after effective_from' });
    if (view.last_note_date && effective_to < view.last_note_date) throw AppError.conflict('DNR_RATE_USED', `Delivery notes up to ${view.last_note_date} use this price.`);
    await conn.execute('UPDATE eq_dnr_rates SET effective_to = ? WHERE dnr_rate_id = ?', [effective_to, id]);
    await audit.log(conn, { table: 'eq_dnr_rates', id, action: 'close', oldValues: { effective_to: day(before.effective_to) }, newValues: { effective_to }, ...audit.ctx(req) });
    return rateRow(conn, id);
  });
  res.json({ status: 'success', data: row });
};

exports.cancelRate = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }) });
  const row = await withTransaction(async (conn) => {
    const before = await D.loadRate(conn, id, true);
    if (before.status === 'Cancelled') return rateRow(conn, id);
    const view = await rateRow(conn, id);
    if (view.notes_count > 0) throw AppError.conflict('DNR_RATE_USED', `${view.notes_count} delivery note(s) use this price: close it on a date instead.`);
    await conn.execute("UPDATE eq_dnr_rates SET status = 'Cancelled' WHERE dnr_rate_id = ?", [id]);
    await audit.log(conn, { table: 'eq_dnr_rates', id, action: 'cancel', oldValues: { status: 'Active' }, newValues: { status: 'Cancelled' }, reason, ...audit.ctx(req) });
    return rateRow(conn, id);
  });
  res.json({ status: 'success', data: row });
};

// ------------------------------------------------------------------ delivery notes
const NOTE_FROM = `FROM eq_delivery_notes dn JOIN eq_equipment e ON e.equipment_id = dn.equipment_id JOIN eq_types t ON t.type_id = e.type_id
  JOIN eq_vendors vd ON vd.vendor_id = dn.vendor_id JOIN sites s ON s.site_id = dn.site_id JOIN eq_dnr_rates r ON r.dnr_rate_id = dn.dnr_rate_id
  LEFT JOIN users u ON u.user_id = dn.created_by_user_id`;
const NOTE_COLS = `dn.*, e.equipment_code, e.machine_label, t.type_name, vd.vendor_name, s.site_code, s.site_name, r.item_name, r.unit, u.full_name AS created_by,
  (SELECT b.eq_batch_id FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
    WHERE l.source_table = 'eq_delivery_notes' AND l.source_id = dn.delivery_note_id AND b.status IN ('Generated','Paid') ORDER BY b.eq_batch_id DESC LIMIT 1) AS in_batch_id,
  (SELECT IF(b.status = 'Paid', 'Paid', IF(b.is_finalized = 1, 'Finalized', 'Draft')) FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
    JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
    WHERE l.source_table = 'eq_delivery_notes' AND l.source_id = dn.delivery_note_id AND b.status IN ('Generated','Paid') ORDER BY b.eq_batch_id DESC LIMIT 1) AS batch_state`;

function noteView(n) {
  const amount = D.exactCents(Number(n.quantity) * Number(n.unit_price)) / 100;
  return { ...n, note_date: day(n.note_date), amount: amount.toFixed(2), in_batch_id: n.in_batch_id || null, batch_state: n.batch_state || null };
}

async function noteRow(conn, id) {
  const [[n]] = await conn.query(`SELECT ${NOTE_COLS} ${NOTE_FROM} WHERE dn.delivery_note_id = ?`, [id]);
  if (!n) throw AppError.notFound('Delivery note');
  return noteView(n);
}

exports.listNotes = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.from) f('dn.note_date >= ?', String(req.query.from));
  if (req.query.to) f('dn.note_date <= ?', String(req.query.to));
  if (req.query.vendor_id) f('dn.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.equipment_id) f('dn.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.site_id) f('dn.site_id = ?', Number(req.query.site_id));
  if (req.query.status) f('dn.status = ?', String(req.query.status));
  if (req.query.q) { where.push('(dn.dn_number LIKE ? OR dn.material LIKE ? OR dn.driver_name LIKE ? OR r.item_name LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q, q); }
  const [rows] = await pool.query(`SELECT ${NOTE_COLS} ${NOTE_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY dn.note_date DESC, dn.delivery_note_id DESC LIMIT 2000`, params);
  res.json({ status: 'success', data: rows.map(noteView) });
};

exports.getNote = async (req, res) => {
  res.json({ status: 'success', data: await noteRow(pool, parseId(req.params.id)) });
};

const NOTE_FIELDS = {
  dn_number: v.string({ max: 60 }), site_id: v.id(), dnr_rate_id: v.id(), note_date: v.date(), quantity: QTY(),
  from_location: v.string({ max: 255 }), to_location: v.string({ max: 255 }), material: v.string({ max: 255 }),
  driver_name: v.string({ max: 255 }), note: v.string({ max: 500 }),
};

async function assertNumberFree(conn, vendorId, number, exceptId = 0) {
  const [[dup]] = await conn.execute(
    "SELECT delivery_note_id, note_date FROM eq_delivery_notes WHERE vendor_id = ? AND dn_number = ? AND status = 'Active' AND delivery_note_id <> ? LIMIT 1",
    [vendorId, number, exceptId]);
  if (dup) throw AppError.conflict('DN_NUMBER_EXISTS', `Delivery note ${number} of this vendor is already recorded (${day(dup.note_date)}).`, { delivery_note_id: dup.delivery_note_id });
}

/** Information for the user, never blocking: the same machine also has attendance that day (it may have done both jobs). */
async function sameDayWarnings(conn, equipmentId, date) {
  const [[a]] = await conn.execute(
    "SELECT COUNT(*) AS n FROM eq_attendance WHERE equipment_id = ? AND record_date = ? AND status <> 'Cancelled' AND day_status IN ('Working','Standby')", [equipmentId, date]);
  return Number(a.n) > 0 ? [{ code: 'ALSO_HAS_ATTENDANCE', message: 'This machine also has attendance (time rate) on this day. That is fine if it did both jobs; check it is not the same work paid twice.' }] : [];
}

exports.createNote = async (req, res) => {
  const d = validate(req.body, {
    ...NOTE_FIELDS, equipment_id: v.id({ required: true }), site_id: v.id({ required: true }), dnr_rate_id: v.id({ required: true }),
    dn_number: v.string({ required: true, max: 60 }), note_date: v.date({ required: true }), quantity: QTY({ required: true }),
  });
  if (d.note_date > businessToday()) throw AppError.badRequest('FUTURE_DATE', 'The date cannot be in the future.');
  const out = await withTransaction(async (conn) => {
    const machine = await C.loadMachine(conn, d.equipment_id, true);
    await C.loadSite(conn, d.site_id);
    const rate = await D.loadRate(conn, d.dnr_rate_id);
    D.assertUsable(rate, machine, d.note_date);
    // a note dated inside a finalized period would never be billed: refuse it
    await lock.assertOpen(conn, { vendorId: machine.vendor_id, equipmentId: d.equipment_id, siteId: d.site_id, from: d.note_date, what: 'This delivery note date' });
    await assertNumberFree(conn, machine.vendor_id, d.dn_number);
    let r;
    try {
      [r] = await conn.execute(
        `INSERT INTO eq_delivery_notes (dn_number, vendor_id, equipment_id, site_id, dnr_rate_id, note_date, quantity, unit_price, currency,
           from_location, to_location, material, driver_name, note, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.dn_number, machine.vendor_id, d.equipment_id, d.site_id, d.dnr_rate_id, d.note_date, d.quantity, rate.unit_price, rate.currency,
          d.from_location || null, d.to_location || null, d.material || null, d.driver_name || null, d.note || null, req.user.user_id]);
    } catch (e) {
      if (e && e.errno === 1062) throw AppError.conflict('DN_NUMBER_EXISTS', `Delivery note ${d.dn_number} of this vendor is already recorded.`);
      throw e;
    }
    const row = await noteRow(conn, r.insertId);
    await audit.log(conn, { table: 'eq_delivery_notes', id: r.insertId, action: 'create', newValues: row, ...audit.ctx(req) });
    const warnings = await sameDayWarnings(conn, d.equipment_id, d.note_date);
    if (machine.status !== 'Active') warnings.push({ code: 'MACHINE_NOT_ACTIVE', message: `The machine is ${machine.status}.` });
    return { row, warnings };
  });
  res.status(201).json({ status: 'success', data: out.row, warnings: out.warnings });
};

async function loadNote(conn, id) {
  const [[n]] = await conn.execute('SELECT * FROM eq_delivery_notes WHERE delivery_note_id = ? FOR UPDATE', [id]);
  if (!n) throw AppError.notFound('Delivery note');
  return n;
}

/**
 * Change a delivery note of an OPEN period. A note paid by a FINALIZED batch is corrected only through an official
 * Correction. A change of quantity, price item, date or site needs a reason; a draft batch holding it turns stale.
 */
exports.updateNote = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { ...NOTE_FIELDS, reason: v.string({ max: 500 }) });
  const reason = d.reason ? d.reason.trim() : ''; delete d.reason;
  const out = await withTransaction(async (conn) => {
    const before = await loadNote(conn, id);
    if (before.status === 'Cancelled') throw AppError.conflict('INVALID_STATE', 'This delivery note is cancelled.');
    const used = await lock.sourceConsumed(conn, 'eq_delivery_notes', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This delivery note is in finalized payroll batch #${used.eq_batch_id}. Ask for an official Correction (open that batch, the machine, "Official correction").`);
    const machine = await C.loadMachine(conn, before.equipment_id);
    const next = { ...before, note_date: day(before.note_date), ...d };
    const moneyKeys = ['quantity', 'dnr_rate_id', 'note_date', 'site_id'];
    const changesMoney = moneyKeys.some((k) => {
      if (d[k] === undefined) return false;
      if (k === 'quantity' || k === 'dnr_rate_id' || k === 'site_id') return Number(d[k]) !== Number(before[k]);
      return String(d[k]) !== day(before[k]);
    });
    if (changesMoney && reason.length < 5) throw AppError.validation({ reason: 'say why the quantity, price, date or site changes (at least 5 characters)' });
    if (next.note_date > businessToday()) throw AppError.badRequest('FUTURE_DATE', 'The date cannot be in the future.');
    await lock.assertOpen(conn, { vendorId: before.vendor_id, equipmentId: before.equipment_id, siteId: before.site_id, from: day(before.note_date), what: 'This delivery note date' });
    if (d.site_id !== undefined) await C.loadSite(conn, d.site_id);
    await lock.assertOpen(conn, { vendorId: before.vendor_id, equipmentId: before.equipment_id, siteId: next.site_id, from: next.note_date, what: 'The new date' });
    let unitPrice = before.unit_price; let currency = before.currency;
    if (d.dnr_rate_id !== undefined || d.note_date !== undefined) {
      const rate = await D.loadRate(conn, next.dnr_rate_id);
      D.assertUsable(rate, machine, next.note_date);
      // the price is taken again only when the price item changes; a date change keeps the agreed price of the note
      if (Number(next.dnr_rate_id) !== Number(before.dnr_rate_id)) { unitPrice = rate.unit_price; currency = rate.currency; }
    }
    if (d.dn_number !== undefined && d.dn_number !== before.dn_number) await assertNumberFree(conn, before.vendor_id, d.dn_number, id);
    const old = await noteRow(conn, id);
    try {
      await conn.execute(
        `UPDATE eq_delivery_notes SET dn_number = ?, site_id = ?, dnr_rate_id = ?, note_date = ?, quantity = ?, unit_price = ?, currency = ?,
           from_location = ?, to_location = ?, material = ?, driver_name = ?, note = ? WHERE delivery_note_id = ?`,
        [next.dn_number, next.site_id, next.dnr_rate_id, next.note_date, next.quantity, unitPrice, currency,
          next.from_location || null, next.to_location || null, next.material || null, next.driver_name || null, next.note || null, id]);
    } catch (e) {
      if (e && e.errno === 1062) throw AppError.conflict('DN_NUMBER_EXISTS', `Delivery note ${next.dn_number} of this vendor is already recorded.`);
      throw e;
    }
    const inBatch = await lock.sourceConsumed(conn, 'eq_delivery_notes', id);
    const row = await noteRow(conn, id);
    await audit.log(conn, { table: 'eq_delivery_notes', id, action: 'update', oldValues: old, newValues: row, reason: reason || null,
      payrollEffect: inBatch ? `stale:${inBatch.eq_batch_id}` : 'none', ...audit.ctx(req) });
    return { row, warnings: await sameDayWarnings(conn, before.equipment_id, next.note_date) };
  });
  res.json({ status: 'success', data: out.row, warnings: out.warnings });
};

exports.cancelNote = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 500 }) });
  await withTransaction(async (conn) => {
    const before = await loadNote(conn, id);
    if (before.status === 'Cancelled') return;
    const used = await lock.sourceConsumed(conn, 'eq_delivery_notes', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This delivery note is in finalized payroll batch #${used.eq_batch_id}. Reverse it with an official Correction.`);
    const inBatch = await lock.sourceConsumed(conn, 'eq_delivery_notes', id);
    await conn.execute("UPDATE eq_delivery_notes SET status = 'Cancelled', cancel_reason = ?, cancelled_by_user_id = ?, cancelled_at = ? WHERE delivery_note_id = ?",
      [reason, req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_delivery_notes', id, action: 'cancel', oldValues: { status: 'Active' }, newValues: { status: 'Cancelled' }, reason,
      payrollEffect: inBatch ? `stale:${inBatch.eq_batch_id}` : 'none', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await noteRow(pool, id) });
};
