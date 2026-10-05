const router = require('express').Router();
const c = require('../controllers/auditController');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');

router.get('/', requireAuth, requireRole('Admin'), c.list);

module.exports = router;
