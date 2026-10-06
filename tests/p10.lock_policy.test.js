// P10 — edit / lock policy, phase 1: nothing is entered inside a finalized period, a paid batch is never
// recalculated, and a generated batch turns stale when anything that moves money changes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
let F; let oct;

async function workDay(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}` }));
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: `${date} ${outT}` }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
});
after(h.closePool);

const code = async (req) => (await req).body.code;

test('fuel and adjustments cannot be dated inside a finalized period', async () => {
  assert.strictEqual(await code(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-20', liters: 50, price_per_liter: 1 })), 'PAYROLL_PERIOD_FINALIZED');
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-11-02', liters: 50, price_per_liter: 1 }));
  assert.strictEqual(await code(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-10-15', adjustment_type: 'Bonus', amount: 10, reason: 'x' })), 'PAYROLL_PERIOD_FINALIZED');
  assert.strictEqual(await code(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-15', adjustment_type: 'Bonus', amount: 10, reason: 'x' })), 'PAYROLL_PERIOD_FINALIZED');
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-11-15', adjustment_type: 'Bonus', amount: 10, reason: 'x' }));
});

test('deployments and supervisor periods cannot change finalized days', async () => {
  const deps = await ok(h.api().get(`/api/equipment/deployments?equipment_id=${F.exc.equipment_id}`).set(A()));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/deployments/${deps[0].eq_assignment_id}/end`).set(A()).send({ unassigned_date: '2026-10-10' })), 'PAYROLL_PERIOD_FINALIZED');
  assert.strictEqual(await code(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' })), 'PAYROLL_PERIOD_FINALIZED');
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-11-01' }));
  assert.strictEqual(await code(h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-10-15' })), 'PAYROLL_PERIOD_FINALIZED');
  await ok(h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-11-25' }));
});

test('a generated batch turns stale when a fuel issue of its period changes, not when remarks change', async () => {
  await workDay(F.exc, '2026-11-03', '07:00', '15:00');
  const nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  assert.strictEqual(nov.stale, false);
  assert.ok(nov.settings_snapshot && nov.settings_snapshot.eq_weekly_off_day !== undefined, 'billing settings are frozen in the batch');
  const fuel = await ok(h.api().get(`/api/equipment/fuel-issues?equipment_id=${F.exc.equipment_id}&from=2026-11-01`).set(ACC()));
  // a price already set changes money: a reason is required (C4)
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-issues/${fuel[0].fuel_issue_id}`).set(ACC()).send({ price_per_liter: 1.25 })), 'VALIDATION_ERROR');
  await ok(h.api().patch(`/api/equipment/fuel-issues/${fuel[0].fuel_issue_id}`).set(ACC()).send({ price_per_liter: 1.25, reason: 'invoice price is 1.25' }));
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${nov.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  assert.ok(d.stale_reasons.find((r) => r.code === 'AMOUNT_CHANGED'));
  const v = await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/void`).set(ACC()).send({ reason: 'fuel price corrected' }));
  assert.strictEqual(v.status, 'Voided');
});

test('official correction of a finalized day: difference at the batch prices, debit note, adjustment in the open period', async () => {
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  // paid 8 h x 40 = 320; the paper says 17:00 -> 10 h = 400 (overtime starts above 10 h): +80
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${row.eq_attendance_id}/correction`).set(A()).send({ reason: 'Signed sheet shows 17:00', changes: { check_out_time: '2026-10-05 17:00' } }));
  assert.strictEqual(Number(c.delta_amount), 80);
  assert.strictEqual(c.delta_detail.invoice_no, 'MI-2026-00001');
  await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/review`).set(ACC()).send({ note: 'matches the sheet' }));
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(done.note.kind, 'DebitNote');
  assert.strictEqual(Number(done.note.amount), 80);
  const [adj] = await h.query('SELECT amount, adjustment_date, reason FROM eq_adjustments WHERE correction_id = ?', [c.correction_id]);
  assert.strictEqual(Number(adj.amount), 80);
  assert.ok(adj.adjustment_date >= '2026-11-01');
  assert.match(adj.reason, /MI-2026-00001/);
  const batch = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(batch.total_net, oct.total_net, 'the finalized batch never changes');
});

test('a paid batch is never superseded; a voided finalized batch keeps its numbers, cancelled', async () => {
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/mark-paid`).set(A()));
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/supersede`).set(A()).send({ reason: 'recalc' })), 'BATCH_PAID');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/void`).set(A()).send({ reason: 'recalc' })), 'BATCH_STATE');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.ok(d.invoices.length && d.invoices.every((i) => !i.cancelled));
});

// ---------------------------------------------------------------- phase 3: flexibility before the lock
async function submitted(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}` }));
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: `${date} ${outT}` }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  return r.eq_attendance_id;
}

test('the supervisor recalls a Submitted row (reason kept) until the office approves it', async () => {
  const id = await submitted(F.exc, '2026-11-10', '07:00', '15:00');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${id}/recall`).set(S8()).send({})), 'VALIDATION_ERROR');
  const r = await ok(h.api().patch(`/api/equipment/attendance/${id}/recall`).set(S8()).send({ reason: 'wrong check-out' }));
  assert.strictEqual(r.status, 'Draft');
  await ok(h.api().patch(`/api/equipment/attendance/${id}`).set(S8()).send({ check_out_time: '2026-11-10 16:00' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-11-10' }));
  const [log] = await h.query("SELECT reason FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? AND action_type = 'recall'", [id]);
  assert.strictEqual(log.reason, 'wrong check-out');
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [id] }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${id}/recall`).set(S8()).send({ reason: 'too late' })), 'INVALID_STATE');

  const id2 = await submitted(F.exc, '2026-11-11', '07:00', '15:00');
  const day = await ok(h.api().post('/api/equipment/attendance/recall').set(S8()).send({ site_id: 8, record_date: '2026-11-11', reason: 'recount the day' }));
  assert.strictEqual(day.recalled, 1);
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-11-11' }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [id2] }));
});

test('the Admin edits an Approved row with a reason: it stays Approved, is flagged, and a generated batch turns stale', async () => {
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-10'", [F.exc.equipment_id]);
  const [row2] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-11'", [F.exc.equipment_id]);
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ check_out_time: '2026-11-10 17:00' })), 'VALIDATION_ERROR');
  const e = await ok(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ check_out_time: '2026-11-10 17:00', reason: 'Signed sheet says 17:00' }));
  assert.strictEqual(e.status, 'Approved');
  assert.strictEqual(e.edited_after_approval, true);
  assert.strictEqual(e.admin_edit_reason, 'Signed sheet says 17:00');
  const s = await ok(h.api().patch(`/api/equipment/admin/attendance/${row2.eq_attendance_id}`).set(A()).send({ day_status: 'Standby', remarks: 'no work front', reason: 'Machine was waiting all day' }));
  assert.strictEqual(s.day_status, 'Standby');
  assert.strictEqual(s.status, 'Approved');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(ACC()).send({ reason: 'rows edited' }));
  // inside a finalized period the edit is refused: corrections only
  const [oldRow] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${oldRow.eq_attendance_id}`).set(A()).send({ remarks: 'x', reason: 'try to edit' })), 'PAYROLL_PERIOD_FINALIZED');
});
