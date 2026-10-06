// P13 — correction policy of 6 Oct 2026: closed months are never reopened by a new batch, official corrections (several
// fields, one approval by another person, also for money that is not attendance), correction settlements cannot be
// cancelled, office edits before the lock, undo Mark Paid, late entries (warning only), historical supervisors, cancelled rows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

const NOW = new Date(Date.UTC(2026, 10, 20, 9, 0, 0)); // 2026-11-20 12:00 Syria time
BD.setClock(() => NOW);
const ACC = () => h.auth(h.T.accountant());
const S9 = () => h.auth(h.T.sup9());
const code = async (req) => (await req).body.code;
const pj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
let F; let oct; let lateRow; let paidRow;

async function workDay(m, date, inT, outT, { approve = true, sup = S8, site = 8, shift = 'Day' } = {}) {
  // a past day is recorded as one whole session (check-in with its check-out), as the paper sheet shows it
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(sup()).send({ equipment_id: m.equipment_id, site_id: site, shift_type: shift, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(sup()).send({ site_id: site, shift_type: shift, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  paidRow = await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  lateRow = await workDay(F.exc, '2026-10-06', '07:00', '15:00', { approve: false }); // still Submitted when October closes
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-05', liters: 50, price_per_liter: 1 }));
  const scope = { start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id };
  // C3: accepting blockers needs a reason, kept on the batch
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(scope)), 'BLOCKERS_PRESENT');
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, accept_blockers: true })), 'VALIDATION_ERROR');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, accept_blockers: true, accept_reason: 'Oct 6 is still checked by the office' }));
  assert.match(oct.accept_blockers_reason, /NOT_APPROVED: Oct 6 is still checked/);
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  // F8: the person who finalizes sees the manual changes it pays (here: late entries, accepted blockers) and confirms them
  const noAck = await h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A());
  assert.strictEqual(noAck.body.code, 'CHANGES_NOT_ACKNOWLEDGED');
  assert.ok(noAck.body.details.items.find((i) => i.kind === 'accepted_blockers'));
  assert.ok(noAck.body.details.items.find((i) => i.kind === 'late_entry'));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
});
after(async () => { BD.setClock(() => NOW); await h.closePool(); });

