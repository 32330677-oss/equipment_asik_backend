// services/telegram/loopback.js — the bot calls the SAME API routes as the app, as the supervisor himself.
//
// Every request goes over HTTP to this server with a JWT of the supervisor that lives 60 seconds (with his password
// version, like a normal sign-in). So it passes through everything the app passes through: requireAuth (account
// Active, role re-read), requireRole, the site / shift / deployment checks, the locks, the transactions.
// The bot never writes SQL for attendance. Only the routes in ALLOWED can be called (phase 2: reading only).
const jwt = require('jsonwebtoken');
const { env } = require('../../config/env');
const { pool } = require('../../config/db');
const { passwordVersion } = require('../../middleware/requireAuth');

const ALLOWED = [
  { method: 'GET', path: /^\/api\/equipment\/my-sites$/ },
  { method: 'GET', path: /^\/api\/equipment\/attendance\/site\/\d+$/ },
];

const TIMEOUT_MS = 20000;

function baseUrl() {
  return env.telegram.loopbackUrl || `http://127.0.0.1:${env.port}`;
}

async function tokenFor(userId) {
  const [[u]] = await pool.execute('SELECT user_id, password_changed_at FROM users WHERE user_id = ?', [userId]);
  if (!u) throw new Error('user not found');
  return jwt.sign({ user_id: u.user_id, pwv: passwordVersion(u) }, env.jwtSecret, { expiresIn: 60 });
}

/**
 * Calls one allowed route as the user. Returns { ok, status, data, code, message } (never throws for an API error;
 * throws only for a route outside ALLOWED).
 */
async function call(userId, method, path, { query, body } = {}) {
  const route = ALLOWED.find((r) => r.method === method && r.path.test(path));
  if (!route) throw new Error(`loopback: ${method} ${path} is not allowed`);
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString()}` : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${await tokenFor(userId)}`, 'Content-Type': 'application/json', 'X-Source': 'telegram' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: json.data, code: json.code || null, message: json.message || null, details: json.details };
  } catch (e) {
    return { ok: false, status: 0, data: null, code: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', message: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { call, ALLOWED };
