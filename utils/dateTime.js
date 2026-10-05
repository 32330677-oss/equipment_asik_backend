// utils/dateTime.js — wall-clock datetimes ('YYYY-MM-DD HH:mm[:ss]') without any time-zone shift.
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Normalize an input to 'YYYY-MM-DD HH:mm:ss' or return null when invalid. */
function toMySqlDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = WALL_RE.exec(String(value).trim().replace(/\.\d+Z?$/, '').replace(/Z$/, ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d
    || +h > 23 || +mi > 59 || +s > 59) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** Milliseconds of a wall-clock value on a fake UTC axis (only for differences). */
function wallMs(value) {
  const v = toMySqlDateTime(value);
  if (!v) return null;
  return Date.parse(v.replace(' ', 'T') + 'Z');
}

/** Whole minutes from a to b (b - a), rounded down. */
function diffMinutes(a, b) {
  const x = wallMs(a); const y = wallMs(b);
  if (x === null || y === null) return null;
  return Math.floor((y - x) / 60000);
}

function datePart(value) { return String(value).slice(0, 10); }
function timePart(value) { return String(value).slice(11, 16); }

function addMinutes(value, minutes) {
  const ms = wallMs(value);
  return new Date(ms + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { toMySqlDateTime, wallMs, diffMinutes, datePart, timePart, addMinutes };
