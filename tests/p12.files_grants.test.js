// P12 — edit / lock policy, phase 5: fuel receipts and contract documents are versioned (old files kept,
// replacing needs a reason), and the audit trail / official numbers are append-only for the app user.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');
const { APPEND_ONLY } = require('../database/grants');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
const pdf = (n) => Buffer.from(`%PDF-1.4\n% version ${n}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
let F;

before(async () => { await h.resetDatabase(); F = await standardFleet(); });
after(h.closePool);

test('contract document: every upload is a new version; replacing needs a reason; old versions stay downloadable', async () => {
  const url = `/api/equipment/contracts/${F.contract.vendor_contract_id}`;
  await ok(h.api().post(`${url}/document`).set(A()).attach('file', pdf(1), 'contract.pdf'));
  const noReason = await h.api().post(`${url}/document`).set(A()).attach('file', pdf(2), 'contract-signed.pdf');
  assert.strictEqual(noReason.body.code, 'VALIDATION');
  await ok(h.api().post(`${url}/document`).set(A()).field('reason', 'Signed copy with the stamp').attach('file', pdf(2), 'contract-signed.pdf'));
  const same = await h.api().post(`${url}/document`).set(A()).field('reason', 'again the same file').attach('file', pdf(2), 'again.pdf');
  assert.strictEqual(same.body.code, 'SAME_FILE');
  const versions = await ok(h.api().get(`${url}/documents`).set(ACC()));
  assert.deepStrictEqual(versions.map((v) => v.version_no), [2, 1]);
  assert.strictEqual(versions[0].is_current, true);
  assert.strictEqual(versions[0].reason, 'Signed copy with the stamp');
  assert.strictEqual(versions[0].original_name, 'contract-signed.pdf');
  const v1 = await h.api().get(`${url}/document?version=1`).set(A()).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
  assert.strictEqual(v1.status, 200);
  assert.ok(v1.body.toString().includes('version 1'), 'the first file is still there');
  const [log] = await h.query("SELECT action_type, reason FROM audit_logs WHERE table_name = 'eq_vendor_contracts' AND action_type = 'replace_document'");
  assert.strictEqual(log.reason, 'Signed copy with the stamp');
});

test('fuel receipt: versions with reason', async () => {
  const f = await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-11-02', liters: 40, price_per_liter: 1 }));
  const url = `/api/equipment/fuel-issues/${f.fuel_issue_id}`;
  await ok(h.api().post(`${url}/receipt`).set(ACC()).attach('file', pdf('r1'), 'r1.pdf'));
  assert.strictEqual((await h.api().post(`${url}/receipt`).set(ACC()).attach('file', pdf('r2'), 'r2.pdf')).body.code, 'VALIDATION');
  const r = await ok(h.api().post(`${url}/receipt`).set(ACC()).field('reason', 'first photo was blurred').attach('file', pdf('r2'), 'r2.pdf'));
  assert.strictEqual(r.version_no, 2);
  const list = await ok(h.api().get(`${url}/receipts`).set(ACC()));
  assert.strictEqual(list.length, 2);
  assert.strictEqual((await h.api().get(`${url}/receipt?version=1`).set(ACC())).status, 200);
  assert.strictEqual((await h.api().get(`${url}/receipt?version=9`).set(ACC())).status, 404);
});

test('append-only tables for the app user', () => {
  for (const t of ['audit_logs', 'eq_invoices', 'eq_invoice_cancellations', 'eq_correction_events', 'eq_file_versions']) assert.ok(APPEND_ONLY.includes(t), t);
});
