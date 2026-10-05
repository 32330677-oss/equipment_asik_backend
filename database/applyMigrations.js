// database/applyMigrations.js — applies database/migrations/NNN_*.sql in name order, once each (shared by migrate, initDb and tests).
const fs = require('fs');
const path = require('path');

async function applyMigrations(conn, log = () => {}) {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  const [done] = await conn.query('SELECT filename FROM schema_migrations');
  const applied = new Set(done.map((r) => r.filename));
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    log(`Applying ${f} ...`);
    await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [f]);
    count += 1;
  }
  return count;
}

module.exports = { applyMigrations };
