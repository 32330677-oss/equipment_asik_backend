// services/telegram/bot.js — handles one Telegram update for a linked site supervisor.
//   text / voice -> the AI reads it (parser.js) -> checked against the day board (builder.js) -> a proposal with
//   buttons -> questions if needed (which machine, which site / shift, the reason) -> Confirm -> the app's own routes
//   (executor.js) save DRAFT rows -> the result, with the app's reason for anything refused.
// Nothing is written before Confirm. Submit, recall, deletes and invoices stay in the app.
const tg = require('./telegramApi');
const links = require('./links');
const loopback = require('./loopback');
const { t } = require('./messages');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');
const context = require('./context');
const parser = require('./parser');
const ai = require('./ai');
const builder = require('./builder');
const pending = require('./pending');
const view = require('./view');
const executor = require('./executor');
const aliases = require('./aliases');
const usage = require('./usage');
const transcriber = require('./transcriber');

const STATES = ['working', 'on_break', 'breakdown', 'standby', 'finished', 'not_arrived', 'absent', 'holiday'];
const RETRY = new Set(['TIMEOUT', 'BUSY', 'BAD_REPLY', 'UNREACHABLE']);

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

function blockedReason(link) {
  if (!link.eligible) return 'account_inactive';
  if (!link.allowed) return 'blocked_by_admin';
  if (Number(link.must_change_password) === 1) return 'change_password';
  return null;
}

/** The day the message is about, guessed from its words before the AI reads it (the AI confirms it). */
function guessDate(text, today, nowHHMM) {
  const s = String(text || '');
  if (/(^|\s)(ا?مبارح|البارح[ةه]|أمس|امس|yesterday)(\s|$|[.,،])/i.test(s)) return addDays(today, -1);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s);
  if (iso) { const r = builder.resolveDate(iso[1], today); if (r.date) return r.date; }
  const dm = /(?:^|\s)(?:يوم|نهار|بيوم|تاريخ|day|on the)\s*(\d{1,2})(?![\d:.])/i.exec(s);
  if (dm) { const r = builder.resolveDate(dm[1], today); if (r.date) return r.date; }
  // a night shift reported in the morning belongs to the evening before
  if (nowHHMM < '12:00' && /(الليلي|ليلي|المسائي|night)/i.test(s)) return addDays(today, -1);
  return today;
}

/** One AI read, logged; one retry on a passing error. Returns the parse result or null (the error was sent). */
async function read(link, chatId, args, kind) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await parser.parse(args);
      await usage.log(link.user_id, kind, { model: r.model, latencyMs: r.latencyMs, usage: r.usage });
      return r;
    } catch (e) {
      const code = e.code || 'ERROR';
      await usage.log(link.user_id, kind, { ok: false, code });
      if (attempt === 0 && RETRY.has(code)) continue;
      const key = ['NOT_CONFIGURED', 'TIMEOUT', 'BUSY', 'TRUNCATED'].includes(code) ? `ai_${code}` : 'ai_other';
      await tg.sendMessage(chatId, t(link.language, key, { code }));
      return null;
    }
  }
  return null;
}

async function rebuild(link, payload) {
  const ctx = await context.load(link.user_id, payload.date);
  if (!ctx.ok) return { ctx, plan: null };
  const plan = builder.build({ reading: payload.reading, ctx, answers: payload.answers || {}, nowStamp: businessNow() });
  return { ctx, plan };
}

const errWhy = (ctx) => tg.esc((ctx && ctx.error && (ctx.error.message || ctx.error.code || ctx.error.status)) || '');

async function showProposal(chatId, messageId, p, ctx, plan, lang, note = '') {
  const v = view.proposal(plan, ctx, lang, p.id);
  const text = note ? `${v.text}\n\n${t(lang, 'note', { note: tg.esc(note) })}` : v.text;
  const m = messageId ? await tg.editMessage(chatId, messageId, text, { reply_markup: v.keyboard }) : await tg.sendMessage(chatId, text, { reply_markup: v.keyboard });
  if (m && m.message_id && m.message_id !== messageId) await pending.setMessage(p.id, m.message_id);
}

async function showQuestion(chatId, messageId, p, ctx, plan, lang) {
  const q = plan.questions[0];
  p.payload.waiting = q.kind === 'reason' ? q.id : null;
  await pending.save(p.id, p.payload);
  const v = view.question(q, ctx, lang, p.id);
  const m = messageId ? await tg.editMessage(chatId, messageId, v.text, { reply_markup: v.keyboard }) : await tg.sendMessage(chatId, v.text, { reply_markup: v.keyboard });
  if (m && m.message_id && m.message_id !== messageId) await pending.setMessage(p.id, m.message_id);
}

/** After an answer: the next question, or the proposal again (with Confirm). */
async function next(chatId, messageId, p, link) {
  const { ctx, plan } = await rebuild(link, p.payload);
  if (!plan) return tg.sendMessage(chatId, t(link.language, 'server_error', { why: errWhy(ctx) }));
  if (plan.questions.length) return showQuestion(chatId, messageId, p, ctx, plan, link.language);
  p.payload.waiting = null;
  await pending.save(p.id, p.payload);
  return showProposal(chatId, messageId, p, ctx, plan, link.language);
}

