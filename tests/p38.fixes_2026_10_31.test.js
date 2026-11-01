// P38 — fixes of 31 Oct 2026.
//  Monthly: parts of a month in order (the Admin still decides the offset), base days counted once across monthly
//  cards, rows of a month without deployment wait. The read-only check of what a new calculation changes. Also: open stops closed by an edit, paper reset, fuel only on a deployed machine, status date,
//  vendor change, currency of the coverage, notes on a cancelled invoice, paid before a withdrawal, hand-over totals,
//  statement flag, cancelled deployments, Telegram times.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');
const P = require('../services/equipment/eqPayrollService');
const check = require('../scripts/checkInvoiceChanges');
const { parseTimes } = require('../services/telegram/timeParse');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00 Syria time
const ACC = () => h.auth(h.T.accountant());
const gen = (body) => h.api().post('/api/equipment/payroll/generate').set(ACC()).send(body);
const OCT = { start_date: '2026-10-01', end_date: '2026-10-31' };
let n = 0;

async function vendor(currencies = ['USD']) {
  n += 1;
  const V = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: `P38 vendor ${n}` }));
  const C = {};
  for (const cur of currencies) {
    C[cur] = await ok(h.api().post(`/api/equipment/vendors/${V.vendor_id}/contracts`).set(A()).send({ contract_number: `P38-${n}-${cur}`, start_date: '2026-07-01', currency: cur }));
  }
  return { V, C };
}
async function machine({ V, C }, card, { assigned = '2026-09-01', currency = 'USD', deploy = true } = {}) {
  n += 1;
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: V.vendor_id, type_id: 1, plate_number: `P38-${n}`, make: 'CAT' }));
  if (card) m.card = await ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A()).send({ vendor_contract_id: C[currency].vendor_contract_id, effective_from: '2026-07-01', ...card }));
  if (deploy) await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: assigned }));
  return m;
}
async function day(m, date, inT, outT, { approve = true } = {}) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, ...(outT ? { check_out_time: `${date} ${outT}` } : {}), late_reason: 'paper sheet typed late' }));
  if (approve) {
    await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
    await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  }
  return r.eq_attendance_id;
}
const batchRow = async (id) => (await h.query('SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?', [id]))[0];
const drift = async (id) => P.batchDrift(require('../config/db').pool, await batchRow(id));
const cents = (x) => Math.round(Number(x) * 100);
const lineSum = async (id, type) => cents((await h.query('SELECT COALESCE(SUM(l.amount), 0) AS s FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id WHERE i.eq_batch_id = ? AND l.line_type = ?', [id, type]))[0].s);

before(async () => { await h.resetDatabase(); });
after(h.closePool);

// ------------------------------------------------------------------ monthly
test('monthly: a later part never changes an earlier one; the parts add up to the whole month (divisor 10 < 17 days)', async () => {
  const VC = await vendor();
  const card = { billing_mode: 'Monthly', monthly_rate: 2600, standard_hours_per_day: 10, overtime_enabled: false };
  const a = await machine(VC, card, { assigned: '2026-10-12' });
  const b = await machine(VC, card, { assigned: '2026-10-12' });
  const days = [];
  for (let d = 12; d <= 31; d += 1) if (![16, 23, 30].includes(d)) days.push(`2026-10-${d}`); // Fridays off: 17 working days
  for (const m of [a, b]) {
    await ok(h.api().put('/api/equipment/payroll/monthly-terms').set(ACC()).send({ equipment_id: m.equipment_id, month: '2026-10', working_days: 10 }));
    for (const d of days) await day(m, d, '07:00', '17:00');
  }
  const a1 = (await gen({ start_date: '2026-10-01', end_date: '2026-10-15', equipment_id: a.equipment_id })).body.data;
  const a2 = (await gen({ start_date: '2026-10-16', end_date: '2026-10-31', equipment_id: a.equipment_id })).body.data;
  const whole = (await gen({ ...OCT, equipment_id: b.equipment_id })).body.data;
  assert.strictEqual(cents(a1.total_net), 104000, '4 base days of 10');
  assert.strictEqual(cents(a1.total_net) + cents(a2.total_net), cents(whole.total_net), `${a1.total_net} + ${a2.total_net} = ${whole.total_net}`);
  assert.deepStrictEqual(await drift(a1.eq_batch_id), [], 'the first part is unchanged after the second one exists');
  assert.deepStrictEqual(await drift(a2.eq_batch_id), []);
});

