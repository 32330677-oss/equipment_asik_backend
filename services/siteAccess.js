// services/siteAccess.js — who supervises which site/shift on a given date (table site_supervisors).
//
// Historical VISIBILITY is not historical EDITING:
//  - view: a supervisor sees a (site, shift, date) when they supervised it on that date (forever, read-only).
//  - edit: a supervisor changes it only while they still supervise that site/shift today AND supervised it on that date.
//    A supervisor who moved away keeps the history read-only; the current supervisor may ask the office
//    (Admin or Accountant) to change a historical row through a change request.
const { pool } = require('../config/db');
const AppError = require('../utils/AppError');
const { activeOnSql } = require('../utils/ranges');
const { businessToday } = require('../utils/businessDate');

async function isSupervisorOf(userId, siteId, shiftType, date, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT 1 FROM site_supervisors ss
     WHERE ss.user_id = ? AND ss.site_id = ? AND ss.shift_type = ? AND ${activeOnSql('ss', 'from_date', 'to_date')}
     LIMIT 1`,
    [userId, siteId, shiftType, date, date]
  );
  return rows.length > 0;
}

/** The supervisor still in charge of (site, shift) today. */
async function isCurrentSupervisor(userId, siteId, shiftType, executor = pool) {
  return isSupervisorOf(userId, siteId, shiftType, businessToday(), executor);
}

/**
 * Read access. Admin and Accountant: always. Supervisor: when supervising (site, shift) on that date (their own history,
 * kept after they move away), or when supervising it today (the current supervisor sees the site's history, to ask
 * the office for a change).
 */
async function canViewSite(user, siteId, shiftType, date, executor = pool) {
  if (user.role === 'Admin' || user.role === 'Accountant') return true;
  if (user.role !== 'Supervisor') return false;
  if (await isSupervisorOf(user.user_id, siteId, shiftType, date, executor)) return true;
  return isCurrentSupervisor(user.user_id, siteId, shiftType, executor);
}

/** Write access for recording. Admin: always. Supervisor: on that date AND still in charge of the site/shift today. */
async function canActOnSite(user, siteId, shiftType, date, executor = pool) {
  if (user.role === 'Admin') return true;
  if (user.role !== 'Supervisor') return false;
  if (!(await isSupervisorOf(user.user_id, siteId, shiftType, date, executor))) return false;
  return isCurrentSupervisor(user.user_id, siteId, shiftType, executor);
}

/** Why a supervisor may not edit: 'not_supervisor' (never there that day) or 'moved_away' / 'before_assignment'. */
async function editDenial(user, siteId, shiftType, date, executor = pool) {
  if (user.role === 'Admin') return null;
  if (user.role !== 'Supervisor') return 'role';
  const then = await isSupervisorOf(user.user_id, siteId, shiftType, date, executor);
  const now = await isCurrentSupervisor(user.user_id, siteId, shiftType, executor);
  if (then && now) return null;
  if (then && !now) return 'moved_away';
  if (!then && now) return 'before_assignment';
  return 'not_supervisor';
}

async function assertCanActOnSite(user, siteId, shiftType, date, executor = pool) {
  const why = await editDenial(user, siteId, shiftType, date, executor);
  if (!why) return;
  if (why === 'moved_away') {
    throw AppError.forbidden('SITE_HISTORY_READ_ONLY',
      `You no longer supervise this site/shift. Its history (${date}) stays visible to you but cannot be changed; the current supervisor or the office can correct it.`);
  }
  if (why === 'before_assignment') {
    throw AppError.forbidden('SITE_HISTORY_NEEDS_APPROVAL',
      `${date} is before your assignment to this site/shift. Send a change request: the Admin or the Accountant approves it.`);
  }
  throw AppError.forbidden('SITE_FORBIDDEN', `You are not the supervisor of this site/shift on ${date}.`);
}

async function assertCanViewSite(user, siteId, shiftType, date, executor = pool) {
  if (!(await canViewSite(user, siteId, shiftType, date, executor))) {
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

module.exports = {
  isSupervisorOf, isCurrentSupervisor, canViewSite, canActOnSite, editDenial, assertCanActOnSite, assertCanViewSite,
  supervisorSitesOn, supervisorSiteIdsEver,
};