async function cancelOpen(link, chatId) {
  const p = await pending.get(link.user_id);
  if (!p) return tg.sendMessage(chatId, t(link.language, 'nothing_open'));
  await pending.close(p.id, 'Cancelled');
  if (p.messageId) return tg.editMessage(chatId, p.messageId, t(link.language, 'cancelled'));
  return tg.sendMessage(chatId, t(link.language, 'cancelled'));
}

/** A message about machines (typed, or a voice note turned into text). */
async function onText(link, chat, text, kind = 'text', preCtx = null) {
  const lang = link.language;
  if (await usage.overLimit(link.user_id)) return tg.sendMessage(chat.id, t(lang, 'limit', { n: usage.limit() }));
  const today = businessToday();
  const now = businessNow();
  const date = guessDate(text, today, now.slice(11, 16));
  let ctx = preCtx && preCtx.date === date ? preCtx : await context.load(link.user_id, date);
  if (!ctx.ok) return tg.sendMessage(chat.id, t(lang, 'server_error', { why: errWhy(ctx) }));
  const names = await aliases.forUser(link.user_id);
  const args = { text, ctx, now: now.slice(11, 16), lang, aliases: names };
  let parsed = await read(link, chat.id, args, kind);
  if (!parsed) return null;
  let r = parsed.reading;
  // nothing read: a second look by a stronger model (when one is set)
  if (!r.entries.length && ['record', 'other'].includes(r.intent) && ai.strongModel() && ctx.machines.length) {
    const again = await read(link, chat.id, { ...args, strong: true }, 'second_look');
    if (again && again.reading.entries.length) r = again.reading;
  }
  if (r.intent === 'status') return tg.sendMessage(chat.id, await todayText(link));
  if (r.intent === 'not_recorded') return tg.sendMessage(chat.id, view.notRecorded(ctx, lang));
  if (r.intent === 'help') return tg.sendMessage(chat.id, t(lang, 'help'));
  if (r.intent === 'cancel' && !r.entries.length) return cancelOpen(link, chat.id);

  // the date he said: if it is not the board that was read, read again with the machines of that day
  if (r.work_date) {
    const d = builder.resolveDate(r.work_date, today);
    if (d.error) return tg.sendMessage(chat.id, t(lang, d.error));
    if (d.date !== ctx.date) {
      ctx = await context.load(link.user_id, d.date);
      if (!ctx.ok) return tg.sendMessage(chat.id, t(lang, 'server_error', { why: errWhy(ctx) }));
      parsed = await read(link, chat.id, { ...args, ctx }, kind);
      if (!parsed) return null;
      r = parsed.reading;
    }
  }
  if (!ctx.machines.length) return tg.sendMessage(chat.id, t(lang, 'no_machines', { date: ctx.date }));
  if (!r.entries.length) {
    return tg.sendMessage(chat.id, [t(lang, 'nothing'), r.note ? t(lang, 'note', { note: tg.esc(r.note) }) : ''].filter(Boolean).join('\n\n'));
  }
  const payload = { date: ctx.date, lang, reading: r, answers: {}, waiting: null };
  const plan = builder.build({ reading: r, ctx, answers: {}, nowStamp: businessNow() });
  const id = await pending.open(link.user_id, chat.id, payload);
  if (!plan.steps.length && !plan.questions.length) await pending.close(id, 'Cancelled');
  return showProposal(chat.id, null, { id, payload }, ctx, plan, lang, r.note);
}

async function onVoice(link, chat, voice) {
  const lang = link.language;
  if (!transcriber.isConfigured()) return tg.sendMessage(chat.id, t(lang, 'voice_off'));
  if (Number(voice.duration) > transcriber.MAX_SECONDS) return tg.sendMessage(chat.id, t(lang, 'voice_long'));
  if (await usage.overLimit(link.user_id)) return tg.sendMessage(chat.id, t(lang, 'limit', { n: usage.limit() }));
  const ctx = await context.load(link.user_id, businessToday());
  const words = ctx.ok ? ctx.machines.map((m) => `${m.type_name_ar || m.type_name} ${m.type_seq || ''} ${m.vendor_name || ''}`.trim()) : [];
  let text;
  try {
    const audio = await tg.downloadFile(voice.file_id);
    text = (await transcriber.transcribe(audio, { mime: voice.mime_type || 'audio/ogg', words, language: lang })).text;
    await usage.log(link.user_id, 'voice', { model: 'stt' });
  } catch (e) {
    await usage.log(link.user_id, 'voice', { ok: false, code: e.code || 'ERROR' });
    return tg.sendMessage(chat.id, t(lang, 'voice_failed', { why: tg.esc(e.code || e.message) }));
  }
  if (!text) return tg.sendMessage(chat.id, t(lang, 'voice_empty'));
  await tg.sendMessage(chat.id, t(lang, 'heard', { text: tg.esc(text) }));
  return onText(link, chat, text, 'voice', ctx.ok ? ctx : null);
}

