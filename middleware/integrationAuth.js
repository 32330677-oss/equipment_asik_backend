// middleware/integrationAuth.js — server-to-server authentication for Team Flow.
// Team Flow sends `Authorization: Bearer <INTEGRATION_TOKEN>`. Compared in constant time (hash first, so the
// lengths always match). No user session, no role: the integration routes are READ-ONLY summaries.
const crypto = require('crypto');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();

module.exports = function integrationAuth(req, res, next) {
  const expected = env.integrationToken;
  if (!expected || expected.length < 32) {
    return next(new AppError(503, 'INTEGRATION_OFF', 'The Team Flow integration is not configured on this server (INTEGRATION_TOKEN).'));
  }
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !crypto.timingSafeEqual(sha(provided), sha(expected))) {
    return next(AppError.unauthorized('INTEGRATION_TOKEN_INVALID', 'Invalid integration token.'));
  }
  req.isIntegration = true;
  return next();
};
