const AppError = require('../utils/AppError');

/** requireRole('Admin', 'Accountant') */
module.exports = function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(AppError.forbidden('FORBIDDEN_ROLE', 'Your role is not allowed to do this.'));
    }
    return next();
  };
};
