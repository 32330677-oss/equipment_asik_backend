const router = require('express').Router();
const { ping } = require('../config/db');

router.get('/', async (req, res) => {
  let db = 'down';
  try { db = (await ping()) ? 'ok' : 'down'; } catch (_) { db = 'down'; }
  res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'error', db, service: 'equipment_asik_backend' });
});

module.exports = router;
