// Rate cards: effective-dated pricing policy of one machine under one vendor contract (BR-05, BR-06).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { overlapsSql } = require('../../utils/ranges');
const C = require('../../services/equipment/eqCommon');
const engine = require('../../services/equipment/equipmentBillingEngine');
const P = require('../../services/equipment/eqPayrollService');
const settings = require('../../services/settings');
const { businessToday, addDays, daysInMonth } = require('../../utils/businessDate');

const MONEY = (o = {}) => v.number({ min: 0, max: 99999999, decimals: 2, ...o });
const HOURS = (o = {}) => v.number({ min: 0, max: 24, decimals: 2, ...o });

const FIELDS = {
  vendor_contract_id: v.id(),
  effective_from: v.date(),
  effective_to: v.date(),
  billing_mode: v.enumOf(['Hourly', 'Daily', 'Monthly']),
  hourly_rate: MONEY(), daily_rate: MONEY(), monthly_rate: MONEY(),
  standard_hours_per_day: HOURS({ min: 1 }),
  min_billable_hours_per_day: HOURS(),
  overtime_enabled: v.bool(),
  overtime_threshold_hours: HOURS(),
  overtime_rate: MONEY(),
  overtime_multiplier: v.number({ min: 0.5, max: 5, decimals: 2 }),
  standby_billable_pct: v.number({ min: 0, max: 100, decimals: 2 }),
  breakdown_billable_pct: v.number({ min: 0, max: 100, decimals: 2 }),
  second_shift_pct: v.number({ min: 0, max: 100, decimals: 2 }),
  break_policy: v.enumOf(['Deduct', 'Paid']),
  daily_partial_rule: v.enumOf(['ProRata', 'FullDayIfWorked', 'HalfDayThreshold']),
  half_day_threshold_hours: HOURS(),
  monthly_working_days: v.int({ min: 1, max: 31 }),
  // Monthly: always a normal month (price / working days of the calendar month). 12 Oct 2026: "Fixed" is gone; a month
  // that is billed differently gets an exception for that machine and month (amount, days, hourly price).
  monthly_divisor: v.enumOf(['MonthDays']),
  operator_included: v.bool(),
  operator_daily_rate: MONEY(),
  fuel_policy: v.enumOf(['VendorSupplies', 'CompanySuppliesDeducted', 'CompanySuppliesFree']),
  notes: v.string({ max: 500 }),
};
const COLUMNS = Object.keys(FIELDS);

const DEFAULTS = {
  standard_hours_per_day: 8, overtime_enabled: false, overtime_multiplier: 1, standby_billable_pct: 50,
  breakdown_billable_pct: 0, break_policy: 'Deduct', daily_partial_rule: 'ProRata', monthly_working_days: 26, monthly_divisor: 'MonthDays',
  operator_included: true, fuel_policy: 'VendorSupplies', second_shift_pct: 0,
};

/** A NEW monthly card pays overtime unless it says otherwise (11 Oct 2026: the card decides; default ON). */
function monthlyDefaults(d) {
  return d.billing_mode === 'Monthly' && d.overtime_enabled === undefined ? { ...d, overtime_enabled: true } : d;
}

/** Cross-field rules of a complete card. Returns the normalized card. */
function checkCard(card) {
  const f = {};
  const mode = card.billing_mode;
  if (!mode) f.billing_mode = 'is required';
  if (mode === 'Hourly' && !(Number(card.hourly_rate) > 0)) f.hourly_rate = 'is required for Hourly billing';
  if (mode === 'Daily' && !(Number(card.daily_rate) > 0)) f.daily_rate = 'is required for Daily billing';
  if (mode === 'Monthly' && !(Number(card.monthly_rate) > 0)) f.monthly_rate = 'is required for Monthly billing';
  if (card.daily_partial_rule === 'HalfDayThreshold' && mode === 'Daily' && !(Number(card.half_day_threshold_hours) > 0)) {
    f.half_day_threshold_hours = 'is required with HalfDayThreshold';
  }
  if (mode !== 'Daily' && Number(card.second_shift_pct || 0) > 0) f.second_shift_pct = 'only for Daily billing';
  if (mode === 'Monthly') card.monthly_divisor = 'MonthDays';
  if (card.second_shift_pct === null || card.second_shift_pct === undefined) card.second_shift_pct = 0;
  if (card.operator_included && card.operator_daily_rate != null) f.operator_daily_rate = 'only allowed when operator_included is false';
  if (card.effective_to && card.effective_from && card.effective_to < card.effective_from) f.effective_to = 'must be on or after effective_from';
  if (Object.keys(f).length) throw AppError.validation(f);
  return card;
}

