// database/grants.js — table rights of the application's MySQL user.
// The app user may read and write ordinary tables, but the audit trail and the official numbers are
// APPEND-ONLY for it: SELECT + INSERT, never UPDATE / DELETE (an edit there needs the migration / admin user).
const APPEND_ONLY = ['audit_logs', 'eq_invoices', 'eq_invoice_cancellations', 'eq_correction_events', 'eq_file_versions', 'login_history'];

function ident(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `\`${name}\``;
}
function account(user, host) {
  if (!/^[A-Za-z0-9_.-]+$/.test(user) || !/^[A-Za-z0-9_.%-]+$/.test(host)) throw new Error(`Unsafe account: ${user}@${host}`);
  return `'${user}'@'${host}'`;
}

/**
 * Re-applies the rights of appUser on every table of `database` (run as a user WITH GRANT OPTION).
 * Database-wide rights are removed first so the table rights are the only ones. Hosts the user does not exist
 * on are skipped. Returns { tables, append_only, hosts }.
 */
async function applyGrants(conn, { database, appUser, hosts = ['localhost', '%'], log = () => {} }) {
  const db = ident(database);
  const [tables] = await conn.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [database]);
  const done = [];
  // only the hosts the app user really exists on (granting to a missing account fails on MySQL 8)
  let existing = hosts;
  try {
    const [rows] = await conn.query('SELECT host FROM mysql.user WHERE user = ?', [appUser]);
    existing = hosts.filter((h) => rows.some((r) => r.host === h));
  } catch (_) { /* no read right on mysql.user (migration user): try every host */ }
  for (const host of existing) {
    const who = account(appUser, host);
    try {
      await conn.query(`REVOKE ALL PRIVILEGES ON ${db}.* FROM ${who}`);
    } catch (e) {
      const msg = `${e.code} ${e.errno} ${e.message}`;
      if (/1141|no such grant/i.test(msg)) { /* had no database-wide rights */ } else if (/1133|3162|1396|doesn't exist|does not exist|unknown user/i.test(msg)) { log(`skip ${who}: ${e.message}`); continue; } else throw e;
    }
    for (const { t } of tables) {
      const rights = APPEND_ONLY.includes(t) ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE, DELETE';
      try { await conn.query(`REVOKE ALL PRIVILEGES ON ${db}.${ident(t)} FROM ${who}`); } catch (_) { /* no table grant yet */ }
      try {
        await conn.query(`GRANT ${rights} ON ${db}.${ident(t)} TO ${who}`);
      } catch (e) {
        if (/1410|1133|3162/.test(`${e.errno}`)) { log(`skip ${who}: ${e.message}`); break; }
        throw e;
      }
    }
    done.push(host);
    log(`${who}: ${tables.length} tables, append-only: ${APPEND_ONLY.filter((x) => tables.some((r) => r.t === x)).join(', ')}`);
  }
  return { tables: tables.length, append_only: APPEND_ONLY, hosts: done };
}

module.exports = { applyGrants, APPEND_ONLY };
