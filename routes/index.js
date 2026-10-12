// routes/index.js — mounts every router under /api
const router = require('express').Router();

router.use('/health', require('./healthRoutes'));
router.use('/auth', require('./authRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/', require('./siteRoutes'));           // /sites, /site-supervisors
router.use('/settings', require('./settingsRoutes'));
router.use('/audit', require('./auditRoutes'));
router.use('/equipment', require('./equipmentRoutes'));
router.use('/help', require('./helpRoutes'));             // Help Center (assistant/guide.md)

module.exports = router;