function toDb(card) {
  return COLUMNS.map((k) => {
    const val = card[k];
    if (['overtime_enabled', 'operator_included'].includes(k)) return val ? 1 : 0;
    return val === undefined ? null : val;
  });
}

async function assertContractAndOverlap(conn, machine, card, exceptId = 0) {
  const contract = await C.loadContract(conn, card.vendor_contract_id);
  if (contract.vendor_id !== machine.vendor_id) throw AppError.badRequest('CONTRACT_OTHER_VENDOR', 'The contract belongs to another vendor.');
  if (card.effective_from < contract.start_date || (contract.end_date && (!card.effective_to || card.effective_to > contract.end_date))) {
    throw AppError.conflict('RATE_CARD_OUTSIDE_CONTRACT', `Rate card dates must be inside the contract (${contract.start_date} to ${contract.end_date || 'open'}).`);
  }
  const [clash] = await conn.execute(
    `SELECT rate_card_id, effective_from, effective_to FROM eq_rate_cards
     WHERE equipment_id = ? AND rate_card_id <> ? AND ${overlapsSql('', 'effective_from', 'effective_to')}`,
    [machine.equipment_id, exceptId, card.effective_to || null, card.effective_from]);
  if (clash.length) throw AppError.conflict('RATE_CARD_OVERLAP', 'Another rate card of this machine covers some of these dates.', { conflicts: clash });
  return contract;
}

exports.list = async (req, res) => {
  const id = parseId(req.params.id);
  await C.loadMachine(pool, id);
  const [rows] = await pool.execute(
    `SELECT rc.*, vc.contract_number, vc.currency,
       EXISTS(SELECT 1 FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
              WHERE i.rate_card_id = rc.rate_card_id AND b.status = 'HandedOver') AS used_in_finalized_payroll
     FROM eq_rate_cards rc JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
     WHERE rc.equipment_id = ? ORDER BY rc.effective_from DESC`, [id]);
  res.json({ status: 'success', data: rows.map((r) => ({ ...r, used_in_finalized_payroll: Boolean(Number(r.used_in_finalized_payroll)) })) });
};

exports.create = async (req, res) => {
  const equipmentId = parseId(req.params.id);
  const d = validate(req.body, { ...FIELDS, vendor_contract_id: v.id({ required: true }), effective_from: v.date({ required: true }), billing_mode: v.enumOf(['Hourly', 'Daily', 'Monthly'], { required: true }) });
  const card = checkCard({ ...DEFAULTS, ...monthlyDefaults(d) });
  const created = await withTransaction(async (conn) => {
    const machine = await C.loadMachine(conn, equipmentId, true);
    await assertContractAndOverlap(conn, machine, card);
    const [r] = await conn.execute(
      `INSERT INTO eq_rate_cards (equipment_id, ${COLUMNS.join(', ')}, created_by_user_id) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?)`,
      [equipmentId, ...toDb(card), req.user.user_id]);
    const row = await C.loadRateCard(conn, r.insertId);
    await audit.log(conn, { table: 'eq_rate_cards', id: r.insertId, action: 'create', newValues: row, ...audit.ctx(req) });
    return row;
  });
  res.status(201).json({ status: 'success', data: created });
};

