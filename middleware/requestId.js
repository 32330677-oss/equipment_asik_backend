const crypto = require('crypto');
module.exports = function requestId(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomBytes(6).toString('hex');
  res.set('x-request-id', req.id);
  next();
};
