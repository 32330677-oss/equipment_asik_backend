// services/telegram/telegramApi.js — the only place that talks to the Telegram Bot API.
// Every call has a timeout and never throws to the webhook (a failed reply is logged, the update is still answered).
// Tests replace the transport with setTransport() so Telegram is never called.
const { env } = require('../../config/env');

const TIMEOUT_MS = 15000;
const MAX_TEXT = 4000; // Telegram refuses messages over 4096 characters

let transport = null;

/** Tests: fn(method, payload) -> result object. null puts the real HTTPS call back. */
function setTransport(fn) { transport = fn; }

function configured() {
  const t = env.telegram;
  return Boolean(t.botToken && t.webhookSecret && t.webhookSecret.length >= 16);
}

function enabled() { return Boolean(env.telegram.enabled) && configured(); }

/** Any Bot API method. Returns the `result` or throws an Error with the Telegram description. */
async function callApi(method, payload = {}) {
  if (transport) return transport(method, payload);
  if (!env.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.telegram.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description || res.status}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

let onSent = null;
/** A hook called with (chatId, text) after every message sent or edited (the conversation log). */
function setOnSent(fn) { onSent = fn; }
function sent(chatId, text) { if (onSent) Promise.resolve(onSent(chatId, text)).catch(() => {}); }

/** Sends a message (HTML), cut to Telegram's limit. Never throws: returns the message or null. */
async function sendMessage(chatId, text, extra = {}) {
  let t = String(text || '');
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 1)}…`;
  try {
    sent(chatId, t);
    return await callApi('sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) {
    console.error('Telegram sendMessage failed:', e.message);
    return null;
  }
}

/** Replaces the text (and buttons) of a message the bot sent; sends a new one when that fails. */
async function editMessage(chatId, messageId, text, extra = {}) {
  let t = String(text || '');
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 1)}…`;
  if (messageId) {
    try {
      sent(chatId, t);
      return await callApi('editMessageText', { chat_id: chatId, message_id: messageId, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (e) {
      if (/not modified/i.test(e.message)) return null;
    }
  }
  return sendMessage(chatId, t, extra);
}

/** Stops the spinner on a tapped button (optionally with a short toast). Never throws. */
async function answerCallback(id, text = '') {
  try { await callApi('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); } catch (_) { /* expired: fine */ }
}

let downloader = null;
/** Tests: fn(fileId) -> Buffer. */
function setDownloader(fn) { downloader = fn; }

/** Downloads a file the supervisor sent (a voice note) into memory. Throws on failure. */
async function downloadFile(fileId) {
  if (downloader) return downloader(fileId);
  const file = await callApi('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegram.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Escapes text put inside an HTML message. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { setOnSent, callApi, sendMessage, editMessage, answerCallback, downloadFile, setDownloader, esc, configured, enabled, setTransport, MAX_TEXT };
