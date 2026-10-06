const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');

let F;
const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const PRICE_KEYS = ['hourly_rate', 'daily_rate', 'monthly_rate', '"amount"', 'price_per_liter', 'net_amount'];
const noPrices = (body) => { const s = JSON.stringify(body); for (const k of PRICE_KEYS) assert.ok(!s.includes(k), `contains ${k}`); };

before(async () => { await h.resetDatabase(); F = await standardFleet(); });
after(h.closePool);

const checkIn = (who, body) => h.api().post('/api/equipment/attendance/check-in').set(who).send({ site_id: 8, shift_type: 'Day', ...body });

test('BR-11: not deployed, future date, other supervisor', async () => {
  const notDep = await h.api().post('/api/equipment/attendance/check-in').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, check_in_time: '2026-10-05 07:00' });
  assert.strictEqual(notDep.body.code, 'MACHINE_NOT_ASSIGNED');
  const future = await checkIn(S8(), { equipment_id: F.exc.equipment_id, check_in_time: '2026-10-25 07:00' });
  assert.strictEqual(future.body.code, 'FUTURE_DATE');
  const other = await checkIn(S9(), { equipment_id: F.exc.equipment_id, check_in_time: '2026-10-05 07:00' });
  assert.strictEqual(other.body.code, 'SITE_FORBIDDEN');
  const acc = await checkIn(h.auth(h.T.accountant()), { equipment_id: F.exc.equipment_id, check_in_time: '2026-10-05 07:00' });
  assert.strictEqual(acc.status, 403);
});

