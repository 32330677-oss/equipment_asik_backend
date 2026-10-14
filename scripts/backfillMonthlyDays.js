// scripts/backfillMonthlyDays.js — fills eq_payroll_monthly_days for batches made before 019 (11 Oct 2026).
// For every active batch (Generated or Paid) and every MONTHLY item: the days of the batch period inside the item's rate
// card and the machine's deployments are the monthly days that item billed. Items that already hold days are skipped.
// Idempotent: run it once on the server after `npm run migrate` and before the first payroll — running it again changes nothing.
//   npm run backfill:monthly-days            (writes)
//   npm run backfill:monthly-days -- --dry   (only counts)
const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { addDays } = require('../utils/businessDate');
const { covers } = require('../utils/ranges');

const day = (d) => (d ? String(d).slice(0, 10) : null);

async function backfill(conn, { dry = false, log = () => {} } = {}) {
  const [items] = await conn.query(
    `SELECT i.eq_item_id, i.eq_batch_id, i.equipment_id, i.site_id, i.rate_card_id, b.start_date, b.end_date, rc.effective_from, rc.effective_to
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     JOIN eq_rate_cards rc ON rc.rate_card_id = i.rate_card_id
     WHERE i.billing_mode = 'Monthly' AND b.status IN ('Generated','HandedOver','Returned')
     ORDER BY b.eq_batch_id, i.eq_item_id`);
  let added = 0; let seen = 0; let skipped = 0;
  for (const it of items) {
    // an item made after 019 already holds its days (and may hold only PART of its period): never touched
    const [[has]] = await conn.query('SELECT COUNT(*) AS n FROM eq_payroll_monthly_days WHERE eq_item_id = ?', [it.eq_item_id]);
    if (Number(has.n) > 0) { skipped += 1; continue; }
    const [deps] = await conn.query(
      `SELECT eq_assignment_id, site_id, shift_type, assigned_date, unassigned_date FROM eq_site_assignments
       WHERE equipment_id = ? AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?) AND (unassigned_date IS NULL OR unassigned_date >= assigned_date)`,
      [it.equipment_id, day(it.end_date), day(it.start_date)]);
    for (let d = day(it.start_date); d <= day(it.end_date); d = addDays(d, 1)) {
      if (!covers(day(it.effective_from), day(it.effective_to), d)) continue;
      // the site that owns the day: the Day-shift deployment first, then the oldest (as the payroll does)
      const own = deps.filter((x) => covers(day(x.assigned_date), day(x.unassigned_date), d))
        .sort((a, b) => (a.shift_type === b.shift_type ? 0 : a.shift_type === 'Day' ? -1 : 1) || day(a.assigned_date).localeCompare(day(b.assigned_date)) || a.eq_assignment_id - b.eq_assignment_id);
      if (!own.length) continue;
      // one batch per machine-day: a day another active batch already holds is never taken twice
      const [[taken]] = await conn.query(
        `SELECT COUNT(*) AS n FROM eq_payroll_monthly_days md JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id
         WHERE md.equipment_id = ? AND md.day = ? AND md.eq_batch_id <> ? AND b.status IN ('Generated','HandedOver','Returned')`, [it.equipment_id, d, it.eq_batch_id]);
      if (Number(taken.n) > 0) continue;
      seen += 1;
      if (dry) continue;
      const [r] = await conn.execute(
        'INSERT IGNORE INTO eq_payroll_monthly_days (eq_batch_id, eq_item_id, equipment_id, day, site_id) VALUES (?, ?, ?, ?, ?)',
        [it.eq_batch_id, it.eq_item_id, it.equipment_id, d, own[0].site_id || it.site_id]);
      added += r.affectedRows;
    }
  }
  log(`${items.length} monthly item(s) (${skipped} already had their days), ${seen} monthly day(s)${dry ? ' (dry run, nothing written)' : `, ${added} added`}.`);
  return { items: items.length, skipped, days: seen, added };
}

async function main() {
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.database,
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await backfill(conn, { dry: process.argv.includes('--dry'), log: console.log });
  } finally {
    await conn.end();
  }
}

if (require.main === module) main().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });

module.exports = { backfill };
