// tests/helpers.js — test harness (local MySQL/MariaDB only; DB name must end with _test).
process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.TEST_DB_PORT || '3306';
process.env.DB_USER = process.env.TEST_DB_USER || 'eqtest';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'eqtestpass';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'equipment_asik_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.BCRYPT_COST = '4';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';
process.env.FILE_STORAGE_DRIVER = 'local';
process.env.FILE_STORAGE_DIR = require('path').join(require('os').tmpdir(), `eqflow-test-files-${process.pid}`);

if (!process.env.DB_NAME.endsWith('_test')) throw new Error('Refusing to run tests on a database whose name does not end with _test');

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');

// Freeze the business clock: 2026-10-20 12:00 Asia/Beirut, so date rules are stable whenever tests run.
const FIXED_NOW = new Date(Date.UTC(2026, 9, 20, 9, 0, 0));
require('../utils/businessDate').setClock(() => FIXED_NOW);
const PASSWORD = 'Passw0rd123';

async function resetDatabase() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, multipleStatements: true,
  });
  const db = process.env.DB_NAME;
  await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; USE \`${db}\`;`);
  await conn.query(fs.readFileSync(path.join(ROOT, 'database/schema.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(ROOT, 'database/seed.sql'), 'utf8'));
  await require('../database/applyMigrations').applyMigrations(conn);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  await conn.query(
    `INSERT INTO users (user_id, username, full_name, password_hash, role, must_change_password) VALUES
     (1, 'admin', 'Admin One', ?, 'Admin', 0),
     (2, 'accountant', 'Accountant One', ?, 'Accountant', 0),
     (3, 'sup8', 'Supervisor Eight', ?, 'Supervisor', 0),
     (4, 'sup9', 'Supervisor Nine', ?, 'Supervisor', 0)`, [hash, hash, hash, hash]);
  await conn.query(
    `INSERT INTO sites (site_id, site_code, site_name, has_night_shift, day_shift_start, night_shift_start) VALUES
     (8, 'S08', 'Tower B', 0, '07:00:00', NULL),
     (9, 'S09', 'Bridge', 1, '07:00:00', '19:00:00'),
     (10, 'S10', 'Warehouse', 0, NULL, NULL)`);
  await conn.query(
    `INSERT INTO site_supervisors (site_id, shift_type, user_id, from_date, to_date) VALUES
     (8, 'Day', 3, '2026-01-01', NULL),
     (9, 'Day', 4, '2026-01-01', NULL),
     (9, 'Night', 4, '2026-01-01', NULL)`);
  await conn.end();
  require('../services/settings').invalidate();
}

let app;
function api() {
  if (!app) app = require('../app').buildApp();
  return request(app);
}

function token(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const T = { admin: () => token(1), accountant: () => token(2), sup8: () => token(3), sup9: () => token(4) };
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function closePool() { await require('../config/db').pool.end(); }

async function query(sql, params = []) {
  const [rows] = await require('../config/db').pool.query(sql, params);
  return rows;
}

module.exports = { resetDatabase, api, token, T, auth, closePool, query, PASSWORD };
