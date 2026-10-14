// P10 — edit / lock policy (14 Oct 2026): an issued invoice still in the office follows the changes with the same
// number; once handed over to finance nothing of its days changes; a draft turns stale when anything that moves money
// changes.
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
  oct = await h.issue(oct.eq_batch_id);
});
after(h.closePool);

const code = async (req) => (await req).body.code;

test('issued, still in the office: fuel and adjustments of its period are added, the invoice keeps its number (14 Oct 2026)', async () => {
  const no = (await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()))).vendor_invoice_no;
  assert.strictEqual(no, 'VI-2026-00001');
  const f = await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-20', liters: 50, price_per_liter: 1 }));
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-11-02', liters: 50, price_per_liter: 1 }));
  const a = await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-15', adjustment_type: 'Bonus', amount: 10, reason: 'x' }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-11-15', adjustment_type: 'Bonus', amount: 10, reason: 'x' }));
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.needs_refresh, true);
  const r = await ok(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/refresh`).set(ACC()).send({}));
  assert.notStrictEqual(r.eq_batch_id, oct.eq_batch_id, 'a new calculation of the same invoice');
  assert.strictEqual(r.vendor_invoice_no, 'VI-2026-00001', 'same number');
  assert.strictEqual(r.state, 'issued');
  assert.ok(r.items.flatMap((i) => i.lines).find((l) => l.line_type === 'Adjustment'));
  const [log] = await h.query("SELECT reason FROM audit_logs WHERE table_name = 'eq_payroll_batches' AND record_id = ? AND action_type = 'invoice_updated'", [r.eq_batch_id]);
  assert.ok(log, 'the change is kept in the audit log');
  // a new invoice over the same days is refused, with the invoice that covers them
  const ov = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id });
  assert.strictEqual(ov.body.code, 'PERIOD_OVERLAP');
  assert.strictEqual(ov.body.details.overlaps[0].conflicts[0].invoice_no, 'VI-2026-00001');
  // back as it was: the invoice follows again (same number)
  await ok(h.api().patch(`/api/equipment/fuel-issues/${f.fuel_issue_id}/cancel`).set(ACC()).send({ reason: 'test only' }));
  await ok(h.api().patch(`/api/equipment/adjustments/${a.adjustment_id}/cancel`).set(ACC()).send({ reason: 'test only' }));
  const r2 = await ok(h.api().post(`/api/equipment/payroll/batches/${r.eq_batch_id}/refresh`).set(ACC()).send({}));
  assert.strictEqual(r2.vendor_invoice_no, 'VI-2026-00001');
  assert.strictEqual(r2.total_net, oct.total_net);
  oct = r2;
  // handed over to finance: locked for everybody from now on
  await h.handOver(oct.eq_batch_id);
});

test('handed over: deployments, supervisor periods, rows and fuel of its days are refused', async () => {
  const deps = await ok(h.api().get(`/api/equipment/deployments?equipment_id=${F.exc.equipment_id}`).set(A()));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/deployments/${deps[0].eq_assignment_id}/end`).set(A()).send({ unassigned_date: '2026-10-04' })), 'INVOICE_LOCKED');
  assert.strictEqual(await code(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' })), 'INVOICE_LOCKED');
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-11-01' }));
  assert.strictEqual(await code(h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-10-15' })), 'INVOICE_LOCKED');
  await ok(h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-11-25' }));
  assert.strictEqual(await code(h.api().post('/api/equipment/fuel-issues').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-21', liters: 5, price_per_liter: 1 })), 'INVOICE_LOCKED');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/void`).set(A()).send({ reason: 'try' })), 'INVOICE_HANDED_OVER');
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/refresh`).set(A()).send({})), 'BATCH_STATE');
});

test('a draft turns stale when a fuel issue of its period changes', async () => {
  await workDay(F.exc, '2026-11-03', '07:00', '15:00');
  const nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  assert.strictEqual(nov.stale, false);
  assert.strictEqual(nov.state, 'draft');
  assert.ok(nov.settings_snapshot && nov.settings_snapshot.eq_weekly_off_day !== undefined, 'billing settings are frozen in the batch');
  const fuel = await ok(h.api().get(`/api/equipment/fuel-issues?equipment_id=${F.exc.equipment_id}&from=2026-11-01`).set(ACC()));
  // a price already set changes money: a reason is required (C4)
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-issues/${fuel[0].fuel_issue_id}`).set(ACC()).send({ price_per_liter: 1.25 })), 'VALIDATION_ERROR');
  await ok(h.api().patch(`/api/equipment/fuel-issues/${fuel[0].fuel_issue_id}`).set(ACC()).send({ price_per_liter: 1.25, reason: 'invoice price is 1.25' }));
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${nov.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  assert.strictEqual(d.needs_refresh, false, 'a draft is recalculated by hand');
  assert.ok(d.stale_reasons.find((r) => r.code === 'AMOUNT_CHANGED'));
  const v = await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/void`).set(ACC()).send({}));
  assert.strictEqual(v.status, 'Voided');
});

test('a debit note settles a difference on a handed-over invoice: a separate number, the invoice never changes', async () => {
  const n = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({
    kind: 'Debit', vendor_id: F.vendor.vendor_id, equipment_id: F.exc.equipment_id, currency: 'USD', amount: 80,
    reason: 'Signed sheet shows 17:00 on 5 Oct', ref_batch_id: oct.eq_batch_id, period_from: '2026-10-05', period_to: '2026-10-05' }));
  assert.strictEqual(n.status, 'Draft');
  assert.strictEqual(n.note_no, null);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/notes/${n.note_id}/issue`).set(ACC())), 'FORBIDDEN_ROLE');
  const issued = await ok(h.api().patch(`/api/equipment/payroll/notes/${n.note_id}/issue`).set(A()));
  assert.strictEqual(issued.note_no, 'DN-2026-00001');
  const batch = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(batch.total_net, oct.total_net, 'the handed-over invoice never changes');
  assert.ok(batch.notes.find((x) => x.note_id === n.note_id), 'the note is shown with its invoice');
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

test('the Admin edits an Approved row (reason optional, kept when given): it stays Approved, is flagged, and a draft turns stale', async () => {
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-10'", [F.exc.equipment_id]);
  const [row2] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-11'", [F.exc.equipment_id]);
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
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
  // inside an invoice handed over to finance the edit is refused: withdraw it first, or a debit / credit note
  const [oldRow] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${oldRow.eq_attendance_id}`).set(A()).send({ remarks: 'x', reason: 'try to edit' })), 'INVOICE_LOCKED');
});
