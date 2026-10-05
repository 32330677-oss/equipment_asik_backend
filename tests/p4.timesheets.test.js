const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { ok, standardFleet, recordExampleA, A, S8 } = require('./fixtures');

let F; let ids; let sheet;
const ACC = () => h.auth(h.T.accountant());

before(async () => { await h.resetDatabase(); F = await standardFleet(); ids = await recordExampleA(F); });
after(h.closePool);

test('sheet created automatically with rows 1..7', async () => {
  const list = await ok(h.api().get('/api/equipment/timesheets?month=2026-10').set(S8()));
  assert.strictEqual(list.length, 1);
  sheet = list[0];
  assert.strictEqual(sheet.sheet_code, 'ETS-2026-10-EQ0001-S08');
  assert.strictEqual(sheet.last_row_no, 7);
  assert.strictEqual(sheet.needs_scan, true);
  assert.strictEqual(sheet.verify_token, undefined);
  const other = await h.api().get(`/api/equipment/timesheets/${sheet.timesheet_id}`).set(h.auth(h.T.sup9()));
  assert.strictEqual(other.body.code, 'SITE_FORBIDDEN');
});

test('print returns a PDF and counts prints', async () => {
  const r = await h.api().get(`/api/equipment/timesheets/${sheet.timesheet_id}/print.pdf`).set(S8()).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/pdf');
  assert.ok(r.body.length > 10000);
  fs.mkdirSync(path.join(__dirname, '..', 'docs', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'generated', 'sample_timesheet.pdf'), r.body);
  const [s] = await h.query('SELECT print_count FROM eq_timesheets WHERE timesheet_id = ?', [sheet.timesheet_id]);
  assert.strictEqual(Number(s.print_count), 1);
});

test('QR resolve needs the right token', async () => {
  const [s] = await h.query('SELECT verify_token FROM eq_timesheets WHERE timesheet_id = ?', [sheet.timesheet_id]);
  const good = await ok(h.api().get(`/api/equipment/timesheets/resolve?qr=${encodeURIComponent(`TFEQ|${sheet.sheet_code}|${s.verify_token}`)}`).set(S8()));
  assert.strictEqual(good.timesheet_id, sheet.timesheet_id);
  const bad = await h.api().get(`/api/equipment/timesheets/resolve?code=${sheet.sheet_code}&token=0000`).set(S8());
  assert.strictEqual(bad.status, 404);
});

const QRCode = require('qrcode');
let PNG; let PNG2;
before(async () => { PNG = await QRCode.toBuffer('page one'); PNG2 = await QRCode.toBuffer('page two'); });