test('closed month: a late row is neither approved nor rejected normally, and no new batch pays it', async () => {
  const ap = await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [lateRow] }));
  assert.deepStrictEqual(ap.approved, []);
  assert.strictEqual(ap.skipped[0].reason, 'PAYROLL_PERIOD_FINALIZED');
  const rj = await ok(h.api().post('/api/equipment/admin/attendance/reject').set(A()).send({ ids: [lateRow], notes: 'check' }));
  assert.strictEqual(rj.skipped[0].reason, 'PAYROLL_PERIOD_FINALIZED');
  const blk = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  const closed = blk.find((b) => b.code === 'IN_CLOSED_PERIOD');
  assert.ok(closed && closed.items.find((r) => r.eq_attendance_id === lateRow), 'the late row is shown as needing a Correction');
  // even if a row got approved by another route (old data), a new batch over the closed month pays nothing of it
  await h.query("UPDATE eq_attendance SET status = 'Approved' WHERE eq_attendance_id = ?", [lateRow]);
  const again = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id });
  assert.strictEqual(again.body.code, 'NOTHING_TO_PAY');
  await h.query("UPDATE eq_attendance SET status = 'Submitted' WHERE eq_attendance_id = ?", [lateRow]);
  // fuel recorded in October but never priced cannot be priced now (it would never be billed): Correction
  const [f] = await h.query("INSERT INTO eq_fuel_issues (equipment_id, site_id, issue_date, liters, issued_by_user_id) VALUES (?, 8, '2026-10-07', 30, 3)", [F.exc.equipment_id]).then((x) => [x]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-issues/${f.insertId}`).set(ACC()).send({ price_per_liter: 1 })), 'PAYROLL_PERIOD_FINALIZED');
});

test('a late row of a closed month is paid through an official Correction (requested by the Accountant, approved by the Admin)', async () => {
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${lateRow}/correction`).set(ACC())
    .send({ reason: 'Approved late: signed sheet received', changes: { check_out_time: '2026-10-06 16:00' }, amount_override: 360, override_reason: '9 h x 40 from the paper sheet' }));
  assert.strictEqual(c.request_status, 'Requested');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(ACC()).send({})), 'SAME_PERSON');
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(done.request_status, 'Approved');
  assert.strictEqual(done.note.kind, 'DebitNote');
  const [row] = await h.query('SELECT status, check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [lateRow]);
  assert.strictEqual(row.status, 'Approved', 'the office accepted the corrected row');
  assert.strictEqual(row.check_out_time, '2026-10-06 16:00:00');
  const [adj] = await h.query('SELECT adjustment_id, amount, adjustment_date FROM eq_adjustments WHERE correction_id = ?', [c.correction_id]);
  assert.strictEqual(Number(adj.amount), 360);
  assert.ok(adj.adjustment_date > '2026-10-31', 'settled in the first open period');
  // F1 / C1: the settlement belongs to the correction: never cancelled by hand (API refuses, list says why)
  assert.strictEqual(await code(h.api().patch(`/api/equipment/adjustments/${adj.adjustment_id}/cancel`).set(ACC()).send({ reason: 'mistake' })), 'CORRECTION_ADJUSTMENT_LOCKED');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/adjustments/${adj.adjustment_id}/cancel`).set(A()).send({ reason: 'mistake' })), 'CORRECTION_ADJUSTMENT_LOCKED');
  const list = await ok(h.api().get(`/api/equipment/adjustments?equipment_id=${F.exc.equipment_id}`).set(ACC()));
  assert.match(list.find((a) => a.adjustment_id === adj.adjustment_id).correction_note_no, /^DN-/);
  // the row is still never paid again by a batch of the closed month
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id })), 'NOTHING_TO_PAY');
});

test('one correction carries several fields; one approval by another person; the author of an amendment cannot approve it', async () => {
  const changes = { check_in_time: '2026-10-05 06:30', check_out_time: '2026-10-05 16:00', downtime: [{ downtime_type: 'Break', start_time: '2026-10-05 12:00', end_time: '2026-10-05 12:30' }] };
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${paidRow}/correction`).set(A()).send({ reason: 'Signed sheet: 06:30-16:00, 30 min break', changes }));
  assert.strictEqual(Number(c.delta_amount), 40); // paid 8 h = 320; corrected 9 h x 40 = 360
  assert.strictEqual(await code(h.api().post(`/api/equipment/admin/attendance/${paidRow}/correction`).set(ACC()).send({ reason: 'another one', changes: { remarks: 'x' } })), 'CORRECTION_PENDING');
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(ACC()).send({ note: 'matches the sheet' }));
  assert.deepStrictEqual(done.events.map((e) => e.action), ['request', 'approve']);
  const [row] = await h.query('SELECT check_in_time, check_out_time, working_minutes, break_minutes FROM eq_attendance WHERE eq_attendance_id = ?', [paidRow]);
  assert.strictEqual(row.check_in_time, '2026-10-05 06:30:00');
  assert.strictEqual(row.check_out_time, '2026-10-05 16:00:00');
  assert.strictEqual(Number(row.break_minutes), 30);
  const notes = await h.query("SELECT kind, amount FROM eq_invoices WHERE kind IN ('DebitNote','CreditNote') AND eq_batch_id = ?", [oct.eq_batch_id]);
  assert.ok(notes.find((n) => Number(n.amount) === 40), 'one note for the three fields');
  // amendment: the Accountant changes the amount; the Accountant may not approve that version, the Admin may
  const c2 = await ok(h.api().post(`/api/equipment/admin/attendance/${paidRow}/correction`).set(A()).send({ reason: 'Work description wrong', changes: { work_description: 'Excavation B2' } }));
  await ok(h.api().patch(`/api/equipment/admin/corrections/${c2.correction_id}/review`).set(ACC()).send({ note: 'no money', amount_override: 0, override_reason: 'text only' }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/corrections/${c2.correction_id}/approve`).set(ACC()).send({})), 'SAME_PERSON');
  const ok2 = await ok(h.api().patch(`/api/equipment/admin/corrections/${c2.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(ok2.note, null, 'no money difference: no note');
  // the finalized batch itself never changes
  const b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(b.total_net, oct.total_net);
});

test('official correction of money that is not attendance: fuel litres of a finalized batch', async () => {
  const b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  const item = b.items[0];
  const fuelLine = item.lines.find((l) => l.line_type === 'Fuel');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-issues/${fuelLine.source_id}`).set(ACC()).send({ liters: 40, reason: 'receipt says 40 L' })), 'PAYROLL_PERIOD_FINALIZED');
  const c = await ok(h.api().post('/api/equipment/admin/corrections/financial').set(ACC())
    .send({ target_type: 'fuel_issue', target_id: fuelLine.source_id, eq_item_id: item.eq_item_id, fuel_changes: { liters: 40 }, reason: 'Receipt shows 40 L, not 50 L' }));
  assert.strictEqual(Number(c.delta_amount), 10, 'we deducted 50, should have deducted 40');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(ACC()).send({})), 'SAME_PERSON');
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(done.note.kind, 'DebitNote');
  const [f] = await h.query('SELECT liters FROM eq_fuel_issues WHERE fuel_issue_id = ?', [fuelLine.source_id]);
  assert.strictEqual(Number(f.liters), 40);
  const [log] = await h.query("SELECT old_values, related_type FROM audit_logs WHERE table_name = 'eq_fuel_issues' AND record_id = ? AND action_type = 'correction'", [fuelLine.source_id]);
  assert.ok(JSON.stringify(pj(log.old_values)).includes('50'), 'the original litres stay in the history');
  // a rate card used by a finalized batch is not edited; its price is corrected the same way (amount given)
  const rc = await ok(h.api().post('/api/equipment/admin/corrections/financial').set(A())
    .send({ target_type: 'rate_card', target_id: item.rate_card_id, eq_item_id: item.eq_item_id, amount: -15, reason: 'Agreed discount not applied' }));
  const rcDone = await ok(h.api().patch(`/api/equipment/admin/corrections/${rc.correction_id}/approve`).set(ACC()).send({}));
  assert.strictEqual(rcDone.note.kind, 'CreditNote');
});

test('before the lock the office corrects directly: the Accountant needs no Admin approval; stale batch; audit keeps field changes', async () => {
  const id = await workDay(F.exc, '2026-11-10', '07:00', '15:00');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${id}`).set(ACC()).send({ check_out_time: '2026-11-10 16:00' })), 'VALIDATION_ERROR');
  const e = await ok(h.api().patch(`/api/equipment/admin/attendance/${id}`).set(ACC()).send({ check_out_time: '2026-11-10 16:00', check_in_time: '2026-11-10 06:45', reason: 'Signed sheet shows 06:45-16:00' }));
  assert.strictEqual(e.status, 'Approved');
  assert.strictEqual(e.edited_after_approval, true);
  const [log] = await h.query("SELECT changed_fields, payroll_effect, reason FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? AND action_type = 'office_edit_after_approval'", [id]);
  const changed = pj(log.changed_fields);
  assert.deepStrictEqual(changed.check_out_time, ['2026-11-10 15:00:00', '2026-11-10 16:00:00']);
  assert.ok(changed.check_in_time);
  assert.strictEqual(log.payroll_effect, 'none');
  const nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  await ok(h.api().patch(`/api/equipment/admin/attendance/${id}`).set(ACC()).send({ check_out_time: '2026-11-10 15:30', reason: 'second look at the sheet' }));
  const [log2] = await h.query("SELECT payroll_effect FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? ORDER BY log_id DESC LIMIT 1", [id]);
  assert.strictEqual(log2.payroll_effect, `stale:${nov.eq_batch_id}`);
  assert.strictEqual((await ok(h.api().get(`/api/equipment/payroll/batches/${nov.eq_batch_id}`).set(ACC()))).stale, true);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/void`).set(ACC()).send({ reason: 'row corrected' }));
  // a row of the closed month is not edited directly, whoever asks
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${paidRow}`).set(ACC()).send({ remarks: 'x', reason: 'try to edit' })), 'PAYROLL_PERIOD_FINALIZED');
});

