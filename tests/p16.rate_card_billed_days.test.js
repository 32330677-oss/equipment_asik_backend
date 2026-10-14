// P16 — rate card close / "change from a date" after billing (monthly = whole batch period): only an invoice handed
// over to finance locks the card (14 Oct 2026), and the list of monthly days without any attendance row (information only here: the
// harness turns eq_block_monthly_days_without_rows off; p28 tests it blocking).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8, recordExampleA } = require('./fixtures');

const ACC = () => h.auth(h.T.accountant());
let F; let craneCard; let excCard;
before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  craneCard = (await ok(h.api().get(`/api/equipment/machines/${F.crane.equipment_id}/rate-cards`).set(ACC())))[0];
  excCard = (await ok(h.api().get(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(ACC())))[0];
});
after(h.closePool);

const SEPT = { start_date: '2026-09-01', end_date: '2026-09-30' };
const revise = (cardId, from) => h.api().post(`/api/equipment/rate-cards/${cardId}/revise`).set(ACC()).send({ effective_from: from });
const close = (cardId, to) => h.api().post(`/api/equipment/rate-cards/${cardId}/close`).set(ACC()).send({ effective_to: to });

let septBatch;
test('monthly machine: deployed working days without any row are listed before generating (information only)', async () => {
  // rows on Sep 1, 2 and 24 only (2026-09-04 is a Friday = weekly day off)
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-24']) {
    await ok(h.api().post('/api/equipment/attendance/day-status').set(S8())
      .send({ equipment_id: F.crane.equipment_id, site_id: 8, record_date: d, day_status: 'Absent', remarks: 'idle', late_entry_reason: 'test data' }));
  }
  await h.query("UPDATE eq_attendance SET status = 'Approved' WHERE equipment_id = ?", [F.crane.equipment_id]);
  const blk = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30&equipment_id=${F.crane.equipment_id}`).set(ACC()));
  const miss = blk.find((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS');
  assert.ok(miss, 'the days without rows are shown');
  const days = miss.items.map((i) => i.record_date);
  assert.ok(days.includes('2026-09-03'));
  assert.ok(days.includes('2026-09-30'));
  assert.ok(!days.includes('2026-09-01'), 'a day with a row is not listed');
  assert.ok(!days.includes('2026-09-04'), 'the weekly day off is not listed');
  assert.strictEqual(miss.count, 26 - 3, '26 working days in Sept 2026, 3 have a row');
  assert.ok(miss.items.every((i) => i.equipment_code && i.site_code === 'S08' && !('_e' in i)), 'items are clean');
  // hourly / daily machines are never listed
  const all = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30').set(ACC()));
  const codes = new Set(all.find((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS').items.map((i) => i.equipment_code));
  assert.deepStrictEqual([...codes], [miss.items[0].equipment_code]);
  // information only: generating does not need accept_blockers
  septBatch = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...SEPT, equipment_id: F.crane.equipment_id }));
  assert.ok(septBatch.eq_batch_id);
});

test('monthly card: an invoice handed over to finance locks the WHOLE period (not only up to the last row); a date after it is accepted', async () => {
  // a draft or an issued invoice never locks the card (14 Oct 2026): issue it and hand it over
  const issued = await h.issue(septBatch.eq_batch_id);
  assert.strictEqual(issued.state, 'issued');
  await h.handOver(septBatch.eq_batch_id);
  // last row is Sep 24 but the invoice bills Sep 25..30 too (hours due)
  const r = await revise(craneCard.rate_card_id, '2026-09-28');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'RATE_CARD_LOCKED');
  assert.strictEqual(r.body.details.billed_up_to, '2026-09-30');
  assert.strictEqual(r.body.details.batch_state, 'handed_over');
  assert.strictEqual(r.body.details.eq_batch_id, septBatch.eq_batch_id);
  assert.match(r.body.message, /handed over to finance/);
  assert.match(r.body.message, /debit \/ credit note/);
  const c = await close(craneCard.rate_card_id, '2026-09-26');
  assert.strictEqual(c.status, 409);
  assert.match(c.body.message, /Close it on 2026-09-30 or later/);
  // the invoiced month is no longer listed as days without rows
  const blk = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30&equipment_id=${F.crane.equipment_id}`).set(ACC()));
  assert.ok(!blk.find((b) => b.code === 'MONTHLY_DAYS_WITHOUT_ROWS'));
  // the day after the period is fine
  const nc = await ok(revise(craneCard.rate_card_id, '2026-10-01'));
  assert.strictEqual(nc.effective_from, '2026-10-01');
  const cards = await ok(h.api().get(`/api/equipment/machines/${F.crane.equipment_id}/rate-cards`).set(ACC()));
  assert.strictEqual(cards.find((c) => c.rate_card_id === craneCard.rate_card_id).effective_to, '2026-09-30');
});

test('hourly card under a draft: no lock, the draft asks to be recalculated', async () => {
  await recordExampleA(F); // rows Oct 1..8 for the excavator
  await h.query("UPDATE eq_attendance SET status = 'Approved', anomaly_ack_at = NOW() WHERE equipment_id = ?", [F.exc.equipment_id]);
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC())
    .send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id, accept_blockers: true, accept_reason: 'test data only' }));
  assert.ok(b.eq_batch_id);
  const nc = await ok(revise(excCard.rate_card_id, '2026-10-05'));
  assert.strictEqual(nc.effective_from, '2026-10-05');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
});
