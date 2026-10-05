const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const json = (code, message) => (req, res) => res.status(429).json({ status: 'error', code, message });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('RATE_LIMITED', 'Too many login attempts from this network. Try again in a few minutes.'),
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('RATE_LIMITED', 'Too many uploads. Please wait a minute.'),
});

module.exports = { loginLimiter, uploadLimiter };
