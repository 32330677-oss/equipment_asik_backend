// P24 — undo of a Finalize within eq_finalize_undo_hours (11 Oct 2026): the batch is a draft again, its rows can be
// edited, and the next Finalize gives back the SAME invoice numbers. Afterwards (or once money moved): Correction only.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

const T0 = new Date(Date.UTC(2026, 10, 20, 9, 0, 0)); // 2026-11-20 12:00 Syria time
BD.setClock(() => T0);
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
const nos = (b) => b.invoices.filter((i) => !i.cancelled && i.status !== 'Withdrawn').map((i) => i.invoice_no).sort();
let F; const rows = {}; let batch;

async function workDay(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}
async function scans(month) {
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=${month}`).set(ACC()));
  for (const s of sheets) {
    const done = await h.query('SELECT COUNT(*) AS n FROM eq_timesheet_scans WHERE timesheet_id = ?', [s.timesheet_id]);
    if (!Number(done[0].n)) await ok(h.api().post(`/api/equipment/timesheets/${s.timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  }
}
const finalize = (id) => ok(h.api().patch(`/api/equipment/payroll/batches/${id}/finalize`).set(A()).send({ acknowledge_changes: true }));
const unfinalize = (id, who = A) => h.api().patch(`/api/equipment/payroll/batches/${id}/unfinalize`).set(who()).send({ reason: 'one day was wrong' });

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  rows.exc = await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  rows.loader = await workDay(F.loader, '2026-10-05', '07:00', '15:00');
  batch = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id }));
  await scans('2026-10');
});
after(async () => { BD.setClock(() => T0); await h.closePool(); });

let first; let v2;
test('Finalize, undo, edit a row, recalculate, Finalize: the same VI and MI numbers, the new amount', async () => {
  first = await finalize(batch.eq_batch_id);
  const issued = nos(first);
  assert.strictEqual(issued.filter((n) => n.startsWith('VI-')).length, 1);
  assert.strictEqual(issued.filter((n) => n.startsWith('MI-')).length, first.items.length);
  assert.strictEqual(first.finalize_undo.possible, true);
  assert.strictEqual(first.finalize_undo.window_hours, 72);
  // the row is locked while finalized
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${rows.exc}`).set(A()).send({ check_out_time: '2026-10-05 16:00' })), 'PAYROLL_PERIOD_FINALIZED');
  const r = await unfinalize(batch.eq_batch_id);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.strictEqual(d.is_finalized, false);
  assert.strictEqual(d.finalize_undo_count, 1);
  assert.ok(d.invoices.every((i) => i.status === 'Withdrawn' && !i.cancelled), 'numbers are reserved, not cancelled');
  assert.deepStrictEqual(d.reserved_numbers.map((x) => x.invoice_no).sort(), issued);
  assert.ok(d.items.every((i) => i.invoice_no === null), 'no live invoice while it is a draft');
  // the day is editable again
  await ok(h.api().patch(`/api/equipment/admin/attendance/${rows.exc}`).set(A()).send({ check_out_time: '2026-10-05 16:00' }));
  const res = await h.api().post(`/api/equipment/payroll/batches/${batch.eq_batch_id}/supersede`).set(A()).send({});
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  v2 = res.body.data;
  assert.deepStrictEqual(v2.reserved_numbers.map((x) => x.invoice_no).sort(), issued);
  const fin2 = await finalize(v2.eq_batch_id);
  assert.deepStrictEqual(nos(fin2), issued, 'the same numbers');
  assert.strictEqual(Math.round((Number(fin2.total_net) - Number(first.total_net)) * 100), 4000, '+1 h x 40');
  const [vi] = await h.query("SELECT amount, reissued_at, eq_batch_id FROM eq_invoices WHERE kind = 'Vendor' AND invoice_no = ?", [issued.find((n) => n.startsWith('VI-'))]);
  assert.strictEqual(Number(vi.amount), Number(fin2.total_net));
  assert.strictEqual(vi.eq_batch_id, v2.eq_batch_id);
  assert.ok(vi.reissued_at);
});

let v3;
test('a machine that left the batch after the undo: its number is cancelled, the others come back', async () => {
  const before3 = await ok(h.api().get(`/api/equipment/payroll/batches/${v2.eq_batch_id}`).set(ACC()));
  const loaderNo = before3.items.find((i) => i.equipment_id === F.loader.equipment_id).invoice_no;
  assert.ok(loaderNo);
  assert.strictEqual((await unfinalize(v2.eq_batch_id)).status, 200);
  await ok(h.api().patch(`/api/equipment/admin/attendance/${rows.loader}/cancel`).set(A()).send({}));
  const res = await h.api().post(`/api/equipment/payroll/batches/${v2.eq_batch_id}/supersede`).set(A()).send({});
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  v3 = res.body.data;
  assert.ok(!v3.items.find((i) => i.equipment_id === F.loader.equipment_id));
  const fin = await finalize(v3.eq_batch_id);
  const live = nos(fin);
  assert.ok(!live.includes(loaderNo));
  assert.deepStrictEqual(live, nos(before3).filter((n) => n !== loaderNo).sort());
  const [c] = await h.query('SELECT c.reason FROM eq_invoice_cancellations c JOIN eq_invoices i ON i.invoice_id = c.invoice_id WHERE i.invoice_no = ?', [loaderNo]);
  assert.match(c.reason, /left the batch/);
});

test('after the window (73 h): no undo, and no new version either (Correction only)', async () => {
  BD.setClock(() => new Date(T0.getTime() + 73 * 3600000));
  try {
    const d = await ok(h.api().get(`/api/equipment/payroll/batches/${v3.eq_batch_id}`).set(ACC()));
    assert.strictEqual(d.finalize_undo.possible, false);
    assert.strictEqual(d.finalize_undo.reason, 'window_passed');
    assert.strictEqual(await code(unfinalize(v3.eq_batch_id)), 'FINALIZE_WINDOW_PASSED');
    assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${v3.eq_batch_id}/supersede`).set(A()).send({ reason: 'recalc' })), 'FINALIZE_WINDOW_PASSED');
  } finally {
    BD.setClock(() => T0);
  }
});

