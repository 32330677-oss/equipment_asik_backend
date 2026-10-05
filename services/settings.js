// services/settings.js — cached key/value settings with typed getters and per-key validation.
const { pool } = require('../config/db');
const AppError = require('../utils/AppError');

// Every known key, its type and allowed values. Unknown keys cannot be written.
const DEFINITIONS = {
  eq_payroll_requires_paper_match: { type: 'bool', description: 'Payroll includes only rows whose paper status is Matched' },
  eq_paper_tolerance_minutes: { type: 'int', min: 0, max: 120, description: 'Max difference paper vs electronic (minutes) to allow Matched' },
  eq_meter_tolerance_pct: { type: 'int', min: 1, max: 100, description: 'Hour-meter vs working hours difference (%) that raises meter_mismatch' },
  eq_long_session_review_hours: { type: 'int', min: 4, max: 48, description: 'Session longer than this raises long_session / forgotten check-out' },
  eq_default_currency: { type: 'enum', values: ['USD', 'SYP', 'EUR'], description: 'Default currency for new vendor contracts' },
  eq_timesheet_blank_rows: { type: 'int', min: 0, max: 20, description: 'Empty rows printed on the monthly sheet' },
  eq_live_refresh_seconds: { type: 'int', min: 15, max: 600, description: 'Live board refresh interval' },
  week_start_day: { type: 'int', min: 0, max: 6, description: 'First day of the attendance week (0=Sunday ... 6=Saturday)' },
  week_gate_enabled: { type: 'bool', description: 'Block submitting a day while the previous week has Draft rows' },
  company_name: { type: 'string', max: 255, description: 'Company name printed on documents' },
  app_time_zone: { type: 'string', max: 64, description: 'Business time zone (APP_TIME_ZONE env overrides it)' },
  payroll_finalize_admin_only: { type: 'bool', description: 'Only Admin may finalize / mark paid payroll batches' },
  eq_weekly_off_day: { type: 'int', min: 0, max: 6, description: 'Weekly day off for monthly machines (0=Sunday ... 5=Friday ... 6=Saturday)' },
  eq_finalize_requires_scan: { type: 'bool', description: 'A batch can be finalized only when the signed monthly sheets are uploaded for all its rows' },
  eq_fuel_diff_allow_negative: { type: 'bool', description: 'Fuel price difference: deduct from the vendor when the official price falls below the base price' },
};

const DEFAULTS = {
  eq_payroll_requires_paper_match: 'false', eq_paper_tolerance_minutes: '10', eq_meter_tolerance_pct: '15',
  eq_long_session_review_hours: '16', eq_default_currency: 'USD', eq_timesheet_blank_rows: '6',
  eq_live_refresh_seconds: '60', week_start_day: '6', week_gate_enabled: 'true',
  company_name: 'ASIK ENGINEERING CONSTRUCTION', app_time_zone: 'Asia/Beirut', payroll_finalize_admin_only: 'true',
  eq_finalize_requires_scan: 'true', eq_fuel_diff_allow_negative: 'true', eq_weekly_off_day: '5',
};

let cache = null;

async function load(executor = pool) {
  const [rows] = await executor.query('SELECT setting_key, setting_value FROM settings');
  cache = { ...DEFAULTS };
  for (const r of rows) cache[r.setting_key] = r.setting_value;
  return cache;
}

function invalidate() { cache = null; }

async function getString(key) {
  if (!cache) await load();
  return cache[key] !== undefined ? String(cache[key]) : DEFAULTS[key];
}
async function getInt(key) {
  const n = parseInt(await getString(key), 10);
  return Number.isFinite(n) ? n : parseInt(DEFAULTS[key], 10);
}
async function getBool(key) {
  return ['true', '1', 'yes', 'on'].includes(String(await getString(key)).toLowerCase());
}

function normalizeValue(key, value) {
  const def = DEFINITIONS[key];
  if (!def) throw AppError.notFound('Setting');
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (def.type === 'bool') {
    if (['true', 'false'].includes(raw.toLowerCase())) return raw.toLowerCase();
    throw AppError.validation({ value: 'must be true or false' });
  }
  if (def.type === 'int') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < def.min || n > def.max) throw AppError.validation({ value: `must be a whole number between ${def.min} and ${def.max}` });
    return String(n);
  }
  if (def.type === 'enum') {
    if (!def.values.includes(raw)) throw AppError.validation({ value: `must be one of ${def.values.join(', ')}` });
    return raw;
  }
  if (!raw || raw.length > def.max) throw AppError.validation({ value: `must be 1-${def.max} characters` });
  return raw;
}

async function list() {
  await load();
  return Object.entries(DEFINITIONS).map(([key, def]) => ({
    setting_key: key, setting_value: cache[key] ?? DEFAULTS[key], type: def.type,
    description: def.description, ...(def.values ? { values: def.values } : {}),
    ...(def.min !== undefined ? { min: def.min, max: def.max } : {}),
  }));
}

module.exports = { DEFINITIONS, DEFAULTS, load, invalidate, getString, getInt, getBool, normalizeValue, list };