test('late entry is a warning, never a block', async () => {
  const late = await h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, check_in_time: '2026-11-14 07:00' });
  assert.strictEqual(late.status, 201, 'saved even without a reason');
  assert.strictEqual(late.body.warnings[0].code, 'LATE_ENTRY');
  assert.strictEqual(late.body.warnings[0].days_late, 6);
  assert.strictEqual(late.body.warnings[0].reason_missing, true);
  assert.strictEqual(late.body.data.late_entry, true);
  const withReason = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: '2026-11-13', day_status: 'Absent', late_reason: 'sheet came back from site late' }));
  assert.strictEqual(withReason.late_entry, true);
  assert.strictEqual(withReason.late_entry_reason, 'sheet came back from site late');
  const recent = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: '2026-11-18', day_status: 'Absent' }));
  assert.strictEqual(recent.late_entry, false, '2 days is not late (threshold 3)');
  const list = await ok(h.api().get('/api/equipment/admin/attendance?late=only').set(ACC()));
  assert.ok(list.find((r) => r.eq_attendance_id === late.body.data.eq_attendance_id));
});

test('daily fuel is not recorded at check-out any more', async () => {
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-14'", [F.loader.equipment_id]);
  const before = await h.query('SELECT COUNT(*) AS n FROM eq_fuel_issues');
  const r = await h.api().post(`/api/equipment/attendance/${row.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-11-14 15:00', fuel_liters: 60 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.warnings, ['FUEL_AT_CHECKOUT_NOT_RECORDED']);
  const afterN = await h.query('SELECT COUNT(*) AS n FROM eq_fuel_issues');
  assert.strictEqual(Number(afterN[0].n), Number(before[0].n));
});

test('stops can be corrected in place; overwriting a session keeps the old one in the history', async () => {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-11-19 07:00' }));
  const withBreak = await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Break', start_time: '2026-11-19 10:00', end_time: '2026-11-19 11:00' }));
  const p = withBreak.downtime[0];
  const fixed = await ok(h.api().patch(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/${p.downtime_id}`).set(S8()).send({ end_time: '2026-11-19 10:30' }));
  assert.strictEqual(fixed.downtime[0].end_time, '2026-11-19 10:30:00');
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-11-19 15:00' }));
  // "did not work" over the recorded session: allowed with confirmation, the session stays in the audit trail (F9)
  await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-11-19', day_status: 'Absent', confirm_discard_session: true }));
  const [log] = await h.query("SELECT old_values FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? AND action_type = 'day_status'", [r.eq_attendance_id]);
  const old = pj(log.old_values);
  assert.strictEqual(old.check_in_time, '2026-11-19 07:00:00');
  assert.strictEqual(old.downtime.length, 1);
});

