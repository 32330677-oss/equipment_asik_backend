#!/usr/bin/env node
// scripts/legacy/legacy_import.js — ASIK legacy import (Feb -> Sep 2026) from the accountant's Excel files.
//
// Everything goes through the real API (the app is started inside this process), so every rule of the system applies:
// validation, deployments, rate cards, hour recompute, monthly sheets, week gate, locks, audit log.
//
//   node scripts/legacy/legacy_import.js --dry-run                      reads only: plan + checks + predicted amounts
//   node scripts/legacy/legacy_import.js --run --backup <file.sql> --confirm-db <DB_NAME>
//   node scripts/legacy/legacy_import.js --verify                       reconciliation workbook (reads only)
//
// Options: --admin <username> (default legacy_import)  --no-invoices  --out <folder> (default scripts/legacy/out)
// Run it from the backend folder (the .env of that folder is used), or choose the database with
//   node --env-file=<file> scripts/legacy/legacy_import.js ...
// The --run is idempotent: run it again after an interruption and it continues where it stopped.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const req = (p) => require(path.join(ROOT, p));
const { buildPlan, predictItem } = require('./plan');

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, def) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const MODE = flag('run') ? 'run' : flag('verify') ? 'verify' : flag('dry-run') ? 'dry-run' : null;
if (!MODE) {
  console.log('Usage: node scripts/legacy/legacy_import.js --dry-run | --verify | --run --backup <file.sql> --confirm-db <DB_NAME>');
  process.exit(2);
}
const OUT = path.resolve(opt('out', path.join(__dirname, 'out')));
const ADMIN = opt('admin', 'legacy_import');
const WITH_INVOICES = !flag('no-invoices');
fs.mkdirSync(OUT, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG = path.join(OUT, `${MODE}_${STAMP}.log`);
function log(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(s);
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
}
class Stop extends Error {}
function stop(msg, details) {
  log(`\nSTOPPED: ${msg}`);
  if (details) log(details);
  throw new Stop(msg);
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'legacy_data.json'), 'utf8'));
const mapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'legacy_mapping.json'), 'utf8'));
const GO_LIVE = data.window.go_live;
const FROM = data.window.from;
const TO = data.window.to;

// backend modules (need the backend's node_modules and .env)
const { env } = req('config/env');
const { pool } = req('config/db');
const engine = req('services/equipment/equipmentBillingEngine');

// ------------------------------------------------------------------ live state (reads only)
async function q(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; }

async function loadLive() {
  const settingsRows = await q('SELECT setting_key, setting_value FROM settings');
  return {
    sites: await q('SELECT * FROM sites'),
    types: await q('SELECT * FROM eq_types'),
    vendors: await q('SELECT vendor_id, vendor_code, vendor_name, status, notes FROM eq_vendors'),
    contracts: await q('SELECT * FROM eq_vendor_contracts'),
    machines: await q('SELECT equipment_id, equipment_code, vendor_id, type_id, type_seq, machine_label, status, notes FROM eq_equipment'),
    rateCards: await q('SELECT * FROM eq_rate_cards'),
    deployments: await q('SELECT * FROM eq_site_assignments'),
    attendance: await q(`SELECT eq_attendance_id, equipment_id, site_id, shift_type, record_date, check_in_time, check_out_time, status
      FROM eq_attendance WHERE record_date BETWEEN ? AND ?`, [addDays(FROM, -1), GO_LIVE]),
    settings: Object.fromEntries(settingsRows.map((r) => [r.setting_key, r.setting_value])),
    batches: await q('SELECT eq_batch_id, scope_vendor_id, start_date, end_date, status, is_finalized FROM eq_payroll_batches'),
    coverage: await q(`SELECT c.eq_batch_id, e.vendor_id, c.equipment_id, c.start_date, c.end_date FROM eq_invoice_coverage c
      JOIN eq_payroll_batches b ON b.eq_batch_id = c.eq_batch_id JOIN eq_equipment e ON e.equipment_id = c.equipment_id
      WHERE b.status IN ('Generated','HandedOver','Returned') AND c.end_date >= ? AND c.start_date <= ?`, [FROM, TO]),
  };
}
function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function planNow() {
  const live = await loadLive();
  return { live, plan: buildPlan(data, mapping, live) };
}

