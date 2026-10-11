// P27 — running statements (11 Oct 2026): vendor statement of account (balance owed to the vendor, every official movement)
// and machine billing history (what was billed, in which invoice, and what is NOT billed yet).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');
const { pool } = require('../config/db');
const L = require('../services/equipment/eqLedger');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F; let oct; let nov; let dn; let firstRow;

async function workDay(m, date, approve = true) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} 15:00`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  const V = F.vendor.vendor_id;
  // money owed from before the system
  await ok(h.api().post(`/api/equipment/vendors/${V}/opening-balances`).set(ACC()).send({ amount: 1000, as_of_date: '2026-09-30', description: 'Rent before the system', reference: 'OLD-1' }));
  // October: two days of the excavator (8 h x 40 = 320 each), finalized
  firstRow = await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  // a payment, and a payment typed by mistake then reversed
  await ok(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V, amount: 100, paid_on: '2026-11-10', method: 'Cheque', reference: 'CHQ-1' }));
  const r = await h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V, amount: 50, paid_on: '2026-11-11' });
  assert.strictEqual(r.status, 201, r.text);
  await ok(h.api().patch(`/api/equipment/payroll/payments/${r.body.payment.payment_id}/reverse`).set(A()).send({ reason: 'typed twice' }));
  // a correction after the lock: one more hour on 5 Oct = debit note of 40
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${firstRow}/correction`).set(A()).send({ reason: 'Signed sheet shows 16:00', changes: { check_out_time: '2026-10-05 16:00' } }));
  dn = c.note;
  // November: one day + the settlement of the debit note (dated the day it was issued, 20 Nov), finalized
  await workDay(F.exc, '2026-11-10');
  nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-20', equipment_id: F.exc.equipment_id }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  // not billed yet: the loader worked (approved) and the excavator has a day waiting for approval
  await workDay(F.loader, '2026-11-12');
  await workDay(F.exc, '2026-11-14', false);
});
after(h.closePool);

test('vendor statement: invoices, opening balance, debit note counted once, payments and the reversal', async () => {
  assert.ok(dn && dn.kind === 'DebitNote', 'the correction issued a debit note');
  const st = await ok(h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}/account`).set(ACC()));
  assert.strictEqual(st.sections.length, 1);
  const s = st.sections[0];
  assert.strictEqual(s.currency, 'USD');
  assert.strictEqual(s.brought_forward, 0);
  const kinds = s.rows.map((r) => r.kind);
  assert.deepStrictEqual(kinds.filter((k) => k === 'invoice').length, 2);
  assert.ok(kinds.includes('opening') && kinds.includes('DebitNote') && kinds.includes('reversal'));
  const novRow = s.rows.find((r) => r.eq_batch_id === nov.eq_batch_id);
  const novNet = Math.round(Number(nov.total_net) * 100);

  assert.ok(novNet > 32000, 'the November batch pays the day and the debit note');
  assert.strictEqual(novRow.debit, novNet - Math.round(Number(dn.amount) * 100), 'the settlement of the note is not counted twice');
  assert.match(novRow.description, /excl\. DN-/);
  // 1000 + 640 + 40 (note) + 320 - 100 (paid) - 50 + 50 (reversed)
  assert.strictEqual(s.closing, 190000);
  assert.strictEqual(s.rows[s.rows.length - 1].balance, s.closing);
  assert.strictEqual(s.total_debit - s.total_credit, s.closing);
  assert.strictEqual(s.last_payment.credit, 5000, 'the last payment line (reversed later)');
  // the estimate: earned (approved) but not in any batch, not part of the balance
  assert.ok(s.estimate && !s.estimate.error, JSON.stringify(s.estimate));
  assert.ok(s.estimate.amount >= 30000, `estimate ${s.estimate.amount}`);
});

test('brought forward: lines before "from" become one opening line; drafts are not counted', async () => {
  const st = await L.vendorStatement(pool, F.vendor.vendor_id, { from: '2026-11-15', to: '2026-11-20', estimate: false });
  const s = st.sections[0];
  assert.strictEqual(s.brought_forward, 100000 - 10000 - 5000, 'opening balance - payments of 10 and 11 Nov (the reversal is dated 20 Nov)');
  assert.strictEqual(s.closing, 190000);
  assert.strictEqual(s.estimate, null);
  // a draft batch adds nothing
  const draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.loader.equipment_id }));
  const again = await L.vendorStatement(pool, F.vendor.vendor_id, { estimate: false });
  assert.strictEqual(again.sections[0].closing, 190000);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/void`).set(ACC()).send({}));
});

