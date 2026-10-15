// P32 — Team Flow integration (read-only, token auth): sites, types and the daily plant summary used by the
// combined Project Daily Report. A machine counts once a day with its best state; Cancelled rows never count.
process.env.INTEGRATION_TOKEN = 'integration-token-integration-token-0001';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');

const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const KEY = { Authorization: `Bearer ${process.env.INTEGRATION_TOKEN}` };
let F;

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // excavator, loader, crane deployed at S08 Day since 2026-09-01
  // excavator works (with a description)
  const e = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00' }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-20 11:30', work_description: 'Backfill by aggregate for water supply trench' }));
  // loader: full-day breakdown
  await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-10-20', day_status: 'Breakdown', remarks: 'hydraulic pump' }));
  // crane: nothing recorded -> Pending
  // a roller at S09 Day: standby all day
  const roller = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 7, plate_number: 'R-77' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: roller.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-01' }));
  await ok(h.api().post('/api/equipment/attendance/day-status').set(S9()).send({ equipment_id: roller.equipment_id, site_id: 9, record_date: '2026-10-20', day_status: 'Standby', remarks: 'no work front' }));
});
after(h.closePool);

test('no token / wrong token is refused; every route is read-only', async () => {
  let r = await h.api().get('/api/integration/sites');
  assert.strictEqual(r.status, 401);
  r = await h.api().get('/api/integration/sites').set({ Authorization: 'Bearer wrong-token-wrong-token-wrong-token-00' });
  assert.strictEqual(r.status, 401);
  r = await h.api().get('/api/integration/sites').set(h.auth(h.T.admin())); // a user JWT is not the integration token
  assert.strictEqual(r.status, 401);
  r = await h.api().post('/api/integration/sites').set(KEY).send({});
  assert.strictEqual(r.status, 404);
});

test('sites and types', async () => {
  const sites = await ok(h.api().get('/api/integration/sites').set(KEY));
  assert.deepStrictEqual(sites.map((s) => s.site_code), ['S08', 'S09', 'S10']);
  const types = await ok(h.api().get('/api/integration/equipment-types').set(KEY));
  assert.ok(types.some((t) => t.type_name === 'Excavator'));
});

test('validation', async () => {
  for (const q of ['date=2026-13-01&site_ids=8', 'date=2026-10-21&site_ids=8', 'date=2026-10-20', 'date=2026-10-20&site_ids=a,8']) {
    const r = await h.api().get(`/api/integration/daily-plant?${q}`).set(KEY);
    assert.strictEqual(r.status, 400, q);
  }
});

test('daily plant summary: best state per machine, per type', async () => {
  const d = await ok(h.api().get('/api/integration/daily-plant?date=2026-10-20&site_ids=8,9').set(KEY));
  const t = Object.fromEntries(d.types.map((x) => [x.type_name, x]));
  assert.strictEqual(t.Excavator.working, 1);
  assert.strictEqual(t['Wheel Loader'].breakdown, 1);
  assert.strictEqual(t.Roller.standby, 1);
  assert.strictEqual(t['Mobile Crane'].pending, 1, 'deployed, nothing recorded');
  assert.strictEqual(d.totals.machines, d.types.reduce((a, x) => a + x.machines, 0));
  assert.deepStrictEqual(d.work_descriptions.map((w) => w.text), ['Backfill by aggregate for water supply trench']);
  assert.strictEqual(d.work_descriptions[0].site_name, 'Tower B');
  // only S09 -> the S08 machines are not there
  const d9 = await ok(h.api().get('/api/integration/daily-plant?date=2026-10-20&site_ids=9').set(KEY));
  assert.ok(!d9.types.some((x) => x.type_name === 'Excavator'));
});

test('a cancelled row does not count, the deployment makes it Pending again', async () => {
  const [[row]] = await require('../config/db').pool.query(
    "SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-20'", [F.exc.equipment_id]);
  await require('../config/db').pool.query("UPDATE eq_attendance SET status = 'Cancelled' WHERE eq_attendance_id = ?", [row.eq_attendance_id]);
  const d = await ok(h.api().get('/api/integration/daily-plant?date=2026-10-20&site_ids=8').set(KEY));
  const exc = d.types.find((x) => x.type_name === 'Excavator');
  assert.strictEqual(exc.working, 0);
  assert.strictEqual(exc.pending, 1);
  assert.strictEqual(d.work_descriptions.length, 0);
});
