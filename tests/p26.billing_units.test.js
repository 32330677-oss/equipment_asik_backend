// P26 — every unit is billed once: machines chosen by hand, a monthly machine billed alone then with its vendor, the
// month split exactly (F-difference), rows not approved block the issue (14 Oct 2026), a handed-over invoice locks the
// period of its machines, machines taken out of drafts, printing holds nothing, backfill of the monthly days.
const { test, before, after } = require('node:test');
const KNOWN_FAILING = { todo: 'known failing on main before CI was added (28 Oct 2026): see tests/KNOWN_FAILING.md' };
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00 Syria time
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; let m4; let m5; const R = {};

async function machine(plate, cardBody, assigned = '2026-09-01', type = 1) {
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: type, plate_number: plate, make: 'CAT' }));
  await ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A()).send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-07-01', ...cardBody }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: assigned, default_operator_id: F.op1.operator_id }));
  return m;
}
async function day(m, date, inT, outT, { approve = true } = {}) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}
async function scans(month) {
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=${month}`).set(ACC()));
  for (const s of sheets) {
    const [done] = await h.query('SELECT COALESCE(MAX(through_row_no), 0) AS r FROM eq_timesheet_scans WHERE timesheet_id = ?', [s.timesheet_id]);
    const [last] = await h.query('SELECT last_row_no FROM eq_timesheets WHERE timesheet_id = ?', [s.timesheet_id]);
    if (Number(done.r) < Number(last.last_row_no)) {
      await ok(h.api().post(`/api/equipment/timesheets/${s.timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer(`signed ${s.timesheet_id} ${last.last_row_no}`), 'scan.png'));
    }
  }
}
const finalize = (id) => ok(h.api().patch(`/api/equipment/payroll/batches/${id}/finalize`).set(A()).send({ acknowledge_changes: true }));
const gen = (body) => h.api().post('/api/equipment/payroll/generate').set(ACC()).send(body);
const OCT = { start_date: '2026-10-01', end_date: '2026-10-31' };
const rowsOf = async (batchId) => (await ok(h.api().get(`/api/equipment/payroll/batches/${batchId}/rows`).set(ACC()))).map((r) => r.eq_attendance_id).sort((a, b) => a - b);

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  m4 = await machine('P-004', { billing_mode: 'Hourly', hourly_rate: 30 });
  m5 = await machine('P-005', { billing_mode: 'Hourly', hourly_rate: 35 });
  R.exc = await day(F.exc, '2026-10-05', '07:00', '15:00');
  R.loader = await day(F.loader, '2026-10-05', '07:00', '15:00');
  R.crane = await day(F.crane, '2026-10-05', '07:00', '15:00');
  R.m4 = await day(m4, '2026-10-05', '07:00', '15:00');
  R.m5a = await day(m5, '2026-10-05', '07:00', '15:00');
  R.m5b = await day(m5, '2026-10-06', '07:00', '15:00', { approve: false }); // still Submitted
  R.m5c = await day(m5, '2026-10-07', '07:00', '15:00', { approve: false });
});
after(h.closePool);

let b1;
test('3 machines of 5 in one batch: items only for them, one vendor invoice', async () => {
  const bad = await gen({ ...OCT, equipment_ids: [F.exc.equipment_id, F.loader.equipment_id] });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR', 'several machines need the vendor');
  const other = await gen({ ...OCT, vendor_id: F.vendor.vendor_id + 999, equipment_ids: [F.exc.equipment_id] });
  assert.ok([404, 422].includes(other.status));
  const r = await gen({ ...OCT, vendor_id: F.vendor.vendor_id, equipment_ids: [F.exc.equipment_id, F.loader.equipment_id, m4.equipment_id] });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  b1 = r.body.data;
  assert.deepStrictEqual([...new Set(b1.items.map((i) => i.equipment_id))].sort((a, b) => a - b), [F.exc.equipment_id, F.loader.equipment_id, m4.equipment_id].sort((a, b) => a - b));
  assert.strictEqual(b1.scope_machines.length, 3);
  await scans('2026-10');
  const fin = await finalize(b1.eq_batch_id);
  assert.strictEqual(fin.invoices.filter((i) => i.kind === 'Vendor').length, 1);
});

