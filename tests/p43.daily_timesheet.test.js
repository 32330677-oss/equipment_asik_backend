// P43 — Weekly Equipment Timesheet (Excel; replaced the daily one, Nov 2026): one worksheet per vendor, one framed block
// per machine with a row per day (Saturday .. Thursday; Friday only when worked), recorded days filled, the others
// empty for the pen, days off site in grey; Accountant + Administration signatures; supervisor limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');

// "now" = Tuesday 2026-10-20 12:00 (helpers clock); weekly off day = Friday -> week Sat 17 .. Thu 22 Oct
const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const URL = '/api/equipment/reports/weekly-timesheet.xlsx';
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F; let roller; let night; let late;

// the text of a cell; the other cells of a merged range give '' (exceljs throws on .text of a merged cell whose
// first cell is empty, e.g. the logo area)
const textOf = (c) => (c.isMerged && c.master.address !== c.address ? '' : String(c.text || ''));

/** Loads the workbook: its sheets by name, each with its whole text and its machine blocks. */
async function bookOf(res) {
  assert.strictEqual(res.status, 200, res.body && res.body.toString());
  assert.match(res.headers['content-type'], /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const sheets = {};
  for (const ws of wb.worksheets) {
    const text = [];
    ws.eachRow((row) => row.eachCell((c) => { const t = textOf(c); if (t) text.push(t); }));
    /** The day rows of a machine block: { 'Tue 20 Oct': { in, out, lunch, sup, drv, remarks } } */
    const block = (code) => {
      let at = null;
      ws.eachRow((row, n) => { if (!at && textOf(ws.getCell(`A${n}`)) === code) at = n; });
      assert.ok(at, `machine ${code} has a block`);
      const days = {};
      for (let r = at + 2; r < at + 10; r += 1) {
        const day = textOf(ws.getCell(`A${r}`));
        if (!/^(Sat|Sun|Mon|Tue|Wed|Thu|Fri) \d+ [A-Z][a-z]{2}$/.test(day)) break;
        const v = (c) => ws.getCell(`${c}${r}`).value;
        days[day] = { in: v('B'), out: v('C'), lunch: v('D'), sup: v('E'), drv: v('F'), remarks: v('G'), note: textOf(ws.getCell(`B${r}`)) };
      }
      return days;
    };
    sheets[ws.name] = { all: text.join('\n'), block };
  }
  return sheets;
}

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // exc, loader, crane deployed at S08 Day since 2026-09-01 (vendor Al-Bunyan)
  // excavator Tue 20: 07:00-11:30 with a 30 min breakdown
  const e = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00', operator_id: F.op1.operator_id }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/downtime/start`).set(S8())
    .send({ downtime_type: 'Breakdown', start_time: '2026-10-20 09:00', end_time: '2026-10-20 09:30', reason: 'hose leak' }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-20 11:30', work_description: 'Excavation zone B' }));
  // the excavator also worked on Friday 16 Oct (the off day of the week before)
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S8())
    .send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-16 07:00', check_out_time: '2026-10-16 12:00', late_reason: 'paper sheet typed late' }));
  // a machine arriving on Monday 19 Oct at S08 (same vendor)
  late = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 1, plate_number: 'L-19' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: late.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-10-19' }));
  // a second vendor: a roller at S09 Day (checked in, not out) and a machine at S09 Night (nothing recorded)
  const v2 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Zeta Rentals' }));
  roller = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: v2.vendor_id, type_id: 11, plate_number: 'R-77' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: roller.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-01' }));
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: roller.equipment_id, site_id: 9, check_in_time: '2026-10-20 08:10' }));
  night = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: v2.vendor_id, type_id: 2, plate_number: 'N-5' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: night.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' }));
});
after(h.closePool); // close the DB pool, or the test process never ends (CI waits until its timeout)

test('the week of a date: Saturday to Thursday, Friday is the off day', async () => {
  const w = await ok(h.api().get('/api/equipment/reports/weekly-timesheet/week').query({ date: '2026-10-20' }).set(S8()));
  assert.strictEqual(w.from, '2026-10-17');
  assert.strictEqual(w.to, '2026-10-22');
  assert.strictEqual(w.off_date, '2026-10-23');
  assert.match(w.label, /Saturday 17 – Thursday 22 Oct 2026/);
});

