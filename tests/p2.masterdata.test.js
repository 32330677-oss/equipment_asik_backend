const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');

let F;
before(async () => { await h.resetDatabase(); F = await standardFleet(); });
after(h.closePool);

const PRICE_KEYS = ['hourly_rate', 'daily_rate', 'monthly_rate', 'amount', 'price_per_liter', 'net_amount', 'contact_person', 'tax_number'];
function assertNoPrices(body) {
  const s = JSON.stringify(body);
  for (const k of PRICE_KEYS) assert.ok(!s.includes(`"${k}"`), `supervisor response contains ${k}`);
}

test('codes are generated', () => {
  assert.strictEqual(F.vendor.vendor_code, 'VND-001');
  assert.strictEqual(F.exc.equipment_code, 'EQ-0001');
  assert.strictEqual(F.crane.equipment_code, 'EQ-0003');
});

test('machines list shows deployment and current rate', async () => {
  const r = await ok(h.api().get('/api/equipment/machines?deployed=true').set(A()));
  assert.strictEqual(r.length, 3);
  const exc = r.find((m) => m.equipment_code === 'EQ-0001');
  assert.strictEqual(exc.site_code, 'S08');
  assert.strictEqual(exc.billing_mode, 'Hourly');
  assert.strictEqual(exc.currency, 'USD');
});

test('rate card overlap and outside contract', async () => {
  const ov = await h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-10-01', billing_mode: 'Hourly', hourly_rate: 45 });
  assert.strictEqual(ov.body.code, 'RATE_CARD_OVERLAP');
  const out = await h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-01-01', effective_to: '2026-02-01', billing_mode: 'Hourly', hourly_rate: 45 });
  assert.strictEqual(out.body.code, 'RATE_CARD_OUTSIDE_CONTRACT');
});

test('rate card cross-field validation', async () => {
  const r = await h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2027-01-01', billing_mode: 'Daily' });
  assert.strictEqual(r.body.code, 'VALIDATION_ERROR');
  assert.ok(r.body.details.fields.daily_rate);
  const r2 = await h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2027-01-01', billing_mode: 'Hourly', hourly_rate: 10, operator_included: true, operator_daily_rate: 5 });
  assert.ok(r2.body.details.fields.operator_daily_rate);
});

test('rate change: close then new card from next day', async () => {
  const cards = await ok(h.api().get(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A()));
  await ok(h.api().post(`/api/equipment/rate-cards/${cards[0].rate_card_id}/close`).set(A()).send({ effective_to: '2026-12-31' }));
  await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2027-01-01', billing_mode: 'Hourly', hourly_rate: 45 }));
});

test('rate card preview reproduces example A', async () => {
  const r = await ok(h.api().post('/api/equipment/rate-cards/preview').set(h.auth(h.T.accountant())).send({
    rate_card: { billing_mode: 'Hourly', hourly_rate: 40, min_billable_hours_per_day: 6, overtime_enabled: true, overtime_threshold_hours: 10, overtime_rate: 50, standby_billable_pct: 50 },
    sample_rows: [
      { day_status: 'Working', gross_hours: 10.5, break_hours: 1 },
      { day_status: 'Working', gross_hours: 13, break_hours: 1 },
      { day_status: 'Working', gross_hours: 8, break_hours: 0.5, breakdown_hours: 3 },
      { day_status: 'Working', gross_hours: 5, standby_hours: 2 },
      { day_status: 'Standby' }, { day_status: 'Breakdown' }, { day_status: 'Absent' },
    ],
    fuel: [{ liters: 100, price_per_liter: 1.1 }],
    adjustments: [{ amount: 150, type: 'Mobilization', reason: 'Transport' }],
  }));
  assert.strictEqual(r.net, 1460);
});

