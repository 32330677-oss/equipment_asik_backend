// P44 — a monthly machine working two shifts, each shift at its own monthly price (decision of 16 Nov 2026).
// A Day card (1080 / month, 10 h per day) and a Night card (550 / month, 12 h per day): each shift is its own monthly
// contract (base, hours due, absence, offset, exception of the month). A card for both shifts (every card before) is
// billed exactly as before. October 2026: 26 working days (Fridays off).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');
const BD = require('../utils/businessDate');
const P = require('../services/equipment/eqPayrollService');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20: all of October can be typed
const S9 = () => h.auth(h.T.sup9());
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F;

const pad = (x) => String(x).padStart(2, '0');
const OCT_DAYS = Array.from({ length: 31 }, (_, i) => `2026-10-${pad(i + 1)}`).filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 5);
const next = (d) => BD.addDays(d, 1);
const setting = async (key, val) => {
  await h.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [val, key]);
  require('../services/settings').invalidate();
};
const card = (m, body) => h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A())
  .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-10-01', billing_mode: 'Monthly', break_policy: 'Paid', overtime_enabled: false, ...body });
const machine = (plate) => ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 4, plate_number: plate, make: 'BOBCAT' }));
const deploy = (m, shift) => ok(h.api().post('/api/equipment/deployments').set(A())
  .send({ equipment_id: m.equipment_id, site_id: 9, shift_type: shift, assigned_date: '2026-10-01', default_operator_id: F.op1.operator_id }));
const dayRow = (m, date) => ok(h.api().post('/api/equipment/attendance/check-in').set(S9())
  .send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Day', check_in_time: `${date} 07:00`, check_out_time: `${date} 17:00`, late_reason: 'typed from the signed sheet' }));
const nightRow = (m, date) => ok(h.api().post('/api/equipment/attendance/check-in').set(S9())
  .send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', record_date: date, check_in_time: `${date} 17:00`, check_out_time: `${next(date)} 05:00`, late_reason: 'typed from the signed sheet' }));
const approve = (m) => h.query("UPDATE eq_attendance SET status = 'Approved' WHERE equipment_id = ?", [m.equipment_id]);
const OCT = (m, x = {}) => ({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id, equipment_ids: [m.equipment_id], ...x });
const byShift = (items, s) => items.find((i) => i.shift_type === s);
const lineOf = (it, type) => it.lines.find((l) => l.line_type === type);

/** Machine with a Day card 1080 / 10 h and a Night card 550 / 12 h, deployed Day and Night at S09 from 1 Oct. */
async function twoShiftMachine(plate) {
  const m = await machine(plate);
  await ok(card(m, { shift_type: 'Day', monthly_rate: 1080, standard_hours_per_day: 10 }));
  await ok(card(m, { shift_type: 'Night', monthly_rate: 550, standard_hours_per_day: 12 }));
  await deploy(m, 'Day'); await deploy(m, 'Night');
  return m;
}

let FULL; let ABSENT; let BOTH;
before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await setting('eq_finalize_requires_scan', 'false');
  await setting('eq_shift_rate_cards_enabled', 'true');
  FULL = await twoShiftMachine('SH-FULL');
  ABSENT = await twoShiftMachine('SH-ABS');
  for (const d of OCT_DAYS) {
    await dayRow(FULL, d); await nightRow(FULL, d);
    await dayRow(ABSENT, d);
    if (d !== '2026-10-15') await nightRow(ABSENT, d); // the Night shift did not come on the 15th
  }
  await approve(FULL); await approve(ABSENT);
  // regression: one card for both shifts, deployed Day and Night = one contract, exactly as before 16 Nov 2026
  BOTH = await machine('SH-BOTH');
  await ok(card(BOTH, { monthly_rate: 1080, standard_hours_per_day: 10 }));
  await deploy(BOTH, 'Day'); await deploy(BOTH, 'Night');
  for (const d of OCT_DAYS) { await dayRow(BOTH, d); await nightRow(BOTH, d); }
  await approve(BOTH);
});
after(h.closePool);

