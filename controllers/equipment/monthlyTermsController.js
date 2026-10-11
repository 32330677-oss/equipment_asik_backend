// Terms of the month of MONTHLY machines (decision of 11 Oct 2026): the divisor D (working days the monthly price is
// divided by) and / or the hourly price, typed per machine and month on "New payroll". Kept on the machine and the month
// (eq_monthly_terms), not on a batch: a draft that used other terms turns stale. Once a FINALIZED batch billed a day of
// that month for the machine, the terms are locked (a difference then goes through an official Correction).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate } = require('../../utils/validate');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const { businessNow, daysInMonth, monthOf } = require('../../utils/businessDate');
const { toDecimalString } = require('../../utils/money');
const P = require('../../services/equipment/eqPayrollService');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthsBetween(start, end) {
  const out = [];
  for (let m = monthOf(start); m <= monthOf(end);) {
    out.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  return out;
}
const firstDay = (m) => `${m}-01`;
const lastDay = (m) => `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;

/** The finalized active batch that billed a day of this month for this machine, or null. */
async function lockOf(conn, equipmentId, month) {
  const [[b]] = await conn.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_monthly_days md JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id
     WHERE md.equipment_id = ? AND md.day BETWEEN ? AND ? AND b.status IN ('Generated','Paid') AND b.is_finalized = 1
     ORDER BY b.eq_batch_id DESC LIMIT 1`, [equipmentId, firstDay(month), lastDay(month)]);
  return b ? b.eq_batch_id : null;
}

/** Monthly rate cards of these machines over [start, end]. */
async function monthlyCards(conn, equipmentIds, start, end) {
  if (!equipmentIds.length) return [];
  const [rows] = await conn.query(
    `SELECT rc.*, vc.currency FROM eq_rate_cards rc JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
     WHERE rc.equipment_id IN (?) AND rc.billing_mode = 'Monthly' AND rc.effective_from <= ? AND (rc.effective_to IS NULL OR rc.effective_to >= ?)
     ORDER BY rc.equipment_id, rc.effective_from`, [equipmentIds, end, start]);
  return rows;
}

