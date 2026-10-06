// services/equipment/eqTimesheetService.js — one paper sheet per machine x site x month; permanent row numbers.
const crypto = require('crypto');
const AppError = require('../../utils/AppError');
const { businessNow } = require('../../utils/businessDate');

async function getOrCreate(conn, equipmentId, siteId, month) {
  const [[m]] = await conn.execute('SELECT equipment_code FROM eq_equipment WHERE equipment_id = ?', [equipmentId]);
  const [[s]] = await conn.execute('SELECT site_code FROM sites WHERE site_id = ?', [siteId]);
  if (!m || !s) throw AppError.notFound('Machine or site');
  const code = `ETS-${month}-${m.equipment_code.replace(/-/g, '')}-${s.site_code}`;
  await conn.execute(
    `INSERT IGNORE INTO eq_timesheets (sheet_code, equipment_id, site_id, period_month, verify_token) VALUES (?, ?, ?, ?, ?)`,
    [code, equipmentId, siteId, month, crypto.randomBytes(8).toString('hex')]);
  const [[sheet]] = await conn.execute(
    'SELECT * FROM eq_timesheets WHERE equipment_id = ? AND site_id = ? AND period_month = ? FOR UPDATE', [equipmentId, siteId, month]);
  return sheet;
}

/** BR-25: next permanent row number of the sheet (caller holds the sheet row lock). */
async function allocateRow(conn, sheet) {
  if (sheet.status !== 'Open') {
    throw AppError.conflict('TIMESHEET_CLOSED', `The paper sheet ${sheet.sheet_code} is ${sheet.status}. An Admin must reopen it before adding rows.`);
  }
  const next = Number(sheet.last_row_no) + 1;
  await conn.execute('UPDATE eq_timesheets SET last_row_no = ? WHERE timesheet_id = ?', [next, sheet.timesheet_id]);
  return next;
}

/** Closed + every row Matched -> Reconciled; Reconciled with a non-matched row -> Closed. */
async function refreshStatus(conn, timesheetId, userId = null) {
  const [[sheet]] = await conn.execute('SELECT * FROM eq_timesheets WHERE timesheet_id = ? FOR UPDATE', [timesheetId]);
  if (!sheet || sheet.status === 'Open') return sheet;
  const [[c]] = await conn.execute(
    "SELECT COUNT(*) AS total, SUM(paper_status = 'Matched') AS matched FROM eq_attendance WHERE timesheet_id = ? AND status <> 'Cancelled'", [timesheetId]);
  const all = Number(c.total) > 0 && Number(c.matched) === Number(c.total);
  if (sheet.status === 'Closed' && all) {
    await conn.execute("UPDATE eq_timesheets SET status = 'Reconciled', reconciled_at = ?, reconciled_by_user_id = ? WHERE timesheet_id = ?", [businessNow(), userId, timesheetId]);
  } else if (sheet.status === 'Reconciled' && !all) {
    await conn.execute("UPDATE eq_timesheets SET status = 'Closed', reconciled_at = NULL, reconciled_by_user_id = NULL WHERE timesheet_id = ?", [timesheetId]);
  }
  const [[after]] = await conn.execute('SELECT * FROM eq_timesheets WHERE timesheet_id = ?', [timesheetId]);
  return after;
}

module.exports = { getOrCreate, allocateRow, refreshStatus };