test('admin: one sheet per vendor, a block per machine, recorded days filled, the others empty, signatures at the end', async () => {
  const book = await bookOf(await bin(h.api().get(URL).query({ date: '2026-10-20' }).set(A())));
  assert.deepStrictEqual(Object.keys(book).sort(), ['Al-Bunyan Heavy Equipment', 'Zeta Rentals']);
  const bun = book['Al-Bunyan Heavy Equipment'];
  for (const t of ['Weekly equipment timesheet', 'Saturday 17 – Thursday 22 Oct 2026', 'Our supervisor', 'Vendor driver', 'Accountant', 'Administration']) {
    assert.ok(bun.all.includes(t), `"${t}" is printed`);
  }
  const exc = bun.block(F.exc.equipment_code);
  assert.deepStrictEqual(Object.keys(exc), ['Sat 17 Oct', 'Sun 18 Oct', 'Mon 19 Oct', 'Tue 20 Oct', 'Wed 21 Oct', 'Thu 22 Oct'], 'Saturday to Thursday, no Friday');
  const tue = exc['Tue 20 Oct'];
  assert.strictEqual(tue.in, '07:00');
  assert.strictEqual(tue.out, '11:30');
  assert.strictEqual(tue.lunch, 0);
  assert.strictEqual(tue.sup, null, 'the signatures stay empty');
  assert.strictEqual(tue.drv, null);
  assert.match(String(tue.remarks), /Excavation zone B/);
  assert.match(String(tue.remarks), /Breakdown 09:00-09:30: hose leak/);
  for (const k of ['in', 'out', 'lunch', 'remarks']) assert.strictEqual(exc['Mon 19 Oct'][k], null, `nothing recorded on Monday: ${k} empty`);
  const lt = bun.block(late.equipment_code); // arrives on Monday: Saturday and Sunday are off site
  assert.match(lt['Sat 17 Oct'].note, /Not on site: arrives Mon 19 Oct/);
  assert.strictEqual(lt['Mon 19 Oct'].in, null);
  const zeta = book['Zeta Rentals'];
  const r = zeta.block(roller.equipment_code); // checked in, not out yet
  assert.strictEqual(r['Tue 20 Oct'].in, '08:10');
  assert.strictEqual(r['Tue 20 Oct'].out, null);
  assert.match(String(r['Tue 20 Oct'].remarks), /In progress/);
  zeta.block(night.equipment_code);
  assert.ok(zeta.all.includes('Night shift') && zeta.all.includes('Accountant'));
});

test('the off day (Friday) appears only when the machine worked', async () => {
  const book = await bookOf(await bin(h.api().get(URL).query({ date: '2026-10-14' }).set(A())));
  const bun = book['Al-Bunyan Heavy Equipment'];
  const exc = bun.block(F.exc.equipment_code);
  assert.strictEqual(exc['Fri 16 Oct'].in, '07:00');
  assert.strictEqual(exc['Fri 16 Oct'].out, '12:00');
  assert.ok(!('Fri 16 Oct' in bun.block(F.loader.equipment_code)), 'no Friday for the loader');
});

test('supervisor: only the vendors of his own sites; a shift or site he does not supervise is refused', async () => {
  const s8 = await bookOf(await bin(h.api().get(URL).query({ date: '2026-10-20' }).set(S8())));
  assert.deepStrictEqual(Object.keys(s8), ['Al-Bunyan Heavy Equipment']);
  const n9 = await bookOf(await bin(h.api().get(URL).query({ date: '2026-10-20', shift: 'Night' }).set(S9())));
  assert.deepStrictEqual(Object.keys(n9), ['Zeta Rentals']);
  assert.ok(!n9['Zeta Rentals'].all.includes(roller.equipment_code), 'the Day roller is not on the Night sheet');
  n9['Zeta Rentals'].block(night.equipment_code);
  let res = await h.api().get(URL).query({ date: '2026-10-20', site_id: 9 }).set(S8());
  assert.strictEqual(res.status, 403);
  res = await h.api().get(URL).query({ date: '2026-10-20', shift: 'Night' }).set(S8());
  assert.strictEqual(res.status, 403);
});

test('a future week prints a blank sheet to fill by hand', async () => {
  const book = await bookOf(await bin(h.api().get(URL).query({ date: '2026-10-27' }).set(S8())));
  const exc = book['Al-Bunyan Heavy Equipment'].block(F.exc.equipment_code);
  assert.strictEqual(Object.keys(exc).length, 6);
  for (const d of Object.values(exc)) for (const k of ['in', 'out', 'lunch', 'remarks', 'sup', 'drv']) assert.strictEqual(d[k], null);
});

test('limits: more than 31 days ahead, a site with no machine, a bad shift, an unknown site', async () => {
  let res = await h.api().get(URL).query({ date: '2026-12-31' }).set(A());
  assert.strictEqual(res.status, 400);
  res = await h.api().get(URL).query({ date: '2026-10-20', site_id: 10 }).set(A());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'NO_MACHINES');
  res = await h.api().get(URL).query({ shift: 'Evening' }).set(A());
  assert.strictEqual(res.status, 400);
  res = await h.api().get(URL).query({ site_id: 999 }).set(A());
  assert.strictEqual(res.status, 404);
});