/** One row per monthly machine and month of [start, end]: card, terms, what is billed so far, the estimate, the lock. */
async function termsRows(conn, { start, end, vendorId = null, equipmentIds = null }) {
  const where = []; const params = [];
  if (vendorId) { where.push('e.vendor_id = ?'); params.push(vendorId); }
  if (equipmentIds && equipmentIds.length) { where.push('e.equipment_id IN (?)'); params.push(equipmentIds); }
  if (!where.length) throw AppError.validation({ vendor_id: 'give the vendor or the machines' });
  const [machines] = await conn.query(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.plate_number, e.vendor_id, t.type_name FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id
     WHERE ${where.join(' AND ')} ORDER BY e.equipment_code`, params);
  const cards = await monthlyCards(conn, machines.map((m) => m.equipment_id), start, end);
  const ids = [...new Set(cards.map((c) => c.equipment_id))];
  const offDay = await settings.getInt('eq_weekly_off_day');
  const terms = await P.loadMonthlyTerms(conn, ids, monthOf(start), monthOf(end));
  const [people] = await conn.query('SELECT user_id, full_name FROM users');
  const who = Object.fromEntries(people.map((u) => [u.user_id, u.full_name]));
  const out = [];
  for (const m of machines.filter((x) => ids.includes(x.equipment_id))) {
    // what a batch over the period would bill now for this machine (months of the monthly item)
    let items = [];
    try { items = (await P.calculate(conn, { start_date: start, end_date: end, vendor_id: m.vendor_id, equipment_ids: [m.equipment_id] })).items; } catch (e) { if (!e.isAppError) throw e; }
    for (const month of monthsBetween(start, end)) {
      const from = firstDay(month) > start ? firstDay(month) : start;
      const card = cards.find((c) => c.equipment_id === m.equipment_id && c.effective_from <= lastDay(month) && (!c.effective_to || c.effective_to >= from));
      if (!card) continue;
      const t = terms(m.equipment_id, month);
      const mt = P.monthTerms(month, P.engineRate(card), offDay, () => t);
      const item = items.find((i) => i.billing_mode === 'Monthly' && i.rate_card_id === card.rate_card_id);
      const det = item && (item.monthly_calc || []).find((x) => x.month === month);
      const amount = item ? item.lines.filter((l) => l.month === month).reduce((a, l) => a + l.amount_cents, 0) : null;
      const locked = await lockOf(conn, m.equipment_id, month);
      const hpd = Number(card.standard_hours_per_day);
      out.push({
        equipment_id: m.equipment_id, label: m.machine_label || `${m.equipment_code} ${m.type_name}`, equipment_code: m.equipment_code, plate: m.plate_number,
        month, rate_card_id: card.rate_card_id, monthly_rate: Number(card.monthly_rate), currency: card.currency, hours_per_day: hpd,
        calendar_days: mt.workingDays, card_divisor_mode: card.monthly_divisor || 'MonthDays', card_fixed_days: Number(card.monthly_working_days),
        divisor: mt.divisor, divisor_source: mt.divisorSource,
        hourly: mt.hourlyCents !== null ? Math.round(mt.hourlyCents) / 100 : Math.round((Number(card.monthly_rate) / mt.divisor / hpd) * 10000) / 10000,
        hourly_source: mt.hourlySource,
        overtime_enabled: Number(card.overtime_enabled) === 1, overtime_rate: card.overtime_rate === null ? null : Number(card.overtime_rate),
        deployed_working_days: det ? det.deployed_working_days : null, holiday_days: det ? det.holiday_days : null,
        required_hours: det ? det.required_hours : null, billable_hours_so_far: det ? det.billable_hours : null,
        estimated_amount: amount === null ? null : toDecimalString(amount), already_billed: det && det.billed_before ? det.billed_before : null,
        locked: Boolean(locked), locked_by_batch_id: locked,
        set_by: t ? who[t.set_by_user_id] || null : null, set_at: t ? t.set_at : null, note: t ? t.note : null,
        typed_working_days: t ? t.working_days : null, typed_hourly_rate: t && t.hourly_rate !== null ? Number(t.hourly_rate) : null,
      });
    }
  }
  return out;
}

exports.list = async (req, res) => {
  const q = { ...req.query };
  if (typeof q.equipment_ids === 'string') q.equipment_ids = q.equipment_ids.split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(q.equipment_ids) && !q.equipment_ids.length) delete q.equipment_ids;
  const d = validate(q, { start_date: v.date({ required: true }), end_date: v.date({ required: true }), vendor_id: v.id(), equipment_ids: v.ids() });
  if (d.end_date < d.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
  if (Date.parse(d.end_date) - Date.parse(d.start_date) > 366 * 86400000) throw AppError.validation({ end_date: 'the period cannot exceed one year' });
  res.json({ status: 'success', data: await termsRows(pool, { start: d.start_date, end: d.end_date, vendorId: d.vendor_id || null, equipmentIds: d.equipment_ids || null }) });
};

/**
 * Set (or clear) the terms of one machine and month: { equipment_id, month, working_days|null, hourly_rate|null, note? }.
 * Both null = back to the card. Reason optional; the audit keeps before / after. Locked once a finalized batch billed
 * a day of that month for the machine (409 MONTHLY_TERMS_LOCKED: use a Correction).
 */
exports.put = async (req, res) => {
  const body = req.body || {};
  const d = validate(body, {
    equipment_id: v.id({ required: true }), month: v.string({ required: true, max: 7 }),
    working_days: v.int({ min: 1, max: 31 }), hourly_rate: v.number({ min: 0.0001, max: 99999999, decimals: 4 }), note: v.string({ max: 500 }),
  });
  if (!MONTH_RE.test(d.month)) throw AppError.validation({ month: 'must be YYYY-MM' });
  const days = body.working_days === null || body.working_days === undefined || body.working_days === '' ? null : d.working_days;
  const hourly = body.hourly_rate === null || body.hourly_rate === undefined || body.hourly_rate === '' ? null : d.hourly_rate;
  await withTransaction(async (conn) => {
    const [[m]] = await conn.execute('SELECT equipment_id FROM eq_equipment WHERE equipment_id = ? FOR UPDATE', [d.equipment_id]);
    if (!m) throw AppError.notFound('Machine');
    const cards = await monthlyCards(conn, [d.equipment_id], firstDay(d.month), lastDay(d.month));
    if (!cards.length) throw new AppError(422, 'NOT_MONTHLY', 'This machine has no monthly rate card in that month.');
    const locked = await lockOf(conn, d.equipment_id, d.month);
    if (locked) {
      throw AppError.conflict('MONTHLY_TERMS_LOCKED', `Finalized batch #${locked} already billed this month for this machine. Use a Correction.`, { eq_batch_id: locked });
    }
    const [[before]] = await conn.execute('SELECT * FROM eq_monthly_terms WHERE equipment_id = ? AND month = ? FOR UPDATE', [d.equipment_id, d.month]);
    if (days === null && hourly === null) {
      if (before) {
        await conn.execute('DELETE FROM eq_monthly_terms WHERE monthly_terms_id = ?', [before.monthly_terms_id]);
        await audit.log(conn, { table: 'eq_monthly_terms', id: before.monthly_terms_id, action: 'clear', oldValues: before, newValues: null, reason: d.note || null, ...audit.ctx(req) });
      }
      return;
    }
    if (before) {
      await conn.execute('UPDATE eq_monthly_terms SET working_days = ?, hourly_rate = ?, note = ?, set_by_user_id = ?, set_at = ? WHERE monthly_terms_id = ?',
        [days, hourly, d.note || null, req.user.user_id, businessNow(), before.monthly_terms_id]);
      const [[after]] = await conn.execute('SELECT * FROM eq_monthly_terms WHERE monthly_terms_id = ?', [before.monthly_terms_id]);
      await audit.log(conn, { table: 'eq_monthly_terms', id: before.monthly_terms_id, action: 'update', oldValues: before, newValues: after, reason: d.note || null, ...audit.ctx(req) });
    } else {
      const [r] = await conn.execute(
        'INSERT INTO eq_monthly_terms (equipment_id, month, working_days, hourly_rate, note, set_by_user_id, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [d.equipment_id, d.month, days, hourly, d.note || null, req.user.user_id, businessNow()]);
      const [[after]] = await conn.execute('SELECT * FROM eq_monthly_terms WHERE monthly_terms_id = ?', [r.insertId]);
      await audit.log(conn, { table: 'eq_monthly_terms', id: r.insertId, action: 'create', newValues: after, reason: d.note || null, ...audit.ctx(req) });
    }
  });
  const rows = await termsRows(pool, { start: firstDay(d.month), end: lastDay(d.month), equipmentIds: [d.equipment_id] });
  res.json({ status: 'success', data: rows.find((r) => r.month === d.month) || null });
};

exports.termsRows = termsRows;
