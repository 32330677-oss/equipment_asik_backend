// services/equipment/eqDnr.js — DNR (Delivery Note Registry): per-unit prices of an existing vendor and the delivery notes
// billed with them. A DNR price never clashes with a rate card: the same machine may be paid by the hour for one job and
// per trip for another. In payroll, the delivery notes of one machine x site x currency form ONE item (billing_mode 'DNR').
'use strict';

const AppError = require('../../utils/AppError');
const { covers } = require('../../utils/ranges');

const UNITS = ['trip', 't', 'm3', 'km', 'pc', 'load'];
const UNIT_LABEL = { trip: 'trip', t: 'ton', m3: 'm3', km: 'km', pc: 'piece', load: 'load' };

const toCents = (v) => Math.round(Number(v || 0) * 100);
/** Money amount -> cents, rounded once (same rule as the billing engine). */
const exactCents = (amount) => Math.round(Number((Number(amount) * 100).toFixed(6)));

/** A DNR price applies to a machine when it is for that machine, or for every machine of the machine's vendor. */
function appliesTo(rate, machine) {
  if (Number(rate.vendor_id) !== Number(machine.vendor_id)) return false;
  return rate.equipment_id === null || rate.equipment_id === undefined || Number(rate.equipment_id) === Number(machine.equipment_id);
}

/** Active DNR prices (with contract currency) that apply to these machines and overlap [start, end]. One row per machine x price. */
async function ratesForMachines(conn, equipmentIds, start, end) {
  if (!equipmentIds.length) return [];
  const [rows] = await conn.query(
    `SELECT r.*, vc.currency, vc.contract_number, e.equipment_id AS for_equipment_id
     FROM eq_equipment e
     JOIN eq_dnr_rates r ON r.vendor_id = e.vendor_id AND (r.equipment_id IS NULL OR r.equipment_id = e.equipment_id)
     JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = r.vendor_contract_id
     WHERE e.equipment_id IN (?) AND r.status = 'Active' AND r.effective_from <= ? AND (r.effective_to IS NULL OR r.effective_to >= ?)
     ORDER BY r.item_name, r.effective_from`, [equipmentIds, end, start]);
  return rows;
}

/** Currency of the DNR prices of a machine on a date (first one found), or null. */
function currencyOn(rates, equipmentId, date) {
  const r = rates.find((x) => Number(x.for_equipment_id) === Number(equipmentId) && covers(x.effective_from, x.effective_to, String(date).slice(0, 10)));
  return r ? r.currency : null;
}

