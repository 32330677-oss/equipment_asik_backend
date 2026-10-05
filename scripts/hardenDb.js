// scripts/hardenDb.js — one-time hardening of the MySQL rights (run with the MySQL root / admin account).
//   DB_ROOT_USER=root DB_ROOT_PASSWORD=... DB_MIGRATE_USER=equipment_asik_migrator DB_MIGRATE_PASSWORD=... npm run harden-db
// 1. creates the migration user (all rights on DB_NAME only, WITH GRANT OPTION) used by `npm run migrate`;
// 2. gives the app user DB_USER table rights only: SELECT/INSERT/UPDATE/DELETE, and SELECT/INSERT only on the
//    append-only tables (audit log, invoice numbers, cancellations, correction events, file versions).
// After it, keep DB_MIGRATE_USER / DB_MIGRATE_PASSWORD in .env: migrate re-applies the rights to new tables.
const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { applyGrants } = require('../database/grants');

async function main() {
  const root = process.env.DB_ROOT_USER;
  const mUser = process.env.DB_MIGRATE_USER;
  const mPass = process.env.DB_MIGRATE_PASSWORD;
  if (!root) throw new Error('set DB_ROOT_USER / DB_ROOT_PASSWORD (a MySQL account that can create users)');
  if (!mUser || !mPass) throw new Error('set DB_MIGRATE_USER / DB_MIGRATE_PASSWORD (the account that will run migrations)');
  if (mUser === env.db.user) throw new Error('DB_MIGRATE_USER must differ from DB_USER');
  if (!/^[A-Za-z0-9_]+$/.test(env.db.database) || !/^[A-Za-z0-9_.-]+$/.test(mUser)) throw new Error('unsafe name');
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: root, password: process.env.DB_ROOT_PASSWORD || '',
    multipleStatements: false, ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  for (const host of ['localhost', '%']) {
    await conn.query(`CREATE USER IF NOT EXISTS '${mUser}'@'${host}' IDENTIFIED BY ?`, [mPass]);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${env.db.database}\`.* TO '${mUser}'@'${host}' WITH GRANT OPTION`);
  }
  console.log(`Migration user ${mUser} ready (rights on ${env.db.database} only).`);
  const r = await applyGrants(conn, { database: env.db.database, appUser: env.db.user, log: console.log });
  console.log(`App user ${env.db.user}: rights set on ${r.tables} tables (${r.hosts.join(', ') || 'no host found'}).`);
  await conn.end();
}

main().catch((e) => { console.error('harden-db failed:', e.message); process.exit(1); });
