// P15 — DNR (per-unit delivery notes on an existing vendor) on invoices (payments are not recorded since 14 Oct 2026).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A } = require('./fixtures');

// October and November must be in the past for this file
require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 11, 5, 9, 0, 0)));

const ACC = () => h.auth(h.T.accountant());
const code = async (p) => (await p).body.code;
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
test('invoice: one DNR item per machine x site; issued notes follow with the same number; handed over, they are locked', async () => {
  const pv = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: V.vendor_id }));
  const dnrItems = pv.items.filter((i) => i.billing_mode === 'DNR');
  assert.strictEqual(dnrItems.length, 2);
  assert.strictEqual(pv.totals[0].net, '275.00');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: V.vendor_id }));
  oct = await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({}));
  assert.ok(oct.is_finalized);
  assert.strictEqual(oct.state, 'issued');
  const no = oct.vendor_invoice_no;
  const [dn] = await h.query("SELECT delivery_note_id FROM eq_delivery_notes WHERE dn_number = 'DN-1'");
  // issued, still in the office: the accountant corrects the note, the invoice follows with the same number
  await ok(h.api().patch(`/api/equipment/delivery-notes/${dn.delivery_note_id}`).set(ACC()).send({ quantity: 4, reason: 'counted again' }));
  oct = await ok(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/refresh`).set(ACC()).send({}));
  assert.strictEqual(oct.vendor_invoice_no, no);
  assert.strictEqual(oct.total_net, '325.00');
  const notes = await ok(h.api().get('/api/equipment/delivery-notes').set(ACC()).query({ vendor_id: V.vendor_id }));
  assert.strictEqual(notes.find((n) => n.dn_number === 'DN-1').batch_state, 'Issued');
  // handed over to finance: the notes of its days are locked, new ones dated inside are refused
  await h.handOver(oct.eq_batch_id);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/delivery-notes/${dn.delivery_note_id}`).set(ACC()).send({ quantity: 5, reason: 'counted again' })), 'INVOICE_LOCKED');
  const sand = (await ok(h.api().get('/api/equipment/dnr-rates').set(ACC()).query({ vendor_id: V.vendor_id }))).find((r) => r.unit === 'trip');
  assert.strictEqual(await code(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'DN-LATE', note_date: '2026-10-20', quantity: 1 })), 'INVOICE_LOCKED');
  const late = await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({ equipment_id: truck.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: 'DN-LATE', note_date: '2026-11-03', quantity: 1 }));
  const nov = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-30', vendor_id: V.vendor_id }));
  assert.strictEqual(nov.totals[0].net, late.amount);
  const list = await ok(h.api().get('/api/equipment/delivery-notes').set(ACC()).query({ vendor_id: V.vendor_id }));
  assert.strictEqual(list.find((n) => n.dn_number === 'DN-1').batch_state, 'HandedOver');
});
