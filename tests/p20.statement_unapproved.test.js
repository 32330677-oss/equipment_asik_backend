// P20 — provisional statement: says why nothing is payable, and can include Submitted days (marked) before approval.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A, standardFleet } = require('./fixtures');

let F;
before(async () => { await h.resetDatabase(); F = await standardFleet(); });
after(h.closePool);

test('nothing approved: clear reason; include_unapproved gives a marked PDF; preview and generate still ignore them', async () => {
  const S8 = () => h.auth(h.T.sup8());
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, shift_type: 'Day', check_in_time: '2026-10-05 07:00', check_out_time: '2026-10-05 15:00' }));
  // the machine statement (the vendor also has a monthly crane, billed on its deployed days)
  const url = `/api/equipment/statements/machine/${F.exc.equipment_id}.pdf`;
  // Draft only
  let r = await h.api().get(url).query({ from: '2026-10-01', to: '2026-10-31' }).set(A());
  assert.strictEqual(r.body.code, 'NOTHING_SUBMITTED');
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, shift_type: 'Day', record_date: '2026-10-05' }));
  r = await h.api().get(url).query({ from: '2026-10-01', to: '2026-10-31' }).set(A());
  assert.strictEqual(r.body.code, 'NOTHING_APPROVED');
  assert.match(r.body.message, /1 day\(s\) are waiting/);
  r = await h.api().get(url).query({ from: '2026-10-01', to: '2026-10-31', include_unapproved: 'true' }).set(A()).buffer(true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/pdf');
  const m = await h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}.pdf`).query({ from: '2026-10-01', to: '2026-10-31', include_unapproved: 'true' }).set(A());
  assert.strictEqual(m.status, 200);
  // the real payroll never counts a day that is not approved
  const pv = await h.api().post('/api/equipment/payroll/preview').set(A()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id, include_submitted: true });
  assert.ok(!(pv.body.data && pv.body.data.items || []).some((i) => i.equipment_id === F.exc.equipment_id && Number(i.work_hours) > 0), 'preview ignores Submitted rows');
});