test('a payment blocks the undo; reversed, the undo works', async () => {
  const d = await ok(h.api().post(`/api/equipment/payroll/batches/${v3.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: F.vendor.vendor_id, amount: 10 }));
  assert.strictEqual(d.finalize_undo.reason, 'payments');
  const r = await unfinalize(v3.eq_batch_id);
  assert.strictEqual(r.body.code, 'UNFINALIZE_NOT_ALLOWED');
  const [p] = await h.query("SELECT payment_id FROM eq_payments WHERE eq_batch_id = ? AND status = 'Active'", [v3.eq_batch_id]);
  await ok(h.api().patch(`/api/equipment/payroll/payments/${p.payment_id}/reverse`).set(A()).send({ reason: 'typed on the wrong batch' }));
  assert.strictEqual((await unfinalize(v3.eq_batch_id)).status, 200);
  await finalize(v3.eq_batch_id);
});

test('a correction on the batch blocks the undo', async () => {
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${rows.exc}/correction`).set(A()).send({ reason: 'Signed sheet shows 17:00', changes: { check_out_time: '2026-10-05 17:00' } }));
  assert.strictEqual(c.request_status, 'Approved');
  const r = await unfinalize(v3.eq_batch_id);
  assert.strictEqual(r.body.code, 'UNFINALIZE_NOT_ALLOWED');
  assert.strictEqual(r.body.details.reason, 'corrections');
});

let nov;
test('the Accountant asks; the Admin approves; the undo runs in the Admin\'s name', async () => {
  await workDay(F.exc, '2026-11-03', '07:00', '15:00');
  nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  await scans('2026-11');
  await finalize(nov.eq_batch_id);
  const asked = await unfinalize(nov.eq_batch_id, ACC);
  assert.strictEqual(asked.status, 202, JSON.stringify(asked.body));
  assert.strictEqual(asked.body.data.is_finalized, true, 'nothing changes before the Admin decides');
  assert.strictEqual(asked.body.data.pending_request.action, 'unfinalize');
  const notAcc = await h.api().patch(`/api/equipment/payroll/requests/${asked.body.data.pending_request.request_id}/approve`).set(ACC()).send({});
  assert.strictEqual(notAcc.status, 403);
  const done = await ok(h.api().patch(`/api/equipment/payroll/requests/${asked.body.data.pending_request.request_id}/approve`).set(A()).send({ note: 'ok' }));
  assert.strictEqual(done.is_finalized, false);
  const [log] = await h.query("SELECT user_id FROM audit_logs WHERE table_name = 'eq_payroll_batches' AND record_id = ? AND action_type = 'unfinalize'", [nov.eq_batch_id]);
  assert.strictEqual(log.user_id, 1);
});

test('void after an undo: every reserved number is cancelled', async () => {
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${nov.eq_batch_id}`).set(ACC()));
  const reserved = d.reserved_numbers.map((x) => x.invoice_no);
  assert.ok(reserved.length >= 2);
  const v = await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/void`).set(A()).send({}));
  assert.strictEqual(v.status, 'Voided');
  assert.ok(v.invoices.every((i) => i.cancelled));
  const left = await h.query("SELECT COUNT(*) AS n FROM eq_invoices i LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = i.invoice_id WHERE i.invoice_no IN (?) AND c.invoice_id IS NULL", [reserved]);
  assert.strictEqual(Number(left[0].n), 0);
});

test('setting eq_finalize_undo_hours = 0: the undo is always closed', async () => {
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  await ok(h.api().put('/api/settings/eq_finalize_undo_hours').set(A()).send({ value: 0, reason: 'finance closes at once' }));
  try {
    const fin = await finalize(b.eq_batch_id);
    assert.strictEqual(fin.finalize_undo.possible, false);
    assert.strictEqual(await code(unfinalize(b.eq_batch_id)), 'FINALIZE_WINDOW_PASSED');
  } finally {
    await ok(h.api().put('/api/settings/eq_finalize_undo_hours').set(A()).send({ value: 72, reason: 'back to the default' }));
  }
});