test('a row that should not exist is cancelled, not falsified; its slot can be recorded again', async () => {
  const wrong = await workDay(F.loader, '2026-11-11', '07:00', '15:00', { approve: false });
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${wrong}/cancel`).set(S8()).send({ reason: 'wrong machine' })), 'INVALID_STATE'); // Submitted: recall first
  await ok(h.api().post('/api/equipment/admin/attendance/reject').set(A()).send({ ids: [wrong], notes: 'this machine was not on site' }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${wrong}/cancel`).set(S8()).send({})), 'VALIDATION_ERROR');
  const c = await ok(h.api().patch(`/api/equipment/attendance/${wrong}/cancel`).set(S8()).send({ reason: 'wrong machine selected' }));
  assert.strictEqual(c.status, 'Cancelled');
  assert.strictEqual(c.cancel_reason, 'wrong machine selected');
  // the slot is free again (the cancelled row stays for history)
  const again = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-11-11', day_status: 'Holiday' }));
  assert.notStrictEqual(again.eq_attendance_id, wrong);
  const rows = await h.query("SELECT status FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-11-11' ORDER BY eq_attendance_id", [F.loader.equipment_id]);
  assert.deepStrictEqual(rows.map((r) => r.status), ['Cancelled', 'Draft']);
  // an Approved row before the lock: the office voids it (reason), it is kept as Cancelled
  const approved = await workDay(F.crane, '2026-11-12', '07:00', '15:00');
  // the supervisor never cancels a row the office approved, also if it later shows as Rejected (old data / any path)
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${approved}/cancel`).set(S8()).send({ reason: 'wrong machine selected' })), 'INVALID_STATE');
  await h.query("UPDATE eq_attendance SET status = 'Rejected' WHERE eq_attendance_id = ?", [approved]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${approved}/cancel`).set(S8()).send({ reason: 'wrong machine selected' })), 'APPROVED_BEFORE');
  const [lookedUp] = await h.query('SELECT status FROM eq_attendance WHERE eq_attendance_id = ?', [approved]);
  assert.strictEqual(lookedUp.status, 'Rejected', 'nothing changed');
  await h.query("UPDATE eq_attendance SET status = 'Approved' WHERE eq_attendance_id = ?", [approved]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${approved}/cancel`).set(ACC()).send({})), 'VALIDATION_ERROR');
  const v = await ok(h.api().patch(`/api/equipment/admin/attendance/${approved}/cancel`).set(ACC()).send({ reason: 'duplicate of the night shift row' }));
  assert.strictEqual(v.status, 'Cancelled');
  // inside the closed month: only an official Correction (cancel_row)
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/attendance/${paidRow}/cancel`).set(ACC()).send({ reason: 'wrong machine' })), 'PAYROLL_PERIOD_FINALIZED');
});

