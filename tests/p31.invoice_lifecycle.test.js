// P31 — life of an invoice (decisions of 13-14 Oct 2026): any vendor / machines / period without overlap (the conflict
// and the free dates are given), issue, same number while in the office, hand-over to finance (HO-), withdrawal with a
// signed acknowledgement (WD-), re-issue with NEW numbers, cancel, debit / credit notes (DN- / CN-), register.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
const gen = (body) => h.api().post('/api/equipment/payroll/generate').set(ACC()).send(body);
let F; let first; let second;

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
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-20', '2026-10-21']) await workDay(F.exc, d);
});
after(h.closePool);

test('periods: 1-15 and 16-31 are separate invoices; an overlapping request says which invoice and what is free', async () => {
  const E = F.exc.equipment_id;
  first = await ok(gen({ start_date: '2026-10-01', end_date: '2026-10-15', equipment_id: E }));
  assert.strictEqual(first.state, 'draft');
  assert.strictEqual(first.vendor_invoice_no, null, 'a draft has no number');
  const ov = await gen({ start_date: '2026-10-10', end_date: '2026-10-31', equipment_id: E });
  assert.strictEqual(ov.status, 409);
  assert.strictEqual(ov.body.code, 'PERIOD_OVERLAP');
  const m = ov.body.details.overlaps[0];
  assert.strictEqual(m.equipment_id, E);
  assert.deepStrictEqual(m.conflicts.map((c) => [c.eq_batch_id, c.state, c.start_date, c.end_date]), [[first.eq_batch_id, 'draft', '2026-10-01', '2026-10-15']]);
  assert.deepStrictEqual(m.free, [{ from: '2026-10-16', to: '2026-10-31' }]);
  // the coverage of the vendor's machines shows the same, before asking
  const cov = await ok(h.api().get(`/api/equipment/payroll/coverage?vendor_id=${F.vendor.vendor_id}&start_date=2026-10-10&end_date=2026-10-31`).set(ACC()));
  const c = cov.find((x) => x.equipment_id === E);
  assert.strictEqual(c.is_ready, false);
  assert.deepStrictEqual(c.in_draft, [first.eq_batch_id]);
  assert.deepStrictEqual(c.free, [{ from: '2026-10-16', to: '2026-10-31' }]);
  second = await ok(gen({ start_date: '2026-10-16', end_date: '2026-10-31', equipment_id: E }));
  assert.ok(second.eq_batch_id);
});

test('issue: only once the period has ended; numbers are unique in the whole system', async () => {
  // the monthly crane is billed for November (its base) while November is not over yet
  const today = await ok(gen({ start_date: '2026-11-01', end_date: '2026-11-30', equipment_id: F.crane.equipment_id, accept_blockers: true, accept_reason: 'test: November not over' }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${today.eq_batch_id}/finalize`).set(ACC()).send({ acknowledge_changes: true })), 'PERIOD_NOT_ENDED');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${today.eq_batch_id}/void`).set(ACC()).send({}));
  first = await h.issue(first.eq_batch_id);
  second = await h.issue(second.eq_batch_id);
  assert.strictEqual(first.vendor_invoice_no, 'VI-2026-00001');
  assert.strictEqual(second.vendor_invoice_no, 'VI-2026-00002');
  assert.deepStrictEqual(first.actions, { recalculate: false, delete_draft: false, issue: false, refresh: true, cancel: true, hand_over: true, withdraw: false, reissue: false, notes: true });
  const [dup] = await h.query('SELECT invoice_no, COUNT(*) AS n FROM eq_invoices GROUP BY invoice_no HAVING n > 1');
  assert.strictEqual(dup, undefined);
});

