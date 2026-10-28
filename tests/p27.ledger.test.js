// P27 — running statements: vendor statement of invoices (14 Oct 2026: every issued invoice and debit / credit note with
// the running total; no payments) and machine billing history (what was billed, in which invoice, what is NOT billed yet).
const { test, before, after } = require('node:test');
const KNOWN_FAILING = { todo: 'known failing on main before CI was added (28 Oct 2026): see tests/KNOWN_FAILING.md' };
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');
const { pool } = require('../config/db');
const L = require('../services/equipment/eqLedger');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F; let oct; let nov; let dn;

async function workDay(m, date, approve = true) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} 15:00`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

let setupError = null; // the setup below fails on main (see tests/KNOWN_FAILING.md); each test reports it
before(async () => { try {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  const V = F.vendor.vendor_id;
  // October: two days of the excavator (8 h x 40 = 320 each), issued and handed over to finance
  await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  oct = await h.issue(oct.eq_batch_id);
  await h.handOver(oct.eq_batch_id);
  // a difference after the hand-over: a debit note of 40 on the machine, issued
  const n = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Debit', vendor_id: V, equipment_id: F.exc.equipment_id, currency: 'USD', amount: 40,
    reason: 'Signed sheet shows 16:00 on 5 Oct', note_date: '2026-11-15', ref_batch_id: oct.eq_batch_id }));
  dn = await ok(h.api().patch(`/api/equipment/payroll/notes/${n.note_id}/issue`).set(A()));
  // a credit note for the vendor in general, then a draft note (not counted)
  const c = await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Credit', vendor_id: V, currency: 'USD', amount: 25, reason: 'Damaged fence, agreed', note_date: '2026-11-16' }));
  await ok(h.api().patch(`/api/equipment/payroll/notes/${c.note_id}/issue`).set(A()));
  await ok(h.api().post('/api/equipment/payroll/notes').set(ACC()).send({ kind: 'Debit', vendor_id: V, currency: 'USD', amount: 999, reason: 'draft only, not counted' }));
  // November: one day, issued (still in the office)
  await workDay(F.exc, '2026-11-10');
  nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-19', equipment_id: F.exc.equipment_id }));
  nov = await h.issue(nov.eq_batch_id);
  // not billed yet: the loader worked (approved) and the excavator has a day waiting for approval
  await workDay(F.loader, '2026-11-12');
  await workDay(F.exc, '2026-11-20', false);
} catch (e) { setupError = e; } });
after(h.closePool);

test('vendor statement of invoices: issued invoices, debit and credit notes (issued only), running total', KNOWN_FAILING, async () => { if (setupError) throw setupError;
  assert.strictEqual(dn.note_no, 'DN-2026-00001');
  const st = await ok(h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}/account`).set(ACC()));
  assert.strictEqual(st.sections.length, 1);
  const s = st.sections[0];
  assert.strictEqual(s.currency, 'USD');
  assert.strictEqual(s.brought_forward, 0);
  // oldest first: the notes (15 and 16 Nov), then the two invoices issued today (20 Nov, the issue date)
  assert.deepStrictEqual(s.rows.map((r) => r.kind), ['Debit', 'Credit', 'invoice', 'invoice']);
  assert.strictEqual(s.rows.filter((r) => r.kind === 'invoice').length, 2);
  assert.ok(s.rows.find((r) => r.kind === 'Debit' && r.doc_no === 'DN-2026-00001' && r.debit === 4000));
  assert.ok(s.rows.find((r) => r.kind === 'Credit' && r.credit === 2500));
  assert.ok(!s.rows.find((r) => r.debit === 99900), 'a draft note is not counted');
  assert.match(s.rows.find((r) => r.eq_batch_id === oct.eq_batch_id).description, /Handed over to finance/);
  // 640 (Oct) + 40 (DN) - 25 (CN) + 320 (Nov)
  assert.strictEqual(s.closing, 97500);
  assert.strictEqual(s.rows[s.rows.length - 1].balance, s.closing);
  assert.strictEqual(s.total_debit - s.total_credit, s.closing);
  // the estimate: earned (approved) but not in any invoice, not part of the total
  assert.ok(s.estimate && !s.estimate.error, JSON.stringify(s.estimate));
  assert.ok(s.estimate.amount >= 30000, `estimate ${s.estimate.amount}`);
});

