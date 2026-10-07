// P15 — DNR (per-unit delivery notes on an existing vendor) and partial payments / carried balances.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A } = require('./fixtures');

// October and November must be in the past for this file
require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 11, 5, 9, 0, 0)));

const ACC = () => h.auth(h.T.accountant());
const code = async (p) => (await p).body.code;
const bin = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
let V; let C; let truck; let other;

before(async () => {
  await h.resetDatabase();
  V = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Haulage Co' }));
  C = await ok(h.api().post(`/api/equipment/vendors/${V.vendor_id}/contracts`).set(A()).send({ contract_number: 'HC-1', start_date: '2026-01-01', currency: 'USD' }));
  truck = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: V.vendor_id, type_id: 1, plate_number: 'T-001' }));
  other = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: V.vendor_id, type_id: 1, plate_number: 'T-002' }));
  // the same truck also has a time rate card: a DNR price never clashes with it
  await ok(h.api().post(`/api/equipment/machines/${truck.equipment_id}/rate-cards`).set(A()).send({ vendor_contract_id: C.vendor_contract_id, effective_from: '2026-01-01', billing_mode: 'Hourly', hourly_rate: 30 }));
});
after(h.closePool);

test('DNR prices for an existing vendor (no new vendor), next to a rate card', async () => {
  const rates = await ok(h.api().post('/api/equipment/dnr-rates').set(ACC()).send({
    vendor_contract_id: C.vendor_contract_id, effective_from: '2026-01-01',
    items: [{ item_name: 'Sand transport', unit: 'trip', unit_price: 50 }, { item_name: 'Gravel', unit: 't', unit_price: 12.5 }],
  }));
  assert.strictEqual(rates.length, 2);
  assert.strictEqual(rates[0].applies_to, 'vendor');
  assert.strictEqual(await code(h.api().post('/api/equipment/dnr-rates').set(ACC()).send({
    vendor_contract_id: C.vendor_contract_id, effective_from: '2026-06-01', items: [{ item_name: 'sand transport', unit: 'trip', unit_price: 55 }],
  })), 'DNR_RATE_OVERLAP');
  const forTruck = await ok(h.api().get(`/api/equipment/machines/${truck.equipment_id}/dnr-rates`).set(ACC()));
  assert.strictEqual(forTruck.length, 2, 'vendor-wide prices apply to every machine of the vendor');
  // the supervisor cannot reach DNR
  assert.strictEqual((await h.api().get('/api/equipment/delivery-notes').set(h.auth(h.T.sup8()))).status, 403);
});

test('delivery notes: number unique per vendor, no future date, priced from the DNR price', async () => {
  const [sand, gravel] = await ok(h.api().get('/api/equipment/dnr-rates').set(ACC()).query({ vendor_id: V.vendor_id }))
    .then((l) => [l.find((r) => r.unit === 'trip'), l.find((r) => r.unit === 't')]);
  const dn1 = await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'DN-1', note_date: '2026-10-05', quantity: 3, from_location: 'Quarry', to_location: 'S08' }));
  assert.strictEqual(dn1.amount, '150.00');
  await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: other.equipment_id, site_id: 8, dnr_rate_id: gravel.dnr_rate_id, dn_number: 'DN-2', note_date: '2026-10-06', quantity: 10 }));
  assert.strictEqual(await code(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: other.equipment_id, site_id: 8, dnr_rate_id: gravel.dnr_rate_id, dn_number: 'DN-2', note_date: '2026-10-07', quantity: 1 })), 'DN_NUMBER_EXISTS');
  assert.strictEqual(await code(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: other.equipment_id, site_id: 8, dnr_rate_id: gravel.dnr_rate_id, dn_number: 'DN-9', note_date: '2027-01-01', quantity: 1 })), 'FUTURE_DATE');
  // a used price cannot change its unit price (close it and add a new one)
  assert.strictEqual(await code(h.api().put(`/api/equipment/dnr-rates/${sand.dnr_rate_id}`).set(ACC()).send({ unit_price: 60 })), 'DNR_RATE_USED');
});