test('monthly: two cards in one month pay the base days once (max the divisor)', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Monthly', monthly_rate: 2600, standard_hours_per_day: 10, overtime_enabled: true }, { assigned: '2026-10-01' });
  await ok(h.api().post(`/api/equipment/rate-cards/${m.card.rate_card_id}/revise`).set(A()).send({ effective_from: '2026-10-16', monthly_rate: 2600 }));
  await ok(h.api().put('/api/equipment/payroll/monthly-terms').set(ACC()).send({ equipment_id: m.equipment_id, month: '2026-10', working_days: 25 }));
  const b = (await gen({ ...OCT, equipment_id: m.equipment_id })).body.data;
  assert.strictEqual(await lineSum(b.eq_batch_id, 'MonthlyBase'), 260000, '13 + 12 base days of 25, not 13 + 13');
});

test('monthly: rows of a month without any deployed day wait for a later invoice (not held at 0)', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Monthly', monthly_rate: 2600, standard_hours_per_day: 10, overtime_enabled: true }, { assigned: '2026-09-01' });
  const sep = await day(m, '2026-09-10', '07:00', '17:00');
  await h.query("UPDATE eq_site_assignments SET assigned_date = '2026-10-01' WHERE equipment_id = ?", [m.equipment_id]); // the deployment record is wrong
  const r = await gen({ start_date: '2026-09-01', end_date: '2026-10-31', equipment_id: m.equipment_id, accept_blockers: true, accept_reason: 'deployment of September fixed later' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.warnings.find((w) => w.code === 'MONTHLY_ROWS_WAITING'));
  const held = await h.query('SELECT eq_attendance_id FROM eq_payroll_attendance_snapshot WHERE eq_batch_id = ?', [r.body.data.eq_batch_id]);
  assert.ok(!held.some((x) => x.eq_attendance_id === sep), 'the September row stays free');
});

