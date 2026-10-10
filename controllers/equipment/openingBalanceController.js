// Opening balances: money still owed to a vendor from BEFORE the system was used (migration 014).
// Entered once; "Add previous balances" on New payroll carries it into the batch, where it is paid with normal vouchers.
// Rules: amount > 0 (what is still owed after the old payments), currency of one of the vendor's contracts,
// balance date not in the future. Changed or cancelled only while it is not carried into an active batch
// (void that batch first; once it is finalized and paid, it is history).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { businessToday, businessNow } = require('../../utils/businessDate');
const C = require('../../services/equipment/eqCommon');

const FIELDS = {
  equipment_id: v.id(), currency: v.currency(), amount: v.number({ min: 0.01, max: 999999999999, decimals: 2 }),
  as_of_date: v.date(), period_from: v.date(), period_to: v.date(),
  description: v.string({ max: 255 }), reference: v.string({ max: 100 }), note: v.string({ max: 500 }),
};

const SELECT = `SELECT ob.*, vd.vendor_name, vd.vendor_code, e.equipment_code, e.machine_label, u.full_name AS created_by, cu.full_name AS cancelled_by,
    c.carryover_id, c.to_batch_id, b.status AS to_batch_status, b.is_finalized AS to_batch_finalized, b.start_date AS to_start_date, b.end_date AS to_end_date
  FROM eq_opening_balances ob JOIN eq_vendors vd ON vd.vendor_id = ob.vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = ob.equipment_id
  JOIN users u ON u.user_id = ob.created_by_user_id LEFT JOIN users cu ON cu.user_id = ob.cancelled_by_user_id
  LEFT JOIN eq_payment_carryovers c ON c.opening_balance_id = ob.opening_balance_id AND c.status = 'Active'
  LEFT JOIN eq_payroll_batches b ON b.eq_batch_id = c.to_batch_id`;

const day = (d) => (d ? String(d).slice(0, 10) : null);

/** API view: state = Open (waiting for the next payroll), Carried (in a batch), Cancelled. */
function view(r) {
  let state = 'Open';
  if (r.status === 'Cancelled') state = 'Cancelled';
  else if (r.carryover_id) state = 'Carried';
  return {
    opening_balance_id: r.opening_balance_id, vendor_id: r.vendor_id, vendor_name: r.vendor_name, vendor_code: r.vendor_code,
    equipment_id: r.equipment_id, equipment_code: r.equipment_code || null, machine_label: r.machine_label || null, currency: r.currency, amount: Number(r.amount).toFixed(2),
    as_of_date: day(r.as_of_date), period_from: day(r.period_from), period_to: day(r.period_to),
    description: r.description, reference: r.reference, note: r.note, status: r.status, state,
    carried_to_batch_id: r.to_batch_id || null,
    carried_to_batch_state: r.to_batch_id ? (r.to_batch_status === 'Generated' ? (Number(r.to_batch_finalized) ? 'Finalized' : 'Draft') : r.to_batch_status) : null,
    carried_to_period: r.to_batch_id ? { start_date: day(r.to_start_date), end_date: day(r.to_end_date) } : null,
    cancel_reason: r.cancel_reason, cancelled_by: r.cancelled_by || null, cancelled_at: r.cancelled_at,
    created_by: r.created_by, created_at: r.created_at,
  };
}

async function loadOne(conn, id, lock = false) {
  const [[r]] = await conn.execute(`${SELECT} WHERE ob.opening_balance_id = ?`, [id]);
  if (!r) throw AppError.notFound('Opening balance');
  if (lock) await conn.execute('SELECT opening_balance_id FROM eq_opening_balances WHERE opening_balance_id = ? FOR UPDATE', [id]);
  return r;
}

/** Checks shared by create and update. d = merged values. */
async function check(conn, vendorId, d) {
  if (!(Number(d.amount) > 0)) throw AppError.validation({ amount: 'is required and must be more than 0 (what is still owed after the old payments)' });
  if (!d.as_of_date) throw AppError.validation({ as_of_date: 'is required (the date of the balance)' });
  if (d.as_of_date > businessToday()) throw AppError.validation({ as_of_date: 'cannot be in the future' });
  if (!d.description || !String(d.description).trim()) throw AppError.validation({ description: 'is required (printed on the statement of account)' });
  if ((d.period_from && !d.period_to) || (!d.period_from && d.period_to)) throw AppError.validation({ period_to: 'give both dates of the old period, or none' });
  if (d.period_from && d.period_to && d.period_to < d.period_from) throw AppError.validation({ period_to: 'must be on or after period_from' });
  if (d.period_to && d.period_to > d.as_of_date) throw AppError.validation({ period_to: 'must be on or before the balance date' });
  if (d.equipment_id) {
    const m = await C.loadMachine(conn, d.equipment_id);
    if (m.vendor_id !== vendorId) throw AppError.validation({ equipment_id: 'is not a machine of this vendor' });
  }
  const [cur] = await conn.execute('SELECT DISTINCT currency FROM eq_vendor_contracts WHERE vendor_id = ?', [vendorId]);
  if (!cur.length) throw AppError.conflict('NO_CONTRACT', 'The vendor has no contract: add one first (it gives the currency).');
  if (!cur.some((c) => c.currency === d.currency)) {
    throw AppError.validation({ currency: `must be the currency of one of the vendor's contracts (${cur.map((c) => c.currency).join(', ')})` });
  }
}

