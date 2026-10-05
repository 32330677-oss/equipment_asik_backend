// scripts/migrate.js — applies database/migrations/NNN_*.sql in name order, once each.
// With DB_MIGRATE_USER / DB_MIGRATE_PASSWORD (see scripts/hardenDb.js) the migrations run with that account and the
// app user's table rights are re-applied afterwards (new tables included). Without them: the app user, as before.
const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { applyMigrations } = require('../database/applyMigrations');
const { applyGrants } = require('../database/grants');

async function main() {
  const mUser = process.env.DB_MIGRATE_USER;
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: mUser || env.db.user, password: mUser ? (process.env.DB_MIGRATE_PASSWORD || '') : env.db.password,
    database: env.db.database, multipleStatements: true, ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  const count = await applyMigrations(conn, console.log);
  console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
  if (mUser && mUser !== env.db.user) {
    const r = await applyGrants(conn, { database: env.db.database, appUser: env.db.user });
    console.log(`App user rights refreshed on ${r.tables} tables (append-only: ${r.append_only.join(', ')}).`);
  }
  await conn.end();
}

main().catch((e) => { console.error('migrate failed:', e.message); process.exit(1); });
