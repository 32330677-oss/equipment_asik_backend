// P28 — monthly machines: deployed working days without any attendance row BLOCK generating (12 Oct 2026). Each such
// day is deducted in full as an absence, so the batch is generated only with accept_blockers and a reason. The setting
// eq_block_monthly_days_without_rows switches it back to information only.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

const ACC = () => h.auth(h.T.accountant());
const setBlocking = async (on) => {
  await h.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [on ? 'true' : 'false', 'eq_block_monthly_days_without_rows']);
  require('../services/settings').invalidate();
};
let F; let SCOPE;
before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  // rows on Sep 1, 2 and 24 only: the other 23 working days of September have no row
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-24']) {
    await ok(h.api().post('/api/equipment/attendance/day-status').set(S8())
      .send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: d, day_status: 'Absent', remarks: 'idle', late_entry_reason: 'test data' }));
  }
  await h.query("UPDATE eq_attendance SET status = 'Approved' WHERE equipment_id = ?", [F.crane.equipment_id]);
  SCOPE = { start_date: '2026-09-01', end_date: '2026-09-30', equipment_id: F.crane.equipment_id };
  await setBlocking(true);
});
after(h.closePool);

test('the setting is on by default (migration 020) and is a control setting', async () => {
  const s = require('../services/settings');
  assert.strictEqual(s.DEFAULTS.eq_block_monthly_days_without_rows, 'true');
  assert.ok(s.CONTROL_KEYS.has('eq_block_monthly_days_without_rows'));
  const [row] = await h.query("SELECT setting_value FROM settings WHERE setting_key = 'eq_block_monthly_days_without_rows'");
  assert.ok(row, 'the migration adds the setting');
});

test('days without rows are listed as BLOCKING, with the absence wording', async () => {
  const blk = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30&equipment_id=${F.crane.equipment_id}`).set(ACC()));
  const miss = blk.find((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS');
  assert.ok(miss);
  assert.strictEqual(miss.blocking, true);
  assert.strictEqual(miss.count, 23);
  assert.match(miss.message, /deducted in full as an absence/);
  assert.doesNotMatch(miss.message, /missing hours/);
  // the other codes carry the flag too
  assert.ok(blk.every((b) => typeof b.blocking === 'boolean'));
});

test('generating without accept_blockers is refused; with a reason it goes through and the absence is deducted', async () => {
  const r = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send(SCOPE);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'BLOCKERS_PRESENT');
  assert.ok(r.body.details.blockers.some((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS'));
  const noWhy = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, accept_blockers: true });
  assert.strictEqual(noWhy.status, 400);
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SCOPE, accept_blockers: true, accept_reason: 'crane was not on site those days' }));
  assert.match(b.accept_blockers_reason, /^MONTHLY_DAYS_WITHOUT_ROWS: crane was not on site/);
  const lines = b.items.flatMap((i) => i.lines);
  assert.ok(lines.some((l) => l.line_type === 'AbsenceDeduction' && Number(l.amount) < 0), 'the days are deducted as an absence');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({ reason: 'test cleanup' }));
});

test('coverage shows the days as a blocker of the machine', async () => {
  const cov = await ok(h.api().get(`/api/equipment/payroll/coverage?vendor_id=${F.vendor.vendor_id}&start_date=2026-09-01&end_date=2026-09-30`).set(ACC()));
  const crane = cov.find((m) => m.equipment_id === F.crane.equipment_id);
  assert.strictEqual(crane.blockers.monthly_days_without_rows, 23);
});

test('setting off: information only again (no accept_blockers needed)', async () => {
  await setBlocking(false);
  const blk = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30&equipment_id=${F.crane.equipment_id}`).set(ACC()));
  assert.strictEqual(blk.find((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS').blocking, false);
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(SCOPE));
  assert.ok(b.eq_batch_id);
  assert.ok(!b.accept_blockers_reason);
});
