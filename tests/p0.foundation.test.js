const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

before(h.resetDatabase);
after(h.closePool);

test('schema + migrations: 30 tables, idempotent', async () => {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  await conn.query(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, '../database/seed.sql'), 'utf8'));
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
  assert.strictEqual(Number(n), 30);
  const [[{ s }]] = await conn.query('SELECT COUNT(*) AS s FROM settings');
  assert.ok(Number(s) >= 11);
  const [[{ t }]] = await conn.query('SELECT COUNT(*) AS t FROM eq_types');
  assert.strictEqual(Number(t), 13);
  await conn.end();
});

test('health ok', async () => {
  const r = await h.api().get('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.db, 'ok');
});

test('unknown route -> 404 JSON', async () => {
  const r = await h.api().get('/api/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'NOT_FOUND');
});

test('businessDate uses Asia/Beirut, not UTC', () => {
  const bd = require('../utils/businessDate');
  // 2026-10-02 22:30 UTC = 2026-10-03 01:30 in Beirut (UTC+3)
  assert.strictEqual(bd.businessToday(new Date(Date.UTC(2026, 9, 2, 22, 30))), '2026-10-03');
  assert.strictEqual(bd.addDays('2026-02-28', 1), '2026-03-01');
  assert.strictEqual(bd.daysInMonth('2026-02'), 28);
  assert.strictEqual(bd.daysBetweenInclusive('2026-10-10', '2026-10-31'), 22);
  assert.strictEqual(bd.dayOfWeek('2026-10-03'), 6);
});

test('ranges overlap inclusive with open ends', () => {
  const { rangesOverlap } = require('../utils/ranges');
  assert.ok(rangesOverlap('2026-01-01', '2026-01-31', '2026-01-31', null));
  assert.ok(!rangesOverlap('2026-01-01', '2026-01-30', '2026-01-31', null));
  assert.ok(rangesOverlap('2026-01-01', null, '2030-01-01', '2030-01-02'));
});

test('dateTime parsing and minutes', () => {
  const d = require('../utils/dateTime');
  assert.strictEqual(d.toMySqlDateTime('2026-10-03 07:02'), '2026-10-03 07:02:00');
  assert.strictEqual(d.toMySqlDateTime('2026-02-30 07:02'), null);
  assert.strictEqual(d.diffMinutes('2026-10-03 18:00', '2026-10-04 04:00'), 600);
  assert.strictEqual(d.addMinutes('2026-10-03 23:50:00', 15), '2026-10-04 00:05:00');
});

test('money helpers', () => {
  const m = require('../utils/money');
  assert.strictEqual(m.toCents('1.10'), 110);
  assert.strictEqual(m.toCents(4612.9032), 461290);
  assert.strictEqual(m.formatMoney(146000, 'USD'), 'USD 1,460.00');
  assert.strictEqual(m.formatMoney(146000049, 'SYP'), 'SYP 1,460,000');
});