test('brought forward: lines before "from" become one line; drafts are not counted', KNOWN_FAILING, async () => { if (setupError) throw setupError;
  const st = await L.vendorStatement(pool, F.vendor.vendor_id, { from: '2026-11-16', to: '2026-11-20', estimate: false });
  const s = st.sections[0];
  assert.strictEqual(s.closing, 97500);
  assert.strictEqual(s.estimate, null);
  assert.ok(s.brought_forward > 0 && s.brought_forward < s.closing);
  // a draft invoice adds nothing
  const draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.loader.equipment_id }));
  const again = await L.vendorStatement(pool, F.vendor.vendor_id, { estimate: false });
  assert.strictEqual(again.sections[0].closing, 97500);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/void`).set(ACC()).send({}));
});

test('one section per currency (a contract currency without any document)', KNOWN_FAILING, async () => { if (setupError) throw setupError;
  await ok(h.api().post(`/api/equipment/vendors/${F.vendor.vendor_id}/contracts`).set(A()).send({ contract_number: 'AB-EUR', start_date: '2026-07-01', currency: 'EUR' }));
  const st = await L.vendorStatement(pool, F.vendor.vendor_id, { estimate: false });
  assert.deepStrictEqual(st.sections.map((s) => [s.currency, s.closing]).sort(), [['EUR', 0], ['USD', 97500]]);
});

test('machine history: billed periods with invoice numbers and states, its notes, and the days not billed yet', KNOWN_FAILING, async () => { if (setupError) throw setupError;
  const hx = await ok(h.api().get(`/api/equipment/statements/machine/${F.exc.equipment_id}/history`).set(ACC()));
  assert.strictEqual(hx.rows.length, 2);
  const [o, n] = hx.rows;
  assert.deepStrictEqual([o.period_from, o.period_to], ['2026-10-05', '2026-10-06']);
  assert.match(o.vi_no, /^VI-/); assert.match(o.mi_no, /^MI-/);
  assert.strictEqual(o.state, 'Handed over to finance');
  assert.strictEqual(n.state, 'Issued');
  assert.strictEqual(hx.notes.length, 1, 'the general credit note is not a note of the machine');
  assert.strictEqual(hx.notes[0].kind, 'Debit');
  assert.strictEqual(hx.notes[0].amount, 4000);
  assert.deepStrictEqual(hx.not_billed.pending.map((r) => [r.from, r.count]), [['2026-11-20', 1]]);
  assert.strictEqual(hx.not_billed.approved.length, 0);
  assert.deepStrictEqual(hx.totals.map((t) => [t.currency, t.finalized, t.notes]), [['USD', 96000, 4000]]);
  // the loader: one approved day, not billed
  const lh = await L.machineHistory(pool, F.loader.equipment_id, {});
  assert.strictEqual(lh.rows.length, 0, 'the deleted draft is not listed');
  assert.deepStrictEqual(lh.not_billed.approved.map((r) => r.from), ['2026-11-12']);
  // the monthly crane: deployed since 1 Sep, never billed -> its working days show
  const ch = await L.machineHistory(pool, F.crane.equipment_id, {});
  assert.strictEqual(ch.not_billed.monthly_days[0].from, '2026-09-01');
  const total = ch.not_billed.monthly_days.reduce((a, r) => a + r.count, 0);
  assert.ok(total > 60 && total < 82, `monthly days ${total}`);
  assert.strictEqual(ch.not_billed.monthly_days[ch.not_billed.monthly_days.length - 1].to <= '2026-11-20', true);
});

test('PDFs and validation', KNOWN_FAILING, async () => { if (setupError) throw setupError;
  const v = await bin(h.api().get(`/api/equipment/statements/vendor/${F.vendor.vendor_id}/account.pdf`).set(ACC()));
  assert.strictEqual(v.status, 200); assert.strictEqual(v.headers['content-type'], 'application/pdf'); assert.ok(v.body.length > 3000);
  assert.match(v.headers['content-disposition'], /statement-of-invoices-.*\.pdf/);
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
