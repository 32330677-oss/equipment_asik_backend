const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, recordExampleA, A, S8 } = require('./fixtures');

// the month of October must be in the past for this file
require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 5, 9, 0, 0)));

let F;
const ACC = () => h.auth(h.T.accountant());
const bin = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

async function workDay(m, date, inT, outT, periods = []) {
  const [y, mo, d] = date.split('-').map(Number);
  const outDate = outT < inT ? new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10) : date;
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}` }));
  for (const p of periods) {
    await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: p[0], start_time: `${date} ${p[1]}`, end_time: `${date} ${p[2]}`, reason: 'reason' }));
  }
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: `${outDate} ${outT}` }));
}
const dayStatus = (m, date, status) => ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, record_date: date, day_status: status, remarks: status }));

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await recordExampleA(F); // excavator (submits its days)
  // loader: example B
  await workDay(F.loader, '2026-10-01', '07:00', '16:00', [['Break', '12:00', '13:00']]);
  await workDay(F.loader, '2026-10-03', '07:00', '18:00', [['Break', '12:00', '13:00']]);
  await workDay(F.loader, '2026-10-04', '07:00', '15:00', [['Breakdown', '08:00', '11:00']]);
  await dayStatus(F.loader, '2026-10-05', 'Standby');
  // crane: example C over the whole of October (Fridays off)
  await dayStatus(F.crane, '2026-10-01', 'Absent');
  await workDay(F.crane, '2026-10-03', '07:00', '17:00', [['Break', '12:00', '13:00']]);
  await workDay(F.crane, '2026-10-04', '07:00', '18:00', [['Break', '12:00', '13:00']]);
  await workDay(F.crane, '2026-10-05', '07:00', '19:00', [['Break', '12:00', '13:00']]);
  await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: '2026-10-06', day_status: 'Breakdown', remarks: 'boom', check_in_time: '2026-10-06 07:00', check_out_time: '2026-10-06 15:00' }));
  await workDay(F.crane, '2026-10-07', '07:00', '16:00', [['Break', '12:00', '13:00'], ['Breakdown', '13:00', '16:00']]);
  await h.query("UPDATE eq_downtime_periods SET start_time = '2026-10-07 07:00:00', end_time = '2026-10-07 11:00:00' WHERE downtime_type = 'Breakdown' AND start_time = '2026-10-07 13:00:00'");
  await h.query("UPDATE eq_attendance SET breakdown_minutes = 240, working_minutes = 240 WHERE equipment_id = ? AND record_date = '2026-10-07'", [F.crane.equipment_id]);
  await dayStatus(F.crane, '2026-10-08', 'Standby');
  const fillers = [];
  for (let d = 10; d <= 31; d += 1) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 5) continue; // Friday
    fillers.push(date);
  }
  for (const date of fillers.slice(0, 18)) await workDay(F.crane, date, '07:00', '16:00', [['Break', '12:00', '13:00']]);
  // submit every date in order
  const [dates] = [await h.query("SELECT DISTINCT record_date FROM eq_attendance WHERE status = 'Draft' ORDER BY record_date")];
  for (const r of dates) await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: r.record_date }));
  // ack anomalies (operator licence expired on the crane), approve all
  const anomalies = await h.query('SELECT eq_attendance_id FROM eq_attendance WHERE anomaly_code IS NOT NULL');
  for (const a of anomalies) await ok(h.api().post(`/api/equipment/admin/attendance/${a.eq_attendance_id}/ack-anomaly`).set(A()).send({ note: 'known' }));
  const all = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE status = 'Submitted'");
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: all.map((r) => r.eq_attendance_id) }));
  // monthly crane: the accountant gives 4 h for its standby day (no % for monthly machines)
  const [sb] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-08'", [F.crane.equipment_id]);
  await ok(h.api().patch(`/api/equipment/admin/attendance/${sb.eq_attendance_id}/standby-credit`).set(ACC()).send({ hours: 4, note: 'site not ready' }));
  // fuel + adjustment for the excavator (example A)
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-03', liters: 100, price_per_liter: 1.1, receipt_number: 'F-10233' }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-01', adjustment_type: 'Mobilization', amount: 150, reason: 'Transport of excavator to S08' }));
});
after(h.closePool);

const SCOPE = { start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: null };

async function matchAllPaper() {
  const sheets = await ok(h.api().get('/api/equipment/timesheets?month=2026-10').set(ACC()));
  for (const s of sheets) {
    await ok(h.api().post(`/api/equipment/timesheets/${s.timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer(`scan ${s.sheet_code}`), 'scan.png'));
    const rows = await h.query('SELECT eq_attendance_id FROM eq_attendance WHERE timesheet_id = ?', [s.timesheet_id]);
    await ok(h.api().post(`/api/equipment/timesheets/${s.timesheet_id}/paper-checks`).set(ACC()).send({ items: rows.map((r) => ({ eq_attendance_id: r.eq_attendance_id, result: 'Matched', employee_signed: true, operator_signed: true })) }));
  }
}

test('blockers: paper not matched blocks generation (only when the setting is on)', async () => {
  const off = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31').set(ACC()));
  assert.ok(!off.find((x) => x.code === 'PAPER_NOT_MATCHED'));
  await h.query("UPDATE settings SET setting_value = 'true' WHERE setting_key = 'eq_payroll_requires_paper_match'");
  require('../services/settings').invalidate();
  const b = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31').set(ACC()));
  assert.ok(b.find((x) => x.code === 'PAPER_NOT_MATCHED'));
  const g = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, vendor_id: F.vendor.vendor_id });
  assert.strictEqual(g.body.code, 'BLOCKERS_PRESENT');
  const sup = await h.api().post('/api/equipment/payroll/preview').set(S8()).send(SCOPE);
  assert.strictEqual(sup.status, 403);
});

