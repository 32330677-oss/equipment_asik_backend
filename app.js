// app.js — builds the Express app (exported for tests; server.js starts it).
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { env } = require('./config/env');
const requestId = require('./middleware/requestId');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const any = env.corsOrigins.includes('*');
  app.use(cors({
    origin: any ? true : (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
    exposedHeaders: ['Content-Disposition', 'x-request-id'],
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', require('./routes'));
  app.get('/', (req, res) => res.json({ status: 'ok', service: 'Equipment Flow API', docs: '/api/health' }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { buildApp };
