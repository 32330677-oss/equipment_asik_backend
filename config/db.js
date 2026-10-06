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

/** UTC offset of the business time zone now, e.g. '+03:00' (Syria). */
function businessOffset() {
  const d = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: env.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const min = Math.round((wall - d.getTime()) / 60000);
  const sign = min < 0 ? '-' : '+'; const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// Every connection uses the business time zone, so automatic timestamps (created_at, audit log) are Syria time
// whatever the time zone of the MySQL server.
if (pool.pool && pool.pool.on) pool.pool.on('connection', (c) => { c.query(`SET time_zone = '${businessOffset()}'`); });

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
