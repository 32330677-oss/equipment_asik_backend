// services/uploads.js — multer in memory + real file-type detection (magic numbers).
const multer = require('multer');
const AppError = require('../utils/AppError');

const MAX_FILE = 15 * 1024 * 1024;

const TYPES = {
  pdf: { mime: 'application/pdf', ext: 'pdf', test: (b) => b.slice(0, 4).toString('latin1') === '%PDF' },
  jpg: { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', ext: 'png', test: (b) => b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG' },
  webp: { mime: 'image/webp', ext: 'webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
};

/** Detects the real type of a buffer among the allowed kinds, or throws 415. */
function detect(buffer, allowed = ['pdf', 'jpg', 'png', 'webp']) {
  for (const k of allowed) {
    if (buffer && buffer.length > 12 && TYPES[k].test(buffer)) return TYPES[k];
  }
  throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `Allowed file types: ${allowed.join(', ').toUpperCase()}.`);
}

const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 10 } });

/** Express middleware: single file field. */
function single(field = 'file') {
  const mw = memory.single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next(AppError.badRequest('FILE_REQUIRED', `Upload a file in the "${field}" field.`));
    return next();
  });
}

/** Express middleware: several files in one field. */
function many(field = 'files', max = 10) {
  const mw = memory.array(field, max);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return next(err);
    if (!req.files || !req.files.length) return next(AppError.badRequest('FILE_REQUIRED', `Upload at least one file in the "${field}" field.`));
    return next();
  });
}

module.exports = { detect, single, many, TYPES, MAX_FILE };