// ------------------------------------------------------------------ guard: the live data (from go-live) must not change
const LIVE_TABLES = [
  ['eq_attendance', 'SELECT * FROM eq_attendance WHERE record_date >= ? ORDER BY eq_attendance_id'],
  ['eq_downtime_periods', 'SELECT d.* FROM eq_downtime_periods d JOIN eq_attendance a ON a.eq_attendance_id = d.eq_attendance_id WHERE a.record_date >= ? ORDER BY d.downtime_id'],
  ['eq_rate_cards', 'SELECT * FROM eq_rate_cards WHERE effective_from >= ? ORDER BY rate_card_id'],
  ['eq_site_assignments', 'SELECT * FROM eq_site_assignments WHERE assigned_date >= ? ORDER BY eq_assignment_id'],
  ['eq_payroll_batches', 'SELECT * FROM eq_payroll_batches WHERE end_date >= ? ORDER BY eq_batch_id'],
  ['eq_payroll_items', 'SELECT i.* FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id WHERE b.end_date >= ? ORDER BY i.eq_item_id'],
  ['eq_invoices', 'SELECT x.* FROM eq_invoices x JOIN eq_payroll_batches b ON b.eq_batch_id = x.eq_batch_id WHERE b.end_date >= ? ORDER BY x.invoice_id'],
  ['eq_adjustments', 'SELECT * FROM eq_adjustments WHERE adjustment_date >= ? ORDER BY adjustment_id'],
  ['eq_fuel_issues', 'SELECT * FROM eq_fuel_issues WHERE issue_date >= ? ORDER BY fuel_issue_id'],
  ['eq_timesheets', "SELECT * FROM eq_timesheets WHERE period_month >= ? ORDER BY timesheet_id"],
];
async function liveSnapshot() {
  const out = {};
  for (const [name, sql] of LIVE_TABLES) {
    const param = name === 'eq_timesheets' ? GO_LIVE.slice(0, 7) : GO_LIVE;
    let rows;
    try { rows = await q(sql, [param]); } catch (e) { out[name] = { error: e.message }; continue; }
    // updated_at of a live row may move when the app touches it; it is kept: any change is reported
    out[name] = { rows: rows.length, sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  return out;
}
function compareSnapshots(a, b) {
  const diffs = [];
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push({ table: k, before: a[k], after: b[k] });
  }
  return diffs;
}

// ------------------------------------------------------------------ API client (the real app, in this process)
let server; let base; let token;
async function startApi() {
  const { buildApp } = req('app');
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  const users = await q('SELECT user_id, username, role, status, must_change_password, password_changed_at FROM users WHERE LOWER(username) = LOWER(?)', [ADMIN]);
  const u = users[0];
  if (!u) stop(`User "${ADMIN}" not found. Create it first: npm run create-admin -- --username ${ADMIN} --name "Legacy import"`);
  if (u.role !== 'Admin' || u.status !== 'Active') stop(`User "${ADMIN}" must be an Active Admin (now ${u.role} / ${u.status}).`);
  if (Number(u.must_change_password) === 1) {
    if (MODE !== 'run') log(`Note: "${ADMIN}" still has a temporary password; the --run clears that flag (service account).`);
    else { await pool.query('UPDATE users SET must_change_password = 0 WHERE user_id = ?', [u.user_id]); log(`"${ADMIN}": temporary-password flag cleared (service account).`); }
  }
  token = jwt.sign({ user_id: u.user_id, pwv: u.password_changed_at ? String(u.password_changed_at) : null }, env.jwtSecret, { expiresIn: '12h' });
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}
let calls = 0;
async function api(method, url, body) {
  calls += 1;
  const r = await fetch(`${base}${url}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* empty body */ }
  if (r.status >= 400) {
    const e = new Error(`${method.toUpperCase()} ${url} -> ${r.status} ${json && json.code ? json.code : ''} ${json && json.message ? json.message : ''}`);
    e.status = r.status; e.body = json; e.request = body;
    throw e;
  }
  return json;
}

// ------------------------------------------------------------------ phases of the --run
async function phaseTypes() {
  const { plan } = await planNow();
  const done = new Set();
  for (const t of Object.values(plan.types).filter((x) => x.create)) {
    if (done.has(t.name)) continue;
    const r = await api('post', '/equipment/types', { type_name: t.name, meter_unit: 'Hours' });
    done.add(t.name);
    log(`type created: ${t.name} (#${r.data.type_id})`);
  }
}

async function phaseVendors() {
  let { plan } = await planNow();
  for (const v of Object.values(plan.vendors).filter((x) => !x.live && !x.vendor_id)) {
    const r = await api('post', '/equipment/vendors', { vendor_name: v.name, notes: `Legacy import (Excel name: ${v.key})` });
    log(`vendor created: ${v.name} (#${r.data.vendor_id})`);
  }
  ({ plan } = await planNow());
  for (const v of Object.values(plan.vendors)) {
    const c = v.contract;
    if (c.action === 'create') {
      const r = await api('post', `/equipment/vendors/${v.vendor_id}/contracts`, {
        contract_number: c.contract_number, start_date: c.new_start, currency: v.currency, notes: 'Legacy import (Feb-Sep 2026)' });
      log(`contract created: ${v.name} ${c.contract_number} from ${c.new_start} ${v.currency} (#${r.data.vendor_contract_id})`);
    } else if (c.action === 'move_start') {
      await api('put', `/equipment/contracts/${c.vendor_contract_id}`, { start_date: c.new_start });
      log(`contract start moved: ${v.name} ${c.contract_number} ${c.start_date} -> ${c.new_start}`);
    }
  }
}

async function phaseMachines() {
  const { plan } = await planNow();
  if (plan.problems.length) stop('the plan has problems', plan.problems);
  const list = Object.values(plan.machines).filter((m) => !m.equipment_id)
    .sort((a, b) => `${a.vendor}|${a.type}|${String(a.number).padStart(3, '0')}`.localeCompare(`${b.vendor}|${b.type}|${String(b.number).padStart(3, '0')}`));
  for (const m of list) {
    const v = plan.vendors[m.vendor];
    const t = Object.values(plan.types).find((x) => x.name === m.type);
    const r = await api('post', '/equipment/machines', { vendor_id: v.vendor_id, type_id: t.type_id, notes: `Legacy import: Excel "${m.excel_name}" (${m.vendor})` });
    if (Number(r.data.type_seq) !== m.number) stop(`${m.key} was created as ${r.data.machine_label} (${r.data.equipment_code}) instead of #${m.number}. Restore the backup and check.`);
    log(`machine created: ${m.key} -> ${r.data.equipment_code} ${r.data.machine_label}`);
  }
}

async function phaseCards() {
  const { plan } = await planNow();
  if (plan.problems.length) stop('the plan has problems', plan.problems);
  let n = 0;
  for (const c of plan.cards.filter((x) => !x.existing_id)) {
    const m = plan.machines[c.machineKey];
    const v = plan.vendors[m.vendor];
    const body = { vendor_contract_id: v.contract.vendor_contract_id, effective_from: c.from, effective_to: c.to, billing_mode: c.billing_mode,
      overtime_enabled: false, notes: `Legacy import: accountant rate ${c.rate_exact}`.slice(0, 500) };
    if (c.billing_mode === 'Daily') Object.assign(body, { daily_rate: c.daily_rate, daily_partial_rule: c.daily_partial_rule, standard_hours_per_day: c.standard_hours_per_day });
    else body.hourly_rate = c.hourly_rate;
    await api('post', `/equipment/machines/${m.equipment_id}/rate-cards`, body);
    n += 1;
  }
  log(`rate cards created: ${n} (already there: ${plan.cards.length - n})`);
}

async function phaseDeployments() {
  const { plan } = await planNow();
  if (plan.problems.length) stop('the plan has problems', plan.problems);
  let n = 0;
  for (const d of plan.deployments.filter((x) => !x.existing_id)) {
    const m = plan.machines[d.machineKey];
    await api('post', '/equipment/deployments', { equipment_id: m.equipment_id, site_id: plan.sites[d.site].site_id, shift_type: d.shift,
      assigned_date: d.from, unassigned_date: d.to, notes: 'Legacy import' });
    n += 1;
  }
  log(`deployments created: ${n} (already there: ${plan.deployments.length - n})`);
}

async function ourEquipmentIds(plan) { return Object.values(plan.machines).map((m) => m.equipment_id).filter(Boolean); }

async function phaseAttendance() {
  const { plan } = await planNow();
  if (plan.problems.length) stop('the plan has problems', plan.problems);
  const ids = await ourEquipmentIds(plan);
  const existing = new Map();
  for (const r of await q(`SELECT eq_attendance_id, equipment_id, site_id, shift_type, record_date, check_in_time, check_out_time, status, anomaly_code, anomaly_ack_at
      FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status <> 'Cancelled'`, [ids, FROM, TO])) {
    existing.set(`${r.equipment_id}|${r.site_id}|${r.shift_type}|${String(r.record_date).slice(0, 10)}`, r);
  }
  const byDate = new Map();
  for (const a of plan.attendance) (byDate.get(a.date) || byDate.set(a.date, []).get(a.date)).push(a);
  const dates = [...byDate.keys()].sort();
  let created = 0; let skipped = 0; let acked = 0; let month = '';
  for (const date of dates) {
    if (date.slice(0, 7) !== month) { month = date.slice(0, 7); log(`attendance ${month}...`); }
    for (const a of byDate.get(date)) {
      const m = plan.machines[a.machineKey];
      const siteId = plan.sites[a.site].site_id;
      const k = `${m.equipment_id}|${siteId}|${a.shift}|${a.date}`;
      const ex = existing.get(k);
      if (ex) {
        if (String(ex.check_in_time).slice(0, 16) !== a.check_in || String(ex.check_out_time || '').slice(0, 16) !== a.check_out) {
          stop(`${a.machineKey} ${a.date} ${a.shift} ${a.site}: a row already exists with other times (#${ex.eq_attendance_id} ${ex.check_in_time} - ${ex.check_out_time}).`);
        }
        skipped += 1;
        continue;
      }
      const r = await api('post', '/equipment/attendance/check-in', {
        equipment_id: m.equipment_id, site_id: siteId, shift_type: a.shift, record_date: a.date,
        check_in_time: a.check_in, check_out_time: a.check_out, late_reason: `${mapping.late_reason_prefix} ${a.date.slice(0, 7)} (${a.src})`.slice(0, 1000),
        remarks: `Legacy import: ${a.hours} h from the accountant's sheet`,
      });
      created += 1;
      if (r.data.anomaly_code && !r.data.anomaly_acknowledged) {
        await api('post', `/equipment/admin/attendance/${r.data.eq_attendance_id}/ack-anomaly`, { note: `Legacy import: ${a.hours} h on the accountant's sheet` });
        acked += 1;
      }
    }
    // submit the day (every site x shift that has Draft rows of our machines that day)
    const drafts = await q(`SELECT DISTINCT site_id, shift_type FROM eq_attendance WHERE record_date = ? AND status = 'Draft' AND equipment_id IN (?)`, [date, ids]);
    for (const d of drafts) await api('post', '/equipment/attendance/submit', { site_id: d.site_id, shift_type: d.shift_type, record_date: date });
  }
  log(`attendance: ${created} created, ${skipped} already there, ${acked} anomalies acknowledged`);
}

async function phaseApprove() {
  const { plan } = await planNow();
  const ids = await ourEquipmentIds(plan);
  const unack = await q(`SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status = 'Submitted'
      AND anomaly_code IS NOT NULL AND anomaly_ack_at IS NULL`, [ids, FROM, TO]);
  for (const r of unack) await api('post', `/equipment/admin/attendance/${r.eq_attendance_id}/ack-anomaly`, { note: 'Legacy import: hours from the accountant\'s sheet' });
  const rows = await q(`SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status = 'Submitted' ORDER BY eq_attendance_id`, [ids, FROM, TO]);
  let approved = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const r = await api('post', '/equipment/admin/attendance/approve', { ids: rows.slice(i, i + 200).map((x) => x.eq_attendance_id) });
    approved += r.data.approved.length;
    if (r.data.skipped.length) stop('some rows were not approved', r.data.skipped.slice(0, 20));
  }
  const left = await q(`SELECT status, COUNT(*) AS n FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status <> 'Cancelled' GROUP BY status`, [ids, FROM, TO]);
  log(`approved: ${approved}; rows by status now: ${left.map((x) => `${x.status} ${x.n}`).join(', ')}`);
  const notApproved = left.filter((x) => x.status !== 'Approved');
  if (notApproved.length) stop('rows of the import are not all Approved', notApproved);
  if (left.reduce((a, x) => a + Number(x.n), 0) !== plan.attendance.length) stop(`the import has ${left.reduce((a, x) => a + Number(x.n), 0)} rows, the Excel ${plan.attendance.length}.`);
}

const toCents = (s) => Math.round(Number(s) * 100);
function itemKey(it) { return `${it.equipment_id}|${it.site_id}|${it.rate_card_id}`; }

/** target items of one invoice, keyed like the preview items (machine|site|rate card) */
function targetsOf(plan, live, inv) {
  const out = new Map();
  for (const t of plan.targets.filter((x) => x.vendor === inv.vendor && x.month === inv.month)) {
    const m = plan.machines[t.machineKey];
    const c = plan.cards.find((x) => x.machineKey === t.machineKey && x.idx === t.cardIdx);
    if (!c.existing_id) stop(`${t.key}: its rate card was not found (run the earlier phases first).`);
    out.set(`${m.equipment_id}|${plan.sites[t.site].site_id}|${c.existing_id}`, t);
  }
  return out;
}

async function phaseInvoices() {
  let { plan, live } = await planNow();
  const a = mapping.adjustment;
  const summary = [];
  for (const inv of plan.invoices.sort((x, y) => x.month.localeCompare(y.month) || x.vendor.localeCompare(y.vendor))) {
    const v = plan.vendors[inv.vendor];
    const scope = { vendor_id: v.vendor_id, start_date: inv.start_date, end_date: inv.end_date };
    const tg = targetsOf(plan, live, inv);
    if (inv.existing && inv.existing.is_finalized) { log(`invoice ${inv.vendor} ${inv.month}: already issued (#${inv.existing.eq_batch_id})`); continue; }
    if (inv.existing && !inv.existing.is_finalized) {
      await api('patch', `/equipment/payroll/batches/${inv.existing.eq_batch_id}/void`, { reason: 'Legacy import: draft of an interrupted run, generated again' });
      log(`invoice ${inv.vendor} ${inv.month}: draft #${inv.existing.eq_batch_id} of an interrupted run deleted`);
    }
    // 1) preview -> adjustments for the accountant's exact amounts
    let pv = (await api('post', '/equipment/payroll/preview', scope)).data;
    const blocking = (pv.blockers || []).filter((b) => b.blocking);
    if (blocking.length) stop(`${inv.vendor} ${inv.month}: blockers`, blocking.map((b) => `${b.code} (${b.count})`));
    if ((pv.overlaps || []).length) stop(`${inv.vendor} ${inv.month}: another invoice covers this period`, pv.overlaps);
    for (const it of pv.items) {
      const t = tg.get(itemKey(it));
      if (!t) stop(`${inv.vendor} ${inv.month}: the system bills an item the Excel does not have (machine #${it.equipment_id} ${it.equipment_code}, site ${it.site_code}, card #${it.rate_card_id}, ${it.net}).`);
      const diff = t.target_cents - toCents(it.net);
      if (diff === 0) continue;
      const limit = Math.max(Math.round(t.target_cents * a.max_abs_fraction), a.max_abs_floor * 100);
      if (Math.abs(diff) > limit) stop(`${t.key}: system ${it.net} vs accountant ${(t.target_cents / 100).toFixed(2)}: the difference is too big for a rounding adjustment.`);
      await api('post', '/equipment/adjustments', {
        equipment_id: it.equipment_id, site_id: it.site_id, adjustment_date: t.last_date, adjustment_type: a.type, amount: diff / 100,
        reason: a.reason.replace('{month}', inv.month).replace('{rate}', String(Math.round(t.card.rate_exact * 1e6) / 1e6)).slice(0, 500) });
    }
    for (const k of tg.keys()) if (!pv.items.some((it) => itemKey(it) === k)) stop(`${tg.get(k).key}: the Excel has it but the system bills nothing (rows not approved?).`);
    // 2) preview again: every item must now equal the accountant
    pv = (await api('post', '/equipment/payroll/preview', scope)).data;
    for (const it of pv.items) {
      const t = tg.get(itemKey(it));
      if (!t || toCents(it.net) !== t.target_cents) stop(`${inv.vendor} ${inv.month}: item ${it.equipment_code} ${it.site_code} = ${it.net}, accountant ${t ? (t.target_cents / 100).toFixed(2) : 'none'}.`);
    }
    // 3) generate + issue
    const g = await api('post', '/equipment/payroll/generate', scope);
    const batchId = g.data.eq_batch_id || (g.data.batch && g.data.batch.eq_batch_id);
    if (!batchId) stop('generate did not return the invoice id', Object.keys(g.data));
    await api('patch', `/equipment/payroll/batches/${batchId}/finalize`, { acknowledge_changes: true });
    const nos = await q("SELECT invoice_no FROM eq_invoices WHERE eq_batch_id = ? AND kind = 'Vendor' AND status = 'Issued'", [batchId]);
    const [b] = await q('SELECT total_net, currency FROM eq_payroll_batches WHERE eq_batch_id = ?', [batchId]);
    log(`invoice ${inv.vendor} ${inv.month}: #${batchId} ${nos.map((x) => x.invoice_no).join(', ')} ${b.total_net} ${b.currency}`);
    summary.push({ ...inv, eq_batch_id: batchId, invoice_no: nos.map((x) => x.invoice_no).join(', '), total_net: b.total_net });
    ({ plan, live } = await planNow());
  }
  return summary;
}

async function phaseDeactivate() {
  const { plan } = await planNow();
  const today = new Date().toISOString().slice(0, 10);
  for (const k of plan.deactivate.machines) {
    const m = plan.machines[k];
    if (!m.equipment_id || m.status === 'Inactive') continue;
    await api('patch', `/equipment/machines/${m.equipment_id}/status`, { status: 'Inactive', effective_date: today, reason: `Legacy import: worked ${m.first_day} to ${m.last_day}, not working since` });
    log(`machine deactivated: ${k} (${m.equipment_code || m.equipment_id})`);
  }
  for (const k of plan.deactivate.vendors) {
    const v = plan.vendors[k];
    if (!v.vendor_id || v.status === 'Inactive') continue;
    await api('patch', `/equipment/vendors/${v.vendor_id}/status`, { status: 'Inactive', reason: `Legacy import: worked ${v.first_day} to ${v.last_day}, not working since` });
    log(`vendor deactivated: ${v.name}`);
  }
}

// ------------------------------------------------------------------ reconciliation workbook
async function reconciliation(plan, liveCheck) {
  const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
  const wb = new ExcelJS.Workbook();
  const ids = Object.values(plan.machines).map((m) => m.equipment_id).filter(Boolean);
  // system hours (Approved rows) per machine x site x month
  const hrs = new Map();
  if (ids.length) {
    for (const r of await q(`SELECT equipment_id, site_id, DATE_FORMAT(record_date, '%Y-%m') AS mo, SUM(working_minutes) AS wm, COUNT(*) AS n,
        SUM(status = 'Approved') AS approved FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status <> 'Cancelled'
        GROUP BY equipment_id, site_id, mo`, [ids, FROM, TO])) hrs.set(`${r.equipment_id}|${r.site_id}|${r.mo}`, r);
  }
  // invoiced amounts per item (issued legacy invoices)
  const items = ids.length ? await q(`SELECT i.equipment_id, i.site_id, i.rate_card_id, i.net_amount, b.eq_batch_id, b.start_date, b.status, b.is_finalized,
      (SELECT GROUP_CONCAT(x.invoice_no) FROM eq_invoices x WHERE x.eq_batch_id = b.eq_batch_id AND x.kind = 'Vendor' AND x.status = 'Issued') AS invoice_no
      FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
      WHERE b.status IN ('Generated','HandedOver','Returned') AND b.start_date >= ? AND b.end_date <= ? AND i.equipment_id IN (?)`, [FROM, TO, ids]) : [];
  const itemBy = new Map(items.map((x) => [`${String(x.start_date).slice(0, 7)}|${x.equipment_id}|${x.site_id}|${x.rate_card_id}`, x]));

  const s1 = wb.addWorksheet('Machine x month');
  s1.columns = [
    { header: 'Month', key: 'month', width: 9 }, { header: 'Excel vendor', key: 'vendor', width: 24 }, { header: 'Excel machine', key: 'machine', width: 18 },
    { header: 'System machine', key: 'sys', width: 26 }, { header: 'Site', key: 'site', width: 9 }, { header: 'Currency', key: 'cur', width: 8 },
    { header: 'Accountant rate', key: 'rate', width: 13 }, { header: 'System rate', key: 'srate', width: 11 },
    { header: 'Excel hours', key: 'xh', width: 11 },
    { header: 'Accountant amount', key: 'xa', width: 16 }, { header: 'Invoice amount', key: 'ia', width: 15 }, { header: 'Amount diff', key: 'ad', width: 12 },
    { header: 'Invoice', key: 'inv', width: 18 }, { header: 'Rows approved', key: 'ap', width: 12 },
  ];
  let bad = 0;
  for (const t of plan.targets.sort((a, b) => a.key.localeCompare(b.key))) {
    const m = plan.machines[t.machineKey]; const c = t.card; const siteId = plan.sites[t.site].site_id;
    const h = hrs.get(`${m.equipment_id}|${siteId}|${t.month}`);
    const it = itemBy.get(`${t.month}|${m.equipment_id}|${siteId}|${c.existing_id}`);
    const ia = it ? toCents(it.net_amount) : null;
    if (ia !== t.target_cents) bad += 1;
    s1.addRow({ month: t.month, vendor: t.vendor, machine: m.excel_name, sys: `${m.equipment_code || '?'} ${m.label}`, site: t.site, cur: c.currency,
      rate: Math.round(c.rate_exact * 1e6) / 1e6, srate: c.billing_mode === 'Daily' ? c.daily_rate : c.hourly_rate,
      xh: Math.round(t.hours * 100) / 100, xa: t.target_cents / 100, ia: ia === null ? null : ia / 100,
      ad: ia === null ? 'NOT INVOICED' : (ia - t.target_cents) / 100, inv: it ? it.invoice_no || `draft #${it.eq_batch_id}` : '', ap: h ? `${h.approved}/${h.n}` : '0' });
  }
  // system hours are per machine x site x month (a card change inside a month splits the Excel side only)
  const hoursSheet = wb.addWorksheet('Hours machine x site x month');
  hoursSheet.columns = [{ header: 'Month', key: 'm', width: 9 }, { header: 'Machine', key: 'k', width: 40 }, { header: 'Site', key: 's', width: 9 },
    { header: 'Excel hours', key: 'x', width: 12 }, { header: 'System hours', key: 'y', width: 12 }, { header: 'Diff (minutes rounding)', key: 'd', width: 22 }];
  const xh = new Map();
  for (const a of plan.attendance) { const k = `${a.date.slice(0, 7)}|${a.machineKey}|${a.site}`; xh.set(k, (xh.get(k) || 0) + (mapping.daily_machines[a.machineKey] ? a.minutes / 60 : a.hours)); }
  for (const [k, x] of [...xh.entries()].sort()) {
    const [mo, vend, mach, site] = k.split('|'); const m = plan.machines[`${vend}|${mach}`];
    const h = hrs.get(`${m.equipment_id}|${plan.sites[site].site_id}|${mo}`);
    const y = h ? Number(h.wm) / 60 : 0;
    hoursSheet.addRow({ m: mo, k: `${vend} ${mach} (${m.equipment_code || '?'})`, s: site, x: Math.round(x * 100) / 100, y: Math.round(y * 10000) / 10000, d: Math.round((y - x) * 60 * 10) / 10 });
  }
  const s2 = wb.addWorksheet('Vendor x month');
  s2.columns = [{ header: 'Month', key: 'm', width: 9 }, { header: 'Excel vendor', key: 'v', width: 26 }, { header: 'Currency', key: 'c', width: 8 },
    { header: 'Accountant (hours x rate)', key: 'x', width: 22 }, { header: 'Accountant TOTAL cells', key: 'xt', width: 20 },
    { header: 'Invoices', key: 'i', width: 14 }, { header: 'Diff', key: 'd', width: 10 }, { header: 'Invoice no', key: 'n', width: 22 }];
  const vm = new Map();
  for (const r of data.excel_rows) {
    const k = `${r.month}|${r.vendor}`; const e = vm.get(k) || { x: 0, xt: 0, i: 0, nos: new Set() };
    e.x += r.amount_calc; e.xt += r.amount_excel || 0; vm.set(k, e);
  }
  for (const t of plan.targets) {
    const m = plan.machines[t.machineKey]; const it = itemBy.get(`${t.month}|${m.equipment_id}|${plan.sites[t.site].site_id}|${t.card.existing_id}`);
    const e = vm.get(`${t.month}|${t.vendor}`); if (it) { e.i += toCents(it.net_amount); if (it.invoice_no) e.nos.add(it.invoice_no); }
  }
  for (const [k, e] of [...vm.entries()].sort()) {
    const [mo, v] = k.split('|');
    s2.addRow({ m: mo, v, c: mapping.vendors[v].currency, x: Math.round(e.x * 100) / 100, xt: Math.round(e.xt * 100) / 100, i: e.i / 100,
      d: Math.round(e.i - Math.round(e.x * 100)) / 100, n: [...e.nos].join(', ') });
  }
  const s3 = wb.addWorksheet('Excel rows');
  s3.columns = Object.keys(data.excel_rows[0]).map((k) => ({ header: k, key: k, width: 16 }));
  for (const r of data.excel_rows) s3.addRow(r);
  const s4 = wb.addWorksheet('Live data check');
  s4.columns = [{ header: 'Table (from go-live)', key: 't', width: 24 }, { header: 'Rows before', key: 'a', width: 12 }, { header: 'Rows after', key: 'b', width: 12 },
    { header: 'Same content', key: 'c', width: 14 }];
  if (liveCheck) for (const k of Object.keys(liveCheck.before)) s4.addRow({ t: k, a: liveCheck.before[k].rows, b: liveCheck.after[k].rows, c: JSON.stringify(liveCheck.before[k]) === JSON.stringify(liveCheck.after[k]) ? 'YES' : 'NO - CHANGED' });
  else s4.addRow({ t: 'no snapshot of a --run found' });
  for (const s of [s1, hoursSheet, s2, s3, s4]) { s.getRow(1).font = { bold: true }; s.views = [{ state: 'frozen', ySplit: 1 }]; }
  const file = path.join(OUT, `reconciliation_${STAMP}.xlsx`);
  await wb.xlsx.writeFile(file);
  return { file, bad };
}

// ------------------------------------------------------------------ backup guard
function checkBackup(file) {
  if (!file) stop('--backup <file> is required: take a backup of THIS database first (see the steps file).');
  if (!fs.existsSync(file)) stop(`backup file not found: ${file}`);
  const st = fs.statSync(file);
  if (st.size < 50 * 1024) stop(`backup file looks too small (${st.size} bytes): ${file}`);
  const ageH = (Date.now() - st.mtimeMs) / 3600000;
  if (ageH > 12) stop(`backup file is ${ageH.toFixed(1)} hours old: take a fresh backup right before the run.`);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(st.size, 64 * 1024 * 1024)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  const txt = buf.toString('utf8');
  for (const t of ['eq_attendance', 'eq_equipment', 'eq_payroll_batches']) if (!txt.includes(t)) stop(`backup file does not contain the table ${t}: is it a full dump of the database?`);
  log(`backup ok: ${file} (${(st.size / 1024 / 1024).toFixed(1)} MB, ${ageH.toFixed(1)} h old)`);
}

// ------------------------------------------------------------------ main
async function main() {
  log(`ASIK legacy import — ${MODE} — database ${env.db.database} on ${env.db.host}:${env.db.port}`);
  log(`data: ${data.days.length} day records from ${data.source_files.length} Excel files (sha ${data.source_sha256.slice(0, 12)}), window ${FROM} to ${TO}, go-live ${GO_LIVE}`);
  if (data.problems && data.problems.length) stop('the Excel data has problems', data.problems);

  const { live, plan } = await planNow();
  fs.writeFileSync(path.join(OUT, `plan_${STAMP}.json`), JSON.stringify(plan, null, 1));
  log('plan:', plan.counts);
  const firstLive = (await q('SELECT MIN(record_date) AS d FROM eq_attendance WHERE record_date > ?', [TO]))[0].d;
  const legacyRows = (await q(`SELECT COUNT(*) AS n FROM eq_attendance WHERE record_date BETWEEN ? AND ? AND status <> 'Cancelled'`, [FROM, TO]))[0].n;
  log(`first live attendance date: ${firstLive || 'none'} (go-live ${GO_LIVE}); rows already in ${FROM}..${TO}: ${legacyRows}`);
  if (firstLive && String(firstLive).slice(0, 10) < GO_LIVE) stop(`there is live attendance on ${firstLive}, before the go-live date ${GO_LIVE}.`);
  if (Number(legacyRows) > 0 && !Object.values(plan.machines).some((m) => !m.live && m.equipment_id)) {
    log('WARNING: there are already rows in the import window but no machine of an earlier run: someone recorded old days by hand?');
  }

  if (MODE === 'dry-run') {
    // predicted amounts with the backend's own billing engine
    let adjN = 0; const lines = [];
    for (const t of plan.targets) {
      const sys = predictItem(engine, t); const d = t.target_cents - sys;
      if (d !== 0) { adjN += 1; lines.push(`  ${t.key}: system ${(sys / 100).toFixed(2)} accountant ${(t.target_cents / 100).toFixed(2)} -> adjustment ${(d / 100).toFixed(2)} ${t.card.currency}`); }
    }
    const rep = [
      `ASIK legacy import — DRY RUN ${STAMP} — ${env.db.database}@${env.db.host}`, '',
      `Counts: ${JSON.stringify(plan.counts)}`, '',
      `PROBLEMS (${plan.problems.length}) — the --run refuses to start while there is one:`, ...plan.problems.map((p) => `  - ${p}`), '',
      'Types to create:', ...Object.values(plan.types).filter((t) => t.create).map((t) => `  ${t.name}`), '',
      'Vendors:', ...Object.values(plan.vendors).map((v) => `  ${v.live ? 'LIVE' : 'NEW '} ${v.key} -> ${v.name}${v.vendor_id ? ` (#${v.vendor_id})` : ''} ${v.currency}; contract ${v.contract.action} ${v.contract.action === 'keep' ? '' : `from ${v.contract.new_start}`}; worked ${v.first_day} to ${v.last_day}`), '',
      'Machines:', ...Object.values(plan.machines).map((m) => `  ${m.live ? 'LIVE' : 'NEW '} ${m.key} -> ${m.equipment_code || 'to create'} ${m.label}; worked ${m.first_day} to ${m.last_day}${m.live ? '' : ' -> Inactive at the end'}`), '',
      `Rate cards: ${plan.cards.length}, deployments: ${plan.deployments.length}, attendance rows: ${plan.attendance.length} (long sessions to acknowledge: ${plan.counts.long_sessions}), invoices: ${plan.invoices.length}`, '',
      `Rounding adjustments predicted (${adjN} of ${plan.targets.length} invoice items):`, ...lines, '',
      'Accountant rates kept with 2 decimals by the system:', ...plan.warnings.map((w) => `  ${w}`),
    ].join('\n');
    const file = path.join(OUT, `dry_run_report_${STAMP}.txt`);
    fs.writeFileSync(file, rep);
    log(`\nDRY RUN done: ${plan.problems.length} problem(s). Report: ${file}`);
    if (plan.problems.length) { plan.problems.slice(0, 30).forEach((p) => log(`  - ${p}`)); process.exitCode = 1; }
    return;
  }

  if (MODE === 'verify') {
    const snaps = fs.readdirSync(OUT).filter((f) => f.startsWith('live_before_')).sort();
    let liveCheck = null;
    if (snaps.length) { const before = JSON.parse(fs.readFileSync(path.join(OUT, snaps[snaps.length - 1]))); liveCheck = { before, after: await liveSnapshot() }; }
    const r = await reconciliation(plan, liveCheck);
    const changed = liveCheck ? compareSnapshots(liveCheck.before, liveCheck.after) : [];
    log(`reconciliation: ${r.file}; items not equal to the accountant: ${r.bad}; live tables changed since the last run: ${changed.length}`);
    if (r.bad || changed.length) process.exitCode = 1;
    return;
  }

  // ---------------- RUN
  if (opt('confirm-db') !== env.db.database) stop(`--confirm-db must be the database name (${env.db.database}): it protects against running on the wrong database.`);
  checkBackup(opt('backup'));
  if (plan.problems.length) stop(`the plan has ${plan.problems.length} problem(s): run --dry-run and fix them first`, plan.problems.slice(0, 30));
  const before = await liveSnapshot();
  fs.writeFileSync(path.join(OUT, `live_before_${STAMP}.json`), JSON.stringify(before, null, 1));
  log('live data snapshot taken (from go-live):', Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.rows])));
  await startApi();
  const t0 = Date.now();
  const phases = [['types', phaseTypes], ['vendors + contracts', phaseVendors], ['machines', phaseMachines], ['rate cards', phaseCards],
    ['deployments', phaseDeployments], ['attendance', phaseAttendance], ['approve', phaseApprove]];
  if (WITH_INVOICES) phases.push(['invoices', phaseInvoices]);
  phases.push(['deactivate', phaseDeactivate]);
  for (const [name, fn] of phases) {
    log(`\n== ${name}`);
    const tp = Date.now();
    await fn();
    log(`   (${name}: ${((Date.now() - tp) / 1000).toFixed(0)} s, ${calls} API calls so far)`);
    const now = await liveSnapshot();
    const diffs = compareSnapshots(before, now);
    if (diffs.length) stop(`the live data (from ${GO_LIVE}) changed during the phase "${name}". If nobody used the app meanwhile, restore the backup.`, diffs);
  }
  const after = await liveSnapshot();
  fs.writeFileSync(path.join(OUT, `live_after_${STAMP}.json`), JSON.stringify(after, null, 1));
  const { plan: finalPlan } = await planNow();
  const r = await reconciliation(finalPlan, { before, after });
  log(`\nRUN done in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${calls} API calls.`);
  log(`reconciliation workbook: ${r.file}; items not equal to the accountant: ${r.bad}`);
  if (r.bad) process.exitCode = 1;
}

main()
  .catch((e) => {
    if (!(e instanceof Stop)) {
      log(`\nFAILED: ${e.message}`);
      if (e.body) log(e.body);
      if (e.request) log({ request: e.request });
      if (e.stack) fs.appendFileSync(LOG, `${e.stack}\n`);
    }
    log(`Nothing is lost: run the same command again after fixing the cause (it continues), or restore the backup. Log: ${LOG}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((r) => server.close(r));
    await pool.end().catch(() => {});
  });
