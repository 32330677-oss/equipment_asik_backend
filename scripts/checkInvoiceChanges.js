// scripts/checkInvoiceChanges.js — READ ONLY (31 Oct 2026). Which drafts and issued invoices (still in the office) would
// come out with another amount if they were recalculated now, and by how much. It never writes: everything runs inside a
// READ ONLY transaction that is rolled back. Invoices handed over to finance (or withdrawn) are never recalculated by the
// application, so they are not checked.
//
// Use it to see what an update of the calculation changes, BEFORE it is deployed:
//   1. with the code that runs now (copy only this file into it first):
//        node scripts/checkInvoiceChanges.js --out before.json   (or: npm run check:invoices -- --out before.json)
//   2. with the new code (same database, nothing deployed yet):
//        node scripts/checkInvoiceChanges.js --out after.json --compare before.json
//   The comparison lists only the invoices whose new amount differs between the two runs: that difference is caused by
//   the new code (a change of the data shows in both runs the same way and is listed apart, as "already changed").
// The database is the one of .env (DB_HOST, DB_NAME...), e.g. Aiven.
'use strict';

const fs = require('fs');
const path = require('path');

const day = (d) => (d ? String(d).slice(0, 10) : null);
const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (c) => (c / 100).toFixed(2);
const key = (x) => `${x.equipment_id}|${x.site_id}|${x.rate_card_id || 'none'}|${x.billing_mode === 'DNR' ? 'DNR' : ''}`;

/** Every draft / issued invoice: amounts as saved and as the code would calculate them now (cents), per machine item. */
async function checkBatches(conn, P, { log = () => {} } = {}) {
  const [batches] = await conn.query(
    `SELECT b.*, (SELECT x.invoice_no FROM eq_invoices x LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id
                  WHERE x.eq_batch_id = b.eq_batch_id AND x.kind = 'Vendor' AND x.status = 'Issued' AND c.invoice_id IS NULL
                  ORDER BY x.invoice_id LIMIT 1) AS invoice_no
     FROM eq_payroll_batches b WHERE b.status = 'Generated' ORDER BY b.eq_batch_id`);
  const out = [];
  for (const b of batches) {
    const [stored] = await conn.query(
      `SELECT i.equipment_id, i.site_id, i.rate_card_id, i.billing_mode, i.net_amount, e.equipment_code FROM eq_payroll_items i
       JOIN eq_equipment e ON e.equipment_id = i.equipment_id WHERE i.eq_batch_id = ?`, [b.eq_batch_id]);
    const row = {
      eq_batch_id: b.eq_batch_id, invoice_no: b.invoice_no || null, state: Number(b.is_finalized) ? 'issued' : 'draft',
      period: `${day(b.start_date)} - ${day(b.end_date)}`, currency: b.currency, saved: cents(b.total_net), now: null, error: null, items: [],
    };
    try {
      const scope = { ...(await P.batchScope(conn, b)), exclude_batch_id: b.eq_batch_id };
      const { items } = await P.calculate(conn, scope);
      const now = new Map(items.filter((i) => i.currency === b.currency).map((i) => [key(i), i.net_cents]));
      const was = new Map(stored.map((s) => [key(s), cents(s.net_amount)]));
      const code = Object.fromEntries(stored.map((s) => [key(s), s.equipment_code]));
      row.now = [...now.values()].reduce((a, c) => a + c, 0);
      for (const k of new Set([...was.keys(), ...now.keys()])) {
        const a = was.has(k) ? was.get(k) : null; const c = now.has(k) ? now.get(k) : null;
        if (a !== c) row.items.push({ item: k, machine: code[k] || k.split('|')[0], saved: a, now: c });
      }
    } catch (e) {
      row.error = `${e.code || 'ERROR'}: ${e.message}`;
    }
    log(`#${b.eq_batch_id} ${row.invoice_no || row.state} ${row.period}: saved ${money(row.saved)}${row.now === null ? ` (${row.error})` : `, now ${money(row.now)}`}`);
    out.push(row);
  }
  return out;
}

/** Invoices whose recalculated amount differs between two runs (before / after the new code). */
function compare(before, after) {
  const b = new Map(before.map((x) => [x.eq_batch_id, x]));
  const changed = []; const missing = [];
  for (const a of after) {
    const x = b.get(a.eq_batch_id);
    if (!x) { missing.push(a.eq_batch_id); continue; }
    if (x.now !== a.now || (x.error || null) !== (a.error || null)) {
      changed.push({ eq_batch_id: a.eq_batch_id, invoice_no: a.invoice_no, state: a.state, period: a.period, currency: a.currency,
        saved: a.saved, old_code: x.now, new_code: a.now, difference: a.now !== null && x.now !== null ? a.now - x.now : null,
        old_error: x.error || null, new_error: a.error || null });
    }
  }
  return { changed, missing };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const outFile = opt('--out'); const cmpFile = opt('--compare');
  const P = require('../services/equipment/eqPayrollService');
  const { pool } = require('../config/db');
  const conn = await pool.getConnection();
  let rows;
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('START TRANSACTION READ ONLY');
    rows = await checkBatches(conn, P, { log: (s) => console.log(s) });
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    conn.release();
    await pool.end();
  }
  const stale = rows.filter((r) => r.now !== null && r.now !== r.saved);
  console.log(`\n${rows.length} draft / issued invoice(s); ${stale.length} would come out with another amount now (data or code); ${rows.filter((r) => r.error).length} cannot be calculated.`);
  if (outFile) { fs.writeFileSync(path.resolve(outFile), JSON.stringify(rows, null, 1)); console.log(`Saved: ${outFile}`); }
  if (cmpFile) {
    const { changed, missing } = compare(JSON.parse(fs.readFileSync(path.resolve(cmpFile), 'utf8')), rows);
    console.log(`\n=== Changed by the NEW CODE: ${changed.length} invoice(s) ===`);
    for (const c of changed) {
      console.log(`#${c.eq_batch_id} ${c.invoice_no || c.state} ${c.period} ${c.currency}: saved ${money(c.saved)}, old code ${c.old_code === null ? c.old_error : money(c.old_code)}`
        + ` -> new code ${c.new_code === null ? c.new_error : money(c.new_code)}${c.difference !== null ? ` (${c.difference >= 0 ? '+' : ''}${money(c.difference)})` : ''}`);
    }
    if (missing.length) console.log(`Not in ${cmpFile} (made between the two runs): ${missing.join(', ')}`);
    if (!changed.length) console.log('Nothing: the new code gives every draft and issued invoice the same amount as the code that runs now.');
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { checkBatches, compare };