test('one section per currency (a currency with only an opening balance)', async () => {
  await ok(h.api().post(`/api/equipment/vendors/${F.vendor.vendor_id}/contracts`).set(A()).send({ contract_number: 'AB-EUR', start_date: '2026-07-01', currency: 'EUR' }));
  await ok(h.api().post(`/api/equipment/vendors/${F.vendor.vendor_id}/opening-balances`).set(ACC()).send({ amount: 500, currency: 'EUR', as_of_date: '2026-08-31', description: 'Old EUR rent' }));
  const st = await L.vendorStatement(pool, F.vendor.vendor_id, { estimate: false });
  assert.deepStrictEqual(st.sections.map((s) => [s.currency, s.closing]), [['EUR', 50000], ['USD', 190000]]);
});

test('machine history: billed periods with invoice numbers, and the days not billed yet', async () => {
  const hx = await ok(h.api().get(`/api/equipment/statements/machine/${F.exc.equipment_id}/history`).set(ACC()));
  assert.strictEqual(hx.rows.length, 2);
  const [o, n] = hx.rows;
  assert.deepStrictEqual([o.period_from, o.period_to], ['2026-10-05', '2026-10-06']);
  assert.match(o.vi_no, /^VI-/); assert.match(o.mi_no, /^MI-/);
  assert.strictEqual(o.state, 'Partly paid');
  assert.strictEqual(n.state, 'Finalized - unpaid');
  assert.strictEqual(hx.notes.length, 1);
  assert.strictEqual(hx.notes[0].kind, 'DebitNote');
  assert.deepStrictEqual(hx.not_billed.pending.map((r) => [r.from, r.count]), [['2026-11-14', 1]]);
  assert.strictEqual(hx.not_billed.approved.length, 0);
  // the loader: one approved day, not billed
  const lh = await L.machineHistory(pool, F.loader.equipment_id, {});
  assert.strictEqual(lh.rows.length, 0, 'the voided draft is not listed');
  assert.deepStrictEqual(lh.not_billed.approved.map((r) => r.from), ['2026-11-12']);
  // the monthly crane: deployed since 1 Sep, never billed -> its working days show
  const ch = await L.machineHistory(pool, F.crane.equipment_id, {});
  assert.strictEqual(ch.not_billed.monthly_days[0].from, '2026-09-01');
  const total = ch.not_billed.monthly_days.reduce((a, r) => a + r.count, 0);
  assert.ok(total > 60 && total < 82, `monthly days ${total}`);
  assert.strictEqual(ch.not_billed.monthly_days[ch.not_billed.monthly_days.length - 1].to <= '2026-11-20', true);
});

test('PDFs and validation', async () => {
  const v = await bin(h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}/account.pdf`).set(ACC()));
  assert.strictEqual(v.status, 200); assert.strictEqual(v.headers['content-type'], 'application/pdf'); assert.ok(v.body.length > 3000);
  assert.match(v.headers['content-disposition'], /statement-of-account-.*-2026-11-20\.pdf/);
  const m = await bin(h.api().get(`/api/equipment/statements/machine/${F.exc.equipment_id}/history.pdf`).query({ from: '2026-10-01' }).set(A()));
  assert.strictEqual(m.status, 200); assert.ok(m.body.length > 3000);
  const code = async (url, q) => (await h.api().get(url).query(q).set(ACC())).body.code;
  const url = `/api/equipment/statements/vendor/${F.vendor.vendor_id}/account`;
  assert.strictEqual(await code(url, { to: '2026-11-21' }), 'VALIDATION_ERROR');
  assert.strictEqual(await code(url, { from: '2026-11-10', to: '2026-11-01' }), 'VALIDATION_ERROR');
  assert.strictEqual(await code(url, { from: 'x' }), 'VALIDATION_ERROR');
  assert.strictEqual((await h.api().get('/api/equipment/statements/vendor/9999/account').set(ACC())).status, 404);
  assert.strictEqual((await h.api().get(url).set(S8())).status, 403);
  // the provisional statement route is untouched
  assert.notStrictEqual((await h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}.pdf`).query({ from: '2026-11-01', to: '2026-11-20' }).set(ACC())).status, 404);
});

test('machine totals: a debit note paid inside a later batch is not added twice', async () => {
  const hx = await L.machineHistory(pool, F.exc.equipment_id, {});
  assert.strictEqual(hx.notes[0].settled_batch_id, nov.eq_batch_id);
  // 640 (Oct) + 360 (Nov = 320 + the note's 40)
  assert.deepStrictEqual(hx.totals.map((t) => [t.currency, t.finalized, t.notes]), [['USD', 100000, 0]]);
});
