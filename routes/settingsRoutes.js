const router = require('express').Router();
const c = require('../controllers/settingsController');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');

router.get('/', requireAuth, requireRole('Admin', 'Accountant'), c.list);
router.put('/:key', requireAuth, requireRole('Admin'), c.update);

module.exports = router;
