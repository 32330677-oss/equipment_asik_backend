// scripts/createAdmin.js — creates an Admin with a random temporary password (shown once).
//   npm run create-admin -- --username admin --name "System Admin"
const { pool } = require('../config/db');
const passwords = require('../services/passwords');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const username = arg('username', 'admin');
  const fullName = arg('name', 'System Admin');
  const [exists] = await pool.execute('SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  if (exists.length) { console.error(`User "${username}" already exists.`); process.exit(1); }
  const temp = passwords.temporary();
  const [r] = await pool.execute(
    "INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'Admin', 1)",
    [username, fullName, await passwords.hash(temp)]);
  console.log('\nAdmin created');
  console.log(`  user_id : ${r.insertId}`);
  console.log(`  username: ${username}`);
  console.log(`  password: ${temp}   (temporary — you must change it at first login)\n`);
  await pool.end();
}

main().catch((e) => { console.error('createAdmin failed:', e.message); process.exit(1); });
