const router = require('express').Router();
const c = require('../controllers/userController');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');

router.use(requireAuth, requireRole('Admin'));
router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.get);
router.put('/:id', c.update);
router.patch('/:id/status', c.setStatus);
router.post('/:id/reset-password', c.resetPassword);

module.exports = router;