test('deployment overlap, transfer, end with attendance check', async () => {
  const ov = await h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.exc.equipment_id, site_id: 9, assigned_date: '2026-09-15' });
  assert.strictEqual(ov.body.code, 'DEPLOYMENT_OVERLAP');
  const deps = await ok(h.api().get(`/api/equipment/deployments?equipment_id=${F.crane.equipment_id}`).set(A()));
  const t = await ok(h.api().post(`/api/equipment/deployments/${deps[0].eq_assignment_id}/transfer`).set(A())
    .send({ target_site_id: 9, target_shift_type: 'Day', first_day_at_target: '2026-11-01' }));
  assert.strictEqual(t.ended.unassigned_date, '2026-10-31');
  assert.strictEqual(t.created.assigned_date, '2026-11-01');
  const night = await h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.crane.equipment_id, site_id: 8, shift_type: 'Night', assigned_date: '2027-05-01' });
  assert.strictEqual(night.body.code, 'NO_NIGHT_SHIFT');
});

test('operator of another vendor is refused', async () => {
  const v2 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Second Vendor' }));
  const op = await ok(h.api().post('/api/equipment/operators').set(A()).send({ vendor_id: v2.vendor_id, full_name: 'Other Op' }));
  const deps = await ok(h.api().get(`/api/equipment/deployments?equipment_id=${F.exc.equipment_id}`).set(A()));
  const r = await h.api().patch(`/api/equipment/deployments/${deps[0].eq_assignment_id}`).set(A()).send({ default_operator_id: op.operator_id });
  assert.strictEqual(r.body.code, 'OPERATOR_OTHER_VENDOR');
});

test('vendor inactive blocked while machines deployed; machine release blocked', async () => {
  const r = await h.api().patch(`/api/equipment/vendors/${F.vendor.vendor_id}/status`).set(A()).send({ status: 'Inactive' });
  assert.strictEqual(r.body.code, 'VENDOR_HAS_DEPLOYED_MACHINES');
  const m = await h.api().patch(`/api/equipment/machines/${F.exc.equipment_id}/status`).set(A()).send({ status: 'Released', effective_date: '2026-10-01' });
  assert.strictEqual(m.body.code, 'MACHINE_STILL_DEPLOYED');
});

test('roles: accountant manages master data but not contracts/sites; supervisor gets reduced columns only', async () => {
  const acc = h.auth(h.T.accountant());
  assert.strictEqual((await h.api().get('/api/equipment/machines').set(acc)).status, 200);
  const v = await h.api().post('/api/equipment/vendors').set(acc).send({ vendor_name: 'Acc vendor' });
  assert.strictEqual(v.status, 201);
  assert.strictEqual((await h.api().post(`/api/equipment/vendors/${v.body.data.vendor_id}/contracts`).set(acc).send({ contract_number: 'X', start_date: '2026-01-01' })).status, 403);
  assert.strictEqual((await h.api().post('/api/sites').set(acc).send({ site_code: 'X1', site_name: 'x' })).status, 403);
  const sup = h.auth(h.T.sup8());
  assert.strictEqual((await h.api().get('/api/equipment/machines').set(sup)).status, 403);
  const vendors = await h.api().get('/api/equipment/vendors').set(sup);
  assert.strictEqual(vendors.status, 200);
  assertNoPrices(vendors.body);
  const ops = await h.api().get('/api/equipment/operators').set(sup);
  assertNoPrices(ops.body);
  assert.ok(!JSON.stringify(ops.body).includes('national_id'));
});

test('contract document upload: type check and private download', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const bad = await h.api().post(`/api/equipment/contracts/${F.contract.vendor_contract_id}/document`).set(A()).attach('file', Buffer.from('hello world, not a pdf'), 'x.pdf');
  assert.strictEqual(bad.status, 415);
  await ok(h.api().post(`/api/equipment/contracts/${F.contract.vendor_contract_id}/document`).set(A()).attach('file', pdf, 'contract.pdf'));
  const noToken = await h.api().get(`/api/equipment/contracts/${F.contract.vendor_contract_id}/document`);
  assert.strictEqual(noToken.status, 401);
  const dl = await h.api().get(`/api/equipment/contracts/${F.contract.vendor_contract_id}/document`).set(A());
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers['content-type'], 'application/pdf');
  const c = await h.api().put(`/api/equipment/contracts/${F.contract.vendor_contract_id}`).set(A()).send({ start_date: '2026-08-01' });
  assert.strictEqual(c.body.code, 'CONTRACT_DATES_EXCLUDE_RATE_CARDS');
});
