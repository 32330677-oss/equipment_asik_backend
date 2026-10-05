// Express 5 forwards rejected promises to the error handler; this wrapper is kept for clarity/compat.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
