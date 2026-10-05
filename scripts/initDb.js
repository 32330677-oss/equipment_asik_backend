// scripts/initDb.js — one-time local setup.
// Creates the database (if missing) and applies database/schema.sql + database/seed.sql.
// Optional: with DB_ROOT_USER / DB_ROOT_PASSWORD it also creates the app user DB_USER with rights
// ONLY on DB_NAME, so this project never touches any other database on the same MySQL server.
//
//   node scripts/initDb.js
const fs = require('fs');
const { applyMigrations } = require('../database/applyMigrations');
const path = require('path');
const mysql = require('mysql2/promise');
const { env } = require('../config/env');

function ident(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `\`${name}\``;
}

async function main() {
  const rootUser = process.env.DB_ROOT_USER;
  const admin = await mysql.createConnection({
    host: env.db.host, port: env.db.port,
    user: rootUser || env.db.user,
    password: rootUser ? (process.env.DB_ROOT_PASSWORD || '') : env.db.password,
    multipleStatements: true,
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  const db = ident(env.db.database);
  await admin.query(`CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`Database ${env.db.database} ready.`);

  if (rootUser && env.db.user !== rootUser) {
    const u = env.db.user.replace(/'/g, '');
    await admin.query(`CREATE USER IF NOT EXISTS '${u}'@'localhost' IDENTIFIED BY ?`, [env.db.password]);
    await admin.query(`CREATE USER IF NOT EXISTS '${u}'@'%' IDENTIFIED BY ?`, [env.db.password]);
    for (const host of ['localhost', '%']) {
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON ${db}.* TO '${u}'@'${host}'`);
    }
    console.log(`User ${u} has rights on ${env.db.database} only.`);
  }

  await admin.query(`USE ${db}`);
  for (const file of ['schema.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8');
    await admin.query(sql);
    console.log(`Applied database/${file}`);
  }
  const applied = await applyMigrations(admin, console.log);
  if (applied) console.log(`${applied} migration(s) applied.`);
  const [[{ n }]] = await admin.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?", [env.db.database]);
  console.log(`Done: ${n} tables in ${env.db.database}. Next: npm run create-admin`);
  await admin.end();
}

main().catch((e) => { console.error('initDb failed:', e.message); process.exit(1); });