let batch;
test('preview reproduces examples A, B (incl. operator) and C (monthly on hours due)', async () => {
  await matchAllPaper();
  const b = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31').set(ACC()));
  assert.deepStrictEqual(b.filter((x) => !['IN_OTHER_BATCH', 'SCAN_MISSING', 'MONTHLY_DAYS_WITHOUT_ROWS'].includes(x.code)), []);
  // example C: the crane has no row on Oct 31 (a working day): shown before generating, deducted as missing hours
  assert.deepStrictEqual(b.find((x) => x.code === 'MONTHLY_DAYS_WITHOUT_ROWS').items.map((i) => i.record_date), ['2026-10-31']);
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(SCOPE));
  const net = (code) => p.items.filter((i) => i.equipment_code === code).reduce((a, i) => a + Number(i.net), 0);
  assert.strictEqual(net('EQ-0001'), 1460);
  assert.strictEqual(net('EQ-0002'), 1087.5);
  assert.strictEqual(net('EQ-0003'), 5687.5); // 208 h due (26 working days x 8), 182 h done -> 26 h x 31.25 missing
  assert.strictEqual(p.totals[0].net, '8235.00');
});

test('generate, rows never paid twice, export PDFs and Excel', async () => {
  batch = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, vendor_id: F.vendor.vendor_id }));
  assert.strictEqual(batch.total_net, '8235.00');
  assert.strictEqual(batch.items.length, 3);
  const again = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, vendor_id: F.vendor.vendor_id });
  assert.ok(['NOTHING_TO_PAY', 'OVERLAPPING_BATCH'].includes(again.body.code), again.body.code);
  const dir = path.join(__dirname, '..', 'docs', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  for (const view of ['vendor', 'summary', 'machine']) {
    const r = await bin(h.api().get(`/api/equipment/payroll/batches/${batch.eq_batch_id}/export.pdf?view=${view}`).set(ACC()));
    assert.strictEqual(r.status, 200, `${view} ${r.status}`);
    assert.strictEqual(r.headers['content-type'], 'application/pdf');
    fs.writeFileSync(path.join(dir, `sample_${view}_statement.pdf`), r.body);
  }
  const x = await bin(h.api().get(`/api/equipment/payroll/batches/${batch.eq_batch_id}/export.xlsx`).set(ACC()));
  assert.strictEqual(x.status, 200);
  fs.writeFileSync(path.join(dir, 'sample_payroll.xlsx'), x.body);
  // November: only the monthly crane base is payable (no rows yet) -> provisional statement with watermark
  const prov = await bin(h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}.pdf?from=2026-11-01&to=2026-11-30`).set(ACC()));
  assert.strictEqual(prov.status, 200);
  fs.writeFileSync(path.join(dir, 'sample_provisional_vendor_statement.pdf'), prov.body);
  const none = await h.api().get(`/api/equipment/statements/machine/${F.exc.equipment_id}.pdf?from=2026-11-01&to=2026-11-30`).set(ACC());
  assert.strictEqual(none.status, 409);
});

test('finalize locks; supersede creates v2; void rules; accountant finalize setting', async () => {
  await ok(h.api().put('/api/settings/payroll_finalize_admin_only').set(A()).send({ value: 'true', reason: 'only the Admin closes payroll' }));
  const accFin = await h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(ACC());
  assert.strictEqual(accFin.body.code, 'FORBIDDEN_ROLE');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-03'", [F.exc.equipment_id]);
  const edit = await h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ remarks: 'x' });
  assert.strictEqual(edit.body.code, 'PAYROLL_PERIOD_FINALIZED');
  // finalized, not paid: a new version may replace it; the old invoice numbers stay, marked cancelled
  const sup = await ok(h.api().post(`/api/equipment/payroll/batches/${batch.eq_batch_id}/supersede`).set(A()).send({ reason: 'rate correction' }));
  assert.strictEqual(sup.version_number, 2);
  assert.strictEqual(sup.total_net, '8235.00');
  const old = await ok(h.api().get(`/api/equipment/payroll/batches/${batch.eq_batch_id}`).set(ACC()));
  assert.ok(old.invoices.length > 0 && old.invoices.every((i) => i.cancelled), 'superseded invoices are cancelled, never reused');
  const chain = await ok(h.api().get(`/api/equipment/payroll/batches/${sup.eq_batch_id}/versions`).set(ACC()));
  assert.deepStrictEqual(chain.map((c) => c.status), ['Superseded', 'Generated']);
  const voided = await ok(h.api().patch(`/api/equipment/payroll/batches/${sup.eq_batch_id}/void`).set(A()).send({ reason: 'redo' }));
  assert.strictEqual(voided.status, 'Voided');
  const again = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(SCOPE));
  assert.strictEqual(again.totals[0].net, '8235.00', 'void frees rows');
});

test('stale batch cannot be finalized', async () => {
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, equipment_id: F.exc.equipment_id }));
  const [row] = await h.query("SELECT eq_attendance_id, check_out_time FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-03'", [F.exc.equipment_id]);
  // remarks / paper do not move money: the batch stays finalizable
  await ok(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ remarks: 'changed after generation', reason: 'remark added by the office' }));
  assert.strictEqual((await ok(h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}`).set(ACC()))).stale, false);
  // a different check-out changes the billed hours: stale
  const { addMinutes } = require('../utils/dateTime');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ check_out_time: addMinutes(row.check_out_time, -30), reason: 'sheet shows earlier check-out' }));
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  const f = await h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/finalize`).set(A());
  assert.strictEqual(f.body.code, 'BATCH_STALE');
});
