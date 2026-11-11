// Weekly Equipment Timesheet (Excel) — replaced the daily one (Nov 2026); the file keeps its first name.
//   GET /api/equipment/reports/weekly-timesheet.xlsx  ?date (any day of the week; default today; up to 31 days ahead,
//       to print a blank sheet before the week) &shift Day|Night|All (default All) &site_id (optional: one site)
//   GET /api/equipment/reports/weekly-timesheet/week  ?date  -> { from, to, off_date, label } (the week the app shows)
// One worksheet per vendor; one framed block per machine with a row per day (Saturday .. Thursday when the weekly
// off day is Friday; the off day only when the machine worked). Admin / Accountant: every site. Supervisor: only the
// sites/shifts he supervises during that week (or today). Read only: nothing is saved.
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
const SHIFT_LABEL = { All: '', Day: 'Day shift', Night: 'Night shift' };

async function offDay() {
  const n = await settings.getInt('eq_weekly_off_day');
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 5;
}

function dateParam(query) {
  const today = businessToday();
  const q = validate(query, {
    date: v.date({ default: today }),
    shift: v.enumOf(['Day', 'Night', 'All'], { default: 'All' }),
    site_id: v.id(),
  });
  if (q.date > addDays(today, MAX_DAYS_AHEAD)) throw AppError.validation({ date: `can be at most ${MAX_DAYS_AHEAD} days ahead` });
  return { q, today };
}

exports.week = async (req, res) => {
  const { q } = dateParam(req.query);
  const w = T.weekOf(q.date, await offDay());
  res.json({ status: 'success', data: { from: w.from, to: w.to, off_date: w.offDate, label: T.weekLabel(w) } });
};

exports.weeklyTimesheetXlsx = async (req, res) => {
  const { q, today } = dateParam(req.query);
  const off = await offDay();
  const week = T.weekOf(q.date, off);
  const shifts = q.shift === 'All' ? ['Day', 'Night'] : [q.shift];

  let supervisorPairs = null;
  if (req.user.role === 'Supervisor') {
    // the sites/shifts he supervises on any day of the week, plus those he supervises today (same rule as reading a site)
    const map = new Map();
    for (const d of [...week.days, today]) {
      for (const s of await supervisorSitesOn(req.user.user_id, d)) map.set(`${s.site_id}|${s.shift_type}`, { site_id: s.site_id, shift_type: s.shift_type });
    }
    supervisorPairs = [...map.values()];
    const usable = supervisorPairs.filter((p) => shifts.includes(p.shift_type) && (!q.site_id || p.site_id === q.site_id));
    if (!usable.length) {
      throw AppError.forbidden('SITE_FORBIDDEN', q.site_id
        ? `You are not the supervisor of this site${q.shift === 'All' ? '' : ` (${q.shift} shift)`} during the week of ${week.from}.`
        : `You are not the supervisor of any site${q.shift === 'All' ? '' : ` for the ${q.shift} shift`} during the week of ${week.from}.`);
    }
  }

  let siteCode = null;
  if (q.site_id) {
    const [[site]] = await pool.execute('SELECT site_code FROM sites WHERE site_id = ?', [q.site_id]);
    if (!site) throw AppError.notFound('Site');
    siteCode = site.site_code;
  }

  const data = await T.loadData(pool, { date: q.date, offDay: off, shift: q.shift, siteIds: q.site_id ? [q.site_id] : null, supervisorPairs });
  if (!data.machineCount) {
    throw AppError.badRequest('NO_MACHINES', `No machines are deployed${siteCode ? ` at ${siteCode}` : ''}${q.shift === 'All' ? '' : ` on the ${q.shift} shift`} during the week ${week.from} to ${week.to}. Choose another week or shift.`);
  }

  const fileName = `Weekly-Timesheet-${week.from}_to_${week.to}${q.shift === 'All' ? '' : `-${q.shift}`}${siteCode ? `-${siteCode}` : ''}.xlsx`.replace(/[^A-Za-z0-9._-]/g, '_');
  const out = await T.renderWorkbook(data, {
    company: (await settings.getString('company_name')) || 'Equipment Flow',
    logoPath: LOGO,
    shiftLabel: SHIFT_LABEL[q.shift],
    printedAt: businessNow(),
    printedBy: req.user.full_name || '',
    fileName,
  });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.set('Cache-Control', 'no-store');
  res.send(out.buffer);
};
