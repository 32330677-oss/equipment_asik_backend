// routes/helpRoutes.js — /api/help (every signed-in role; what each role sees is filtered in services/help).
const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const c = require('../controllers/helpController');

router.use(requireAuth);
router.get('/', c.home);
router.get('/search', c.search);
router.get('/topics/:id', c.topic);

module.exports = router;
