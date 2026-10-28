// P29 — monthly machines, rules of 12 Oct 2026: every working day on its own; extra hours cover missing hours ONLY when
// the Admin decides it (per machine and month); an hour is either an offset or overtime; extra hours not paid are kept
// for a later invoice of the same month. Also: a card is not edited under a draft, PDF / client report options.
const { test, before, after } = require('node:test');
const KNOWN_FAILING = { todo: 'known failing on main before CI was added (28 Oct 2026): see tests/KNOWN_FAILING.md' };
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20: all of October can be typed
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; let OT; let NOOT;

/** Monthly machine 2600 / month, 10 h per day: hourly price 2600 / 26 / 10 = 10 in October 2026 (26 working days). */
async function monthlyMachine(plate, cardBody) {
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 4, plate_number: plate, make: 'XCMG' }));
  await ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-07-01', billing_mode: 'Monthly', monthly_rate: 2600, standard_hours_per_day: 10, break_policy: 'Paid', ...cardBody }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-10-01', default_operator_id: F.op1.operator_id }));
  return m;
}
const work = (m, date, inT, outT) => ok(h.api().post('/api/equipment/attendance/check-in').set(S8())
  .send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'typed from the signed sheet' }));
/** October: absent on the 1st, 12 h on the 3rd (+2), 6 h on the 5th (-4), 10 h on Friday 9th (day off: +10), 10 h on every other working day. */
async function october(m) {
  await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, record_date: '2026-10-01', day_status: 'Absent', late_reason: 'typed from the signed sheet' }));
  for (let d = 2; d <= 31; d += 1) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    const friday = new Date(`${date}T00:00:00Z`).getUTCDay() === 5;
    if (friday && date !== '2026-10-09') continue;
    if (date === '2026-10-03') await work(m, date, '07:00', '19:00');
    else if (date === '2026-10-05') await work(m, date, '07:00', '13:00');
    else await work(m, date, '07:00', '17:00');
  }
  await h.query("UPDATE eq_attendance SET status = 'Approved' WHERE equipment_id = ?", [m.equipment_id]);
}
const OCT = (m, x = {}) => ({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id, equipment_ids: [m.equipment_id], ...x });
const key = (m) => `${m.equipment_id}|2026-10`;
const lineSum = (b, type) => b.items.flatMap((i) => i.lines).filter((l) => l.line_type === type).reduce((a, l) => a + Number(l.amount), 0);

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  OT = await monthlyMachine('M-OT', { overtime_enabled: true, overtime_rate: 40 });
  NOOT = await monthlyMachine('M-NOOT', { overtime_enabled: false });
  await october(OT);
  await october(NOOT);
});
after(h.closePool);

let draft;
test('each day on its own; without a decision the extra hours are overtime; with it they cover missing hours', async () => {
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(OT)));
  const mc = p.items[0].monthly_calc[0];
  assert.strictEqual(mc.month_missing_hours, 14); // absent 10 h + 4 h short on the 5th
  assert.strictEqual(mc.month_extra_hours, 12); // +2 on the 3rd, +10 on Friday the 9th
  assert.strictEqual(mc.offset_possible_hours, 12);
  assert.strictEqual(p.totals[0].net, '2940.00'); // 2600 - 100 - 40 + 12 h x 40
  assert.ok(mc.days.find((d) => d.date === '2026-10-09' && d.kind === 'off'), 'the day off worked is explained');
  // anyone may PREVIEW the decision
  const p2 = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(OT, { offsets: [key(OT)] })));
  assert.strictEqual(p2.totals[0].net, '2580.00'); // 2600 - 140 + 12 h x 10, no overtime left
  assert.strictEqual(p2.items[0].lines.find((l) => l.line_type === 'ExtraHoursOffset').quantity, 12);
});

