// Daily Equipment Timesheet (Excel): GET /api/equipment/reports/daily-timesheet.xlsx
// Query: date (default today; up to 31 days ahead, to print a blank sheet before the day), shift Day|Night|All (default All),
//        site_id (optional: one site; default = every site the user may see).
// Admin / Accountant: every site. Supervisor: only the sites/shifts he supervises on that date (or today).
// One worksheet: Site -> Shift -> Vendor -> machines; machines with nothing recorded keep empty cells for the pen.
// Read only: nothing is saved.
'use strict';

const { pool } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate } = require('../../utils/validate');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');
const { supervisorSitesOn } = require('../../services/siteAccess');
const settings = require('../../services/settings');
const { LOGO } = require('../../services/pdfKit');
const T = require('../../services/equipment/eqDailyTimesheet');

const MAX_DAYS_AHEAD = 31;
const SHIFT_LABEL = { All: 'Day & Night', Day: 'Day shift', Night: 'Night shift' };

exports.dailyTimesheetXlsx = async (req, res) => {
  const today = businessToday();
  const q = validate(req.query, {
    date: v.date({ default: today }),
    shift: v.enumOf(['Day', 'Night', 'All'], { default: 'All' }),
    site_id: v.id(),
  });
  if (q.date > addDays(today, MAX_DAYS_AHEAD)) throw AppError.validation({ date: `can be at most ${MAX_DAYS_AHEAD} days ahead` });

  let supervisorPairs = null;
  if (req.user.role === 'Supervisor') {
    // the sites/shifts he supervises on that date, plus those he supervises today (same rule as reading a site)
    const map = new Map();
    for (const d of [q.date, today]) {
      for (const s of await supervisorSitesOn(req.user.user_id, d)) map.set(`${s.site_id}|${s.shift_type}`, { site_id: s.site_id, shift_type: s.shift_type });
    }
    supervisorPairs = [...map.values()];
    const shifts = q.shift === 'All' ? ['Day', 'Night'] : [q.shift];
    const usable = supervisorPairs.filter((p) => shifts.includes(p.shift_type) && (!q.site_id || p.site_id === q.site_id));
    if (!usable.length) {
      throw AppError.forbidden('SITE_FORBIDDEN', q.site_id
        ? `You are not the supervisor of this site${q.shift === 'All' ? '' : ` (${q.shift} shift)`} on ${q.date}.`
        : `You are not the supervisor of any site${q.shift === 'All' ? '' : ` for the ${q.shift} shift`} on ${q.date}.`);
    }
  }

  let siteCode = null;
  if (q.site_id) {
    const [[site]] = await pool.execute('SELECT site_code FROM sites WHERE site_id = ?', [q.site_id]);
    if (!site) throw AppError.notFound('Site');
    siteCode = site.site_code;
  }

  const data = await T.loadData(pool, { date: q.date, shift: q.shift, siteIds: q.site_id ? [q.site_id] : null, supervisorPairs });
  if (!data.machineCount) {
    throw AppError.badRequest('NO_MACHINES', `No machines are deployed${siteCode ? ` at ${siteCode}` : ''}${q.shift === 'All' ? '' : ` on the ${q.shift} shift`} on ${q.date}. Choose another day or shift.`);
  }

  const codes = data.sites.map((s) => s.site_code);
  const isSup = req.user.role === 'Supervisor';
  const fileName = `Timesheet-${q.date}-${q.shift === 'All' ? 'All-shifts' : `${q.shift}-shift`}${siteCode ? `-${siteCode}` : ''}.xlsx`.replace(/[^A-Za-z0-9._-]/g, '_');
  const out = await T.renderWorkbook(data, {
    company: (await settings.getString('company_name')) || 'Equipment Flow',
    logoPath: LOGO,
    shiftLabel: SHIFT_LABEL[q.shift],
    personLabel: isSup ? 'Supervisor' : 'Prepared by',
    personName: req.user.full_name || '',
    sitesText: codes.length > 6 ? `${codes.length} sites` : codes.join(', '),
    printedAt: businessNow(),
    printedBy: req.user.full_name || '',
    fileName,
  });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.set('Cache-Control', 'no-store');
  res.send(out.buffer);
};
