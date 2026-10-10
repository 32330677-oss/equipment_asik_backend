// services/equipment/eqSettlement.js — what is still owed on a FINALIZED payroll batch, per vendor.
//
//   balance = vendor invoice (net of its items) + balances carried IN from older batches - payments - balance carried OUT
//
// * The vendor invoice issued at finalize is never changed: payments are separate records with their own official voucher
//   number (PV-YYYY-00001), and the statement of account shows the running balance.
// * A payment can never be larger than the balance (no over-payment).
// * "Add previous balances" on New payroll moves the unpaid balance of an older finalized batch into the new one
//   (eq_payment_carryovers). The old batch is then closed as "carried forward" (balance 0, no more payments there);
//   voiding the new batch releases the carry and the old balance is open again.
// * An OPENING BALANCE (eq_opening_balances, money owed from before the system) is carried the same way: the carry row has
//   opening_balance_id instead of from_batch_id, and the statement of account prints it on its own line.
// * The batch status follows the money: 'Paid' when every vendor balance is 0 (or below) and nothing was carried out;
//   back to 'Generated' (finalized, waiting for payment) when a payment is reversed.
// * Batches marked paid before payments existed (status 'Paid', no payment row) are kept as fully paid (legacy).
'use strict';

const AppError = require('../../utils/AppError');
const { businessNow, businessToday } = require('../../utils/businessDate');
const { toDecimalString } = require('../../utils/money');
const audit = require('../audit');

const cents = (v) => Math.round(Number(v || 0) * 100);
const day = (d) => (d ? String(d).slice(0, 10) : null);
const METHODS = ['BankTransfer', 'Cheque', 'Cash', 'Other'];

