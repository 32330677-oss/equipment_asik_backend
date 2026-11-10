// P43 — Daily Equipment Timesheet (Excel): one worksheet with every machine of the day, Site > Shift > Vendor;
// recorded machines filled, the others left empty for the pen; signatures at the end; supervisor limits.
const { test, before } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');

// "now" = 2026-10-20 12:00 (helpers clock)
const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const URL = '/api/equipment/reports/daily-timesheet.xlsx';
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F; let roller; let night;

/** Loads the workbook and returns its single sheet with helpers. */
async function sheetOf(res) {
  assert.strictEqual(res.status, 200, res.body && res.body.toString());
  assert.match(res.headers['content-type'], /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  assert.strictEqual(wb.worksheets.length, 1, 'one worksheet only');
  const ws = wb.worksheets[0];
  const text = [];
  // the text of a cell; the other cells of a merged range give '' (exceljs throws on .text of a merged cell whose
  // first cell is empty, e.g. the logo area A1:B3)
  const textOf = (c) => (c.isMerged && c.master.address !== c.address ? '' : String(c.text || ''));
  ws.eachRow((row) => row.eachCell((c) => { const t = textOf(c); if (t) text.push(t); }));
  const all = text.join('\n');
  const rowOf = (code) => {
    let found = null;
    ws.eachRow((row, n) => { if (!found && textOf(ws.getCell(`B${n}`)).startsWith(code)) found = n; });
    assert.ok(found, `machine ${code} is listed`);
    const v = (c) => ws.getCell(`${c}${found}`).value;
    return { status: v('C'), start: v('D'), end: v('E'), downtime: v('F'), work: v('G'), remarks: v('H') };
  };
  return { ws, all, rowOf };
}

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // exc, loader, crane deployed at S08 Day since 2026-09-01 (vendor Al-Bunyan)
  // excavator: 07:00-11:30 with a 30 min breakdown -> 4.00 h of work, 0.50 h of downtime
  const e = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00', operator_id: F.op1.operator_id }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/downtime/start`).set(S8())
    .send({ downtime_type: 'Breakdown', start_time: '2026-10-20 09:00', end_time: '2026-10-20 09:30', reason: 'hose leak' }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-20 11:30', work_description: 'Excavation zone B' }));
  // a second vendor with a roller at S09 Day (recorded) and a machine at S09 Night (not recorded)
  const v2 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Zeta Rentals' }));
  roller = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: v2.vendor_id, type_id: 11, plate_number: 'R-77' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: roller.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-01' }));
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: roller.equipment_id, site_id: 9, check_in_time: '2026-10-20 08:10' }));
  night = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: v2.vendor_id, type_id: 2, plate_number: 'N-5' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: night.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' }));
});

test('admin: one sheet with every site and shift, recorded machines filled, the others empty, signatures at the end', async () => {
  const { all, rowOf } = await sheetOf(await bin(h.api().get(URL).query({ date: '2026-10-20' }).set(A())));
  for (const t of ['DAILY EQUIPMENT TIMESHEET', 'S08', 'S09', 'DAY SHIFT', 'NIGHT SHIFT', 'Al-Bunyan Heavy Equipment', 'Zeta Rentals', 'SUPERVISOR', 'APPROVED BY', 'TOTAL WORK HOURS']) {
    assert.ok(all.includes(t), `"${t}" is printed`);
  }
  const exc = rowOf(F.exc.equipment_code);
  assert.strictEqual(exc.status, 'Working');
  assert.strictEqual(exc.start, '07:00');
  assert.strictEqual(exc.end, '11:30');
  assert.strictEqual(exc.downtime, 0.5);
  assert.strictEqual(exc.work, 4);
  assert.match(String(exc.remarks), /Excavation zone B/);
  assert.match(String(exc.remarks), /Breakdown 09:00-09:30: hose leak/);
  const loader = rowOf(F.loader.equipment_code); // nothing recorded: every cell empty
  for (const k of ['status', 'start', 'end', 'downtime', 'work', 'remarks']) assert.strictEqual(loader[k], null, `loader ${k} is empty`);
  const r = rowOf(roller.equipment_code); // checked in, not out yet
  assert.strictEqual(r.status, 'In progress');
  assert.strictEqual(r.start, '08:10');
  assert.strictEqual(r.end, null);
  assert.strictEqual(r.work, null);
  rowOf(night.equipment_code);
});

test('supervisor: only his own sites; both shifts of his site in the same sheet', async () => {
  const s8 = await sheetOf(await bin(h.api().get(URL).query({ date: '2026-10-20' }).set(S8())));
  assert.ok(s8.all.includes('S08'));
  assert.ok(!s8.all.includes('S09'), 'S09 is not his site');
  assert.ok(!s8.all.includes(roller.equipment_code));
  const s9 = await sheetOf(await bin(h.api().get(URL).query({ date: '2026-10-20', shift: 'All' }).set(S9())));
  assert.ok(s9.all.includes('DAY SHIFT') && s9.all.includes('NIGHT SHIFT'));
  assert.ok(!s9.all.includes(F.exc.equipment_code));
  const n9 = await sheetOf(await bin(h.api().get(URL).query({ date: '2026-10-20', shift: 'Night' }).set(S9())));
  assert.ok(!n9.all.includes('DAY SHIFT'));
  assert.ok(n9.all.includes(night.equipment_code));
});

test('supervisor: another site or a shift he does not supervise is refused', async () => {
  let res = await h.api().get(URL).query({ date: '2026-10-20', site_id: 9 }).set(S8());
  assert.strictEqual(res.status, 403);
  res = await h.api().get(URL).query({ date: '2026-10-20', shift: 'Night' }).set(S8());
  assert.strictEqual(res.status, 403);
});

test('a future day prints a blank sheet (no data, no total) to fill by hand', async () => {
  const { all, rowOf } = await sheetOf(await bin(h.api().get(URL).query({ date: '2026-10-25' }).set(S8())));
  const exc = rowOf(F.exc.equipment_code);
  for (const k of ['status', 'start', 'end', 'downtime', 'work', 'remarks']) assert.strictEqual(exc[k], null);
  assert.ok(!all.includes('TOTAL WORK HOURS'));
  assert.ok(all.includes('SUPERVISOR') && all.includes('APPROVED BY'));
});

test('limits: more than 31 days ahead, a site with no machine, a bad shift', async () => {
  let res = await h.api().get(URL).query({ date: '2026-12-31' }).set(A());
  assert.strictEqual(res.status, 400);
  res = await h.api().get(URL).query({ date: '2026-10-20', site_id: 10 }).set(A());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code || (res.body.error && res.body.error.code), 'NO_MACHINES');
  res = await h.api().get(URL).query({ shift: 'Evening' }).set(A());
  assert.strictEqual(res.status, 400);
  res = await h.api().get(URL).query({ site_id: 999 }).set(A());
  assert.strictEqual(res.status, 404);
});
