const router = require('express').Router();
const c = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');
const { loginLimiter } = require('../middleware/rateLimits');

router.post('/login', loginLimiter, c.login);
router.get('/me', requireAuth, c.me);
router.post('/change-password', requireAuth, c.changePassword);

module.exports = router;