/** Draft or issued invoice billed with this card: it follows the change (draft recalculated, issued brought up to date). */
async function rateCardInOpenBatch(conn, rateCardId) {
  const [rows] = await conn.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.rate_card_id = ? AND b.status = 'Generated' ORDER BY b.eq_batch_id DESC LIMIT 1`, [rateCardId]);
  return rows[0] ? rows[0].eq_batch_id : null;
}

/**
 * 409 when a close / "change from a date" would move days billed with the card by an invoice handed over to finance
 * (or withdrawn, for a non-Admin). Draft and issued invoices follow the change by themselves.
 */
function billedConflict(billed, hint) {
  const { date, eq_batch_id: batchId, state } = billed;
  const where = state === 'returned' ? 'withdrawn from finance (the Admin changes it)' : 'handed over to finance';
  return AppError.conflict('RATE_CARD_LOCKED', `Invoice batch #${batchId}, ${where}, bills this card up to ${date}. ${hint}. `
    + 'To change a price already handed over: withdraw the invoice from finance first, or make a debit / credit note.', { eq_batch_id: batchId, billed_up_to: date, batch_state: state });
}

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { ...FIELDS, reason: v.string({ max: 500 }) });
  const reason = d.reason ? d.reason.trim() : ''; delete d.reason;
  const updated = await withTransaction(async (conn) => {
    const before = await C.loadRateCard(conn, id, true);
    const lockedBy = await C.rateCardLocked(conn, id);
    if (lockedBy) {
      throw AppError.conflict('RATE_CARD_LOCKED', `This rate card is used by invoice batch #${lockedBy}, handed over to finance. Use "Change from a date" for the future; `
        + 'to change a price already handed over, withdraw the invoice from finance first, or make a debit / credit note.', { eq_batch_id: lockedBy });
    }
    // 14 Oct 2026: a draft or issued invoice using the card follows the change (it is recalculated / brought up to date)
    const generated = await rateCardInOpenBatch(conn, id);
    const card = checkCard({ ...before, overtime_enabled: Boolean(before.overtime_enabled), operator_included: Boolean(before.operator_included), ...d });
    const machine = await C.loadMachine(conn, before.equipment_id, true);
    await assertContractAndOverlap(conn, machine, card, id);
    await conn.execute(`UPDATE eq_rate_cards SET ${COLUMNS.map((k) => `${k} = ?`).join(', ')} WHERE rate_card_id = ?`, [...toDb(card), id]);
    const after = await C.loadRateCard(conn, id);
    await audit.log(conn, { table: 'eq_rate_cards', id, action: 'update', oldValues: before, newValues: after, reason: reason || null,
      payrollEffect: generated ? `stale:${generated}` : 'none', ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: updated });
};

exports.close = async (req, res) => {
  const id = parseId(req.params.id);
  const { effective_to } = validate(req.body, { effective_to: v.date({ required: true }) });
  const updated = await withTransaction(async (conn) => {
    const before = await C.loadRateCard(conn, id, true);
    if (effective_to < before.effective_from) throw AppError.validation({ effective_to: 'must be on or after effective_from' });
    if (before.effective_to && effective_to > before.effective_to) throw AppError.validation({ effective_to: 'can only shorten the card' });
    const billed = await C.rateCardBilledUpTo(conn, id);
    if (billed && effective_to < billed.date) throw billedConflict(billed, `Close it on ${billed.date} or later`);
    await conn.execute('UPDATE eq_rate_cards SET effective_to = ? WHERE rate_card_id = ?', [effective_to, id]);
    await audit.log(conn, { table: 'eq_rate_cards', id, action: 'close', oldValues: { effective_to: before.effective_to }, newValues: { effective_to }, ...audit.ctx(req) });
    return C.loadRateCard(conn, id);
  });
  res.json({ status: 'success', data: updated });
};

/**
 * "Test this price": body { rate_card: {...}, sample_rows: [{ day_status, gross_hours, break_hours, breakdown_hours, standby_hours }],
 *   fuel: [{liters, price_per_liter}], adjustments: [{amount, type, reason}], assigned_days, days_in_month }
 */
exports.preview = async (req, res) => {
  const body = req.body || {};
  const card = checkCard({ ...DEFAULTS, ...monthlyDefaults(validate(body.rate_card, { ...FIELDS, billing_mode: v.enumOf(['Hourly', 'Daily', 'Monthly'], { required: true }) })) });
  const rows = Array.isArray(body.sample_rows) ? body.sample_rows.slice(0, 62) : [];
  const toMin = (h) => Math.round(Number(h || 0) * 60);
  const engineRows = rows.map((r, i) => {
    const s = validate(r, {
      day_status: v.enumOf(['Working', 'Standby', 'Breakdown', 'Absent', 'Holiday'], { required: true }),
      gross_hours: HOURS(), break_hours: HOURS(), breakdown_hours: HOURS(), standby_hours: HOURS(), standby_paid_hours: HOURS(),
    });
    if (s.day_status === 'Working' && !(s.gross_hours > 0)) throw AppError.validation({ [`sample_rows[${i}].gross_hours`]: 'is required for Working' });
    // monthly: standby hours given by the accountant; default in the test = all the standby of the sample row
    const fullStandby = s.day_status === 'Standby' ? (toMin(s.gross_hours) || Math.round(Number(card.standard_hours_per_day) * 60)) : toMin(s.standby_hours);
    return { record_date: null, day_status: s.day_status, gross_minutes: toMin(s.gross_hours), break_minutes: toMin(s.break_hours), breakdown_minutes: toMin(s.breakdown_hours), standby_minutes: toMin(s.standby_hours),
      standby_credit_minutes: s.standby_paid_hours !== undefined && s.standby_paid_hours !== null ? toMin(s.standby_paid_hours) : fullStandby };
  });
  // Monthly: a real calendar month (working days = days minus the weekly day off)
  const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : businessToday().slice(0, 7);
  const wd = P.workingDaysOfMonth(month, await settings.getInt('eq_weekly_off_day'));
  const assigned = Math.min(wd, Number(body.assigned_working_days) || wd);
  // exception of the test month (amount, days, hourly price): typed in the test, else a normal month
  const typedD = Number.isInteger(Number(body.divisor)) && Number(body.divisor) >= 1 && Number(body.divisor) <= 31 ? Number(body.divisor) : null;
  const typedH = Number(body.hourly_rate) > 0 ? Math.round(Number(body.hourly_rate) * 10000) / 100 : null;
  const typedA = Number(body.monthly_amount) > 0 ? Math.round(Number(body.monthly_amount) * 100) : null;
  const ctx = { months: [{ month, daysInMonth: daysInMonth(month), assignedDays: assigned, workingDays: wd, assignedWorkingDays: assigned, holidayDays: Math.min(assigned, Number(body.holiday_days) || 0),
    divisor: typedD ?? wd, divisorSource: typedD ? 'manual' : 'calendar', amountCents: typedA, amountSource: typedA ? 'manual' : 'card', hourlyCents: typedH, hourlySource: typedH ? 'manual' : 'auto' }],
    offset: body.offset === true };
  const result = engine.billItem(engineRows, card, ctx, { fuel: body.fuel || [], adjustments: body.adjustments || [] });
  res.json({
    status: 'success',
    data: {
      lines: result.lines.map((l) => ({ ...l, unit_price: l.unit_price_exact ?? l.unit_price_cents / 100, amount: l.amount_cents / 100 })),
      gross: result.gross_cents / 100, deductions: result.deductions_cents / 100, net: result.net_cents / 100,
      totals: result.totals, monthly: result.monthly_details || null,
    },
  });
};

/**
 * Change a card FROM A DATE: the current card is closed the day before and a new card (old values + changes) starts.
 * The old card is never modified for the past, so invoices already issued keep their prices.
 */
exports.revise = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { ...FIELDS, effective_from: v.date({ required: true }) });
  delete d.vendor_contract_id;
  const created = await withTransaction(async (conn) => {
    const before = await C.loadRateCard(conn, id, true);
    if (d.effective_from <= before.effective_from) throw AppError.validation({ effective_from: `must be after the start of the current card (${before.effective_from})` });
    if (before.effective_to && d.effective_from > before.effective_to) throw AppError.validation({ effective_from: 'the current card already ended before that date' });
    const billed = await C.rateCardBilledUpTo(conn, id);
    const closeOn = addDays(d.effective_from, -1);
    if (billed && closeOn < billed.date) throw billedConflict(billed, `Choose a start date after ${billed.date}`);
    const { rate_card_id: _a, created_at: _b, updated_at: _c, created_by_user_id: _d, equipment_id: equipmentId, ...old } = before;
    const card = checkCard({ ...old, overtime_enabled: Boolean(before.overtime_enabled), operator_included: Boolean(before.operator_included), ...d, effective_to: before.effective_to });
    await conn.execute('UPDATE eq_rate_cards SET effective_to = ? WHERE rate_card_id = ?', [closeOn, id]);
    await audit.log(conn, { table: 'eq_rate_cards', id, action: 'close', oldValues: { effective_to: before.effective_to }, newValues: { effective_to: closeOn }, ...audit.ctx(req) });
    const machine = await C.loadMachine(conn, equipmentId, true);
    await assertContractAndOverlap(conn, machine, card);
    const [r] = await conn.execute(
      `INSERT INTO eq_rate_cards (equipment_id, ${COLUMNS.join(', ')}, created_by_user_id) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?)`,
      [equipmentId, ...toDb(card), req.user.user_id]);
    const row = await C.loadRateCard(conn, r.insertId);
    await audit.log(conn, { table: 'eq_rate_cards', id: r.insertId, action: 'revise', newValues: row, reason: `replaces card #${id} from ${d.effective_from}`, ...audit.ctx(req) });
    return row;
  });
  res.status(201).json({ status: 'success', data: created });
};