test('hand-over to finance (HO-), then the invoice is locked; withdrawal with a signed acknowledgement (WD-)', async () => {
  const ho = await h.handOver([first.eq_batch_id]);
  assert.strictEqual(ho.handover_no, 'HO-2026-00001');
  assert.strictEqual(ho.lines[0].doc_no, 'VI-2026-00001');
  const pdf = await bin(h.api().get(`/api/equipment/payroll/handovers/${ho.handover_id}/pdf`).set(ACC()));
  assert.strictEqual(pdf.body.slice(0, 4).toString(), '%PDF');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${first.eq_batch_id}`).set(A()));
  assert.strictEqual(d.state, 'handed_over');
  assert.strictEqual(d.handover.handover_no, 'HO-2026-00001');
  assert.deepStrictEqual(Object.entries(d.actions).filter(([, v]) => v).map(([k]) => k).sort(), ['notes', 'withdraw']);
  // nobody changes its days now
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ check_out_time: '2026-10-05 16:00' })), 'INVOICE_LOCKED');
  // the accountant cannot withdraw; a reason and the finance person are required
  assert.strictEqual((await h.api().post(`/api/equipment/payroll/batches/${first.eq_batch_id}/withdraw`).set(ACC()).send({ reason: 'wrong hours', finance_person: 'Rami' })).status, 403);
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${first.eq_batch_id}/withdraw`).set(A()).send({ reason: 'x', finance_person: 'Rami' })), 'VALIDATION_ERROR');
  const w = await h.api().post(`/api/equipment/payroll/batches/${first.eq_batch_id}/withdraw`).set(A())
    .send({ reason: 'Hours of 5 Oct are wrong', finance_person: 'Rami (finance)', withdrawn_on: '2026-11-20', was_paid: true, paid_amount: 100 });
  assert.strictEqual(w.status, 201, w.text);
  assert.strictEqual(w.body.data.state, 'returned');
  assert.strictEqual(w.body.data.withdrawal.withdrawal_no, 'WD-2026-00001');
  assert.strictEqual(w.body.data.withdrawal.was_paid, true);
  const wpdf = await bin(h.api().get(`/api/equipment/payroll/withdrawals/${w.body.withdrawal_id}/pdf`).set(A()));
  assert.strictEqual(wpdf.body.slice(0, 4).toString(), '%PDF');
});

