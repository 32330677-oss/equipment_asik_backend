const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

// "now" = 2026-10-20 12:00 Beirut (helpers clock)
let F;
before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  // excavator: working since 07:00 with a closed break -> Working
  const exc = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00' }));
  await ok(h.api().post(`/api/equipment/attendance/${exc.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Break', start_time: '2026-10-20 10:00', end_time: '2026-10-20 10:30' }));
  // loader: in an open breakdown
  const ld = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, check_in_time: '2026-10-20 06:30' }));
  await ok(h.api().post(`/api/equipment/attendance/${ld.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-20 09:15', reason: 'pump' }));
  // crane: nothing -> NotArrived (late, site starts 07:00)
  // a night machine at S09 still open from yesterday 18:00 -> Working
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 11, plate_number: 'G-1' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01', default_operator_id: F.op1.operator_id }));
  await ok(h.api().post('/api/equipment/attendance/check-in').set(h.auth(h.T.sup9())).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', check_in_time: '2026-10-19 18:00' }));
});
after(h.closePool);

test('live states and KPIs', async () => {
  const d = await ok(h.api().get('/api/equipment/live').set(A()));
  const st = Object.fromEntries(d.machines.map((m) => [m.equipment_code, m]));
  assert.strictEqual(st['EQ-0001'].live_state, 'Working');
  assert.strictEqual(st['EQ-0001'].work_minutes_today, 270); // 07:00-12:00 minus 30 min break
  assert.strictEqual(st['EQ-0002'].live_state, 'Breakdown');
  assert.strictEqual(st['EQ-0002'].since, '2026-10-20 09:15:00');
  assert.strictEqual(st['EQ-0003'].live_state, 'NotArrived');
  assert.strictEqual(st['EQ-0003'].late, true);
  assert.strictEqual(st['EQ-0004'].live_state, 'Working');
  assert.strictEqual(st['EQ-0004'].forgotten_checkout, true); // 18 h > 16 h
  assert.strictEqual(d.kpis.deployed, 4);
  assert.strictEqual(d.kpis.on_site_now, 3);
  assert.strictEqual(d.kpis.forgotten_checkout, 1);
  assert.ok(d.kpis.estimated_cost_today.USD > 0);
});

test('supervisor sees only own site/shift and no money', async () => {
  const d = await ok(h.api().get('/api/equipment/live').set(S8()));
  assert.deepStrictEqual([...new Set(d.machines.map((m) => m.site_code))], ['S08']);
  assert.strictEqual(d.kpis.estimated_cost_today, undefined);
  assert.ok(!JSON.stringify(d).includes('estimated_cost'));
  const other = await h.api().get('/api/equipment/live/sites/9').set(S8());
  assert.strictEqual(other.body.code, 'SITE_FORBIDDEN');
});

test('constant number of queries regardless of machine count', async () => {
  const { pool } = require('../config/db');
  const count = async () => {
    let n = 0;
    const q = pool.query.bind(pool); const e = pool.execute.bind(pool);
    pool.query = (...a) => { n += 1; return q(...a); };
    pool.execute = (...a) => { n += 1; return e(...a); };
    try { await require('../services/equipment/eqLiveService').live({ date: '2026-10-20', withMoney: true }); } finally { pool.query = q; pool.execute = e; }
    return n;
  };
  const before5 = await count();
  for (let i = 0; i < 10; i += 1) {
    const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 7, plate_number: `R-${i}` }));
    await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 10, assigned_date: '2026-10-01' }));
  }
  const after15 = await count();
  assert.strictEqual(before5, after15);
});

test('daily report PDF and utilization', async () => {
  const pdf = await h.api().get('/api/equipment/reports/daily.pdf?site_id=8&date=2026-10-20').set(S8());
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers['content-type'], 'application/pdf');
  const u = await ok(h.api().get('/api/equipment/reports/utilization?from=2026-10-01&to=2026-10-20').set(h.auth(h.T.accountant())));
  assert.ok(u.length >= 4);
  assert.ok(u.every((r) => r.deployed_days > 0));
  const x = await h.api().get('/api/equipment/reports/utilization?from=2026-10-01&to=2026-10-20&format=xlsx').set(A());
  assert.strictEqual(x.status, 200);
  const sup = await h.api().get('/api/equipment/reports/utilization?from=2026-10-01&to=2026-10-20').set(S8());
  assert.strictEqual(sup.status, 403);
});