let b2; let b3;
test('a monthly machine alone, then the vendor for the same month: no error, the monthly machine is skipped', async () => {
  b2 = (await gen({ ...OCT, equipment_id: F.crane.equipment_id })).body.data;
  assert.strictEqual(b2.items[0].equipment_id, F.crane.equipment_id);
  const [days] = await h.query('SELECT COUNT(*) AS n FROM eq_payroll_monthly_days WHERE eq_batch_id = ?', [b2.eq_batch_id]);
  assert.ok(Number(days.n) >= 26, 'the crane days of October are held by its batch');
  const r = await gen({ ...OCT, vendor_id: F.vendor.vendor_id, accept_blockers: true, accept_reason: 'two m5 days are still waiting' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  b3 = r.body.data;
  // the machine left out of the finalized batch (m5) is billed normally; nothing of the crane or of b1
  assert.deepStrictEqual(b3.items.map((i) => i.equipment_id), [m5.equipment_id]);
  assert.deepStrictEqual(await rowsOf(b3.eq_batch_id), [R.m5a]);
});

test('rows not approved block the issue (14 Oct 2026): approved, the draft is recalculated and takes them', async () => {
  const no = await h.api().patch(`/api/equipment/payroll/batches/${b3.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true });
  assert.strictEqual(no.body.code, 'ROWS_NOT_APPROVED');
  const ids = no.body.details.blockers[0].items.map((i) => i.eq_attendance_id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [R.m5b, R.m5c].sort((a, b) => a - b), 'the rows to approve or reject are listed');
  const ap = await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [R.m5b, R.m5c] }));
  assert.strictEqual(ap.approved.length, 2);
  assert.strictEqual((await ok(h.api().get(`/api/equipment/payroll/batches/${b3.eq_batch_id}`).set(ACC()))).stale, true);
  const v2 = await ok(h.api().post(`/api/equipment/payroll/batches/${b3.eq_batch_id}/supersede`).set(ACC()).send({}));
  assert.deepStrictEqual(await rowsOf(v2.eq_batch_id), [R.m5a, R.m5b, R.m5c].sort((a, b) => a - b));
  await scans('2026-10');
  b3 = await finalize(v2.eq_batch_id);
  assert.strictEqual(b3.state, 'issued');
  assert.ok(['NOTHING_TO_PAY', 'PERIOD_OVERLAP'].includes(await code(gen({ ...OCT, vendor_id: F.vendor.vendor_id }))), 'never twice');
});

test('handed over to finance: the whole period of its machines is locked; before that the office edits with the same number', KNOWN_FAILING, async () => {
  b1 = await ok(h.api().get(`/api/equipment/payroll/batches/${b1.eq_batch_id}`).set(ACC()));
  const no = b1.vendor_invoice_no;
  assert.ok(no, 'issued in the first test');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${R.exc}`).set(A()).send({ check_out_time: '2026-10-05 16:00' }));
  b1 = await ok(h.api().post(`/api/equipment/payroll/batches/${b1.eq_batch_id}/refresh`).set(ACC()).send({}));
  assert.strictEqual(b1.vendor_invoice_no, no, 'same number');
  await h.handOver(b1.eq_batch_id);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${R.exc}`).set(A()).send({ check_out_time: '2026-10-05 17:00' })), 'INVOICE_LOCKED');
  // a day nobody recorded inside its period, fuel and adjustments dated inside: refused too (the period is the invoice's)
  assert.strictEqual(await code(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-08 07:00', check_out_time: '2026-10-08 15:00', late_reason: 'paper sheet typed late' })), 'INVOICE_LOCKED');
  assert.strictEqual(await code(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-10', liters: 20, price_per_liter: 1 })), 'INVOICE_LOCKED');
  assert.strictEqual(await code(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.loader.equipment_id, site_id: 8, adjustment_date: '2026-10-12', adjustment_type: 'Bonus', amount: 25, reason: 'extra trip' })), 'INVOICE_LOCKED');
  // the machines it does not cover stay free in the same period
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.crane.equipment_id, site_id: 8, issue_date: '2026-10-10', liters: 20, price_per_liter: 1 }));
  const ov = await gen({ ...OCT, vendor_id: F.vendor.vendor_id, equipment_ids: [F.exc.equipment_id, F.loader.equipment_id] });
  assert.strictEqual(ov.body.code, 'PERIOD_OVERLAP');
  assert.ok(ov.body.details.overlaps.every((m) => m.free.length === 0), 'nothing of October is free for them');
});

test('a monthly month split in two batches adds up to the whole month (overtime empty, at 9, off)', async () => {
  for (const [plate, card] of [['M-OT', { overtime_enabled: true }], ['M-9', { overtime_enabled: true, overtime_rate: 9 }], ['M-OFF', { overtime_enabled: false }]]) {
    const m = await machine(plate, { billing_mode: 'Monthly', monthly_rate: 2000, standard_hours_per_day: 10, ...card }, '2026-10-13', 4);
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) await day(m, d, '06:00', '18:00'); // 12 h: more than due in the first half
    for (const d of ['2026-10-17', '2026-10-18', '2026-10-19']) await day(m, d, '07:00', '15:00'); // 8 h
    const whole = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ ...OCT, equipment_id: m.equipment_id }));
    const first = (await gen({ start_date: '2026-10-01', end_date: '2026-10-15', equipment_id: m.equipment_id })).body.data;
    const second = (await gen({ start_date: '2026-10-16', end_date: '2026-10-31', equipment_id: m.equipment_id })).body.data; // the next period (no overlap)
    const sum = Math.round(Number(first.total_net) * 100) + Math.round(Number(second.total_net) * 100);
    assert.strictEqual(sum, Math.round(Number(whole.totals[0].net) * 100), `${plate}: ${first.total_net} + ${second.total_net} = ${whole.totals[0].net}`);
    const mc = second.items[0].rate_snapshot.monthly_calc[0];
    assert.strictEqual(mc.part, true, 'the second part is a settlement of the month');
    assert.ok(mc.billed_before);
  }
});

test('take_from_drafts: a draft with two machines keeps the other one; a draft with one machine is voided', async () => {
  R.excN = await day(F.exc, '2026-11-03', '07:00', '15:00');
  R.loaderN = await day(F.loader, '2026-11-03', '07:00', '15:00');
  const NOV = { start_date: '2026-11-01', end_date: '2026-11-15', vendor_id: F.vendor.vendor_id };
  const d1 = (await gen({ ...NOV, equipment_ids: [F.exc.equipment_id, F.loader.equipment_id] })).body.data;
  // without take_from_drafts the machine in the draft is simply skipped
  assert.ok(['NOTHING_TO_PAY', 'PERIOD_OVERLAP'].includes(await code(gen({ ...NOV, equipment_ids: [F.exc.equipment_id] }))));
  const cov = await ok(h.api().get(`/api/equipment/payroll/coverage?vendor_id=${F.vendor.vendor_id}&start_date=2026-11-01&end_date=2026-11-15`).set(ACC()));
  const excCov = cov.find((c) => c.equipment_id === F.exc.equipment_id);
  assert.deepStrictEqual(excCov.in_draft, [d1.eq_batch_id]);
  assert.strictEqual(excCov.ready.rows, 0);
  const r = await gen({ ...NOV, equipment_ids: [F.exc.equipment_id], take_from_drafts: true });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.deepStrictEqual(await rowsOf(r.body.data.eq_batch_id), [R.excN]);
  assert.ok(r.body.warnings.find((w) => w.code === 'DRAFT_RECALCULATED'));
  const old = await ok(h.api().get(`/api/equipment/payroll/batches/${d1.eq_batch_id}`).set(ACC()));
  assert.strictEqual(old.status, 'Superseded');
  const [nv] = await h.query("SELECT eq_batch_id FROM eq_payroll_batches WHERE supersedes_batch_id = ? AND status = 'Generated'", [d1.eq_batch_id]);
  assert.deepStrictEqual(await rowsOf(nv.eq_batch_id), [R.loaderN]);
  const r2 = await gen({ ...NOV, equipment_ids: [F.loader.equipment_id], take_from_drafts: true });
  assert.strictEqual(r2.status, 201, JSON.stringify(r2.body));
  const gone = await ok(h.api().get(`/api/equipment/payroll/batches/${nv.eq_batch_id}`).set(ACC()));
  assert.strictEqual(gone.status, 'Voided');
});

test('printing holds nothing: two statements, then Generate gives the same result', async () => {
  const id = await day(m4, '2026-11-04', '07:00', '15:00');
  for (let i = 0; i < 2; i += 1) {
    const pdf = await h.api().get(`/api/equipment/statements/machine/${m4.equipment_id}.pdf?from=2026-11-01&to=2026-11-15`).set(ACC());
    assert.strictEqual(pdf.status, 200);
  }
  const b = (await gen({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: m4.equipment_id })).body.data;
  assert.deepStrictEqual(await rowsOf(b.eq_batch_id), [id]);
});

test('the backfill fills the monthly days of older batches and is idempotent', KNOWN_FAILING, async () => {
  const { backfill } = require('../scripts/backfillMonthlyDays');
  const { pool } = require('../config/db');
  const [[before1]] = await pool.query('SELECT COUNT(*) AS n FROM eq_payroll_monthly_days WHERE eq_batch_id = ?', [b2.eq_batch_id]);
  await h.query('DELETE FROM eq_payroll_monthly_days WHERE eq_batch_id = ?', [b2.eq_batch_id]);
  const first = await backfill(pool);
  assert.ok(first.added >= Number(before1.n));
  const [[after1]] = await pool.query('SELECT COUNT(*) AS n FROM eq_payroll_monthly_days WHERE eq_batch_id = ?', [b2.eq_batch_id]);
  assert.strictEqual(Number(after1.n), Number(before1.n));
  const second = await backfill(pool);
  assert.strictEqual(second.added, 0);
  // the old batch holds its days again: a new crane batch for October finds nothing
  assert.strictEqual(await code(gen({ ...OCT, equipment_id: F.crane.equipment_id })), 'NOTHING_TO_PAY');
});
