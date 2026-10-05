// middleware/errorHandler.js — one place that formats every error.
const AppError = require('../utils/AppError');

function notFound(req, res) {
  res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.isAppError) {
    const body = { status: 'error', code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ status: 'error', code: 'FILE_TOO_LARGE', message: 'File is larger than the allowed size.' });
  }
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
    return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: 'Too many files or unexpected file field.' });
  }
  // a database CHECK constraint refused the values (MySQL 3819, MariaDB 4025): the request is invalid, not a crash
  if (err && (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || err.errno === 3819 || err.errno === 4025)) {
    return res.status(409).json({ status: 'error', code: 'INVALID_VALUES', message: 'These values are not allowed (a date or number is out of range).' });
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ status: 'error', code: 'DUPLICATE', message: 'A record with the same unique value already exists.' });
  }
  console.error(`[${req.id || '-'}] ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({ status: 'error', code: 'INTERNAL_ERROR', message: 'Unexpected server error. Please try again.', request_id: req.id });
}

module.exports = { notFound, errorHandler, AppError };