// ------------------------------------------------------------------ attendance
test('an edit that closes the session closes its open stop (BR-16), by the supervisor and by the office', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 20 });
  const id = await day(m, '2026-10-20', '07:00', null, { approve: false });
  await ok(h.api().post(`/api/equipment/attendance/${id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-20 10:00', reason: 'hydraulic hose' }));
  await ok(h.api().patch(`/api/equipment/attendance/${id}`).set(S8()).send({ check_out_time: '2026-10-20 17:00' }));
  const [row] = await h.query('SELECT working_minutes, breakdown_minutes FROM eq_attendance WHERE eq_attendance_id = ?', [id]);
  assert.deepStrictEqual([Number(row.working_minutes), Number(row.breakdown_minutes)], [180, 420]);

  const id2 = await day(m, '2026-10-21', '07:00', null, { approve: false });
  await ok(h.api().post(`/api/equipment/attendance/${id2}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-21 10:00', reason: 'engine' }));
  const lost = await h.api().patch(`/api/equipment/admin/attendance/${id2}`).set(ACC())
    .send({ downtime: [{ downtime_type: 'Break', start_time: '2026-10-21 12:00', end_time: '2026-10-21 12:30' }] });
  assert.strictEqual(lost.body.code, 'DOWNTIME_OVERLAP', 'the open breakdown is never dropped by the office list');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${id2}`).set(ACC()).send({ check_out_time: '2026-10-21 17:00' }));
  const [dt] = await h.query('SELECT end_time FROM eq_downtime_periods WHERE eq_attendance_id = ?', [id2]);
  assert.strictEqual(String(dt.end_time).slice(0, 16), '2026-10-21 17:00');
});

test('a timed Working row becomes a timed Breakdown with its own times; a supervisor change resets the paper check', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 20 });
  await day(m, '2026-10-22', '07:00', '13:00', { approve: false });
  const r = await h.api().post('/api/equipment/attendance/day-status').set(S8()).send({
    equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', record_date: '2026-10-22', day_status: 'Breakdown',
    check_in_time: '2026-10-22 07:00', check_out_time: '2026-10-22 13:00', remarks: 'engine', confirm_discard_session: true, late_reason: 'paper sheet typed late',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = await day(m, '2026-10-23', '07:00', '15:00', { approve: false });
  await h.query("UPDATE eq_attendance SET paper_status = 'Matched' WHERE eq_attendance_id = ?", [id]);
  await ok(h.api().patch(`/api/equipment/attendance/${id}`).set(S8()).send({ check_out_time: '2026-10-23 16:00' }));
  const [row] = await h.query('SELECT paper_status FROM eq_attendance WHERE eq_attendance_id = ?', [id]);
  assert.strictEqual(row.paper_status, 'Pending');
});

// ------------------------------------------------------------------ machines and vendors
test('fuel only on a machine deployed there; no future status date; no vendor change once fuel is recorded', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 20 });
  const f = await h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: m.equipment_id, site_id: 9, issue_date: '2026-10-10', liters: 20, price_per_liter: 1 });
  assert.strictEqual(f.body.code, 'MACHINE_NOT_ASSIGNED');
  const st = await h.api().patch(`/api/equipment/machines/${m.equipment_id}/status`).set(A()).send({ status: 'Inactive', effective_date: '2026-12-01' });
  assert.ok(st.body.details.fields.effective_date, JSON.stringify(st.body));
  const bare = await machine(VC, null, { deploy: false });
  await h.query("INSERT INTO eq_fuel_issues (equipment_id, site_id, issue_date, liters, issued_by_user_id) VALUES (?, 8, '2026-10-10', 30, 1)", [bare.equipment_id]);
  const other = await vendor();
  const ch = await h.api().put(`/api/equipment/machines/${bare.equipment_id}`).set(A()).send({ vendor_id: other.V.vendor_id });
  assert.strictEqual(ch.body.code, 'MACHINE_VENDOR_LOCKED');
});

test('an invoice in one currency does not block the same period in another currency', async () => {
  const VC = await vendor(['USD', 'SYP']);
  const x = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 10 });
  const y = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 1000 }, { currency: 'SYP' });
  await day(x, '2026-10-06', '07:00', '15:00'); await day(y, '2026-10-06', '07:00', '15:00');
  const usd = await gen({ ...OCT, vendor_id: VC.V.vendor_id, equipment_ids: [x.equipment_id, y.equipment_id], currency: 'USD' });
  assert.strictEqual(usd.status, 201, JSON.stringify(usd.body));
  const syp = await gen({ ...OCT, vendor_id: VC.V.vendor_id, equipment_ids: [y.equipment_id], currency: 'SYP' });
  assert.strictEqual(syp.status, 201, JSON.stringify(syp.body));
});

test('cancelling an invoice with issued notes asks the Admin; withdrawal paid amount capped and shown at the next hand-over', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 10 });
  await day(m, '2026-10-07', '07:00', '15:00');
  const b = (await gen({ ...OCT, equipment_id: m.equipment_id })).body.data;
  await h.issue(b.eq_batch_id);
  const note = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Credit', vendor_id: VC.V.vendor_id, currency: 'USD', amount: 15, reason: 'three hours not done', ref_batch_id: b.eq_batch_id }));
  await ok(h.api().patch(`/api/equipment/payroll/notes/${note.note_id}/issue`).set(A()).send({}));
  const v1 = await h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({ reason: 'wrong period' });
  assert.strictEqual(v1.body.code, 'NOTES_ATTACHED');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({ reason: 'wrong period', keep_notes: true }));

  const m2 = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 10 });
  await day(m2, '2026-10-08', '07:00', '15:00');
  const b2 = (await gen({ ...OCT, equipment_id: m2.equipment_id })).body.data;
  await h.issue(b2.eq_batch_id);
  await h.handOver([b2.eq_batch_id]);
  const w = (body) => h.api().post(`/api/equipment/payroll/batches/${b2.eq_batch_id}/withdraw`).set(A()).send({ reason: 'hours to check', finance_person: 'Finance clerk', was_paid: true, ...body });
  assert.ok((await w({ paid_amount: Number(b2.total_net) + 1 })).body.details.fields.paid_amount);
  assert.strictEqual((await w({ paid_amount: 50 })).status, 201);
  const ho = await h.handOver([b2.eq_batch_id]);
  assert.strictEqual(ho.lines[0].paid_before.amount, '50.00');
});

test('an issued invoice changed since: flagged in the statement; the hand-over refuses totals that are not the printed ones', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 10 });
  const id = await day(m, '2026-10-09', '07:00', '15:00');
  const b = await h.issue((await gen({ ...OCT, equipment_id: m.equipment_id })).body.data.eq_batch_id);
  await ok(h.api().patch(`/api/equipment/admin/attendance/${id}`).set(A()).send({ check_out_time: '2026-10-09 17:00' }));
  const st = await ok(h.api().get(`/api/equipment/statements/vendor/${VC.V.vendor_id}/account?estimate=false`).set(ACC()));
  assert.deepStrictEqual(st.sections.find((s) => s.currency === 'USD').not_up_to_date, [b.vendor_invoice_no]);
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  const send = (expected) => h.api().post('/api/equipment/payroll/handovers').set(A()).send({ batch_ids: [b.eq_batch_id], receiver_name: 'Finance clerk', expected_totals: expected });
  const r = await send({ USD: b.total_net });
  assert.strictEqual(r.body.code, 'TOTALS_CHANGED');
  assert.strictEqual(r.body.details.totals.USD, '100.00');
  assert.strictEqual((await send(r.body.details.totals)).status, 201);
});

test('a cancelled future deployment does not keep a site open', async () => {
  const VC = await vendor();
  const m = await machine(VC, { billing_mode: 'Hourly', hourly_rate: 10 }, { deploy: false });
  await h.query("INSERT INTO eq_site_assignments (equipment_id, site_id, shift_type, assigned_date, unassigned_date) VALUES (?, 10, 'Day', '2026-12-10', '2026-12-09')", [m.equipment_id]);
  await ok(h.api().patch('/api/sites/10/status').set(A()).send({ status: 'Completed' }));
});

// ------------------------------------------------------------------ Telegram
test('Telegram times of a day shift', () => {
  assert.deepStrictEqual(parseTimes('من 1 لل 5'), { in: '13:00', out: '17:00' });
  assert.deepStrictEqual(parseTimes('7 لـ 11'), { in: '07:00', out: '11:00' });
  assert.deepStrictEqual(parseTimes('8 لـ 5'), { in: '08:00', out: '17:00' });
  assert.deepStrictEqual(parseTimes('7 ونص ل 7'), { in: '07:30', out: '19:00' });
  assert.deepStrictEqual(parseTimes('خروج 5'), { in: '', out: '17:00' });
  assert.deepStrictEqual(parseTimes('7 لـ 5', 'Night'), { in: '19:00', out: '05:00' });
});

// ------------------------------------------------------------------ read-only check before a deploy
test('checkInvoiceChanges: every draft / issued invoice compared with a new calculation; nothing is written', async () => {
  const { pool } = require('../config/db');
  const [[before]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS s FROM eq_payroll_batches');
  const conn = await pool.getConnection();
  let rows;
  try {
    await conn.query('START TRANSACTION READ ONLY');
    rows = await check.checkBatches(conn, P);
  } finally { await conn.query('ROLLBACK'); conn.release(); }
  const [[afterRun]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS s FROM eq_payroll_batches');
  assert.deepStrictEqual(afterRun, before, 'nothing written');
  assert.ok(rows.length > 0);
  for (const r of rows.filter((x) => !x.error)) assert.strictEqual(typeof r.now, 'number');
  // compare: only what differs between two runs is listed
  const other = rows.map((r) => ({ ...r }));
  other[0] = { ...other[0], now: other[0].now + 500 };
  const { changed } = check.compare(rows, other);
  assert.deepStrictEqual(changed.map((c) => [c.eq_batch_id, c.difference]), [[rows[0].eq_batch_id, 500]]);
  assert.deepStrictEqual(check.compare(rows, rows).changed, []);
});
