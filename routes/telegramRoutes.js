// routes/telegramRoutes.js — /api/telegram/* : the supervisors' Telegram bot (phase 2: linking, read-only status).
//   POST   /webhook             Telegram only (secret header), no sign-in
//   GET    /me                  Supervisor: is my Telegram linked?
//   POST   /link-code           Supervisor: one-time link (https://t.me/<bot>?start=<code>, 15 minutes)
//   DELETE /me                  Supervisor: unlink my Telegram
//   GET    /links               Admin: linked accounts
//   DELETE /links/:userId       Admin: unlink an account (reason optional)
//   GET    /access              Admin: supervisors the bot is switched off for (open by default)
//   PUT    /access/:userId      Admin: { allowed: true|false, reason? }
//   POST   /setup-webhook       Admin: registers <PUBLIC_BASE_URL>/api/telegram/webhook with Telegram
const crypto = require('crypto');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const AppError = require('../utils/AppError');
const { env } = require('../config/env');
const tg = require('../services/telegram/telegramApi');
const links = require('../services/telegram/links');
const bot = require('../services/telegram/bot');
const { t } = require('../services/telegram/messages');

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const webhookLimit = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });

router.post('/webhook', webhookLimit, async (req, res) => {
  if (!tg.configured()) return res.status(503).json({ status: 'error', code: 'TELEGRAM_NOT_CONFIGURED', message: 'The Telegram bot is not configured.' });
  if (!sameSecret(req.get('x-telegram-bot-api-secret-token'), env.telegram.webhookSecret)) {
    return res.status(401).json({ status: 'error', code: 'BAD_SECRET', message: 'Invalid webhook secret.' });
  }
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    // answer 200 anyway: Telegram would otherwise resend the same update for hours
    console.error('Telegram update failed:', e.message);
  }
  return res.json({ ok: true });
});

router.use(requireAuth);
const SUP = requireRole('Supervisor');
const A = requireRole('Admin');

router.get('/me', SUP, async (req, res) => {
  res.json({ status: 'success', data: await links.status(req.user.user_id) });
});

router.post('/link-code', SUP, async (req, res) => {
  if (!env.telegram.enabled) throw new AppError(503, 'TELEGRAM_OFF', 'The Telegram bot is not switched on yet.');
  res.json({ status: 'success', data: await links.createLinkCode(req.user) });
});

router.delete('/me', SUP, async (req, res) => {
  const chatId = await links.unlink(req.user.user_id, req.user.user_id, 'unlinked by the supervisor in the app');
  if (chatId) await tg.sendMessage(chatId, t('ar', 'unlinked_by_admin'));
  res.json({ status: 'success', data: { unlinked: Boolean(chatId) } });
});

router.get('/links', A, async (req, res) => {
  res.json({ status: 'success', data: await links.listLinks() });
});

router.delete('/links/:userId', A, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 1) throw AppError.validation({ userId: 'must be a positive integer' });
  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : 'unlinked by the Admin';
  const chatId = await links.unlink(userId, req.user.user_id, reason);
  if (chatId) await tg.sendMessage(chatId, t('ar', 'unlinked_by_admin'));
  res.json({ status: 'success', data: { unlinked: Boolean(chatId) } });
});

// The Admin switches the bot off (or back on) for one supervisor. Open by default.
router.get('/access', A, async (req, res) => {
  res.json({ status: 'success', data: await links.listBlocked() });
});

router.put('/access/:userId', A, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 1) throw AppError.validation({ userId: 'must be a positive integer' });
  if (typeof (req.body && req.body.allowed) !== 'boolean') throw AppError.validation({ allowed: 'true or false' });
  const reason = req.body.reason ? String(req.body.reason).trim().slice(0, 500) || null : null;
  const r = await links.setAccess(userId, req.body.allowed, req.user.user_id, reason);
  if (r.chat_id && r.changed) {
    const [[l]] = await require('../config/db').pool.execute('SELECT language FROM tg_links WHERE user_id = ?', [userId]);
    await tg.sendMessage(r.chat_id, t(l ? l.language : 'ar', r.allowed ? 'access_back' : 'blocked_by_admin'));
  }
  res.json({ status: 'success', data: { user_id: userId, allowed: r.allowed } });
});

// The conversation of one supervisor with the bot (kept BOT_KEEP_CHAT_DAYS days), for the Admin to check mistakes.
router.get('/chat-log/:userId', A, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 1) throw AppError.validation({ userId: 'must be a positive integer' });
  res.json({ status: 'success', data: await require('../services/telegram/chatlog').list(userId, req.query.limit) });
});

router.post('/setup-webhook', A, async (req, res) => {
  if (!tg.configured()) throw new AppError(503, 'TELEGRAM_NOT_CONFIGURED', 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (16+ characters) first.');
  if (!/^https:\/\//.test(env.telegram.publicUrl)) throw new AppError(503, 'PUBLIC_URL_MISSING', 'Set PUBLIC_BASE_URL (https://...) first.');
  const url = `${env.telegram.publicUrl}/api/telegram/webhook`;
  try {
    await tg.callApi('setWebhook', { url, secret_token: env.telegram.webhookSecret, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: true });
  } catch (e) {
    throw new AppError(502, 'TELEGRAM_ERROR', `Telegram refused the webhook: ${e.message}`);
  }
  res.json({ status: 'success', data: { webhook: url } });
});

module.exports = router;