let row1;
test('full day: check-in, break, breakdown auto-closed at check-out, minutes', async () => {
  row1 = await ok(checkIn(S8(), { equipment_id: F.exc.equipment_id, check_in_time: '2026-10-05 07:00', meter_start: 5100 }));
  assert.strictEqual(row1.operator_id, F.op1.operator_id, 'default operator used');
  assert.strictEqual(row1.live_state, 'Working');
  assert.strictEqual(row1.sheet.sheet_code, 'ETS-2026-10-EQ0001-S08');
  assert.strictEqual(row1.sheet.sheet_row_no, 1);
  noPrices(row1);
  const id = row1.eq_attendance_id;
  const b = await ok(h.api().post(`/api/equipment/attendance/${id}/downtime/start`).set(S8()).send({ downtime_type: 'Break', start_time: '2026-10-05 12:00' }));
  assert.strictEqual(b.live_state, 'OnBreak');
  const two = await h.api().post(`/api/equipment/attendance/${id}/downtime/start`).set(S8()).send({ downtime_type: 'Refuel', start_time: '2026-10-05 12:30' });
  assert.strictEqual(two.body.code, 'DOWNTIME_OVERLAP');
  await ok(h.api().post(`/api/equipment/attendance/${id}/downtime/${b.open_downtime.downtime_id}/end`).set(S8()).send({ end_time: '2026-10-05 13:00' }));
  const noReason = await h.api().post(`/api/equipment/attendance/${id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-05 14:00' });
  assert.strictEqual(noReason.body.code, 'VALIDATION_ERROR');
  const bd = await ok(h.api().post(`/api/equipment/attendance/${id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-05 14:00', reason: 'Hydraulic hose' }));
  assert.strictEqual(bd.live_state, 'Breakdown');
  const out = await ok(h.api().post(`/api/equipment/attendance/${id}/check-out`).set(S8()).send({ check_out_time: '2026-10-05 17:30', meter_end: 5106, fuel_liters: 80, work_description: 'Excavation A1-A4' }));
  assert.strictEqual(out.gross_minutes, 630);
  assert.strictEqual(out.break_minutes, 60);
  assert.strictEqual(out.breakdown_minutes, 210);
  assert.strictEqual(out.working_minutes, 360);
  assert.strictEqual(out.live_state, 'Finished');
  assert.ok(out.downtime.every((p) => p.end_time));
  // decision of 6 Oct 2026: daily fuel is not recorded at check-out (approximate-fuel policy); litres sent are ignored, with a warning
  const fuel = await h.query('SELECT liters FROM eq_fuel_issues WHERE equipment_id = ?', [F.exc.equipment_id]);
  assert.strictEqual(fuel.length, 0);
});

test('BR-12/13: open session across dates/sites and overlap', async () => {
  const open = await ok(checkIn(S8(), { equipment_id: F.loader.equipment_id, check_in_time: '2026-10-06 07:00' }));
  const again = await checkIn(S8(), { equipment_id: F.loader.equipment_id, check_in_time: '2026-10-07 07:00' });
  assert.strictEqual(again.body.code, 'MACHINE_HAS_OPEN_SESSION');
  await ok(h.api().post(`/api/equipment/attendance/${open.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-06 15:00' }));
  const dup = await checkIn(S8(), { equipment_id: F.loader.equipment_id, check_in_time: '2026-10-06 16:00' });
  assert.strictEqual(dup.body.code, 'ATTENDANCE_EXISTS');
  const ovl = await h.api().patch(`/api/equipment/attendance/${row1.eq_attendance_id}`).set(S8()).send({ check_out_time: '2026-10-05 18:00' });
  assert.strictEqual(ovl.status, 200);
});

test('night shift crossing midnight is stored on the check-in date', async () => {
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 6, plate_number: 'N-1' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01', default_operator_id: F.op1.operator_id }));
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', check_in_time: '2026-10-07 18:00' }));
  const board = await ok(h.api().get('/api/equipment/attendance/site/9?date=2026-10-08&shift=Night').set(S9()));
  const mach = board.machines.find((x) => x.equipment_id === m.equipment_id);
  assert.strictEqual(mach.attendance.from_previous_day, true);
  const out = await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S9()).send({ check_out_time: '2026-10-08 04:00' }));
  assert.strictEqual(out.record_date, '2026-10-07');
  assert.strictEqual(out.gross_minutes, 600);
  const long = await h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', check_in_time: '2026-10-09 18:00' });
  const tooLong = await h.api().post(`/api/equipment/attendance/${long.body.data.eq_attendance_id}/check-out`).set(S9()).send({ check_out_time: '2026-10-10 19:00' });
  assert.strictEqual(tooLong.body.code, 'SESSION_TOO_LONG');
});

test('anomalies: meter_backwards, meter_mismatch, long_session; an expired licence is NOT an anomaly', async () => {
  const r = await ok(checkIn(S8(), { equipment_id: F.exc.equipment_id, check_in_time: '2026-10-07 07:00', meter_start: 5000 }));
  assert.strictEqual(r.anomaly_code, 'meter_backwards');
  const fixed = await ok(h.api().patch(`/api/equipment/attendance/${r.eq_attendance_id}`).set(S8()).send({ meter_start: 5106 }));
  assert.strictEqual(fixed.anomaly_code, null);
  const out = await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-07 17:00', meter_end: 5130 }));
  assert.strictEqual(out.anomaly_code, 'meter_mismatch');
  const crane = await ok(checkIn(S8(), { equipment_id: F.crane.equipment_id, check_in_time: '2026-10-07 06:00' }));
  assert.strictEqual(crane.anomaly_code, null);
  const longOut = await ok(h.api().post(`/api/equipment/attendance/${crane.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-07 23:30' }));
  assert.strictEqual(longOut.anomaly_code, 'long_session');
});

test('day status rules', async () => {
  const noReason = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-10-08', day_status: 'Breakdown' });
  assert.strictEqual(noReason.body.code, 'VALIDATION_ERROR');
  const absTimes = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-10-08', day_status: 'Absent', check_in_time: '2026-10-08 07:00', check_out_time: '2026-10-08 09:00' });
  assert.strictEqual(absTimes.body.code, 'VALIDATION_ERROR');
  const bd = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-10-08', day_status: 'Breakdown', remarks: 'Engine failure' }));
  assert.strictEqual(bd.live_state, 'Breakdown');
  const discard = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-10-05', day_status: 'Standby', remarks: 'x' });
  assert.strictEqual(discard.body.code, 'SESSION_WILL_BE_DISCARDED');
});

test('sheet row numbers: sequential, back-dated gets next, delete keeps a gap', async () => {
  const back = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-10-01', day_status: 'Absent' }));
  assert.strictEqual(back.sheet.sheet_row_no, 3);
  await ok(h.api().delete(`/api/equipment/attendance/${back.eq_attendance_id}`).set(S8()));
  const next = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-10-02', day_status: 'Holiday' }));
  assert.strictEqual(next.sheet.sheet_row_no, 4);
});

test('day board for supervisor: summary, sort, no prices', async () => {
  const b = await ok(h.api().get('/api/equipment/attendance/site/8?date=2026-10-07&shift=Day').set(S8()));
  assert.strictEqual(b.summary.deployed, 3);
  assert.strictEqual(b.machines[0].live_state, 'NotArrived');
  noPrices(b);
  const forbidden = await h.api().get('/api/equipment/attendance/site/8?date=2026-10-07&shift=Day').set(S9());
  assert.strictEqual(forbidden.body.code, 'SITE_FORBIDDEN');
});

test('submit: open sessions block, week gate blocks, then success', async () => {
  const open = await ok(checkIn(S8(), { equipment_id: F.loader.equipment_id, check_in_time: '2026-10-12 07:00' }));
  const blocked = await h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-10-12' });
  assert.strictEqual(blocked.body.code, 'OPEN_SESSIONS');
  await ok(h.api().post(`/api/equipment/attendance/${open.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-12 15:00' }));
  const gate = await h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-10-12' });
  assert.strictEqual(gate.body.code, 'PREVIOUS_WEEK_DRAFTS');
  for (const d of ['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
    await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: d }));
  }
  const okRes = await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: '2026-10-12' }));
  assert.strictEqual(okRes.submitted, 1);
  assert.deepStrictEqual(okRes.machines_without_row.sort(), ['EQ-0001', 'EQ-0003']);
  const edit = await h.api().patch(`/api/equipment/attendance/${open.eq_attendance_id}`).set(S8()).send({ remarks: 'late' });
  assert.strictEqual(edit.body.code, 'INVALID_STATE');
});

test('review: unacknowledged anomaly skipped, ack, approve; reject + resubmit', async () => {
  const list = await ok(h.api().get('/api/equipment/admin/attendance?status=Submitted&page_size=100').set(h.auth(h.T.accountant())));
  const ids = list.map((r) => r.eq_attendance_id);
  const res1 = await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids }));
  const skipped = res1.skipped.filter((s) => s.reason === 'UNACK_ANOMALY');
  assert.ok(skipped.length >= 2);
  for (const s of skipped) await ok(h.api().post(`/api/equipment/admin/attendance/${s.id}/ack-anomaly`).set(A()).send({ note: 'checked with site' }));
  const res2 = await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: skipped.map((s) => s.id) }));
  assert.strictEqual(res2.approved.length, skipped.length);
  const accApprove = await h.api().post('/api/equipment/admin/attendance/approve').set(h.auth(h.T.accountant())).send({ ids });
  assert.strictEqual(accApprove.status, 403);
  // reject the loader day of 2026-10-12, supervisor fixes and resubmits
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-12'", [F.loader.equipment_id]);
  await h.query("UPDATE eq_attendance SET status = 'Submitted' WHERE eq_attendance_id = ?", [row.eq_attendance_id]);
  await ok(h.api().post('/api/equipment/admin/attendance/reject').set(A()).send({ ids: [row.eq_attendance_id], notes: 'Check-out was 16:00 per paper' }));
  const rej = await ok(h.api().get('/api/equipment/attendance/rejected').set(S8()));
  assert.ok(rej.some((r) => r.eq_attendance_id === row.eq_attendance_id && r.admin_rejection_notes));
  await ok(h.api().patch(`/api/equipment/attendance/${row.eq_attendance_id}`).set(S8()).send({ check_out_time: '2026-10-12 16:00' }));
  const re = await ok(h.api().patch(`/api/equipment/attendance/${row.eq_attendance_id}/resubmit`).set(S8()));
  assert.strictEqual(re.status, 'Submitted');
});

test('payroll lock blocks edits; correction is logged and payroll untouched', async () => {
  const [r] = await h.query("SELECT * FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  const [b] = await h.query(`INSERT INTO eq_payroll_batches (start_date, end_date, scope_vendor_id, currency, status, is_finalized, generated_by_user_id)
    VALUES ('2026-10-01','2026-10-10', ?, 'USD', 'Generated', 1, 1)`, [F.vendor.vendor_id]).then((x) => [x]);
  const edit = await h.api().patch(`/api/equipment/admin/attendance/${r.eq_attendance_id}`).set(A()).send({ remarks: 'x' });
  assert.strictEqual(edit.body.code, 'PAYROLL_PERIOD_FINALIZED');
  const newRow = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-10-09', day_status: 'Absent' });
  assert.strictEqual(newRow.body.code, 'PAYROLL_PERIOD_FINALIZED');
  // official correction: Admin requests -> Accountant reviews -> Admin returns / approves
  const ACCT = () => h.auth(h.T.accountant());
  const corr = await ok(h.api().post(`/api/equipment/admin/attendance/${r.eq_attendance_id}/correction`).set(A()).send({ reason: 'Paper shows check-out 17:45', changes: { check_out_time: '2026-10-05 17:45' } }));
  assert.strictEqual(corr.locked_batch_id, b.insertId);
  assert.strictEqual(corr.request_status, 'Requested');
  const [still] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [r.eq_attendance_id]);
  assert.notStrictEqual(still.check_out_time, '2026-10-05 17:45:00', 'nothing changes before approval');
  // the person who asked for the correction never approves it (decision of 6 Oct 2026: another Admin or Accountant does)
  const early = await h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/approve`).set(A()).send({});
  assert.strictEqual(early.body.code, 'SAME_PERSON');
  // this row was never paid by a real batch: the accountant must give the amount
  const noAmount = await h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/review`).set(ACCT()).send({ note: 'checked' });
  assert.strictEqual(noAmount.body.code, 'VALIDATION_ERROR');
  await ok(h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/review`).set(ACCT()).send({ note: 'checked', amount_override: 12.5, override_reason: 'hours from the paper sheet' }));
  const ret = await ok(h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/return`).set(A()).send({ note: 'check the meter too' }));
  assert.strictEqual(ret.request_status, 'Requested');
  assert.strictEqual(ret.return_count, 1);
  await ok(h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/review`).set(ACCT()).send({ note: 'meter fine' }));
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${corr.correction_id}/approve`).set(A()).send({ note: 'ok' }));
  assert.strictEqual(done.request_status, 'Approved');
  assert.match(done.note.invoice_no, /^DN-\d{4}-\d{5}$/);
  assert.deepStrictEqual(done.events.map((e) => e.action), ['request', 'review', 'return', 'review', 'approve']);
  const [after] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [r.eq_attendance_id]);
  assert.strictEqual(after.check_out_time, '2026-10-05 17:45:00');
  const [adj] = await h.query("SELECT amount, adjustment_type, adjustment_date FROM eq_adjustments WHERE correction_id = ?", [corr.correction_id]);
  assert.strictEqual(Number(adj.amount), 12.5);
  assert.strictEqual(adj.adjustment_type, 'Correction');
  assert.ok(adj.adjustment_date > '2026-10-10', 'settled in the first open day');
  await h.query('UPDATE eq_payroll_batches SET status = \'Voided\' WHERE eq_batch_id = ?', [b.insertId]);
});

test('fuel: supervisor records litres without price; accountant prices; adjustments need a rate card', async () => {
  const f = await ok(h.api().post('/api/equipment/fuel-issues').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-13', liters: 100, price_per_liter: 9 }));
  assert.strictEqual(f.price_per_liter, undefined);
  const list = await ok(h.api().get('/api/equipment/fuel-issues?unpriced=true').set(h.auth(h.T.accountant())));
  assert.strictEqual(list.length, 1); // no fuel issue is created at check-out any more
  const priced = await ok(h.api().patch(`/api/equipment/fuel-issues/${f.fuel_issue_id}`).set(h.auth(h.T.accountant())).send({ price_per_liter: 1.1 }));
  assert.strictEqual(Number(priced.price_per_liter), 1.1);
  const noCard = await h.api().post('/api/equipment/adjustments').set(A()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-01-01', adjustment_type: 'Bonus', amount: 10, reason: 'x' });
  assert.strictEqual(noCard.body.code, 'NO_RATE_CARD');
  const adj = await ok(h.api().post('/api/equipment/adjustments').set(h.auth(h.T.accountant())).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-10-01', adjustment_type: 'Mobilization', amount: 150, reason: 'Transport to site' }));
  assert.strictEqual(adj.currency, 'USD');
});
