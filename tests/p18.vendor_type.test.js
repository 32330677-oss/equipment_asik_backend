// P18 — a vendor is a company or an individual (migration 015): existing vendors stay Company, an individual has a national ID.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, A } = require('./fixtures');

const ACC = () => h.auth(h.T.accountant());

before(async () => { await h.resetDatabase(); });
after(h.closePool);

test('default Company (existing data unchanged); an individual with a national ID; invalid type refused', async () => {
  const co = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Big Rentals Co', tax_number: 'TX-1' }));
  assert.strictEqual(co.vendor_type, 'Company');
  assert.strictEqual(co.national_id, null);
  const ind = await ok(h.api().post('/api/equipment/vendors').set(ACC()).send({ vendor_name: 'Abu Ali', vendor_type: 'Individual', national_id: '01020304050', phone_number: '0999' }));
  assert.strictEqual(ind.vendor_type, 'Individual');
  assert.strictEqual(ind.national_id, '01020304050');
  // an existing vendor is switched to Individual later, nothing else changes
  const sw = await ok(h.api().put(`/api/equipment/vendors/${co.vendor_id}`).set(ACC()).send({ vendor_type: 'Individual', national_id: '99' }));
  assert.strictEqual(sw.vendor_type, 'Individual');
  assert.strictEqual(sw.tax_number, 'TX-1');
  assert.strictEqual(sw.vendor_name, 'Big Rentals Co');
  const bad = await h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'X', vendor_type: 'Person' });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR');
  const list = await ok(h.api().get('/api/equipment/vendors').set(ACC()));
  assert.strictEqual(list.find((v) => v.vendor_id === ind.vendor_id).vendor_type, 'Individual');
});

test('payment voucher of an individual prints the national ID (PDF renders)', async () => {
  const statements = require('../services/equipment/eqStatements');
  const { pool } = require('../config/db');
  const base = { voucher_no: 'PV-2026-00001', eq_batch_id: 1, version_number: 1, currency: 'USD', vendor_name: 'Abu Ali', vendor_code: 'VND-002',
    paid_on: '2026-10-10', invoice_no: 'VI-2026-00001', start_date: '2026-09-01', end_date: '2026-09-30', method: 'Cash', reference: null,
    created_by: 'Accountant One', created_at: '2026-10-10 10:00:00', balance_before: '1000.00', amount: '400.00', balance_after: '600.00', status: 'Active', source: 'Payment' };
  const user = { full_name: 'Accountant One' };
  const pdfText = async (p) => (await statements.voucherPdf(pool, p, user)).buffer;
  const ind = await pdfText({ ...base, vendor_type: 'Individual', national_id: '01020304050', tax_number: null });
  const co = await pdfText({ ...base, vendor_type: 'Company', national_id: null, tax_number: 'TX-1' });
  assert.ok(ind.length > 1000 && co.length > 1000);
  assert.ok(ind.toString('latin1').includes('National ID') || ind.length !== co.length, 'the individual voucher differs (national ID instead of tax number)');
});
