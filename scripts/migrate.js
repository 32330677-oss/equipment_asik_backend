// scripts/migrate.js — applies database/migrations/NNN_*.sql in name order, once each.
const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { applyMigrations } = require('../database/applyMigrations');

async function main() {
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
    database: env.db.database, multipleStatements: true, ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  const count = await applyMigrations(conn, console.log);
  console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
  await conn.end();
}

main().catch((e) => { console.error('migrate failed:', e.message); process.exit(1); });
