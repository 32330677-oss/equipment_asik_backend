// utils/validate.js — tiny declarative validator.
// Usage: const data = validate(req.body, { name: v.string({ required: true, max: 255 }), ... });
// Throws AppError VALIDATION_ERROR with { fields: { name: 'message' } }.
const AppError = require('./AppError');
const { isValidDateOnly } = require('./businessDate');
const { toMySqlDateTime } = require('./dateTime');

const SKIP = Symbol('skip');

function make(check) {
  return (opts = {}) => (value, field) => {
    if (value === undefined || value === null || value === '') {
      if (opts.required) throw new Error('is required');
      if (opts.default !== undefined) return opts.default;
      return value === undefined ? SKIP : null;
    }
    return check(value, opts, field);
  };
}

const v = {
  string: make((val, o) => {
    if (typeof val !== 'string' && typeof val !== 'number') throw new Error('must be text');
    const s = String(val).trim();
    if (o.required && !s) throw new Error('is required');
    if (o.min && s.length < o.min) throw new Error(`must be at least ${o.min} characters`);
    if (o.max && s.length > o.max) throw new Error(`must be at most ${o.max} characters`);
    if (o.pattern && !o.pattern.test(s)) throw new Error(o.patternMessage || 'has an invalid format');
    return s;
  }),
  int: make((val, o) => {
    const n = Number(val);
    if (!Number.isInteger(n)) throw new Error('must be a whole number');
    if (o.min !== undefined && n < o.min) throw new Error(`must be >= ${o.min}`);
    if (o.max !== undefined && n > o.max) throw new Error(`must be <= ${o.max}`);
    return n;
  }),
  id: (opts = {}) => v.int({ ...opts, min: 1 }),
  number: make((val, o) => {
    const n = Number(val);
    if (!Number.isFinite(n)) throw new Error('must be a number');
    if (o.min !== undefined && n < o.min) throw new Error(`must be >= ${o.min}`);
    if (o.max !== undefined && n > o.max) throw new Error(`must be <= ${o.max}`);
    if (o.decimals !== undefined) {
      const dec = (String(val).split('.')[1] || '').length;
      if (dec > o.decimals) throw new Error(`must have at most ${o.decimals} decimals`);
    }
    return n;
  }),
  bool: make((val) => {
    if (val === true || val === 'true' || val === 1 || val === '1') return true;
    if (val === false || val === 'false' || val === 0 || val === '0') return false;
    throw new Error('must be true or false');
  }),
  date: make((val) => {
    if (!isValidDateOnly(val)) throw new Error('must be a date YYYY-MM-DD');
    return String(val);
  }),
  datetime: make((val) => {
    const s = toMySqlDateTime(val);
    if (!s) throw new Error('must be a date-time YYYY-MM-DD HH:mm');
    return s;
  }),
  month: make((val) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(val))) throw new Error('must be a month YYYY-MM');
    return String(val);
  }),
  time: make((val) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(val));
    if (!m) throw new Error('must be a time HH:mm');
    return `${m[1]}:${m[2]}:${m[3] || '00'}`;
  }),
  enumOf: (values, opts = {}) => make((val) => {
    if (!values.includes(val)) throw new Error(`must be one of: ${values.join(', ')}`);
    return val;
  })(opts),
  currency: make((val) => {
    const s = String(val).toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw new Error('must be a 3-letter currency code');
    return s;
  }),
  ids: make((val) => {
    if (!Array.isArray(val) || !val.length) throw new Error('must be a non-empty list');
    if (val.length > 500) throw new Error('must contain at most 500 items');
    return val.map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n) || n < 1) throw new Error('must contain positive ids');
      return n;
    });
  }),
  any: make((val) => val),
};

function validate(input, schema) {
  const src = input || {};
  const out = {};
  const fields = {};
  for (const [key, rule] of Object.entries(schema)) {
    try {
      const value = rule(src[key], key);
      if (value !== SKIP) out[key] = value;
    } catch (e) {
      fields[key] = e.message;
    }
  }
  if (Object.keys(fields).length) throw AppError.validation(fields);
  return out;
}

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.page_size, 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseId(value, what = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw AppError.badRequest('VALIDATION_ERROR', `Invalid ${what}.`);
  return n;
}

module.exports = { v, validate, pageParams, parseId };