let oct;
test('payroll: one DNR item per machine x site, finalize, then the notes are locked', async () => {
  const pv = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: V.vendor_id }));
  const dnrItems = pv.items.filter((i) => i.billing_mode === 'DNR');
  assert.strictEqual(dnrItems.length, 2);
  assert.strictEqual(pv.totals[0].net, '275.00');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: V.vendor_id }));
  oct = await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({}));
  assert.ok(oct.is_finalized);
  assert.strictEqual(oct.settlement.payment_status, 'Unpaid');
  const [dn] = await h.query("SELECT delivery_note_id FROM eq_delivery_notes WHERE dn_number = 'DN-1'");
  assert.strictEqual(await code(h.api().patch(`/api/equipment/delivery-notes/${dn.delivery_note_id}`).set(ACC()).send({ quantity: 4, reason: 'counted again' })), 'PAYROLL_PERIOD_FINALIZED');
  const sand = (await ok(h.api().get('/api/equipment/dnr-rates').set(ACC()).query({ vendor_id: V.vendor_id }))).find((r) => r.unit === 'trip');
  assert.strictEqual(await code(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'DN-LATE', note_date: '2026-10-20', quantity: 1 })), 'PAYROLL_PERIOD_FINALIZED');
});

test('partial payment: voucher, balance, no over-payment, void refused', async () => {
  const r = await h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payments`).set(ACC())
    .send({ vendor_id: V.vendor_id, amount: 100, paid_on: '2026-11-10', method: 'Cheque', reference: 'CHQ-77' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.payment.voucher_no, /^PV-2026-\d{5}$/);
  assert.strictEqual(r.body.payment.balance_after, '175.00');
  const b = r.body.data;
  assert.strictEqual(b.status, 'Generated');
  assert.strictEqual(b.settlement.payment_status, 'PartiallyPaid');
  assert.strictEqual(b.settlement.vendors[0].balance, '175.00');
  // the invoice itself never changes
  assert.strictEqual(b.invoices.find((i) => i.kind === 'Vendor').amount, '275.00');
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V.vendor_id, amount: 175.01 })), 'OVERPAYMENT');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/void`).set(A()).send({ reason: 'test void' })), 'BATCH_HAS_PAYMENTS');
  const st = await bin(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}/statement.pdf`).query({ vendor_id: V.vendor_id }).set(ACC()));
  assert.strictEqual(st.status, 200); assert.strictEqual(st.headers['content-type'], 'application/pdf');
  const vp = await bin(h.api().get(`/api/equipment/payroll/payments/${r.body.payment.payment_id}/voucher.pdf`).set(ACC()));
  assert.strictEqual(vp.status, 200); assert.ok(vp.body.length > 1000);
});

test('new payroll with "add previous balances": the old balance moves, voiding releases it, mark paid closes', async () => {
  const sand = (await ok(h.api().get('/api/equipment/dnr-rates').set(ACC()).query({ vendor_id: V.vendor_id }))).find((r) => r.unit === 'trip');
  await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'DN-3', note_date: '2026-11-03', quantity: 2 }));
  const scope = { start_date: '2026-11-01', end_date: '2026-11-30', vendor_id: V.vendor_id };
  const pv = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(scope));
  assert.deepStrictEqual(pv.carry_forward.map((c) => [c.from_batch_id, c.amount]), [[oct.eq_batch_id, '175.00']]);
  let nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, carry_forward: true }));
  assert.strictEqual(nov.settlement.vendors[0].carried_in, '175.00');
  let old = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(old.settlement.payment_status, 'CarriedForward');
  assert.strictEqual(old.status, 'Generated');
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/payments`).set(ACC()).send({ vendor_id: V.vendor_id, amount: 1 })), 'BALANCE_CARRIED_FORWARD');
  // void the draft: the balance is owed on October again
  await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/void`).set(A()).send({ reason: 'redo with balances' }));
  old = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  assert.strictEqual(old.settlement.vendors[0].balance, '175.00');
  // again, finalize and mark paid: 100 (Nov) + 175 (carried) = 275 paid by one voucher
  nov = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, carry_forward: true }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  nov = await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/mark-paid`).set(A()).send({}));
  assert.strictEqual(nov.status, 'Paid');
  assert.strictEqual(nov.settlement.vendors[0].paid, '275.00');
  assert.strictEqual(nov.settlement.vendors[0].balance, '0.00');
  assert.strictEqual((await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()))).settlement.payment_status, 'CarriedForward');
  // undo mark paid: only its voucher is reversed
  nov = await ok(h.api().patch(`/api/equipment/payroll/batches/${nov.eq_batch_id}/undo-paid`).set(A()).send({ reason: 'not paid yet' }));
  assert.strictEqual(nov.status, 'Generated');
  assert.strictEqual(nov.settlement.vendors[0].balance, '275.00');
  // the list shows the money state
  const list = await ok(h.api().get('/api/equipment/payroll/batches').set(ACC()));
  assert.strictEqual(list.find((b) => b.eq_batch_id === nov.eq_batch_id).balance, '275.00');
  assert.strictEqual(list.find((b) => b.eq_batch_id === oct.eq_batch_id).payment_status, 'CarriedForward');
});