test('rate cards: shift cards only when switched on, Monthly only, never with a card for both shifts, from the 1st of a month', async () => {
  const m = await machine('SH-RULES');
  await setting('eq_shift_rate_cards_enabled', 'false');
  assert.strictEqual(await code(card(m, { shift_type: 'Day', monthly_rate: 1000 })), 'SHIFT_CARDS_DISABLED');
  await setting('eq_shift_rate_cards_enabled', 'true');
  assert.strictEqual((await card(m, { billing_mode: 'Hourly', hourly_rate: 20, shift_type: 'Day' })).status, 400);
  await ok(card(m, { shift_type: 'Day', monthly_rate: 1000 }));
  assert.strictEqual(await code(card(m, { shift_type: 'Day', monthly_rate: 900, effective_from: '2026-11-01' })), 'RATE_CARD_OVERLAP', 'two Day cards on the same days');
  assert.strictEqual(await code(card(m, { monthly_rate: 900, effective_from: '2026-11-01' })), 'RATE_CARD_OVERLAP', 'a card for both shifts over a shift card');
  const night = await ok(card(m, { shift_type: 'Night', monthly_rate: 500 }));
  assert.strictEqual(night.shift_type, 'Night');
  // a machine with one card for both shifts passes to shift cards on the 1st of a month only
  const g = await machine('SH-SWITCH');
  const both = await ok(card(g, { monthly_rate: 1000 }));
  await ok(h.api().post(`/api/equipment/rate-cards/${both.rate_card_id}/close`).set(A()).send({ effective_to: '2026-11-14' }));
  assert.strictEqual(await code(card(g, { shift_type: 'Day', monthly_rate: 1000, effective_from: '2026-11-15' })), 'SHIFT_CARDS_MONTH_START');
  await ok(h.api().post(`/api/equipment/rate-cards/${both.rate_card_id}/close`).set(A()).send({ effective_to: '2026-10-31' }));
  await ok(card(g, { shift_type: 'Day', monthly_rate: 1000, effective_from: '2026-11-01' }));
});

test('full month, both shifts: one item per shift, 1080 + 550 = 1630', async () => {
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(FULL)));
  const monthly = p.items.filter((i) => i.billing_mode === 'Monthly');
  assert.strictEqual(monthly.length, 2);
  assert.strictEqual(Number(byShift(monthly, 'Day').net), 1080);
  assert.strictEqual(Number(byShift(monthly, 'Night').net), 550);
  const night = byShift(monthly, 'Night').monthly_calc[0];
  assert.strictEqual(night.required_hours, 26 * 12);
  assert.strictEqual(night.hours_per_day, 12);
  assert.strictEqual(byShift(monthly, 'Day').monthly_calc[0].required_hours, 26 * 10);
});

test('the Night shift absent one day: deducted at the Night hourly price (550 / 26 / 12), the Day shift untouched', async () => {
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(ABSENT)));
  const day = byShift(p.items, 'Day'); const night = byShift(p.items, 'Night');
  assert.strictEqual(Number(day.net), 1080);
  const abs = lineOf(night, 'AbsenceDeduction');
  assert.strictEqual(Number(abs.quantity), 12);
  assert.strictEqual(Number(abs.amount), -21.15); // 12 h x 1.7628
  assert.strictEqual(Number(night.net), 528.85);
});

test('a card for both shifts deployed Day and Night: one item, the night hours are extra hours (as before)', async () => {
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(BOTH)));
  const monthly = p.items.filter((i) => i.billing_mode === 'Monthly');
  assert.strictEqual(monthly.length, 1);
  assert.strictEqual(monthly[0].shift_type, null);
  assert.strictEqual(Number(monthly[0].net), 1080); // overtime off: the 12 night hours a day are kept, not paid
  assert.strictEqual(monthly[0].monthly_calc[0].month_extra_hours, 26 * 12);
});

