// Daily Equipment Report for an external party (sub-contractor / client): GET /api/equipment/reports/client-daily.pdf
// Query: date (default today, not in the future), site_ids (comma list; empty = every active site), shift Day|Night|All,
// lang en|ar, to, issued_by, issued_title, notes (JSON [{label, value}]). Read only: nothing is saved.
'use strict';

const { pool } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate } = require('../../utils/validate');
const { businessToday } = require('../../utils/businessDate');
const { canViewSite, supervisorSitesOn } = require('../../services/siteAccess');
const R = require('../../services/equipment/eqClientReport');

const MAX_NOTES = 20;

/** notes = JSON text of [{label, value}] -> clean list (or a validation error). */
function parseNotes(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { throw AppError.validation({ notes: 'must be a JSON list of {label, value}' }); }
  if (!Array.isArray(list)) throw AppError.validation({ notes: 'must be a JSON list of {label, value}' });
  if (list.length > MAX_NOTES) throw AppError.validation({ notes: `at most ${MAX_NOTES} lines` });
  return list.map((n, i) => {
    if (!n || typeof n !== 'object') throw AppError.validation({ notes: `line ${i + 1} must be {label, value}` });
    const label = String(n.label ?? '').trim(); const value = String(n.value ?? '').trim();
    if (label.length > 80) throw AppError.validation({ notes: `line ${i + 1}: label is longer than 80 characters` });
    if (value.length > 500) throw AppError.validation({ notes: `line ${i + 1}: value is longer than 500 characters` });
    return { label, value };
  }).filter((n) => n.label || n.value);
}

function parseSiteIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (parts.length > 200) throw AppError.validation({ site_ids: 'at most 200 sites' });
  return [...new Set(parts.map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1) throw AppError.validation({ site_ids: 'must be a comma list of site ids' });
    return n;
  }))];
}

exports.clientDailyPdf = async (req, res) => {
  const today = businessToday();
  const q = validate(req.query, {
    date: v.date({ default: today }), shift: v.enumOf(['Day', 'Night', 'All'], { default: 'All' }), lang: v.enumOf(['en', 'ar'], { default: 'en' }),
    to: v.string({ max: 150 }), issued_by: v.string({ max: 120 }), issued_title: v.string({ max: 120 }),
    site_ids: v.any(), notes: v.any(),
  });
  if (q.date > today) throw AppError.validation({ date: 'cannot be in the future' });
  const notes = parseNotes(q.notes);
  let siteIds = parseSiteIds(q.site_ids);
  const shifts = q.shift === 'All' ? ['Day', 'Night'] : [q.shift];

  if (req.user.role === 'Supervisor') {
    // a supervisor reports only on the sites/shifts he is in charge of on that date
    if (!siteIds.length) {
      const mine = await supervisorSitesOn(req.user.user_id, q.date);
      siteIds = [...new Set(mine.filter((r) => shifts.includes(r.shift_type)).map((r) => r.site_id))];
      if (!siteIds.length) throw AppError.forbidden('SITE_FORBIDDEN', `You are not the supervisor of any site for this shift on ${q.date}.`);
    }
    for (const id of siteIds) {
      for (const sh of shifts) {
        if (!(await canViewSite(req.user, id, sh, q.date))) {
          throw AppError.forbidden('SITE_FORBIDDEN', `You are not the supervisor of site #${id} (${sh} shift) on ${q.date}: choose your own site and shift.`);
        }
      }
    }
  }

  const data = await R.loadData(pool, { date: q.date, siteIds, shift: q.shift });
  if (siteIds.length && data.sites.length !== siteIds.length) throw AppError.notFound('Site');
  const out = await R.renderPdf(pool, data, {
    lang: q.lang, date: q.date, shift: q.shift, to: q.to || '', issuedBy: q.issued_by || '', issuedTitle: q.issued_title || '', notes,
  }, req.user);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${out.fileName}"`);
  res.send(out.buffer);
};
