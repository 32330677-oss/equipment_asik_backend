// P23 — before the Finalize the office edits freely (11 Oct 2026): no mandatory reason on an approved row or on a void,
// "Recalculate" (new version) on a draft, void of a draft without a reason; a finalized batch still needs one.
const { test, before, after } = require('node:test');
const KNOWN_FAILING = { todo: 'known failing on main before CI was added (28 Oct 2026): see tests/KNOWN_FAILING.md' };
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; const rows = {};

async function workDay(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}
const OCT = () => ({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id });

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  rows.a = await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  rows.b = await workDay(F.exc, '2026-10-06', '07:00', '15:00');
  rows.c = await workDay(F.exc, '2026-10-07', '07:00', '15:00');
});
after(h.closePool);

test('the Admin edits an approved row without a reason: saved, flagged, audited', async () => {
  const e = await ok(h.api().patch(`/api/equipment/admin/attendance/${rows.a}`).set(A()).send({ check_out_time: '2026-10-05 16:00' }));
  assert.strictEqual(e.status, 'Approved');
  assert.strictEqual(e.edited_after_approval, true);
  assert.strictEqual(e.admin_edit_reason, null);
  const [log] = await h.query("SELECT changed_fields, reason FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? AND action_type = 'office_edit_after_approval'", [rows.a]);
  assert.ok(log, 'the change is in the history');
  assert.strictEqual(log.reason, null);
});

test('the Accountant edits an approved row without a reason too', async () => {
  const e = await ok(h.api().patch(`/api/equipment/admin/attendance/${rows.b}`).set(ACC()).send({ check_out_time: '2026-10-06 16:00' }));
  assert.strictEqual(e.edited_after_approval, true);
});

let draft;
test('a row inside a draft is edited: the draft turns stale and cannot be finalized', async () => {
  draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT()));
  assert.strictEqual(draft.stale, false);
  await ok(h.api().patch(`/api/equipment/admin/attendance/${rows.c}`).set(ACC()).send({ check_out_time: '2026-10-07 17:00' }));
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  assert.ok(d.stale_reasons.length > 0);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true })), 'BATCH_STALE');
});

let v2;
test('Recalculate (new version) of a draft without a reason: new numbers, no invoice number', KNOWN_FAILING, async () => {
  const res = await h.api().post(`/api/equipment/payroll/batches/${draft.eq_batch_id}/supersede`).set(ACC()).send({});
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  v2 = res.body.data;
  assert.strictEqual(v2.version_number, 2);
  assert.strictEqual(v2.is_finalized, false);
  assert.strictEqual(v2.stale, false);
  // 15:00 -> 17:00 on Oct 7: +2 h x 40
  assert.strictEqual(Math.round((Number(v2.total_net) - Number(draft.total_net)) * 100), 8000);
  assert.deepStrictEqual(v2.invoices, []);
  assert.deepStrictEqual(v2.reserved_numbers, []);
  const old = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(old.status, 'Superseded');
  assert.strictEqual(old.invoices.length, 0);
});

test('void of a draft without a reason', async () => {
  const v = await ok(h.api().patch(`/api/equipment/payroll/batches/${v2.eq_batch_id}/void`).set(ACC()).send({}));
  assert.strictEqual(v.status, 'Voided');
  assert.strictEqual(v.void_reason, null);
});

test('void of a finalized batch still needs a reason (validation error)', async () => {
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT()));
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  const r = await h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'VALIDATION_ERROR');
  // the void row of the office before the lock also needs no reason
  const late = await workDay(F.loader, '2026-11-02', '07:00', '15:00');
  const vr = await ok(h.api().patch(`/api/equipment/admin/attendance/${late}/cancel`).set(ACC()).send({}));
  assert.strictEqual(vr.status, 'Cancelled');
});
