// scripts/seedDemo.js — demo data for local testing (refuses to run in production).
// Creates: 2 sites, 1 supervisor, 1 accountant, 1 vendor + contract, 3 machines (Hourly / Daily / Monthly),
// 2 operators, deployments from the 1st of the previous month, and ~2 weeks of recorded, submitted
// and approved attendance (paper still Pending so you can try the reconciliation screen).
//   npm run seed-demo
const { env } = require('../config/env');
if (env.nodeEnv === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { pool } = require('../config/db');
const { buildApp } = require('../app');
const { businessToday, addDays, dayOfWeek } = require('../utils/businessDate');

async function main() {
  const [[admin]] = await pool.query("SELECT user_id FROM users WHERE role = 'Admin' AND status = 'Active' ORDER BY user_id LIMIT 1");
  if (!admin) throw new Error('Create an Admin first: npm run create-admin');
  const app = buildApp();
  const tok = jwt.sign({ user_id: admin.user_id }, env.jwtSecret, { expiresIn: '1h' });
  // the admin may still have a temporary password: allow the seed to run anyway
  const [[mc]] = await pool.query('SELECT must_change_password FROM users WHERE user_id = ?', [admin.user_id]);
  if (Number(mc.must_change_password)) await pool.query('UPDATE users SET must_change_password = 0 WHERE user_id = ?', [admin.user_id]);
  const call = async (method, url, body) => {
    const r = await request(app)[method](`/api${url}`).set('Authorization', `Bearer ${tok}`).send(body || {});
    if (r.status >= 400) throw new Error(`${method.toUpperCase()} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  try {
    const today = businessToday();
    const start = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    const s1 = await call('post', '/sites', { site_code: 'DEMO1', site_name: 'Demo Tower', has_night_shift: false, day_shift_start: '07:00' });
    const s2 = await call('post', '/sites', { site_code: 'DEMO2', site_name: 'Demo Bridge', has_night_shift: true, day_shift_start: '07:00', night_shift_start: '19:00' });
    const sup = await call('post', '/users', { username: 'demo_supervisor', full_name: 'Demo Supervisor', role: 'Supervisor' });
    const acc = await call('post', '/users', { username: 'demo_accountant', full_name: 'Demo Accountant', role: 'Accountant' });
    await call('post', `/sites/${s1.site_id}/supervisors`, { user_id: sup.user_id, shift_type: 'Day', from_date: start });
    await call('post', `/sites/${s2.site_id}/supervisors`, { user_id: sup.user_id, shift_type: 'Day', from_date: start });
    const vendor = await call('post', '/equipment/vendors', { vendor_name: 'Demo Heavy Equipment Co.', contact_person: 'Samer', phone_number: '+963 900 000 000' });
    const contract = await call('post', `/equipment/vendors/${vendor.vendor_id}/contracts`, { contract_number: 'DEMO-001', start_date: start, currency: 'USD' });
    const op1 = await call('post', '/equipment/operators', { vendor_id: vendor.vendor_id, full_name: 'Ahmad Khaled', license_expiry: '2030-12-31' });
    const op2 = await call('post', '/equipment/operators', { vendor_id: vendor.vendor_id, full_name: 'Omar Saleh', license_expiry: '2030-12-31' });
    const mk = (type_id, plate, model) => call('post', '/equipment/machines', { vendor_id: vendor.vendor_id, type_id, plate_number: plate, make: 'CAT', model });
    const exc = await mk(1, 'DEMO-101', '320D');
    const ldr = await mk(2, 'DEMO-102', '950H');
    const crn = await mk(4, 'DEMO-103', 'LTM 1050');
    const card = (m, b) => call('post', `/equipment/machines/${m.equipment_id}/rate-cards`, { vendor_contract_id: contract.vendor_contract_id, effective_from: start, ...b });
    await card(exc, { billing_mode: 'Hourly', hourly_rate: 40, min_billable_hours_per_day: 6, overtime_enabled: true, overtime_threshold_hours: 10, overtime_rate: 50 });
    await card(ldr, { billing_mode: 'Daily', daily_rate: 300, overtime_enabled: true, overtime_rate: 45 });
    await card(crn, { billing_mode: 'Monthly', monthly_rate: 6500, monthly_working_days: 26 });
    for (const [m, site, op] of [[exc, s1, op1], [ldr, s1, op2], [crn, s2, op2]]) {
      await call('post', '/equipment/deployments', { equipment_id: m.equipment_id, site_id: site.site_id, shift_type: 'Day', assigned_date: start, default_operator_id: op.operator_id });
    }
    let days = 0;
    for (let d = addDays(today, -16); d < today; d = addDays(d, 1)) {
      if (dayOfWeek(d) === 5) continue; // Friday off
      for (const [m, site] of [[exc, s1], [ldr, s1], [crn, s2]]) {
        const r = await call('post', '/equipment/attendance/check-in', { equipment_id: m.equipment_id, site_id: site.site_id, check_in_time: `${d} 07:00` });
        await call('post', `/equipment/attendance/${r.eq_attendance_id}/downtime/start`, { downtime_type: 'Break', start_time: `${d} 12:00`, end_time: `${d} 13:00` });
        await call('post', `/equipment/attendance/${r.eq_attendance_id}/check-out`, { check_out_time: `${d} ${m === exc ? '18:30' : '16:00'}`, work_description: 'Demo work' });
      }
      for (const site of [s1, s2]) await call('post', '/equipment/attendance/submit', { site_id: site.site_id, record_date: d });
      days += 1;
    }
    const [rows] = await pool.query("SELECT eq_attendance_id FROM eq_attendance WHERE status = 'Submitted'");
    if (rows.length) await call('post', '/equipment/admin/attendance/approve', { ids: rows.map((x) => x.eq_attendance_id) });
    console.log(`\nDemo data created (${days} working days).`);
    console.log(`  Supervisor login: demo_supervisor / ${sup.temporary_password}`);
    console.log(`  Accountant login: demo_accountant / ${acc.temporary_password}`);
    console.log('  (temporary passwords: you will be asked to change them at first login)\n');
  } finally {
    if (Number(mc.must_change_password)) await pool.query('UPDATE users SET must_change_password = 1 WHERE user_id = ?', [admin.user_id]);
    await pool.end();
  }
}

main().catch(async (e) => { console.error('seedDemo failed:', e.message); process.exit(1); });
