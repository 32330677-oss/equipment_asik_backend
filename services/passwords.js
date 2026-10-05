const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');

/** BR-P2: at least 10 characters, one letter and one digit. */
function assertStrong(password) {
  const p = String(password || '');
  if (p.length < 10 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    throw AppError.badRequest('WEAK_PASSWORD', 'Password must be at least 10 characters and contain at least one letter and one digit.');
  }
}

function hash(password) { return bcrypt.hash(String(password), env.bcryptCost); }
function verify(password, passwordHash) { return bcrypt.compare(String(password || ''), passwordHash || ''); }

/** Random temporary password (12 chars, always passes the policy). */
function temporary() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 10; i += 1) s += alphabet[bytes[i] % alphabet.length];
  return `${s}${2 + (bytes[10] % 8)}${alphabet[bytes[11] % 24]}`;
}

module.exports = { assertStrong, hash, verify, temporary };
