// utils/AppError.js — every expected error is thrown as an AppError and formatted by errorHandler.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.isAppError = true;
  }
  static badRequest(code, message, details) { return new AppError(400, code, message, details); }
  static validation(fields) {
    return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', { fields });
  }
  static unauthorized(code, message) { return new AppError(401, code, message); }
  static forbidden(code = 'FORBIDDEN_ROLE', message = 'You are not allowed to do this.') { return new AppError(403, code, message); }
  static notFound(what = 'Record') { return new AppError(404, 'NOT_FOUND', `${what} not found.`); }
  static conflict(code, message, details) { return new AppError(409, code, message, details); }
}
module.exports = AppError;