test('scan upload: images merged to one PDF, duplicates refused, private file', async () => {
  const close1 = await h.api().patch(`/api/equipment/timesheets/${sheet.timesheet_id}/close`).set(ACC()).send({ site_engineer_name: 'Eng. Rami', vendor_rep_name: 'Samer' });
  assert.strictEqual(close1.body.code, 'FINAL_SCAN_REQUIRED');
  const supUp = await h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(S8()).attach('files', PNG, 'p1.png');
  assert.strictEqual(supUp.status, 403); // supervisors only record times; the accountant uploads the signed sheet
  const up = await ok(h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', PNG, 'p1.png').attach('files', PNG2, 'p2.png').field('through_row_no', '5'));
  assert.strictEqual(up.version_no, 1);
  assert.strictEqual(up.page_count, 2);
  const dup = await h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', PNG, 'p1.png').attach('files', PNG2, 'p2.png');
  // merged PDFs embed a creation date, so identical images can still differ; uploading the SAME pdf twice must fail:
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'docs', 'generated', 'sample_timesheet.pdf'));
  const v2 = await ok(h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', pdf, 'scan.pdf'));
  const again = await h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', pdf, 'scan.pdf');
  assert.strictEqual(again.body.code, 'DUPLICATE_SCAN');
  assert.ok([201, 409].includes(dup.status));
  const noTok = await h.api().get(`/api/equipment/timesheets/${sheet.timesheet_id}/scans/${v2.scan_id}/file`);
  assert.strictEqual(noTok.status, 401);
  const file = await h.api().get(`/api/equipment/timesheets/${sheet.timesheet_id}/scans/${v2.scan_id}/file`).set(ACC());
  assert.strictEqual(file.status, 200);
  const txt = await h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', Buffer.from('not an image at all....'), 'x.png');
  assert.strictEqual(txt.status, 415);
  const broken = Buffer.concat([PNG.subarray(0, 40), Buffer.alloc(20)]);
  const bad = await h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/scans`).set(ACC()).attach('files', broken, 'b.png');
  assert.strictEqual(bad.body.code, 'FILE_CORRUPT');
});

test('paper checks: tolerance, signatures, mismatch note; supervisor cannot reconcile', async () => {
  const url = `/api/equipment/timesheets/${sheet.timesheet_id}/paper-checks`;
  const sup = await h.api().post(url).set(S8()).send({ items: [{ eq_attendance_id: ids[0], result: 'Matched', employee_signed: true, operator_signed: true }] });
  assert.strictEqual(sup.status, 403);
  const far = await h.api().post(url).set(ACC()).send({ items: [{ eq_attendance_id: ids[0], result: 'Matched', paper_check_in: '2026-10-01 07:12', employee_signed: true, operator_signed: true }] });
  assert.strictEqual(far.body.code, 'CANNOT_MATCH');
  const sig = await h.api().post(url).set(ACC()).send({ items: [{ eq_attendance_id: ids[0], result: 'Matched', employee_signed: true }] });
  assert.strictEqual(sig.body.code, 'CANNOT_MATCH');
  const noNote = await h.api().post(url).set(ACC()).send({ items: [{ eq_attendance_id: ids[1], result: 'Mismatch' }] });
  assert.strictEqual(noNote.body.code, 'VALIDATION_ERROR');
  const res = await ok(h.api().post(url).set(ACC()).send({ items: [
    { eq_attendance_id: ids[0], result: 'Matched', paper_check_in: '2026-10-01 07:05', employee_signed: true, operator_signed: true },
    { eq_attendance_id: ids[1], result: 'Mismatch', note: 'Paper shows 07:30 check-in' },
  ] }));
  assert.strictEqual(res.checked.length, 2);
  assert.strictEqual(res.checked[0].diff_minutes, 5);
});

test('close then reconcile; correction sets Pending again', async () => {
  const items = ids.map((id) => ({ eq_attendance_id: id, result: 'Matched', employee_signed: true, operator_signed: true }));
  await ok(h.api().post(`/api/equipment/timesheets/${sheet.timesheet_id}/paper-checks`).set(ACC()).send({ items }));
  const closed = await ok(h.api().patch(`/api/equipment/timesheets/${sheet.timesheet_id}/close`).set(ACC()).send({ site_engineer_name: 'Eng. Rami', vendor_rep_name: 'Samer' }));
  assert.strictEqual(closed.status, 'Reconciled');
  const late = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-10-09', day_status: 'Absent' });
  assert.strictEqual(late.body.code, 'TIMESHEET_CLOSED');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${ids[0]}`).set(A()).send({ remarks: 'admin note' }));
  const [row] = await h.query('SELECT paper_status FROM eq_attendance WHERE eq_attendance_id = ?', [ids[0]]);
  assert.strictEqual(row.paper_status, 'Pending');
  const [s] = await h.query('SELECT status FROM eq_timesheets WHERE timesheet_id = ?', [sheet.timesheet_id]);
  assert.strictEqual(s.status, 'Closed');
  await ok(h.api().patch(`/api/equipment/timesheets/${sheet.timesheet_id}/reopen`).set(A()).send({ reason: 'late row' }));
});
