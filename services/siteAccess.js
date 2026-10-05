// services/siteAccess.js — who supervises which site/shift on a given date (table site_supervisors).
const { pool } = require('../config/db');
const AppError = require('../utils/AppError');
const { activeOnSql } = require('../utils/ranges');

async function isSupervisorOf(userId, siteId, shiftType, date, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT 1 FROM site_supervisors ss
     WHERE ss.user_id = ? AND ss.site_id = ? AND ss.shift_type = ? AND ${activeOnSql('ss', 'from_date', 'to_date')}
     LIMIT 1`,
    [userId, siteId, shiftType, date, date]
  );
  return rows.length > 0;
}

/** Admin: always. Supervisor: only when supervising (site, shift) on that date. Others: never. */
async function canActOnSite(user, siteId, shiftType, date, executor = pool) {
  if (user.role === 'Admin') return true;
  if (user.role !== 'Supervisor') return false;
  return isSupervisorOf(user.user_id, siteId, shiftType, date, executor);
}

async function assertCanActOnSite(user, siteId, shiftType, date, executor = pool) {
  if (!(await canActOnSite(user, siteId, shiftType, date, executor))) {
    throw AppError.forbidden('SITE_FORBIDDEN', `You are not the supervisor of this site/shift on ${date}.`);
  }
}

/** Sites/shifts a supervisor is in charge of on a date. */
async function supervisorSitesOn(userId, date, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT s.site_id, s.site_code, s.site_name, ss.shift_type, s.status
     FROM site_supervisors ss JOIN sites s ON s.site_id = ss.site_id
     WHERE ss.user_id = ? AND ${activeOnSql('ss', 'from_date', 'to_date')}
     ORDER BY s.site_code, ss.shift_type`,
    [userId, date, date]
  );
  return rows;
}

/** Every site id the supervisor has EVER supervised (for read-only lists). */
async function supervisorSiteIdsEver(userId, executor = pool) {
  const [rows] = await executor.execute('SELECT DISTINCT site_id FROM site_supervisors WHERE user_id = ?', [userId]);
  return rows.map((r) => r.site_id);
}

module.exports = { isSupervisorOf, canActOnSite, assertCanActOnSite, supervisorSitesOn, supervisorSiteIdsEver };
