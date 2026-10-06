// utils/businessDate.js — the ONE definition of the business date (default Asia/Damascus, Syria time, UTC+3 all year).
// Every "today" used by a business rule comes from here: never new Date().toISOString() (UTC)
// and never MySQL NOW()/CURDATE() (server time zone).
const { env } = require('../config/env');

let clockOverride = null; // tests only
function setClock(fn) { clockOverride = fn; }
function now() { return clockOverride ? clockOverride() : new Date(); }

function partsInZone(date, timeZone = env.timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** 'YYYY-MM-DD' in the business time zone. */
function businessToday(at = now()) {
  const v = partsInZone(at);
  return `${v.year}-${v.month}-${v.day}`;
}

/** 'YYYY-MM-DD HH:mm:ss' wall clock in the business time zone. */
function businessNow(at = now()) {
  const v = partsInZone(at);
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(n))).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Inclusive count of days between two dates. */
function daysBetweenInclusive(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

function monthOf(dateStr) { return String(dateStr).slice(0, 7); }

module.exports = {
  setClock, now, businessToday, businessNow, isValidDateOnly, addDays, dayOfWeek,
  daysInMonth, daysBetweenInclusive, monthOf,
};