test('the office can undo Mark Paid only within the window, with a reason, and never once a payment reference exists', async () => {
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/mark-paid`).set(A()).send({}));
  let b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(A()));
  assert.strictEqual(b.paid_undo.possible, true);
  assert.strictEqual(b.paid_undo.window_hours, 168);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/undo-paid`).set(A()).send({})), 'VALIDATION_ERROR');
  assert.strictEqual((await h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/undo-paid`).set(ACC()).send({ reason: 'wrong batch' })).status, 403);
  // 100 hours later: still inside the default 168 h window
  BD.setClock(() => new Date(NOW.getTime() + 100 * 3600000));
  const u = await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/undo-paid`).set(A()).send({ reason: 'marked the wrong batch' }));
  assert.strictEqual(u.status, 'Generated');
  assert.strictEqual(u.is_finalized, true);
  assert.strictEqual(u.paid_undo_count, 1);
  // with a payment reference the payment really happened: no undo
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/mark-paid`).set(A()).send({ payment_reference: 'TRF-55120' }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/undo-paid`).set(A()).send({ reason: 'oops, wrong batch' })), 'UNDO_PAID_NOT_ALLOWED');
  // the window is a setting (control setting: reason required); past it, no undo
  await h.query("UPDATE eq_payroll_batches SET payment_reference = NULL WHERE eq_batch_id = ?", [oct.eq_batch_id]);
  assert.strictEqual(await code(h.api().put('/api/settings/eq_paid_undo_hours').set(A()).send({ value: 48 })), 'VALIDATION_ERROR');
  await ok(h.api().put('/api/settings/eq_paid_undo_hours').set(A()).send({ value: 48, reason: 'finance asked for 2 days' }));
  BD.setClock(() => new Date(NOW.getTime() + 100 * 3600000 + 49 * 3600000));
  const late = await h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/undo-paid`).set(A()).send({ reason: 'too late' });
  assert.strictEqual(late.body.code, 'UNDO_PAID_NOT_ALLOWED');
  assert.strictEqual(late.body.details.reason, 'window_passed');
  BD.setClock(() => NOW);
  // a reference recorded later also closes the undo
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payment-reference`).set(A()).send({ payment_reference: 'TRF-55121' }));
  b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(A()));
  assert.strictEqual(b.paid_undo.possible, false);
  const logs = await h.query("SELECT action_type, reason FROM audit_logs WHERE table_name = 'eq_payroll_batches' AND record_id = ? AND action_type IN ('undo_paid','payment_reference')", [oct.eq_batch_id]);
  assert.ok(logs.find((l) => l.action_type === 'undo_paid' && l.reason === 'marked the wrong batch'));
});