async function loadBatch(conn, id, lock = false) {
  const [[b]] = await conn.execute(`SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!b) throw AppError.notFound('Payroll batch');
  return b;
}

const isOpenForMoney = (b) => Number(b.is_finalized) === 1 && (b.status === 'Generated' || b.status === 'Paid');

/**
 * Money of a batch, per vendor (amounts in cents). Works for any batch; `payable` says whether payments may be recorded.
 * Returns { vendors: [...], totals: {...}, payment_status, legacy_paid, payable }.
 */
async function balances(conn, batch) {
  const id = batch.eq_batch_id;
  const [own] = await conn.execute(
    `SELECT i.vendor_id, vd.vendor_name, vd.vendor_code, SUM(i.net_amount) AS net FROM eq_payroll_items i JOIN eq_vendors vd ON vd.vendor_id = i.vendor_id
     WHERE i.eq_batch_id = ? GROUP BY i.vendor_id, vd.vendor_name, vd.vendor_code`, [id]);
  const [cin] = await conn.execute(
    `SELECT c.*, COALESCE(b.start_date, ob.period_from) AS start_date, COALESCE(b.end_date, ob.period_to) AS end_date, b.version_number,
       ob.as_of_date, ob.description AS ob_description, ob.reference AS ob_reference, e.equipment_code AS ob_equipment_code,
       COALESCE((SELECT x.invoice_no FROM eq_invoices x WHERE x.eq_batch_id = c.from_batch_id AND x.kind = 'Vendor' AND x.vendor_id = c.vendor_id ORDER BY x.invoice_id DESC LIMIT 1),
         ob.reference) AS invoice_no
     FROM eq_payment_carryovers c LEFT JOIN eq_payroll_batches b ON b.eq_batch_id = c.from_batch_id
     LEFT JOIN eq_opening_balances ob ON ob.opening_balance_id = c.opening_balance_id LEFT JOIN eq_equipment e ON e.equipment_id = ob.equipment_id
     WHERE c.to_batch_id = ? AND c.status = 'Active' ORDER BY c.carryover_id`, [id]);
  const [cout] = await conn.execute(
    `SELECT c.*, b.start_date, b.end_date, b.status AS to_status, b.is_finalized AS to_finalized
     FROM eq_payment_carryovers c JOIN eq_payroll_batches b ON b.eq_batch_id = c.to_batch_id WHERE c.from_batch_id = ? AND c.status = 'Active' ORDER BY c.carryover_id`, [id]);
  const [pays] = await conn.execute(
    `SELECT p.*, u.full_name AS created_by, r.full_name AS reversed_by FROM eq_payments p JOIN users u ON u.user_id = p.created_by_user_id
     LEFT JOIN users r ON r.user_id = p.reversed_by_user_id WHERE p.eq_batch_id = ? ORDER BY p.payment_id`, [id]);
  const [inv] = await conn.execute(
    `SELECT i.invoice_id, i.invoice_no, i.vendor_id, i.amount, (c.invoice_id IS NOT NULL) AS cancelled FROM eq_invoices i
     LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id WHERE i.eq_batch_id = ? AND i.kind = 'Vendor'`, [id]);
  const legacyPaid = batch.status === 'Paid' && pays.length === 0;
  const byVendor = new Map();
  const get = (vid, name, code) => {
    if (!byVendor.has(vid)) {
      byVendor.set(vid, { vendor_id: vid, vendor_name: name || null, vendor_code: code || null, own: 0, carried_in: 0, paid: 0, carried_out: 0, carried_in_detail: [], carried_out_detail: [], payments: [] });
    }
    const x = byVendor.get(vid);
    if (!x.vendor_name && name) x.vendor_name = name;
    return x;
  };
  for (const r of own) get(r.vendor_id, r.vendor_name, r.vendor_code).own += cents(r.net);
  for (const c of cin) {
    const x = get(c.vendor_id);
    x.carried_in += cents(c.amount);
    x.carried_in_detail.push({ carryover_id: c.carryover_id, from_batch_id: c.from_batch_id, start_date: day(c.start_date), end_date: day(c.end_date), invoice_no: c.invoice_no || null, amount: toDecimalString(cents(c.amount)),
      kind: c.opening_balance_id ? 'opening' : 'batch', opening_balance_id: c.opening_balance_id || null, as_of_date: day(c.as_of_date),
      description: c.ob_description || null, equipment_code: c.ob_equipment_code || null });
  }
  for (const c of cout) {
    const x = get(c.vendor_id);
    x.carried_out += cents(c.amount);
    x.carried_out_detail.push({ carryover_id: c.carryover_id, to_batch_id: c.to_batch_id, start_date: day(c.start_date), end_date: day(c.end_date), amount: toDecimalString(cents(c.amount)),
      to_state: c.to_status === 'Generated' ? (Number(c.to_finalized) ? 'Finalized' : 'Draft') : c.to_status });
  }
  for (const p of pays) {
    const x = get(p.vendor_id);
    if (p.status === 'Active') x.paid += cents(p.amount);
    x.payments.push(paymentView(p));
  }
  // vendor names for vendors that only have a carried balance
  const unnamed = [...byVendor.values()].filter((x) => !x.vendor_name).map((x) => x.vendor_id);
  if (unnamed.length) {
    const [names] = await conn.query('SELECT vendor_id, vendor_name, vendor_code FROM eq_vendors WHERE vendor_id IN (?)', [unnamed]);
    for (const n of names) Object.assign(byVendor.get(n.vendor_id), { vendor_name: n.vendor_name, vendor_code: n.vendor_code });
  }
  const vendors = [...byVendor.values()].map((x) => {
    const due = x.own + x.carried_in;
    const paid = legacyPaid ? Math.max(0, due - x.carried_out) : x.paid;
    const balance = due - paid - x.carried_out;
    const invoice = inv.find((i) => i.vendor_id === x.vendor_id && !Number(i.cancelled)) || null;
    let status;
    if (balance <= 0 && x.carried_out > 0) status = 'CarriedForward';
    else if (balance <= 0) status = due > 0 ? 'Paid' : 'NothingDue';
    else if (paid > 0 || x.carried_out > 0) status = 'PartiallyPaid';
    else status = 'Unpaid';
    return {
      vendor_id: x.vendor_id, vendor_name: x.vendor_name, vendor_code: x.vendor_code, invoice_id: invoice ? invoice.invoice_id : null, invoice_no: invoice ? invoice.invoice_no : null,
      invoice_amount: toDecimalString(x.own), carried_in: toDecimalString(x.carried_in), total_due: toDecimalString(due), paid: toDecimalString(paid),
      carried_out: toDecimalString(x.carried_out), balance: toDecimalString(balance), payment_status: status,
      carried_in_detail: x.carried_in_detail, carried_out_detail: x.carried_out_detail, payments: x.payments,
      _due: due, _paid: paid, _out: x.carried_out, _balance: balance,
    };
  }).sort((a, b) => String(a.vendor_name).localeCompare(String(b.vendor_name)));
  const sum = (k) => vendors.reduce((a, x) => a + x[k], 0);
  const t = { due: sum('_due'), paid: sum('_paid'), out: sum('_out'), owed: vendors.reduce((a, x) => a + Math.max(0, x._balance), 0) };
  let paymentStatus = null;
  if (isOpenForMoney(batch)) {
    if (vendors.every((x) => x._balance <= 0)) paymentStatus = t.out > 0 ? 'CarriedForward' : 'Paid';
    else paymentStatus = t.paid > 0 || t.out > 0 ? 'PartiallyPaid' : 'Unpaid';
  }
  return {
    vendors: vendors.map(({ _due, _paid, _out, _balance, ...x }) => x),
    totals: { total_due: toDecimalString(t.due), paid: toDecimalString(t.paid), carried_out: toDecimalString(t.out), balance: toDecimalString(t.owed) },
    payment_status: paymentStatus, legacy_paid: legacyPaid, payable: isOpenForMoney(batch) && batch.status === 'Generated' && t.owed > 0,
    _vendors: vendors, _totals: t,
  };
}

function paymentView(p) {
  return {
    payment_id: p.payment_id, voucher_no: p.voucher_no, eq_batch_id: p.eq_batch_id, vendor_id: p.vendor_id, invoice_id: p.invoice_id, currency: p.currency,
    amount: toDecimalString(cents(p.amount)), paid_on: day(p.paid_on), method: p.method, reference: p.reference, note: p.note, source: p.source,
    balance_before: toDecimalString(cents(p.balance_before)), balance_after: toDecimalString(cents(p.balance_after)), status: p.status,
    created_by: p.created_by || null, created_at: p.created_at, reversed_by: p.reversed_by || null, reversed_at: p.reversed_at, reverse_reason: p.reverse_reason,
  };
}

/** Balance of one vendor in a batch (cents), with the row used. */
async function vendorBalance(conn, batch, vendorId) {
  const s = await balances(conn, batch);
  const x = s._vendors.find((v) => v.vendor_id === vendorId);
  if (!x) throw AppError.notFound('Vendor in this batch');
  return { s, x };
}

/**
 * Status follows the money (finalized active batches only, legacy paid batches untouched):
 * 'Paid' when every vendor balance is 0 or below, nothing was carried out, and something was paid (or nothing was due).
 */
async function refreshStatus(conn, batchId, { userId, paidAt = null, reason = null, ip = null } = {}) {
  const b = await loadBatch(conn, batchId, true);
  if (!isOpenForMoney(b)) return b.status;
  const s = await balances(conn, b);
  if (s.legacy_paid) return b.status;
  const settled = s._vendors.every((x) => x._balance <= 0) && s._totals.out === 0 && (s._totals.paid > 0 || s._totals.due <= 0);
  const now = businessNow();
  if (settled && b.status === 'Generated') {
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Paid', paid_by_user_id = ?, paid_at = ?, paid_marked_at = ? WHERE eq_batch_id = ?",
      [userId, paidAt || now, now, batchId]);
    await audit.log(conn, { table: 'eq_payroll_batches', id: batchId, action: 'paid_in_full', oldValues: { status: 'Generated' }, newValues: { status: 'Paid', paid_at: paidAt || now }, reason, userId, ip });
    return 'Paid';
  }
  if (!settled && b.status === 'Paid') {
    await conn.execute("UPDATE eq_payroll_batches SET status = 'Generated', paid_by_user_id = NULL, paid_at = NULL, paid_marked_at = NULL WHERE eq_batch_id = ?", [batchId]);
    await audit.log(conn, { table: 'eq_payroll_batches', id: batchId, action: 'reopened_for_payment', oldValues: { status: 'Paid', paid_at: b.paid_at }, newValues: { status: 'Generated' }, reason, userId, ip });
    return 'Generated';
  }
  return b.status;
}

async function nextVoucherNo(conn, year) {
  await conn.execute("INSERT IGNORE INTO eq_invoice_counters (kind, year, last_seq) VALUES ('PaymentVoucher', ?, 0)", [year]);
  const [[c]] = await conn.execute("SELECT last_seq FROM eq_invoice_counters WHERE kind = 'PaymentVoucher' AND year = ? FOR UPDATE", [year]);
  const seq = Number(c.last_seq) + 1;
  await conn.execute("UPDATE eq_invoice_counters SET last_seq = ? WHERE kind = 'PaymentVoucher' AND year = ?", [seq, year]);
  return `PV-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Records one payment (inside the caller's transaction). amountCents > 0 and <= balance. Returns the payment view.
 * The batch row must already be locked by the caller (loadBatch(..., true)).
 */
async function recordPayment(conn, batch, { vendorId, amountCents, paidOn, method = 'BankTransfer', reference = null, note = null, source = 'Payment', userId, ip = null }) {
  if (!isOpenForMoney(batch)) throw AppError.conflict('BATCH_STATE', 'Payments are recorded on a FINALIZED batch (finalize it first).');
  if (batch.status !== 'Generated') throw AppError.conflict('BATCH_STATE', 'This batch is already paid in full.');
  if (!(amountCents > 0)) throw AppError.validation({ amount: 'must be more than 0' });
  if (!METHODS.includes(method)) throw AppError.validation({ method: `must be one of: ${METHODS.join(', ')}` });
  if (paidOn > businessToday()) throw AppError.validation({ paid_on: 'cannot be in the future' });
  const { x } = await vendorBalance(conn, batch, vendorId);
  if (x._out > 0 && x._balance <= 0) throw AppError.conflict('BALANCE_CARRIED_FORWARD', `The balance of ${x.vendor_name} was carried to batch #${x.carried_out_detail[0].to_batch_id}: pay it there.`);
  if (x._balance <= 0) throw AppError.conflict('NOTHING_TO_PAY', `Nothing is owed to ${x.vendor_name} on this batch.`);
  if (amountCents > x._balance) {
    throw AppError.conflict('OVERPAYMENT', `The payment (${toDecimalString(amountCents)}) is more than the balance of ${x.vendor_name} (${toDecimalString(x._balance)} ${batch.currency}).`,
      { balance: toDecimalString(x._balance) });
  }
  const voucher = await nextVoucherNo(conn, Number(String(paidOn).slice(0, 4)) || Number(businessToday().slice(0, 4)));
  const [r] = await conn.execute(
    `INSERT INTO eq_payments (voucher_no, eq_batch_id, vendor_id, invoice_id, currency, amount, paid_on, method, reference, note, source, balance_before, balance_after, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [voucher, batch.eq_batch_id, vendorId, x.invoice_id, batch.currency, toDecimalString(amountCents), paidOn, method, reference || null, note || null, source,
      toDecimalString(x._balance), toDecimalString(x._balance - amountCents), userId, businessNow()]);
  const [[p]] = await conn.execute('SELECT p.*, u.full_name AS created_by FROM eq_payments p JOIN users u ON u.user_id = p.created_by_user_id WHERE p.payment_id = ?', [r.insertId]);
  await audit.log(conn, { table: 'eq_payments', id: r.insertId, action: source === 'MarkPaid' ? 'create_mark_paid' : 'create', newValues: paymentView(p),
    relatedType: 'eq_payroll_batches', relatedId: batch.eq_batch_id, userId, ip });
  return paymentView(p);
}

/** Reverses a payment (kept, marked Reversed). Refused when the vendor balance of that batch was carried to a later batch. */
async function reversePayment(conn, paymentId, { reason, userId, ip = null }) {
  const [[p]] = await conn.execute('SELECT * FROM eq_payments WHERE payment_id = ? FOR UPDATE', [paymentId]);
  if (!p) throw AppError.notFound('Payment');
  if (p.status !== 'Active') throw AppError.conflict('INVALID_STATE', 'This payment is already reversed.');
  const b = await loadBatch(conn, p.eq_batch_id, true);
  const [[co]] = await conn.execute("SELECT to_batch_id FROM eq_payment_carryovers WHERE from_batch_id = ? AND vendor_id = ? AND status = 'Active' LIMIT 1", [p.eq_batch_id, p.vendor_id]);
  if (co) {
    throw AppError.conflict('BALANCE_CARRIED_FORWARD', `The rest of this invoice was carried to batch #${co.to_batch_id}. Void that batch first (it releases the carried balance), then reverse this payment.`);
  }
  await conn.execute("UPDATE eq_payments SET status = 'Reversed', reversed_by_user_id = ?, reversed_at = ?, reverse_reason = ? WHERE payment_id = ?",
    [userId, businessNow(), reason, paymentId]);
  await audit.log(conn, { table: 'eq_payments', id: paymentId, action: 'reverse', oldValues: { status: 'Active' }, newValues: { status: 'Reversed' }, reason,
    relatedType: 'eq_payroll_batches', relatedId: p.eq_batch_id, userId, ip });
  await refreshStatus(conn, p.eq_batch_id, { userId, reason: `payment ${p.voucher_no} reversed: ${reason}`, ip });
  return { payment: p, batch: b };
}

/** Void / new version are refused once money moved on a batch (payments or a balance carried to another batch). */
async function assertNoMoneyMoved(conn, batchId) {
  const [[p]] = await conn.execute("SELECT voucher_no FROM eq_payments WHERE eq_batch_id = ? AND status = 'Active' LIMIT 1", [batchId]);
  if (p) throw AppError.conflict('BATCH_HAS_PAYMENTS', `Payment ${p.voucher_no} is recorded on this batch. Reverse its payments first; a difference is otherwise settled with an official Correction.`);
  const [[c]] = await conn.execute("SELECT to_batch_id FROM eq_payment_carryovers WHERE from_batch_id = ? AND status = 'Active' LIMIT 1", [batchId]);
  if (c) throw AppError.conflict('BATCH_CARRIED_FORWARD', `The balance of this batch was carried into batch #${c.to_batch_id}. Void that batch first.`);
}

/**
 * Older finalized batches (same currency, ending before `beforeDate`) with a balance still owed to these vendors.
 * Returns [{ from_batch_id, vendor_id, vendor_name, amount_cents, start_date, end_date, invoice_no }].
 */
async function carryCandidates(conn, { vendorIds, currency, beforeDate, excludeBatchId = 0, lock = false }) {
  if (!vendorIds.length) return [];
  const [batches] = await conn.query(
    `SELECT b.* FROM eq_payroll_batches b
     WHERE b.status = 'Generated' AND b.is_finalized = 1 AND b.currency = ? AND b.end_date < ? AND b.eq_batch_id <> ?
       AND (EXISTS (SELECT 1 FROM eq_payroll_items i WHERE i.eq_batch_id = b.eq_batch_id AND i.vendor_id IN (?))
         OR EXISTS (SELECT 1 FROM eq_payment_carryovers c WHERE c.to_batch_id = b.eq_batch_id AND c.status = 'Active' AND c.vendor_id IN (?)))
     ORDER BY b.end_date, b.eq_batch_id${lock ? ' FOR UPDATE' : ''}`, [currency, beforeDate, excludeBatchId || 0, vendorIds, vendorIds]);
  const out = [];
  for (const b of batches) {
    const s = await balances(conn, b);
    for (const x of s._vendors) {
      if (!vendorIds.includes(x.vendor_id) || x._balance <= 0) continue;
      out.push({ from_batch_id: b.eq_batch_id, vendor_id: x.vendor_id, vendor_name: x.vendor_name, amount_cents: x._balance,
        amount: toDecimalString(x._balance), start_date: day(b.start_date), end_date: day(b.end_date), invoice_no: x.invoice_no, currency });
    }
  }
  // opening balances (money owed from before the system) that are not carried into an active batch yet
  const [obs] = await conn.query(
    `SELECT ob.*, vd.vendor_name, e.equipment_code FROM eq_opening_balances ob JOIN eq_vendors vd ON vd.vendor_id = ob.vendor_id
     LEFT JOIN eq_equipment e ON e.equipment_id = ob.equipment_id
     WHERE ob.status = 'Active' AND ob.currency = ? AND ob.as_of_date < ? AND ob.vendor_id IN (?)
       AND NOT EXISTS (SELECT 1 FROM eq_payment_carryovers c WHERE c.opening_balance_id = ob.opening_balance_id AND c.status = 'Active')
     ORDER BY ob.as_of_date, ob.opening_balance_id${lock ? ' FOR UPDATE' : ''}`, [currency, beforeDate, vendorIds]);
  for (const ob of obs) {
    out.push({ from_batch_id: null, opening_balance_id: ob.opening_balance_id, kind: 'opening', vendor_id: ob.vendor_id, vendor_name: ob.vendor_name,
      amount_cents: cents(ob.amount), amount: toDecimalString(cents(ob.amount)), start_date: day(ob.period_from), end_date: day(ob.period_to),
      as_of_date: day(ob.as_of_date), description: ob.description, equipment_code: ob.equipment_code || null, invoice_no: ob.reference || null, currency });
  }
  return out;
}

/** "Add previous balances": moves every candidate balance into the new batch (inside the generate transaction). */
async function applyCarryForward(conn, { toBatchId, vendorIds, currency, beforeDate, userId, ip = null }) {
  const list = await carryCandidates(conn, { vendorIds, currency, beforeDate, excludeBatchId: toBatchId, lock: true });
  const now = businessNow();
  for (const c of list) {
    const [r] = await conn.execute(
      'INSERT INTO eq_payment_carryovers (from_batch_id, opening_balance_id, to_batch_id, vendor_id, currency, amount, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [c.from_batch_id || null, c.opening_balance_id || null, toBatchId, c.vendor_id, currency, toDecimalString(c.amount_cents), userId, now]);
    await audit.log(conn, { table: 'eq_payment_carryovers', id: r.insertId, action: 'carry_forward', newValues: { ...c, to_batch_id: toBatchId },
      relatedType: 'eq_payroll_batches', relatedId: toBatchId, userId, ip });
  }
  return list;
}

/** Releases the balances carried INTO a batch (it is voided): the old batches owe them again. */
async function releaseCarryIns(conn, batchId, { reason, userId, ip = null }) {
  const [rows] = await conn.execute("SELECT * FROM eq_payment_carryovers WHERE to_batch_id = ? AND status = 'Active' FOR UPDATE", [batchId]);
  for (const c of rows) {
    await conn.execute("UPDATE eq_payment_carryovers SET status = 'Released', released_reason = ?, released_by_user_id = ?, released_at = ? WHERE carryover_id = ?",
      [String(reason || '').slice(0, 500), userId, businessNow(), c.carryover_id]);
    await audit.log(conn, { table: 'eq_payment_carryovers', id: c.carryover_id, action: 'release', reason,
      relatedType: c.from_batch_id ? 'eq_payroll_batches' : 'eq_opening_balances', relatedId: c.from_batch_id || c.opening_balance_id, userId, ip });
    // an opening balance has no batch: it is simply open again
    if (c.from_batch_id) await refreshStatus(conn, c.from_batch_id, { userId, reason: `carried balance released: ${reason}`, ip });
  }
  return rows.length;
}

/** A new version replaces a batch: its carried-in balances follow the new version (released for a vendor no longer in it). */
async function moveCarryIns(conn, fromBatchId, toBatchId, vendorIds, { reason, userId, ip = null }) {
  const [rows] = await conn.execute("SELECT * FROM eq_payment_carryovers WHERE to_batch_id = ? AND status = 'Active' FOR UPDATE", [fromBatchId]);
  for (const c of rows) {
    if (vendorIds.includes(c.vendor_id)) {
      await conn.execute('UPDATE eq_payment_carryovers SET to_batch_id = ? WHERE carryover_id = ?', [toBatchId, c.carryover_id]);
      await audit.log(conn, { table: 'eq_payment_carryovers', id: c.carryover_id, action: 'move', oldValues: { to_batch_id: fromBatchId }, newValues: { to_batch_id: toBatchId }, reason, userId, ip });
    } else {
      await conn.execute("UPDATE eq_payment_carryovers SET status = 'Released', released_reason = ?, released_by_user_id = ?, released_at = ? WHERE carryover_id = ?",
        [`vendor not in new version #${toBatchId}`, userId, businessNow(), c.carryover_id]);
      await audit.log(conn, { table: 'eq_payment_carryovers', id: c.carryover_id, action: 'release', reason: `vendor not in new version #${toBatchId}`, userId, ip });
      if (c.from_batch_id) await refreshStatus(conn, c.from_batch_id, { userId, reason: 'carried balance released', ip });
    }
  }
}

module.exports = {
  METHODS, balances, paymentView, vendorBalance, refreshStatus, recordPayment, reversePayment, assertNoMoneyMoved,
  carryCandidates, applyCarryForward, releaseCarryIns, moveCarryIns, isOpenForMoney,
};
