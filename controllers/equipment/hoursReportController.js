// GET /api/equipment/reports/hours  — hours since the start of the project per machine, grouped by vendor (read only).
// Query: vendor_id, site_id (optional), format = json | pdf | xlsx.
'use strict';

const { pool } = require('../../config/db');
const { v, validate } = require('../../utils/validate');
const H = require('../../services/equipment/eqHoursReport');

exports.hours = async (req, res) => {
  const q = validate(req.query, { vendor_id: v.id(), site_id: v.id(), format: v.enumOf(['json', 'xlsx', 'pdf'], { default: 'json' }) });
  const data = await H.hoursReport(pool, { vendor_id: q.vendor_id || null, site_id: q.site_id || null });
  if (q.format === 'json') return res.json({ status: 'success', data });
  const name = `equipment-hours-since-start-${data.generated_on}`;
  if (q.format === 'xlsx') {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(await H.hoursReportXlsx(data));
  }
  let siteLabel = null;
  if (q.site_id) { const [[s]] = await pool.query('SELECT site_code, site_name FROM sites WHERE site_id = ?', [q.site_id]); if (s) siteLabel = `${s.site_code} - ${s.site_name}`; }
  const buf = await H.hoursReportPdf(data, { siteLabel });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${name}.pdf"`);
  return res.send(buf);
};
