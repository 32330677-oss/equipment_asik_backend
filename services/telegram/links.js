// services/telegram/links.js — linking a supervisor's Telegram chat to his account (phase 2).
//   App:  POST /api/telegram/link-code  -> https://t.me/<bot>?start=<code>   (valid LINK_MINUTES, once)
//   Bot:  "/start <code>" in the chat    -> the chat is linked to that account
// Only Active Supervisor accounts can link. One chat <-> one account. Every change is in the audit log.
const crypto = require('crypto');
const { pool, withTransaction } = require('../../config/db');
const { env } = require('../../config/env');
const audit = require('../audit');
const AppError = require('../../utils/AppError');

const LINK_MINUTES = 15;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const eligible = (u) => Boolean(u) && u.role === 'Supervisor' && u.status === 'Active';

async function logLink(conn, userId, action, { actorId = null, oldValues = null, newValues = null, reason = null } = {}) {
  await audit.log(conn, { table: 'tg_links', id: userId, action, userId: actorId, oldValues, newValues, reason, source: 'telegram' });
}

async function userById(conn, userId) {
  const [[u]] = await conn.execute('SELECT user_id, full_name, role, status FROM users WHERE user_id = ?', [userId]);
  return u || null;
}

/** The link of an account (or null): { user_id, chat_id, telegram_username, language, linked_at }. */
async function linkOf(conn, userId, forUpdate = false) {
  const [[row]] = await conn.execute(
    `SELECT user_id, chat_id, telegram_username, language, linked_at FROM tg_links WHERE user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
  return row || null;
}

/** Open by default: false only when the Admin switched the bot off for this account. */
async function isAllowed(userId, conn = pool) {
  const [[row]] = await conn.execute('SELECT allowed FROM tg_access WHERE user_id = ?', [userId]);
  return !row || Number(row.allowed) === 1;
}

/** PUT /access/:userId (Admin). Returns { allowed, chat_id } (chat_id: a linked chat to tell). */
async function setAccess(userId, allowed, actorId, reason = null) {
  return withTransaction(async (c) => {
    const user = await userById(c, userId);
    if (!user) throw AppError.notFound('User');
    if (user.role !== 'Supervisor') throw AppError.badRequest('NOT_SUPERVISOR', 'The Telegram bot is for site supervisors only.');
    const before = await isAllowed(userId, c);
    await c.execute(
      `INSERT INTO tg_access (user_id, allowed, reason, changed_by_user_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), reason = VALUES(reason), changed_by_user_id = VALUES(changed_by_user_id)`,
      [userId, allowed ? 1 : 0, reason, actorId]);
    if (!allowed) await c.execute('DELETE FROM tg_link_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
    await logLink(c, userId, allowed ? 'allow' : 'block', { actorId, oldValues: { allowed: before }, newValues: { allowed }, reason });
    const link = await linkOf(c, userId);
    return { allowed, chat_id: link && link.chat_id ? link.chat_id : null, changed: before !== allowed };
  });
}

/** GET /access (Admin): the supervisors the bot is switched off for. */
async function listBlocked() {
  const [rows] = await pool.execute(
    `SELECT a.user_id, u.full_name, a.reason, a.changed_at FROM tg_access a JOIN users u ON u.user_id = a.user_id
     WHERE a.allowed = 0 ORDER BY u.full_name`);
  return rows;
}

/** POST /link-code (the supervisor himself). */
async function createLinkCode(user) {
  if (!eligible(user)) throw AppError.forbidden('TELEGRAM_NOT_ELIGIBLE', 'Only an active site supervisor can link Telegram.');
  if (!(await isAllowed(user.user_id))) throw AppError.forbidden('TELEGRAM_BLOCKED', 'The office switched the Telegram bot off for your account.');
  const username = env.telegram.botUsername;
  if (!username) throw new AppError(503, 'TELEGRAM_NOT_CONFIGURED', 'The Telegram bot is not set up yet (TELEGRAM_BOT_USERNAME).');
  const code = crypto.randomBytes(18).toString('base64url'); // 24 characters, [A-Za-z0-9_-], fits /start
  await withTransaction(async (c) => {
    await c.execute('DELETE FROM tg_link_codes WHERE user_id = ? AND used_at IS NULL', [user.user_id]);
    await c.execute(`INSERT INTO tg_link_codes (code_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ${LINK_MINUTES} MINUTE)`,
      [sha256(code), user.user_id]);
    await logLink(c, user.user_id, 'link_code', { actorId: user.user_id, newValues: { valid_minutes: LINK_MINUTES } });
  });
  return { url: `https://t.me/${username}?start=${code}`, valid_minutes: LINK_MINUTES };
}

/**
 * "/start <code>" in a chat. Returns { ok: false, reason: 'invalid' | 'not_eligible' }
 * or { ok: true, user, language, previousChatId }.
 */
async function linkWithCode(code, chat, from) {
  return withTransaction(async (c) => {
    const [[row]] = await c.execute(
      'SELECT user_id FROM tg_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW() FOR UPDATE', [sha256(code)]);
    if (!row) return { ok: false, reason: 'invalid' };
    const user = await userById(c, row.user_id);
    if (!eligible(user)) return { ok: false, reason: 'not_eligible' };
    if (!(await isAllowed(user.user_id, c))) return { ok: false, reason: 'blocked' };
    await c.execute('UPDATE tg_link_codes SET used_at = NOW() WHERE code_hash = ?', [sha256(code)]);
    // one chat = one account: this chat leaves any other account first
    const [others] = await c.execute('SELECT user_id FROM tg_links WHERE chat_id = ? AND user_id <> ? FOR UPDATE', [chat.id, user.user_id]);
    for (const o of others) {
      await c.execute('UPDATE tg_links SET chat_id = NULL, telegram_username = NULL, linked_at = NULL WHERE user_id = ?', [o.user_id]);
      await logLink(c, o.user_id, 'unlink', { reason: 'the chat was linked to another account' });
    }
    const before = await linkOf(c, user.user_id, true);
    const tgUser = from && from.username ? String(from.username).slice(0, 100) : null;
    if (before) {
      await c.execute('UPDATE tg_links SET chat_id = ?, telegram_username = ?, linked_at = NOW() WHERE user_id = ?', [chat.id, tgUser, user.user_id]);
    } else {
      await c.execute('INSERT INTO tg_links (user_id, chat_id, telegram_username, linked_at) VALUES (?, ?, ?, NOW())', [user.user_id, chat.id, tgUser]);
    }
    await logLink(c, user.user_id, 'link', { actorId: user.user_id, newValues: { telegram_username: tgUser } });
    const previousChatId = before && before.chat_id && String(before.chat_id) !== String(chat.id) ? before.chat_id : null;
    return { ok: true, user, language: before ? before.language : 'ar', previousChatId };
  });
}

/** The account linked to a chat, with its CURRENT role / status, or null. */
async function linkByChat(chatId) {
  const [[row]] = await pool.execute(
    `SELECT l.user_id, l.chat_id, l.language, u.full_name, u.role, u.status, u.must_change_password
     FROM tg_links l JOIN users u ON u.user_id = l.user_id WHERE l.chat_id = ?`, [chatId]);
  return row ? { ...row, eligible: eligible(row), allowed: await isAllowed(row.user_id) } : null;
}

async function setLanguage(userId, language) {
  if (!['ar', 'en'].includes(language)) throw AppError.validation({ language: 'ar or en' });
  await pool.execute('UPDATE tg_links SET language = ? WHERE user_id = ?', [language, userId]);
}

/** GET /me (the supervisor). */
async function status(userId) {
  const link = await linkOf(pool, userId);
  return {
    linked: Boolean(link && link.chat_id),
    telegram_username: link ? link.telegram_username : null,
    linked_at: link ? link.linked_at : null,
    bot_username: env.telegram.botUsername || null,
    bot_enabled: Boolean(env.telegram.enabled),
    allowed: await isAllowed(userId),
  };
}

/** Unlinks an account (himself, or an Admin). Returns the chat that was linked (the bot tells it), or null. */
async function unlink(userId, actorId, reason = null) {
  return withTransaction(async (c) => {
    const before = await linkOf(c, userId, true);
    if (!before || !before.chat_id) return null;
    await c.execute('UPDATE tg_links SET chat_id = NULL, telegram_username = NULL, linked_at = NULL WHERE user_id = ?', [userId]);
    await logLink(c, userId, 'unlink', { actorId, oldValues: { telegram_username: before.telegram_username }, reason });
    return before.chat_id;
  });
}

/** GET /links (Admin): every linked account. */
async function listLinks() {
  const [rows] = await pool.execute(
    `SELECT l.user_id, u.full_name, u.username, u.role, u.status, l.telegram_username, l.language, l.linked_at
     FROM tg_links l JOIN users u ON u.user_id = l.user_id WHERE l.chat_id IS NOT NULL ORDER BY u.full_name`);
  return rows;
}

module.exports = { createLinkCode, linkWithCode, linkByChat, setLanguage, status, unlink, listLinks, eligible, isAllowed, setAccess, listBlocked, LINK_MINUTES, sha256 };
