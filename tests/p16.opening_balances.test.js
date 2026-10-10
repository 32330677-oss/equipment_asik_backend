// P16 — opening balances: money owed to a vendor from before the system, carried into the next payroll (migration 014).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A } = require('./fixtures');

// November must be in the past for this file
require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 11, 5, 9, 0, 0)));

const ACC = () => h.auth(h.T.accountant());
const code = async (p) => (await p).body.code;
let V; let truck; let OB; let sand;

before(async () => {
  await h.resetDatabase();
  V = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Old Debts Co' }));
  const C = await ok(h.api().post(`/api/equipment/vendors/${V.vendor_id}/contracts`).set(A()).send({ contract_number: 'OD-1', start_date: '2026-01-01', currency: 'USD' }));
  truck = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: V.vendor_id, type_id: 1, plate_number: 'OD-001' }));
  [sand] = await ok(h.api().post('/api/equipment/dnr-rates').set(ACC()).send({
    vendor_contract_id: C.vendor_contract_id, effective_from: '2026-01-01', items: [{ item_name: 'Sand transport', unit: 'trip', unit_price: 50 }],
  }));
  await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'N-1', note_date: '2026-11-04', quantity: 2 }));
});
after(h.closePool);

test('create: validations, currency taken from the only contract, supervisor refused', async () => {
  const base = `/api/equipment/vendors/${V.vendor_id}/opening-balances`;
  assert.strictEqual(await code(h.api().post(base).set(ACC()).send({ amount: 100, as_of_date: '2027-01-01', description: 'x' })), 'VALIDATION_ERROR');
  assert.strictEqual(await code(h.api().post(base).set(ACC()).send({ amount: 100, as_of_date: '2026-10-31', description: 'x', currency: 'EUR' })), 'VALIDATION_ERROR');
  assert.strictEqual(await code(h.api().post(base).set(ACC()).send({ as_of_date: '2026-10-31', description: 'x' })), 'VALIDATION_ERROR');
  assert.strictEqual((await h.api().post(base).set(h.auth(h.T.sup8())).send({ amount: 1, as_of_date: '2026-10-31', description: 'x' })).status, 403);
  OB = await ok(h.api().post(base).set(ACC()).send({
    amount: 1250.5, as_of_date: '2026-10-31', period_from: '2026-06-01', period_to: '2026-10-31', equipment_id: truck.equipment_id,
    description: 'Rent June - October 2026 not paid yet', reference: 'OLD-STMT-7',
  }));
  assert.strictEqual(OB.currency, 'USD');
  assert.strictEqual(OB.amount, '1250.50');
  assert.strictEqual(OB.state, 'Open');
  // still open: it can be changed
  OB = await ok(h.api().put(`/api/equipment/opening-balances/${OB.opening_balance_id}`).set(ACC()).send({ amount: 1200, reason: 'one old payment found' }));
  assert.strictEqual(OB.amount, '1200.00');
  assert.strictEqual(OB.description, 'Rent June - October 2026 not paid yet');
});

test('the next payroll offers it, carries it on its own line, the invoice is not inflated', async () => {
  const scope = { start_date: '2026-11-01', end_date: '2026-11-30', vendor_id: V.vendor_id };
  const pv = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(scope));
  assert.deepStrictEqual(pv.carry_forward.map((c) => [c.kind, c.opening_balance_id, c.amount]), [['opening', OB.opening_balance_id, '1200.00']]);
  // not ticked: nothing moves
  let b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(scope));
  assert.strictEqual(b.settlement.vendors[0].carried_in, '0.00');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({ reason: 'redo with the old balance' }));
  // ticked
  b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, carry_forward: true }));
  const x = b.settlement.vendors[0];
  assert.strictEqual(x.invoice_amount, '100.00', 'the invoice of the period stays the work of the period');
  assert.strictEqual(x.carried_in, '1200.00');
  assert.strictEqual(x.total_due, '1300.00');
  assert.strictEqual(x.carried_in_detail[0].kind, 'opening');
  assert.strictEqual(x.carried_in_detail[0].description, 'Rent June - October 2026 not paid yet');
  assert.strictEqual(x.carried_in_detail[0].invoice_no, 'OLD-STMT-7');
  // carried: locked
  const st = (await ok(h.api().get('/api/equipment/opening-balances').set(ACC()).query({ vendor_id: V.vendor_id })))[0];
  assert.strictEqual(st.state, 'Carried');
  assert.strictEqual(st.carried_to_batch_id, b.eq_batch_id);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/opening-balances/${OB.opening_balance_id}/cancel`).set(ACC()).send({ reason: 'wrong amount' })), 'OPENING_BALANCE_CARRIED');
  assert.strictEqual(await code(h.api().put(`/api/equipment/opening-balances/${OB.opening_balance_id}`).set(ACC()).send({ amount: 5 })), 'OPENING_BALANCE_CARRIED');
  // a second payroll does not offer it again
  const pv2 = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(scope));
  assert.strictEqual(pv2.carry_forward.length, 0);
  // the review summary names it
  const rs = await ok(h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}/review-summary`).set(A()));
  assert.ok(rs.items.find((i) => i.kind === 'opening_balance'));

  // void releases it: open again
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(A()).send({ reason: 'check again' }));
  assert.strictEqual((await ok(h.api().get('/api/equipment/opening-balances').set(ACC())))[0].state, 'Open');

  // carry again, finalize, partial payment, statement of account prints it
  b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, carry_forward: true }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  const paid = await h.api().post(`/api/equipment/payroll/batches/${b.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V.vendor_id, amount: 800, paid_on: '2026-12-01' });
  assert.strictEqual(paid.status, 201);
  assert.strictEqual(paid.body.data.settlement.vendors[0].balance, '500.00');
  const pdf = await h.api().get(`/api/equipment/payroll/batches/${b.eq_batch_id}/statement.pdf`).query({ vendor_id: V.vendor_id }).set(ACC());
  assert.strictEqual(pdf.status, 200);
  // paid in full -> Paid
  const done = await ok(h.api().post(`/api/equipment/payroll/batches/${b.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V.vendor_id, amount: 500, paid_on: '2026-12-02' }));
  assert.strictEqual(done.status, 'Paid');
});

test('cancel an open one (reason kept); a balance dated inside the period is not offered', async () => {
  const late = await ok(h.api().post(`/api/equipment/vendors/${V.vendor_id}/opening-balances`).set(ACC()).send({ amount: 40, as_of_date: '2026-11-15', description: 'late' }));
  const pv = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-30', vendor_id: V.vendor_id }));
  assert.ok(!pv.carry_forward.find((c) => c.opening_balance_id === late.opening_balance_id), 'only balances dated before the period start');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/opening-balances/${late.opening_balance_id}/cancel`).set(ACC()).send({ reason: 'x' })), 'VALIDATION_ERROR');
  const c = await ok(h.api().patch(`/api/equipment/opening-balances/${late.opening_balance_id}/cancel`).set(ACC()).send({ reason: 'entered twice' }));
  assert.strictEqual(c.state, 'Cancelled');
  assert.strictEqual(c.cancel_reason, 'entered twice');
});