test('exception of the month per shift; offsets per shift', async () => {
  const put = (body) => h.api().put('/api/equipment/payroll/monthly-terms').set(A()).send({ equipment_id: ABSENT.equipment_id, month: '2026-10', ...body });
  assert.strictEqual((await put({ monthly_amount: 600 })).status, 400, 'say which shift');
  const row = await ok(put({ monthly_amount: 600, shift_type: 'Night' }));
  assert.strictEqual(row.shift_type, 'Night'); assert.strictEqual(row.amount, 600);
  let p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(ABSENT)));
  assert.strictEqual(Number(byShift(p.items, 'Day').net), 1080, 'the Night exception does not touch the Day card');
  assert.strictEqual(Number(byShift(p.items, 'Night').net), Math.round((600 - 12 * 600 / 26 / 12) * 100) / 100);
  await ok(put({ monthly_amount: null, shift_type: 'Night' }));
  const list = await ok(h.api().get(`/api/equipment/payroll/monthly-terms?start_date=2026-10-01&end_date=2026-10-31&equipment_ids=${ABSENT.equipment_id}`).set(A()));
  assert.deepStrictEqual(list.map((r) => r.shift_type).sort(), ['Day', 'Night']);
  assert.deepStrictEqual(P.normalizeOffsets([`${ABSENT.equipment_id}|2026-10|Night`, '5|2026-10', 'x|2026-10|Night', '5|2026-10|Evening']), [`${ABSENT.equipment_id}|2026-10|Night`, '5|2026-10'].sort());
  // the Night shift's extra hours of the month may cover its missing night (the Admin's decision, Night only)
  p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(ABSENT, { offsets: [`${ABSENT.equipment_id}|2026-10|Night`] })));
  const n = byShift(p.items, 'Night').monthly_calc[0];
  assert.strictEqual(n.offset_used, true); assert.strictEqual(byShift(p.items, 'Day').monthly_calc[0].offset_used, false);
});

test('generate: each shift bills each deployed day once (monthly days per shift), a second batch has nothing left; documents', async () => {
  const g = await ok(h.api().post('/api/equipment/payroll/generate').set(A()).send(OCT(FULL)));
  const id = g.eq_batch_id || g.batch?.eq_batch_id || g.id;
  const days = await h.query('SELECT shift_key, COUNT(*) AS n FROM eq_payroll_monthly_days WHERE eq_batch_id = ? GROUP BY shift_key ORDER BY shift_key', [id]);
  assert.deepStrictEqual(days.map((x) => [x.shift_key, Number(x.n)]), [['Day', 31], ['Night', 31]]);
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(A()).send(OCT(FULL))), 'NOTHING_TO_PAY');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${id}`).set(A()));
  assert.deepStrictEqual(d.items.filter((i) => i.billing_mode === 'Monthly').map((i) => i.shift_type).sort(), ['Day', 'Night']);
  for (const url of [`export.pdf?view=vendor`, 'export.pdf?view=summary', 'export.xlsx', 'certificate.xlsx']) {
    const r = await h.api().get(`/api/equipment/payroll/batches/${id}/${url}`).set(A()).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    assert.strictEqual(r.status, 200, `${url} -> ${r.status}`);
  }
});

test('adjustments of a machine with shift cards say their shift and go to that item', async () => {
  const adj = (body) => h.api().post('/api/equipment/adjustments').set(A())
    .send({ equipment_id: ABSENT.equipment_id, site_id: 9, adjustment_date: '2026-10-20', adjustment_type: 'Bonus', amount: 25, reason: 'night bonus', ...body });
  assert.strictEqual((await adj({})).status, 400);
  await ok(adj({ shift_type: 'Night' }));
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(OCT(ABSENT)));
  assert.ok(lineOf(byShift(p.items, 'Night'), 'Adjustment'));
  assert.ok(!lineOf(byShift(p.items, 'Day'), 'Adjustment'));
});

test('blockers: a Night row without its card and a missing Night row are reported per shift', async () => {
  const m = await machine('SH-DAYONLY');
  await ok(card(m, { shift_type: 'Day', monthly_rate: 1000, standard_hours_per_day: 10 }));
  await deploy(m, 'Day'); await deploy(m, 'Night');
  await dayRow(m, '2026-10-01'); await nightRow(m, '2026-10-01');
  await approve(m);
  const b = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-03&equipment_ids=${m.equipment_id}&vendor_id=${F.vendor.vendor_id}`).set(ACC()));
  const noCard = b.find((x) => x.code === 'NO_RATE_CARD');
  assert.ok(noCard && noCard.items.every((x) => x.shift_type === 'Night'), JSON.stringify(b.map((x) => x.code)));
  const b2 = await ok(h.api().get(`/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31&equipment_ids=${ABSENT.equipment_id}&vendor_id=${F.vendor.vendor_id}`).set(ACC()));
  const missing = b2.find((x) => x.code === 'MONTHLY_DAYS_WITHOUT_ROWS');
  assert.deepStrictEqual(missing.items.map((x) => [x.record_date, x.shift_type]), [['2026-10-15', 'Night']]);
});