/** Load one DNR price with its contract (currency, contract dates). */
async function loadRate(conn, id, lock = false) {
  const [rows] = await conn.execute(
    `SELECT r.*, vc.currency, vc.contract_number, vc.start_date AS contract_start, vc.end_date AS contract_end, vc.status AS contract_status
     FROM eq_dnr_rates r JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = r.vendor_contract_id
     WHERE r.dnr_rate_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('DNR price');
  return rows[0];
}

/** Refuses a price that cannot be used for this machine on this date. */
function assertUsable(rate, machine, date) {
  if (rate.status !== 'Active') throw AppError.conflict('DNR_RATE_CANCELLED', 'This DNR price is cancelled.');
  if (!appliesTo(rate, machine)) throw AppError.conflict('DNR_RATE_OTHER_MACHINE', 'This DNR price is not for this machine (another vendor or another machine).');
  if (!covers(String(rate.effective_from).slice(0, 10), rate.effective_to ? String(rate.effective_to).slice(0, 10) : null, date)) {
    throw AppError.conflict('DNR_RATE_NOT_IN_FORCE', `This DNR price is valid from ${String(rate.effective_from).slice(0, 10)} to ${rate.effective_to ? String(rate.effective_to).slice(0, 10) : 'open'}, not on ${date}.`);
  }
}

/**
 * Bills one DNR group: { delivery_notes:[...], fuel:[...], adjustments:[...] }. Every delivery note is its own line
 * (traceable by source_table / source_id, so it is never paid twice). Fuel issued by us is deducted; adjustments as usual.
 */
function billGroup(g) {
  const lines = [];
  const notes = [...g.delivery_notes].sort((a, b) => String(a.note_date).localeCompare(String(b.note_date)) || String(a.dn_number).localeCompare(String(b.dn_number)));
  for (const dn of notes) {
    const qty = Number(dn.quantity); const price = Number(dn.unit_price);
    const route = dn.from_location || dn.to_location ? ` | ${dn.from_location || '?'} > ${dn.to_location || '?'}` : '';
    lines.push({
      line_type: 'DeliveryNote', quantity: qty, unit: dn.unit, unit_price_cents: Math.round(price * 100), unit_price_exact: price,
      amount_cents: exactCents(qty * price), source_table: 'eq_delivery_notes', source_id: dn.delivery_note_id,
      note: `DN ${dn.dn_number} | ${String(dn.note_date).slice(0, 10)} | ${dn.item_name}${dn.material ? ` (${dn.material})` : ''}${route}`.slice(0, 500),
    });
  }
  for (const f of g.fuel) {
    const price = Number(f.price_per_liter || 0);
    lines.push({ line_type: 'Fuel', quantity: Number(f.liters), unit: 'L', unit_price_cents: Math.round(price * 100), unit_price_exact: price,
      amount_cents: -exactCents(Number(f.liters) * price), source_table: 'eq_fuel_issues', source_id: f.fuel_issue_id,
      note: `${String(f.issue_date).slice(0, 10)}${f.receipt_number ? ` receipt ${f.receipt_number}` : ''}` });
  }
  for (const a of g.adjustments) {
    lines.push({ line_type: 'Adjustment', quantity: 1, unit: 'item', unit_price_cents: toCents(a.amount), amount_cents: toCents(a.amount),
      source_table: 'eq_adjustments', source_id: a.adjustment_id, note: `${a.adjustment_type}: ${a.reason}` });
  }
  const gross = lines.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const deductions = -lines.filter((l) => l.amount_cents < 0).reduce((s, l) => s + l.amount_cents, 0);
  const rates = new Map();
  for (const dn of notes) {
    if (!rates.has(dn.dnr_rate_id)) {
      rates.set(dn.dnr_rate_id, { dnr_rate_id: dn.dnr_rate_id, item_name: dn.item_name, unit: dn.unit, contract_number: dn.contract_number });
    }
  }
  const snapshot = {
    billing_mode: 'DNR', currency: g.currency, vendor_id: g.vendor_id,
    contract_number: [...new Set(notes.map((dn) => dn.contract_number).filter(Boolean))].join(', ') || g.contract_number || null,
    dnr_rates: [...rates.values()],
    delivery_notes: notes.map((dn) => ({
      delivery_note_id: dn.delivery_note_id, dn_number: dn.dn_number, note_date: String(dn.note_date).slice(0, 10), item_name: dn.item_name,
      unit: dn.unit, quantity: Number(dn.quantity), unit_price: Number(dn.unit_price), amount: exactCents(Number(dn.quantity) * Number(dn.unit_price)) / 100,
      from_location: dn.from_location || null, to_location: dn.to_location || null, material: dn.material || null, driver_name: dn.driver_name || null,
    })),
  };
  return {
    equipment_id: g.equipment_id, vendor_id: g.vendor_id, site_id: g.site_id, currency: g.currency,
    rate_card_id: null, rate_snapshot: snapshot, fuel_diff: null, monthly_calc: null, billing_mode: 'DNR',
    days_recorded: notes.length, worked_days: new Set(notes.map((dn) => String(dn.note_date).slice(0, 10))).size,
    work_minutes: 0, overtime_minutes: 0, standby_minutes: 0, breakdown_minutes: 0, topup_minutes: 0,
    gross_cents: gross, deductions_cents: deductions, net_cents: gross - deductions,
    lines, per_row: [], months: null, site_allocation: null,
  };
}

module.exports = { UNITS, UNIT_LABEL, appliesTo, ratesForMachines, currencyOn, loadRate, assertUsable, billGroup, exactCents };