exports.list = async (req, res) => {
  const where = []; const params = [];
  if (req.query.vendor_id) { where.push('ob.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('ob.status = ?'); params.push(String(req.query.status)); }
  const [rows] = await pool.query(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ob.as_of_date DESC, ob.opening_balance_id DESC LIMIT 1000`, params);
  res.json({ status: 'success', data: rows.map(view) });
};

exports.create = async (req, res) => {
  const vendorId = parseId(req.params.id);
  const d = validate(req.body, FIELDS);
  const out = await withTransaction(async (conn) => {
    await C.loadVendor(conn, vendorId, true);
    if (!d.currency) {
      const [cur] = await conn.execute('SELECT DISTINCT currency FROM eq_vendor_contracts WHERE vendor_id = ?', [vendorId]);
      if (cur.length === 1) d.currency = cur[0].currency;
      else if (cur.length > 1) throw AppError.validation({ currency: `is required: the vendor has contracts in ${cur.map((c) => c.currency).join(', ')}` });
    }
    await check(conn, vendorId, d);
    const [r] = await conn.execute(
      `INSERT INTO eq_opening_balances (vendor_id, equipment_id, currency, amount, as_of_date, period_from, period_to, description, reference, note, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vendorId, d.equipment_id || null, d.currency, Number(d.amount).toFixed(2), d.as_of_date, d.period_from || null, d.period_to || null,
        d.description.trim(), d.reference || null, d.note || null, req.user.user_id, businessNow()]);
    const row = view(await loadOne(conn, r.insertId));
    await audit.log(conn, { table: 'eq_opening_balances', id: r.insertId, action: 'create', newValues: row, ...audit.ctx(req) });
    return row;
  });
  res.status(201).json({ status: 'success', data: out });
};

/** Change an opening balance that is still Open (not carried into a batch). */
exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { ...FIELDS, reason: v.string({ max: 500 }) });
  const out = await withTransaction(async (conn) => {
    const old = await loadOne(conn, id, true);
    if (old.status === 'Cancelled') throw AppError.conflict('INVALID_STATE', 'This opening balance is cancelled.');
    if (old.carryover_id) {
      throw AppError.conflict('OPENING_BALANCE_CARRIED', `It is carried into batch #${old.to_batch_id}: void that batch first, then change it.`, { eq_batch_id: old.to_batch_id });
    }
    const keys = ['equipment_id', 'currency', 'amount', 'as_of_date', 'period_from', 'period_to', 'description', 'reference', 'note'];
    const merged = {};
    for (const k of keys) merged[k] = Object.prototype.hasOwnProperty.call(req.body, k) ? (d[k] ?? null) : (k.endsWith('date') || k.startsWith('period') ? day(old[k]) : old[k]);
    await check(conn, old.vendor_id, merged);
    await conn.execute(
      `UPDATE eq_opening_balances SET equipment_id = ?, currency = ?, amount = ?, as_of_date = ?, period_from = ?, period_to = ?, description = ?, reference = ?, note = ?
       WHERE opening_balance_id = ?`,
      [merged.equipment_id || null, merged.currency, Number(merged.amount).toFixed(2), merged.as_of_date, merged.period_from || null, merged.period_to || null,
        String(merged.description).trim(), merged.reference || null, merged.note || null, id]);
    const row = view(await loadOne(conn, id));
    await audit.log(conn, { table: 'eq_opening_balances', id, action: 'update', oldValues: view(old), newValues: row, reason: d.reason || null, ...audit.ctx(req) });
    return row;
  });
  res.json({ status: 'success', data: out });
};

exports.cancel = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 5, max: 500 }) });
  const out = await withTransaction(async (conn) => {
    const old = await loadOne(conn, id, true);
    if (old.status === 'Cancelled') return view(old);
    if (old.carryover_id) {
      throw AppError.conflict('OPENING_BALANCE_CARRIED', `It is carried into batch #${old.to_batch_id}: void that batch first, then cancel it.`, { eq_batch_id: old.to_batch_id });
    }
    await conn.execute("UPDATE eq_opening_balances SET status = 'Cancelled', cancel_reason = ?, cancelled_by_user_id = ?, cancelled_at = ? WHERE opening_balance_id = ?",
      [reason, req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_opening_balances', id, action: 'cancel', oldValues: { status: 'Active' }, newValues: { status: 'Cancelled' }, reason, ...audit.ctx(req) });
    return view(await loadOne(conn, id));
  });
  res.json({ status: 'success', data: out });
};
