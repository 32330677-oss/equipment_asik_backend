// config/db.js — mysql2/promise pool + transaction helper.
// dateStrings: DATE/DATETIME come back as plain 'YYYY-MM-DD[ HH:mm:ss]' strings (business wall-clock,
// never shifted through a time zone). decimalNumbers is OFF on purpose: DECIMAL arrives as string and
// is converted explicitly where needed (money is handled in cents).
const mysql = require('mysql2/promise');
const { env } = require('./env');

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  charset: 'utf8mb4',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
});

/** Run fn(conn) inside a transaction; commits on success, rolls back on any error. */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    conn.release();
  }
}

async function ping() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

module.exports = { pool, withTransaction, ping };
