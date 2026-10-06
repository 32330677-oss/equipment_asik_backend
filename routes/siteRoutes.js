const router = require('express').Router();
const c = require('../controllers/siteController');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');

const A = requireRole('Admin');
const AC = requireRole('Admin', 'Accountant');
const ACS = requireRole('Admin', 'Accountant', 'Supervisor');

router.get('/sites', requireAuth, ACS, c.list);
router.post('/sites', requireAuth, A, c.create);
router.get('/sites/:id', requireAuth, AC, c.get);
router.put('/sites/:id', requireAuth, A, c.update);
router.patch('/sites/:id/status', requireAuth, A, c.setStatus);
router.get('/sites/:id/supervisors', requireAuth, AC, c.listSupervisors);
router.post('/sites/:id/supervisors', requireAuth, A, c.assignSupervisor);
router.post('/sites/:id/supervisors/replace', requireAuth, A, c.replaceSupervisor);
router.patch('/site-supervisors/:id/end', requireAuth, A, c.endSupervisor);
router.patch('/site-supervisors/:id/start', requireAuth, A, c.changeSupervisorStart);

module.exports = router;
