// utils/requestContext.js — who is calling, readable anywhere during a request (14 Oct 2026).
// The lock rules depend on the role (a supervisor cannot touch an issued invoice's days, an accountant cannot touch a
// returned one, nobody touches a handed-over one). requireAuth runs the rest of the request inside this context, so the
// lock service reads the user without every caller passing it.
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** Runs fn with this user as the current user. */
function runAs(user, fn) {
  return store.run({ user }, fn);
}

/** The signed-in user of the current request, or null (scripts, tests without a request). */
function currentUser() {
  const s = store.getStore();
  return s ? s.user || null : null;
}

module.exports = { runAs, currentUser };