test('withdrawn: only the Admin changes it; changed, it must be re-issued (new numbers) before a new hand-over', async () => {
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [F.exc.equipment_id]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(ACC()).send({ check_out_time: '2026-10-05 16:00' })), 'INVOICE_LOCKED');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${row.eq_attendance_id}`).set(A()).send({ check_out_time: '2026-10-05 16:00', reason: 'signed sheet' }));
  const again = await h.api().post('/api/equipment/payroll/handovers').set(A()).send({ batch_ids: [first.eq_batch_id], receiver_name: 'Finance' });
  assert.strictEqual(again.body.code, 'REISSUE_FIRST');
  assert.strictEqual((await h.api().post(`/api/equipment/payroll/batches/${first.eq_batch_id}/reissue`).set(ACC()).send({ reason: 'corrected' })).status, 403);
  const r = await h.api().post(`/api/equipment/payroll/batches/${first.eq_batch_id}/reissue`).set(A()).send({ reason: 'Hours of 5 Oct corrected' });
  assert.strictEqual(r.status, 201, r.text);
  const nb = r.body.data;
  assert.strictEqual(nb.state, 'issued');
  assert.strictEqual(nb.vendor_invoice_no, 'VI-2026-00003', 'a NEW number, never a reused one');
  assert.strictEqual(nb.replaces.invoice_no, 'VI-2026-00001', 'the link is shown in the app');
  assert.strictEqual(Number(nb.total_net), Number(first.total_net) + 40, 'one more hour at 40');
  const old = await ok(h.api().get(`/api/equipment/payroll/batches/${first.eq_batch_id}`).set(A()));
  assert.strictEqual(old.state, 'replaced');
  assert.strictEqual(old.replaced_by.invoice_no, 'VI-2026-00003');
  assert.ok(old.invoices.every((i) => i.cancelled), 'the old numbers stay cancelled');
  first = nb;
});

test('debit / credit notes: draft (no number), Admin issues (DN- / CN-), handed over, withdrawn; shown with their invoice', async () => {
  const V = F.vendor.vendor_id;
  // the accountant prepares; an unknown machine of another vendor is refused
  const n = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Credit', vendor_id: V, equipment_id: F.exc.equipment_id, currency: 'USD', amount: 30, reason: 'Damaged mirror, agreed', ref_batch_id: second.eq_batch_id }));
  assert.strictEqual(n.status, 'Draft');
  assert.deepStrictEqual(n.actions, { edit: true, issue: false, cancel: true, hand_over: false, withdraw: false });
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Debit', vendor_id: V, currency: 'USD', amount: 0, reason: 'zero amount' })), 'VALIDATION_ERROR');
  const changed = await ok(h.api().put(`/api/equipment/payroll/notes/${n.note_id}`).set(ACC()).send({ amount: 35 }));
  assert.strictEqual(changed.amount, '35.00');
  const cn = await ok(h.api().patch(`/api/equipment/payroll/notes/${n.note_id}/issue`).set(A()));
  assert.strictEqual(cn.note_no, 'CN-2026-00001');
  // issued: only the Admin changes it (same number)
  assert.strictEqual(await code(h.api().put(`/api/equipment/payroll/notes/${n.note_id}`).set(ACC()).send({ amount: 36 })), 'ADMIN_ONLY');
  const general = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Debit', vendor_id: V, currency: 'USD', amount: 50, reason: 'Transport of the crane, agreed' }));
  const dn = await ok(h.api().patch(`/api/equipment/payroll/notes/${general.note_id}/issue`).set(A()));
  assert.strictEqual(dn.note_no, 'DN-2026-00001');
  // one hand-over with an invoice and the two notes: the credit note is negative
  const ho = await ok(h.api().post('/api/equipment/payroll/handovers').set(A()).send({ batch_ids: [second.eq_batch_id], note_ids: [n.note_id, general.note_id], receiver_name: 'Finance' }));
  assert.deepStrictEqual(ho.lines.map((l) => [l.doc_no, Number(l.amount)]), [['VI-2026-00002', Number(second.total_net)], ['CN-2026-00001', -35], ['DN-2026-00001', 50]]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/notes/${n.note_id}/cancel`).set(A()).send({ reason: 'try' })), 'NOTE_HANDED_OVER');
  const w = await ok(h.api().post(`/api/equipment/payroll/notes/${general.note_id}/withdraw`).set(A()).send({ reason: 'Amount to be checked', finance_person: 'Rami' }));
  assert.strictEqual(w.status, 'Returned');
  const cancelled = await ok(h.api().patch(`/api/equipment/payroll/notes/${general.note_id}/cancel`).set(A()).send({ reason: 'not agreed after all' }));
  assert.strictEqual(cancelled.status, 'Cancelled');
  const pdf = await bin(h.api().get(`/api/equipment/payroll/notes/${n.note_id}/pdf`).set(ACC()));
  assert.strictEqual(pdf.body.slice(0, 4).toString(), '%PDF');
  // the register shows each invoice with its own notes, general notes apart
  const reg = await ok(h.api().get('/api/equipment/payroll/register').set(ACC()));
  const v = reg.find((x) => x.vendor_id === V);
  const inv = v.invoices.find((i) => i.eq_batch_id === second.eq_batch_id);
  assert.deepStrictEqual(inv.notes.map((x) => x.note_no), ['CN-2026-00001']);
  assert.ok(v.general_notes.find((x) => x.note_id === general.note_id));
  assert.ok(v.invoices.find((i) => i.state === 'replaced' && i.vendor_invoice_no === 'VI-2026-00001' && i.cancelled), 'old invoices stay findable, marked cancelled');
  const found = await ok(h.api().get('/api/equipment/payroll/register').query({ q: 'VI-2026-00003' }).set(ACC()));
  assert.deepStrictEqual(found.flatMap((x) => x.invoices).map((i) => i.vendor_invoice_no), ['VI-2026-00003']);
});

test('cancel: drafts by the office, issued or withdrawn by the Admin with a reason; handed over must be withdrawn first', async () => {
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${second.eq_batch_id}/void`).set(A()).send({ reason: 'try' })), 'INVOICE_HANDED_OVER');
  const v = await ok(h.api().patch(`/api/equipment/payroll/batches/${first.eq_batch_id}/void`).set(A()).send({ reason: 'issued by mistake' }));
  assert.strictEqual(v.state, 'cancelled');
  // its days are free again; the cancelled number is never given again
  const again = await ok(gen({ start_date: '2026-10-01', end_date: '2026-10-15', equipment_id: F.exc.equipment_id }));
  const issued = await h.issue(again.eq_batch_id);
  assert.strictEqual(issued.vendor_invoice_no, 'VI-2026-00004');
});