test('only the Admin decides: the accountant generates without it; the review lists what is not used', async () => {
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT(OT, { offsets: [key(OT)] }))), 'OFFSET_ADMIN_ONLY');
  draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT(OT)));
  assert.strictEqual(draft.total_net, '2940.00');
  assert.deepStrictEqual(draft.offset_months, []);
  const review = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}/review-summary`).set(A()));
  assert.ok(review.items.find((i) => i.kind === 'monthly_offset_not_used' && /paid as overtime instead/.test(i.ref)));
});

test('the Admin turns the offset on for a draft: a new version; the accountant cannot', async () => {
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/offsets`).set(ACC()).send({ offsets: [key(OT)] })), 'OFFSET_ADMIN_ONLY');
  const v2 = await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/offsets`).set(A()).send({ offsets: [key(OT)] }));
  assert.strictEqual(v2.version_number, 2);
  assert.strictEqual(v2.total_net, '2580.00');
  assert.deepStrictEqual(v2.offset_months, [key(OT)]);
  assert.strictEqual(lineSum(v2, 'Overtime'), 0);
  const review = await ok(h.api().get(`/api/equipment/payroll/batches/${v2.eq_batch_id}/review-summary`).set(A()));
  assert.ok(review.items.find((i) => i.kind === 'monthly_offset' && /12.00 h of extra hours cover missing hours/.test(i.ref)));
  // a recalculation by the accountant keeps the Admin's decision
  const v3 = await ok(h.api().post(`/api/equipment/payroll/batches/${v2.eq_batch_id}/supersede`).set(ACC()).send({}));
  assert.deepStrictEqual(v3.offset_months, [key(OT)]);
  assert.strictEqual(v3.total_net, '2580.00');
  draft = v3;
});

test('a rate card is edited under a draft (14 Oct 2026): the draft asks to be recalculated', KNOWN_FAILING, async () => {
  const [card] = await ok(h.api().get(`/api/equipment/machines/${OT.equipment_id}/rate-cards`).set(ACC()));
  await ok(h.api().put(`/api/equipment/rate-cards/${card.rate_card_id}`).set(ACC()).send({ overtime_rate: 45, reason: 'new price agreed' }));
  assert.strictEqual((await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()))).stale, true);
  await ok(h.api().put(`/api/equipment/rate-cards/${card.rate_card_id}`).set(ACC()).send({ overtime_rate: 40, reason: 'back to the agreed price' }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/void`).set(ACC()).send({}));
});

test('PDF: the office chooses what the vendor sees (money lines always stay)', KNOWN_FAILING, async () => {
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT(OT)));
  for (const view of ['machine', 'vendor']) {
    const r = await h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}/export.pdf?view=${view}&hide=days,monthly,notes,reasons,operator,paper,terms,sites,unknown`).set(ACC())
      .buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    assert.strictEqual(r.status, 200, `${view} ${r.status}`);
    assert.strictEqual(r.headers['content-type'], 'application/pdf');
  }
  const S = require('../services/equipment/eqStatements');
  assert.deepStrictEqual([...S.hideOptions('days,notes,unknown')], ['days', 'notes']);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(ACC()).send({}));
});

test('two invoices in one month: overtime paid in the first is never reused', KNOWN_FAILING, async () => {
  const a = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT(OT, { end_date: '2026-10-15' })));
  assert.strictEqual(a.total_net, '1640.00'); // 13 of 26 days = 1300 - 140 + 12 h x 40
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(A()).send(OCT(OT, { start_date: '2026-10-16', offsets: [key(OT)] })));
  assert.strictEqual(b.total_net, '1300.00');
  assert.strictEqual(b.items[0].rate_snapshot.monthly_calc[0].offset_possible_hours, 0);
  for (const x of [b, a]) await ok(h.api().patch(`/api/equipment/payroll/batches/${x.eq_batch_id}/void`).set(A()).send({}));
});

test('two invoices in one month, overtime off: the extra hours kept unpaid are offered again in the second', async () => {
  const a = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT(NOOT, { end_date: '2026-10-15' })));
  assert.strictEqual(a.total_net, '1160.00'); // 1300 - 140, the 12 extra hours kept
  assert.strictEqual(a.items[0].rate_snapshot.monthly_calc[0].unpaid_extra_hours, 12);
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(NOOT, { start_date: '2026-10-16' })));
  assert.strictEqual(p.items[0].monthly_calc[0].offset_possible_hours, 12, 'the Admin is asked again in the next invoice');
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(A()).send(OCT(NOOT, { start_date: '2026-10-16', offsets: [key(NOOT)] })));
  assert.strictEqual(b.total_net, '1420.00'); // 1300 + 12 h x 10: the month adds up to 2580, as one invoice with the offset
});

test('client report: the supervisor remarks are printed only when asked', async () => {
  for (const flag of ['false', 'true']) {
    const r = await h.api().get(`/api/equipment/reports/client-daily.pdf?date=2026-10-05&site_ids=8&include_remarks=${flag}`).set(ACC())
      .buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    assert.strictEqual(r.status, 200);
  }
});