async function onStart(chat, from, code) {
  if (code) {
    const r = await links.linkWithCode(code, chat, from);
    if (!r.ok) return tg.sendMessage(chat.id, t('ar', { invalid: 'link_invalid', blocked: 'blocked_by_admin' }[r.reason] || 'not_eligible'));
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

async function onCallback(cb) {
  await tg.answerCallback(cb.id);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  if (!chatId || !tg.enabled()) return null;
  const messageId = cb.message.message_id;
  const link = await links.linkByChat(chatId);
  if (!link) return tg.sendMessage(chatId, t('ar', 'not_linked'));
  const why = blockedReason(link);
  if (why) return tg.sendMessage(chatId, t(link.language, why));
  const lang = link.language;
  const [kind, idText, qid, val] = String(cb.data || '').split('|');
  const p = await pending.get(link.user_id, Number(idText) || -1);
  if (kind === 'w' && p) {
    const ctx = await context.load(link.user_id, p.payload.date);
    return tg.sendMessage(chatId, ctx.ok ? view.notRecorded(ctx, lang) : t(lang, 'server_error', { why: errWhy(ctx) }));
  }
  if (!p || p.status !== 'Open' || !p.fresh) return tg.editMessage(chatId, messageId, t(lang, 'expired'));
  if (kind === 'x') {
    await pending.close(p.id, 'Cancelled');
    return tg.editMessage(chatId, messageId, t(lang, 'cancelled'));
  }
  if (kind === 'a') return next(chatId, messageId, p, link);
  if (kind === 'q') {
    const { ctx, plan } = await rebuild(link, p.payload);
    if (!plan) return tg.sendMessage(chatId, t(lang, 'server_error', { why: errWhy(ctx) }));
    const q = plan.questions.find((x) => x.id === qid);
    if (q) {
      const answers = p.payload.answers || {};
      if (val === 's') answers[qid] = 'skip';
      else if (q.kind === 'pick' && q.options.includes(Number(val))) {
        answers[qid] = Number(val);
        const m = ctx.machines.find((x) => x.n === Number(val));
        // learn his name for it, unless the words only say a type and a number (that fits several vendors' machines)
        const candidates = q.options.map((n) => ctx.machines.find((x) => x.n === n)).filter(Boolean);
        if (m && q.said && !aliases.isGeneric(q.said, candidates)) await aliases.save(link.user_id, q.said, m.equipment_id);
      } else if (q.kind === 'scope') {
        answers.scope = val === 'all' ? 'all' : q.options[Number(String(val).slice(1))] || 'all';
      }
      p.payload.answers = answers;
      p.payload.waiting = null;
      await pending.save(p.id, p.payload);
    }
    return next(chatId, messageId, p, link);
  }
  if (kind === 'c') {
    if (!(await pending.claim(p.id))) return tg.editMessage(chatId, messageId, t(lang, 'expired'));
    const { ctx, plan } = await rebuild(link, p.payload);
    if (!plan) return tg.editMessage(chatId, messageId, t(lang, 'server_error', { why: errWhy(ctx) }));
    const run = await executor.run(link.user_id, plan.steps);
    const keys = { inline_keyboard: [[{ text: t(lang, 'btn_why'), callback_data: `w|${p.id}` }]] };
    return tg.editMessage(chatId, messageId, view.result(run, plan, ctx, lang), { reply_markup: keys });
  }
  return null;
}

async function handleUpdate(update) {
  if (update && update.callback_query) return onCallback(update.callback_query);
  const msg = update && (update.message || update.edited_message);
  if (!msg || !msg.chat) return null;
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
  if (/^\/help$/i.test(text)) return tg.sendMessage(chat.id, t(link.language, 'help'));
  if (/^\/(status|today)$/i.test(text)) return tg.sendMessage(chat.id, await todayText(link));
  if (/^\/missing$/i.test(text)) {
    const ctx = await context.load(link.user_id, businessToday());
    return tg.sendMessage(chat.id, ctx.ok ? view.notRecorded(ctx, link.language) : t(link.language, 'server_error', { why: errWhy(ctx) }));
  }
  if (msg.voice || msg.audio) return onVoice(link, chat, msg.voice || msg.audio);
  if (!text) return tg.sendMessage(chat.id, t(link.language, 'help'));

  // the reason of a breakdown / standby the bot asked for
  const open = await pending.get(link.user_id);
  if (open && open.fresh && open.payload && open.payload.waiting && text.length <= 300) {
    open.payload.answers = { ...(open.payload.answers || {}), [open.payload.waiting]: text };
    open.payload.waiting = null;
    await pending.save(open.id, open.payload);
    return next(chat.id, null, open, link);
  }
  return onText(link, chat, text, 'text');
}

module.exports = { handleUpdate, todayText, guessDate };