test('historical visibility is not editing permission: the old supervisor reads, the new one asks the office', async () => {
  const draft = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, record_date: '2026-11-12', day_status: 'Standby', remarks: 'no work front' }));
  // from Nov 15 Supervisor Nine takes S08 Day
  await ok(h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-11-15' }));
  // the previous supervisor still sees the day, read-only, and cannot change it or ask for a change
  const view = await ok(h.api().get('/api/equipment/attendance/site/8?date=2026-11-12').set(S8()));
  assert.strictEqual(view.access.can_edit, false);
  assert.strictEqual(view.access.reason, 'moved_away');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${draft.eq_attendance_id}`).set(S8()).send({ remarks: 'changed' })), 'SITE_HISTORY_READ_ONLY');
  assert.strictEqual(await code(h.api().post(`/api/equipment/attendance/${draft.eq_attendance_id}/change-requests`).set(S8()).send({ reason: 'fix it please', changes: { remarks: 'x' } })), 'SITE_HISTORY_READ_ONLY');
  // the new supervisor sees the site history but changes it only through the office
  const v9 = await ok(h.api().get('/api/equipment/attendance/site/8?date=2026-11-12').set(S9()));
  assert.strictEqual(v9.access.can_edit, false);
  assert.strictEqual(v9.access.reason, 'before_assignment');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/attendance/${draft.eq_attendance_id}`).set(S9()).send({ remarks: 'changed' })), 'SITE_HISTORY_NEEDS_APPROVAL');
  const cr = await ok(h.api().post(`/api/equipment/attendance/${draft.eq_attendance_id}/change-requests`).set(S9())
    .send({ reason: 'Machine was waiting for the crane, not the work front', changes: { remarks: 'waiting for crane' } }));
  assert.strictEqual(cr.status, 'Pending');
  assert.strictEqual((await h.api().patch(`/api/equipment/admin/change-requests/${cr.change_request_id}/approve`).set(S9()).send({})).status, 403);
  const applied = await ok(h.api().patch(`/api/equipment/admin/change-requests/${cr.change_request_id}/approve`).set(ACC()).send({ note: 'ok' }));
  assert.strictEqual(applied.status, 'Applied');
  const [row] = await h.query('SELECT remarks FROM eq_attendance WHERE eq_attendance_id = ?', [draft.eq_attendance_id]);
  assert.strictEqual(row.remarks, 'waiting for crane');
  const [log] = await h.query("SELECT related_type, related_id, reason FROM audit_logs WHERE table_name = 'eq_attendance' AND record_id = ? AND action_type = 'office_edit'", [draft.eq_attendance_id]);
  assert.strictEqual(log.related_type, 'eq_attendance_change_requests');
  assert.match(log.reason, /Change request #/);
  // the old supervisor's forgotten Draft no longer blocks the new supervisor's week
  const id = await ok(h.api().post('/api/equipment/attendance/day-status').set(S9()).send({ equipment_id: F.loader.equipment_id, site_id: 8, record_date: '2026-11-18', day_status: 'Holiday' }));
  const sub = await ok(h.api().post('/api/equipment/attendance/submit').set(S9()).send({ site_id: 8, record_date: '2026-11-18' }));
  assert.ok(sub.submitted >= 1);
  const day = await ok(h.api().get('/api/equipment/attendance/site/8?date=2026-11-18').set(S9()));
  assert.ok(day.submit.week_gate.left_by_others.length >= 1, 'left by the previous supervisor, reported');
  void id;
  // a request on a row of the closed month becomes an official Correction when the office says so
  const crOld = await ok(h.api().post(`/api/equipment/attendance/${paidRow}/change-requests`).set(S9()).send({ reason: 'meter end was 5110', changes: { meter_end: 5110 } }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/change-requests/${crOld.change_request_id}/approve`).set(ACC()).send({})), 'ROW_LOCKED_USE_CORRECTION');
  const conv = await ok(h.api().patch(`/api/equipment/admin/change-requests/${crOld.change_request_id}/approve`).set(ACC()).send({ convert_to_correction: true }));
  assert.match(conv.decision_note, /converted to correction #\d+/);
});

test('deployment first day can be corrected (with a reason) in an open period', async () => {
  const dep = await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.loader.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-11-16' }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/deployments/${dep.eq_assignment_id}/start`).set(ACC()).send({ assigned_date: '2026-11-18' })), 'VALIDATION_ERROR');
  const later = await ok(h.api().patch(`/api/equipment/deployments/${dep.eq_assignment_id}/start`).set(ACC()).send({ assigned_date: '2026-11-18', reason: 'machine arrived on the 18th' }));
  assert.strictEqual(later.assigned_date, '2026-11-18');
  const earlier = await ok(h.api().patch(`/api/equipment/deployments/${dep.eq_assignment_id}/start`).set(ACC()).send({ assigned_date: '2026-11-17', reason: 'gate log shows the 17th' }));
  assert.strictEqual(earlier.assigned_date, '2026-11-17');
  // the excavator's deployment: moving its first day into the closed month is refused (closed period: Correction)
  const [exc] = await h.query("SELECT eq_assignment_id FROM eq_site_assignments WHERE equipment_id = ? AND unassigned_date IS NULL ORDER BY eq_assignment_id LIMIT 1", [F.exc.equipment_id]);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/deployments/${exc.eq_assignment_id}/start`).set(ACC()).send({ assigned_date: '2026-10-10', reason: 'try the closed month' })), 'PAYROLL_PERIOD_FINALIZED');
});

test('control settings, role changes and deactivations need a reason; ordinary settings do not', async () => {
  assert.strictEqual(await code(h.api().put('/api/settings/eq_weekly_off_day').set(A()).send({ value: 5 })), 'VALIDATION_ERROR');
  await ok(h.api().put('/api/settings/eq_weekly_off_day').set(A()).send({ value: 5, reason: 'Friday stays the day off' }));
  await ok(h.api().put('/api/settings/eq_paper_tolerance_minutes').set(A()).send({ value: 12 }));
  const list = await ok(h.api().get('/api/settings').set(ACC()));
  assert.strictEqual(list.find((s) => s.setting_key === 'eq_late_entry_days').setting_value, '3');
  assert.strictEqual(list.find((s) => s.setting_key === 'payroll_finalize_admin_only').reason_required, true);
  // role change: a reason is required and kept in the audit trail
  const u = await ok(h.api().post('/api/users').set(A()).send({ full_name: 'Temp Clerk', username: 'tempclerk', password: 'Secret#123', role: 'Supervisor' }));
  assert.strictEqual(await code(h.api().put(`/api/users/${u.user_id}`).set(A()).send({ role: 'Accountant' })), 'VALIDATION_ERROR');
  await ok(h.api().put(`/api/users/${u.user_id}`).set(A()).send({ role: 'Accountant', reason: 'moved to the office team' }));
  const [log] = await h.query("SELECT reason FROM audit_logs WHERE table_name = 'users' AND record_id = ? AND reason IS NOT NULL ORDER BY log_id DESC LIMIT 1", [u.user_id]);
  assert.strictEqual(log.reason, 'moved to the office team');
  assert.strictEqual(await code(h.api().patch(`/api/users/${u.user_id}/status`).set(A()).send({ status: 'Inactive' })), 'VALIDATION_ERROR');
});

test('final decisions of 6 Oct 2026: no amount threshold, no extra separation of duties, late reason optional, undo default 168 h', async () => {
  // no monetary threshold: a very large manual adjustment is created and cancelled by the same Accountant, no extra approval
  const big = await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-11-20', adjustment_type: 'Bonus', amount: 250000, reason: 'Contract bonus agreed with the vendor' }));
  assert.strictEqual(big.status, 'Active');
  const gone = await ok(h.api().patch(`/api/equipment/adjustments/${big.adjustment_id}/cancel`).set(ACC()).send({ reason: 'entered on the wrong machine' }));
  assert.strictEqual(gone.status, 'Cancelled');
  // no extra separation of duties: the same Admin generates, finalizes and marks paid (only the official Correction needs two people)
  const id = await workDay(F.loader, '2026-11-17', '07:00', '15:00', { sup: S9 });
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-11&equipment_id=${F.loader.equipment_id}`).set(A()));
  for (const sh of sheets) await ok(h.api().post(`/api/equipment/timesheets/${sh.timesheet_id}/scans`).set(A()).attach('files', await QRCode.toBuffer(`signed ${sh.timesheet_id}`), 'scan.png'));
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(A()).send({ start_date: '2026-11-17', end_date: '2026-11-17', equipment_id: F.loader.equipment_id, accept_blockers: true, accept_reason: 'other loader days still open' }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  const paid = await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/mark-paid`).set(A()).send({}));
  assert.strictEqual(paid.status, 'Paid');
  void id;
  // late reason stays optional at every age (no second threshold)
  const veryLate = await h.api().post('/api/equipment/attendance/day-status').set(S9()).send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: '2026-11-16', day_status: 'Holiday' });
  assert.strictEqual(veryLate.status, 201);
  assert.strictEqual(veryLate.body.data.late_entry, true);
  // the undo window default is 168 h (the earlier test changed the setting on purpose; the shipped default is checked here)
  const settingsSvc = require('../services/settings');
  assert.strictEqual(settingsSvc.DEFAULTS.eq_paid_undo_hours, '168');
  assert.ok(settingsSvc.CONTROL_KEYS.has('eq_paid_undo_hours'), 'changing the window needs a reason');
  assert.strictEqual(settingsSvc.DEFAULTS.eq_late_entry_days, '3');
  const mig = require('fs').readFileSync(require('path').join(__dirname, '../database/migrations/012_correction_policy.sql'), 'utf8');
  assert.match(mig, /'eq_paid_undo_hours', '168'/);
});
