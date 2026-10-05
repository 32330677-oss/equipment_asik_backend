// tests/fixtures.js — builds equipment master data through the API (reused by P2+ tests).
const assert = require('node:assert');
const h = require('./helpers');

const A = () => h.auth(h.T.admin());

async function ok(promise, status = [200, 201]) {
  const r = await promise;
  assert.ok([].concat(status).includes(r.status), `${r.req && r.req.method} ${r.req && r.req.path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** Vendor + USD contract + 3 machines (Hourly / Daily / Monthly) + 2 operators, deployed to S08 Day from 2026-09-01. */
async function standardFleet() {
  const vendor = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Al-Bunyan Heavy Equipment' }));
  const contract = await ok(h.api().post(`/api/equipment/vendors/${vendor.vendor_id}/contracts`).set(A())
    .send({ contract_number: 'AB-2026-07', start_date: '2026-07-01', currency: 'USD' }));
  const mk = (type_id, plate) => ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: vendor.vendor_id, type_id, plate_number: plate, make: 'CAT' }));
  const exc = await mk(1, 'P-001');
  const loader = await mk(2, 'P-002');
  const crane = await mk(4, 'P-003');
  const op1 = await ok(h.api().post('/api/equipment/operators').set(A()).send({ vendor_id: vendor.vendor_id, full_name: 'Ahmad Khaled', license_expiry: '2030-01-01' }));
  const op2 = await ok(h.api().post('/api/equipment/operators').set(A()).send({ vendor_id: vendor.vendor_id, full_name: 'Omar Saleh', license_expiry: '2026-01-01' }));
  const card = (m, body) => ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: contract.vendor_contract_id, effective_from: '2026-07-01', ...body }));
  await card(exc, { billing_mode: 'Hourly', hourly_rate: 40, min_billable_hours_per_day: 6, overtime_enabled: true, overtime_threshold_hours: 10, overtime_rate: 50, standby_billable_pct: 50 });
  await card(loader, { billing_mode: 'Daily', daily_rate: 300, overtime_enabled: true, overtime_rate: 45, operator_included: false, operator_daily_rate: 20, fuel_policy: 'CompanySuppliesFree' });
  await card(crane, { billing_mode: 'Monthly', monthly_rate: 6500, monthly_working_days: 26, overtime_enabled: true, overtime_threshold_hours: 8, overtime_rate: 40 });
  const deploy = (m, op) => ok(h.api().post('/api/equipment/deployments').set(A())
    .send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-09-01', default_operator_id: op.operator_id }));
  await deploy(exc, op1); await deploy(loader, op1); await deploy(crane, op2);
  return { vendor, contract, exc, loader, crane, op1, op2 };
}

module.exports = { ok, standardFleet, A };

const S8 = () => h.auth(h.T.sup8());

/** Records document 04 Example A for the excavator at S08 (Oct 2026) and submits every day. Returns row ids. */
async function recordExampleA(F) {
  const ids = [];
  const work = async (date, inT, outT, meters, periods = []) => {
    const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8())
      .send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, meter_start: meters[0] }));
    for (const p of periods) {
      await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8())
        .send({ downtime_type: p[0], start_time: `${date} ${p[1]}`, end_time: `${date} ${p[2]}`, reason: p[3] || 'site reason' }));
    }
    await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8())
      .send({ check_out_time: `${date} ${outT}`, meter_end: meters[1], work_description: `Excavation ${date}` }));
    ids.push(r.eq_attendance_id);
  };
  const day = async (date, status) => {
    const r = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8())
      .send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: date, day_status: status, remarks: `${status} day` }));
    ids.push(r.eq_attendance_id);
  };
  await work('2026-10-01', '07:00', '17:30', [5100.0, 5109.6], [['Break', '12:00', '13:00']]);
  await work('2026-10-03', '06:00', '19:00', [5109.6, 5121.7], [['Break', '12:00', '13:00']]);
  await work('2026-10-04', '07:00', '15:00', [5121.7, 5126.3], [['Breakdown', '09:00', '12:00', 'Hydraulic hose'], ['Break', '12:00', '12:30']]);
  await work('2026-10-05', '07:00', '12:00', [5126.3, 5129.4], [['Standby', '09:00', '11:00', 'Waiting trucks']]);
  await day('2026-10-06', 'Standby');
  await day('2026-10-07', 'Breakdown');
  await day('2026-10-08', 'Absent');
  for (const d of ['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
    await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: d }));
  }
  return ids;
}

module.exports.recordExampleA = recordExampleA;
module.exports.S8 = S8;
