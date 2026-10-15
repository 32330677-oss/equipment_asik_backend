// routes/integrationRoutes.js — /api/integration/* : READ-ONLY server-to-server reads for Team Flow.
//   GET /api/integration/sites                               every site (Active first)
//   GET /api/integration/equipment-types                     every equipment type
//   GET /api/integration/daily-plant?date=YYYY-MM-DD&site_ids=8,9
//        machines per type for the day: working / breakdown / standby / pending / absent / holiday
// Auth: Authorization: Bearer <INTEGRATION_TOKEN> (middleware/integrationAuth). Rate limited.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const integrationAuth = require('../middleware/integrationAuth');
const AppError = require('../utils/AppError');
const { isValidDateOnly, businessToday } = require('../utils/businessDate');
const svc = require('../services/equipment/eqIntegrationService');

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ status: 'error', code: 'RATE_LIMITED', message: 'Too many integration requests.' }),
}));
router.use(integrationAuth);

router.get('/sites', async (req, res) => {
  res.json({ status: 'success', data: await svc.listSites() });
});

router.get('/equipment-types', async (req, res) => {
  res.json({ status: 'success', data: await svc.listTypes() });
});

router.get('/daily-plant', async (req, res) => {
  const date = String(req.query.date || '');
  if (!isValidDateOnly(date)) throw AppError.validation({ date: 'Use YYYY-MM-DD.' });
  if (date > businessToday()) throw AppError.validation({ date: 'The date cannot be in the future.' });
  const raw = String(req.query.site_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const siteIds = [...new Set(raw.map(Number))];
  if (!siteIds.length || siteIds.length > 200 || siteIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw AppError.validation({ site_ids: 'Give 1 to 200 site ids, comma separated.' });
  }
  res.json({ status: 'success', data: await svc.dailyPlantSummary({ date, siteIds }) });
});

module.exports = router;
