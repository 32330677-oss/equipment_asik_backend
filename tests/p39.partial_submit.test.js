// P39 — submit a day while some rows stay Draft (1 Nov 2026). Without leave_draft_ids nothing changed: a session still
// open refuses the day (OPEN_SESSIONS). With it, the other rows are submitted, the kept ones stay Draft (editable) and are
// submitted later the same way; the week gate still asks for them; an invoice without their machine is not blocked.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00 Syria time
const ACC = () => h.auth(h.T.accountant());
const D = '2026-10-27'; // Tuesday; the attendance week starts on Saturday (24 Oct - 30 Oct)
const submit = (body) => h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: D, ...body });
const statusOf = async (id) => (await h.query('SELECT status FROM eq_attendance WHERE eq_attendance_id = ?', [id]))[0].status;
let n = 0;

async function vendorMachine() {
  n += 1;
  const V = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: `P39 vendor ${n}` }));
  const C = await ok(h.api().post(`/api/equipment/vendors/${V.vendor_id}/contracts`).set(A()).send({ contract_number: `P39-${n}`, start_date: '2026-07-01', currency: 'USD' }));
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: V.vendor_id, type_id: 1, plate_number: `P39-${n}`, make: 'CAT' }));
  await ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A()).send({ vendor_contract_id: C.vendor_contract_id, effective_from: '2026-07-01', billing_mode: 'Hourly', hourly_rate: 10 }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-09-01' }));
  return { V, m };
}
const checkIn = async (m, date, out) => (await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({
  equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, ...(out ? { check_out_time: `${date} ${out}` } : {}), late_reason: 'paper sheet typed late',
}))).eq_attendance_id;

let X; let Y; let Z; const R = {};
before(async () => {
  await h.resetDatabase();
  X = await vendorMachine(); Y = await vendorMachine(); Z = await vendorMachine();
  R.x = await checkIn(X.m, D, '15:00');
  R.y = await checkIn(Y.m, D, null); // still working: no check-out
  R.z = await checkIn(Z.m, D, '16:00');
});
after(h.closePool);

test('a session still open refuses the day as before; the board says what can be sent', async () => {
  const r = await submit({});
  assert.strictEqual(r.body.code, 'OPEN_SESSIONS');
  assert.deepStrictEqual(r.body.details.rows.map((x) => x.eq_attendance_id), [R.y]);
  assert.strictEqual(await statusOf(R.x), 'Draft', 'nothing was submitted');
  const board = await ok(h.api().get(`/api/equipment/attendance/site/8?date=${D}&shift=Day`).set(S8()));
  assert.strictEqual(board.submit.can_submit, false);
  assert.strictEqual(board.submit.can_submit_partial, true);
  assert.strictEqual(board.submit.open_rows, 1);
});

test('wrong lists are refused: a row of another day, every row kept', async () => {
  const other = await checkIn(X.m, '2026-10-26', '15:00');
  assert.ok((await submit({ leave_draft_ids: [R.y, other] })).body.details.fields.leave_draft_ids);
  assert.strictEqual((await submit({ leave_draft_ids: [R.x, R.y, R.z] })).body.code, 'NOTHING_TO_SUBMIT');
  await ok(h.api().delete(`/api/equipment/attendance/${other}`).set(S8()));
});

test('the open row (and one chosen by the supervisor) stay Draft; the others are submitted', async () => {
  const r = await ok(submit({ leave_draft_ids: [R.y, R.z] }));
  assert.strictEqual(r.submitted, 1);
  assert.strictEqual(r.kept_draft.length, 2);
  assert.deepStrictEqual([await statusOf(R.x), await statusOf(R.y), await statusOf(R.z)], ['Submitted', 'Draft', 'Draft']);
  const [log] = await h.query("SELECT COUNT(*) AS n FROM audit_logs WHERE table_name = 'eq_attendance' AND action_type = 'kept_as_draft'");
  assert.strictEqual(Number(log.n), 2);
  // still editable by the supervisor
  await ok(h.api().patch(`/api/equipment/attendance/${R.z}`).set(S8()).send({ check_out_time: `${D} 17:00` }));
});

test('the week gate still asks for the rows left as draft', async () => {
  await checkIn(X.m, '2026-11-02', '15:00');
  const r = await h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-11-02' });
  assert.strictEqual(r.body.code, 'PREVIOUS_WEEK_DRAFTS');
});

test('an invoice without the machine left as draft is not blocked; with it, it is', async () => {
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [R.x] }));
  const okGen = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: X.V.vendor_id });
  assert.strictEqual(okGen.status, 201, JSON.stringify(okGen.body));
  const blocked = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: Y.V.vendor_id });
  assert.strictEqual(blocked.body.code, 'BLOCKERS_PRESENT');
  assert.ok(blocked.body.details.blockers.find((b) => b.code === 'NOT_APPROVED' || b.code === 'OPEN_SESSION'));
});

test('finished later, the kept rows are submitted with the same button', async () => {
  await ok(h.api().post(`/api/equipment/attendance/${R.y}/check-out`).set(S8()).send({ check_out_time: `${D} 18:00` }));
  const r = await ok(submit({}));
  assert.strictEqual(r.submitted, 2);
  assert.deepStrictEqual(r.kept_draft, []);
  assert.deepStrictEqual([await statusOf(R.y), await statusOf(R.z)], ['Submitted', 'Submitted']);
  const r2 = await h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-11-02' });
  assert.strictEqual(r2.status, 200, 'the next week is free again');
});
