// services/telegram/bot.js — handles one Telegram update (phase 2: linking + today's status, read-only).
// The bot answers only in private chats, only to a linked Active supervisor, and reads only through the app's
// own routes (loopback.js). Recording by text / voice comes in phase 3.
const tg = require('./telegramApi');
const links = require('./links');
const loopback = require('./loopback');
const { t } = require('./messages');
const { businessToday } = require('../../utils/businessDate');

const STATES = ['working', 'on_break', 'breakdown', 'standby', 'finished', 'not_arrived', 'absent', 'holiday'];

/** Today's status of every site / shift of the supervisor, as one message. */
async function todayText(link) {
  const lang = link.language;
  const date = businessToday();
  const sites = await loopback.call(link.user_id, 'GET', '/api/equipment/my-sites', { query: { date } });
  if (!sites.ok) return t(lang, 'server_error', { why: sites.message || sites.code || sites.status });
  const list = Array.isArray(sites.data) ? sites.data : [];
  const out = [t(lang, 'today_title', { date })];
  if (!list.length) {
    out.push(t(lang, 'no_sites'));
    return out.join('\n\n');
  }
  for (const s of list) {
    const shift = s.shift_type === 'Night' ? 'Night' : 'Day';
    const head = t(lang, 'site_line', { site: tg.esc(`${s.site_code} ${s.site_name || ''}`.trim()), shift: t(lang, `shift_${shift}`) });
    const day = await loopback.call(link.user_id, 'GET', `/api/equipment/attendance/site/${Number(s.site_id)}`, { query: { date, shift } });
    if (!day.ok) {
      out.push(`${head}\n${t(lang, 'site_error', { why: tg.esc(day.message || day.code || day.status) })}`);
      continue;
    }
    const sum = (day.data && day.data.summary) || {};
    const parts = STATES.filter((k) => Number(sum[k]) > 0).map((k) => `${Number(sum[k])} ${t(lang, `st_${k}`)}`);
    out.push(`${head}\n${t(lang, 'machines', { n: Number(sum.deployed) || 0 })}${parts.length ? `: ${parts.join('، ')}` : ''}`);
  }
  return out.join('\n\n');
}

/** Can this linked account use the bot now? Returns the message key that explains why not, or null. */
function blockedReason(link) {
  if (!link.eligible) return 'account_inactive';
  if (Number(link.must_change_password) === 1) return 'change_password';
  return null;
}

async function onStart(chat, from, code) {
  if (code) {
    const r = await links.linkWithCode(code, chat, from);
    if (!r.ok) return tg.sendMessage(chat.id, t('ar', r.reason === 'invalid' ? 'link_invalid' : 'not_eligible'));
    if (r.previousChatId) await tg.sendMessage(r.previousChatId, t(r.language, 'moved'));
    await tg.sendMessage(chat.id, t(r.language, 'welcome', { name: tg.esc(String(r.user.full_name || '').split(' ')[0]) }));
  }
  const link = await links.linkByChat(chat.id);
  if (!link) return tg.sendMessage(chat.id, t('ar', 'not_linked'));
  const why = blockedReason(link);
  if (why) return tg.sendMessage(chat.id, t(link.language, why));
  await tg.sendMessage(chat.id, await todayText(link));
  return tg.sendMessage(chat.id, t(link.language, 'coming_soon'));
}

async function handleUpdate(update) {
  const msg = update && (update.message || update.edited_message);
  if (!msg || !msg.chat) return; // callback queries and other updates: nothing in phase 2
  const chat = msg.chat;
  if (chat.type !== 'private') return tg.sendMessage(chat.id, t('ar', 'private_only'));
  if (!tg.enabled()) return tg.sendMessage(chat.id, t('ar', 'bot_off'));
  const text = String(msg.text || '').trim();

  const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{8,64}))?\s*$/.exec(text);
  if (start) return onStart(chat, msg.from, start[1] || null);

  const link = await links.linkByChat(chat.id);
  if (!link) return tg.sendMessage(chat.id, t('ar', 'not_linked'));
  const why = blockedReason(link);
  if (why) return tg.sendMessage(chat.id, t(link.language, why));

  if (/^\/(en|english)$/i.test(text) || /^english$/i.test(text)) {
    await links.setLanguage(link.user_id, 'en');
    return tg.sendMessage(chat.id, t('en', 'lang_set'));
  }
  if (/^\/(ar|arabic)$/i.test(text) || text === 'عربي') {
    await links.setLanguage(link.user_id, 'ar');
    return tg.sendMessage(chat.id, t('ar', 'lang_set'));
  }
  // phase 2: any other message (text or voice) gets today's status and the note that recording comes next
  await tg.sendMessage(chat.id, await todayText(link));
  return tg.sendMessage(chat.id, t(link.language, 'coming_soon'));
}

module.exports = { handleUpdate, todayText };
