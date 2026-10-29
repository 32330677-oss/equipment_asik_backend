// services/telegram/bot.js — the supervisors' equipment bot (one Telegram update at a time).
//
// How a conversation works (29 Oct 2026):
//   * SESSION: the day / site / shift he is working on, remembered between messages (session.js).
//   * DRAFT: what he said, collected across messages and buttons, one item per machine (draft.js).
//   * The AI only turns his words into a fixed shape (parser.js); the CODE finds the machines on the chosen board
//     (matcher.js), asks what is missing (which machine, which board, times, reason), and checks everything against the
//     day board (builder.js). Nothing is written before he confirms; then the app's own routes save DRAFT rows.
//   * Guided mode: "📋 Record a day" -> day -> site / shift -> "all came at the usual time" or one machine at a time.
// Submit, recall, deletes, invoices stay in the app.
const tg = require('./telegramApi');
const links = require('./links');
const loopback = require('./loopback');
const { t, T } = require('./messages');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');
const context = require('./context');
const parser = require('./parser');
const ai = require('./ai');
const builder = require('./builder');
const draftLib = require('./draft');
const matcher = require('./matcher');
const pending = require('./pending');
const session = require('./session');
const view = require('./view');
const executor = require('./executor');
const aliases = require('./aliases');
const usage = require('./usage');
const transcriber = require('./transcriber');
const answerer = require('./answer');
const chatlog = require('./chatlog');
const { parseTimes } = require('./timeParse');

const STATES = ['working', 'on_break', 'breakdown', 'standby', 'finished', 'not_arrived', 'absent', 'holiday'];
const RETRY = new Set(['TIMEOUT', 'BUSY', 'BAD_REPLY', 'UNREACHABLE']);

tg.setOnSent((chatId, text) => chatlog.add(chatId, 'out', 'bot', text));

/** The keyboard always under the chat. */
function mainKeyboard(lang) {
  return { keyboard: [[{ text: t(lang, 'kb_record') }, { text: t(lang, 'kb_status') }], [{ text: t(lang, 'kb_missing') }, { text: t(lang, 'kb_machines') }], [{ text: t(lang, 'kb_help') }]], resize_keyboard: true, is_persistent: true };
}

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

// ------------------------------------------------------------------ dates said in words
const MONTHS = [
  ['كانون الثاني', 'يناير', 'جانفي', 'january', 'jan'], ['شباط', 'فبراير', 'february', 'feb'], ['آذار', 'اذار', 'مارس', 'march', 'mar'],
  ['نيسان', 'أبريل', 'ابريل', 'april', 'apr'], ['أيار', 'ايار', 'مايو', 'may'], ['حزيران', 'يونيو', 'june', 'jun'], ['تموز', 'يوليو', 'july', 'jul'],
  ['آب', 'اب', 'أغسطس', 'اغسطس', 'august', 'aug'], ['أيلول', 'ايلول', 'سبتمبر', 'september', 'sep'], ['تشرين الأول', 'تشرين الاول', 'أكتوبر', 'اكتوبر', 'october', 'oct'],
  ['تشرين الثاني', 'تشرين التاني', 'نوفمبر', 'november', 'nov'], ['كانون الأول', 'كانون الاول', 'ديسمبر', 'december', 'dec'],
];
const arDigits = (s) => String(s || '').replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
const pad = (n) => String(n).padStart(2, '0');

/** The day the message names, or null. ("مبارح", "28 أكتوبر", "28 تشرين الأول", "28/10", "يوم 28", "2026-10-28") */
function guessDate(text, today, nowHHMM) {
  const s = arDigits(text);
  const ok = (d) => { const r = builder.resolveDate(d, today); return r.date || null; };
  if (/(^|\s)(ا?مبارح|البارح[ةه]|أمس|امس|yesterday)(\s|$|[.,،])/i.test(s)) return addDays(today, -1);
  if (/(^|\s)(اول مبارح|أول مبارح|قبل مبارح|day before yesterday)(\s|$|[.,،])/i.test(s)) return addDays(today, -2);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s);
  if (iso) return ok(iso[1]);
  const year = today.slice(0, 4);
  for (let i = 0; i < MONTHS.length; i += 1) {
    for (const name of MONTHS[i]) {
      const re = new RegExp(`(\\d{1,2})\\s*(?:من\\s*)?(?:شهر\\s*)?${name}(?![\\u0600-\\u06FFa-z])`, 'i');
      const m = re.exec(s);
      if (m) return ok(`${year}-${pad(i + 1)}-${pad(m[1])}`);
    }
  }
  const dm = /(?:^|\s)(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?(?![\d:])/.exec(s);
  if (dm && Number(dm[2]) <= 12) return ok(`${dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : year}-${pad(dm[2])}-${pad(dm[1])}`);
  const day = /(?:^|\s)(?:يوم|نهار|بيوم|تاريخ|بتاريخ|لتاريخ|day|on the)\s*(\d{1,2})(?![\d:.])/i.exec(s);
  if (day) return ok(day[1]);
  // a night shift reported in the morning belongs to the evening before
  if (nowHHMM < '12:00' && /(الليلي|ليلي|المسائي|night)/i.test(s)) return addDays(today, -1);
  return null;
}

// ------------------------------------------------------------------ short replies understood by the code alone
function plain(text) {
  return String(text || '').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[!.؟?،,\s]+$/g, '').replace(/^[\s]+/, '').replace(/\s+/g, ' ').toLowerCase();
}
const QUICK = [
  ['confirm', /^(اي|ايه|ايوه|ايوا|اكيد|تمام|ماشي|سجل|سجلها|سجلهم|اوكي|اوك|تم|نعم|ok|okay|yes|y)$/],
  ['cancel', /^(لا|لاء|الغي|الغيها|الغيهم|بلاها|بلا|الغاء|cancel|no)$/],
  ['status', /^(شو الوضع|كيف الوضع|وين صرنا|الوضع|شو صار|status)$/],
  ['not_recorded', /^(شو ناقص|مين ما تسجل|شو باقي|مين باقي|الناقص|شو ما تسجل|missing)$/],
  ['machines', /^(شو الياتي|الياتي|شو عندي اليات|شو الاليات|شو الاليات الموجوده|الاليات الموجوده|my machines)$/],
  ['guided', /^(سجل يوم|بدي سجل|record a day)$/],
  ['today', /^(اليوم|رجاع لليوم|today)$/],
];
const KB = { kb_record: 'guided', kb_status: 'status', kb_missing: 'not_recorded', kb_machines: 'machines', kb_help: 'help' };
function quickIntent(text) {
  const raw = String(text || '').trim();
  for (const [key, intent] of Object.entries(KB)) if (raw === T.ar[key] || raw === T.en[key]) return intent;
  const p = plain(raw);
  if (!p || p.length > 40) return null;
  const hit = QUICK.find(([, re]) => re.test(p));
  return hit ? hit[0] : null;
}

// ------------------------------------------------------------------ AI read
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
      if (!e.code) console.error('Telegram parse failed:', e.message);
      const key = ['NOT_CONFIGURED', 'TIMEOUT', 'BUSY', 'TRUNCATED'].includes(code) ? `ai_${code}` : 'ai_other';
      await tg.sendMessage(chatId, t(link.language, key, { code }));
      return null;
    }
  }
  return null;
}

const errWhy = (ctx) => tg.esc((ctx && ctx.error && (ctx.error.message || ctx.error.code || ctx.error.status)) || '');

// ------------------------------------------------------------------ session + draft
/** The open draft of the session (or null), and the session. */
async function current(link) {
  const ses = await session.get(link.user_id);
  let p = ses.draftId ? await pending.get(link.user_id, ses.draftId) : null;
  if (p && (p.status !== 'Open' || !p.fresh || !p.payload || p.payload.v !== 2)) p = null;
  return { ses, p };
}

async function newDraft(link, chatId, { date, siteId = null, shift = null }) {
  const payload = draftLib.create({ date, siteId, shift });
  const id = await pending.open(link.user_id, chatId, payload);
  await session.set(link.user_id, { date, siteId, shift, draftId: id });
  return { id, payload, messageId: null };
}

async function saveDraft(link, p) {
  await pending.save(p.id, p.payload);
  await session.set(link.user_id, { date: p.payload.date, siteId: p.payload.siteId, shift: p.payload.shift, draftId: p.id });
}

async function rebuild(link, payload) {
  const ctx = await context.load(link.user_id, payload.date);
  if (!ctx.ok) return { ctx, plan: null };
  return { ctx, plan: draftLib.plan(payload, ctx, businessNow()) };
}

async function send(chatId, messageId, v) {
  return messageId ? tg.editMessage(chatId, messageId, v.text, { reply_markup: v.keyboard }) : tg.sendMessage(chatId, v.text, { reply_markup: v.keyboard });
}

async function showProposal(chatId, messageId, p, ctx, plan, lang, note = '') {
  const v = view.proposal(plan, ctx, lang, p.id, p.payload);
  const text = note ? `${v.text}\n\n${t(lang, 'note', { note: tg.esc(note) })}` : v.text;
  const m = await send(chatId, messageId, { text, keyboard: v.keyboard });
  if (m && m.message_id && m.message_id !== messageId) await pending.setMessage(p.id, m.message_id);
}

/** What the bot waits for as a typed answer: 't:<key>' (times) or 'r:<key>:<k>' (a reason). */
function waitingFor(q) {
  if (q.kind === 'times') return `t:${q.key}`;
  if (q.kind === 'reason' && q.key) return `r:${q.key}:${q.k === null || q.k === undefined ? '' : q.k}`;
  return null;
}

async function showQuestion(chatId, messageId, p, ctx, q, lang) {
  p.payload.waiting = waitingFor(q);
  await pending.save(p.id, p.payload);
  return send(chatId, messageId, view.question(q, ctx, lang, p.id));
}

/** After a change: the proposal, then the first open question (if any) as its own message. */
async function showDraft(chatId, messageId, p, link, note = '') {
  const lang = link.language;
  const { ctx, plan } = await rebuild(link, p.payload);
  if (!plan) return tg.sendMessage(chatId, t(lang, 'server_error', { why: errWhy(ctx) }));
  if (!p.payload.items.length && !p.payload.open.length && !plan.skipped.length) {
    p.payload.waiting = null;
    await pending.save(p.id, p.payload);
    return tg.sendMessage(chatId, [t(lang, 'draft_empty'), note ? t(lang, 'note', { note: tg.esc(note) }) : ''].filter(Boolean).join('\n\n'));
  }
  await showProposal(chatId, messageId, p, ctx, plan, lang, note);
  if (plan.questions.length) return showQuestion(chatId, null, p, ctx, plan.questions[0], lang);
  p.payload.waiting = null;
  return pending.save(p.id, p.payload);
}

async function cancelOpen(link, chatId) {
  const { p } = await current(link);
  const any = p || (await pending.get(link.user_id));
  if (!any) return tg.sendMessage(chatId, t(link.language, 'nothing_open'));
  await pending.close(any.id, 'Cancelled');
  await session.set(link.user_id, { draftId: null });
  return tg.sendMessage(chatId, t(link.language, 'cancelled'));
}

/** Confirm: claims the draft (a second tap finds nothing), checks it again, records through the app's routes. */
async function confirm(chatId, messageId, p, link) {
  const lang = link.language;
  if (!(await pending.claim(p.id))) return tg.editMessage(chatId, messageId, t(lang, 'expired'));
  const { ctx, plan } = await rebuild(link, p.payload);
  if (!plan) return tg.editMessage(chatId, messageId, t(lang, 'server_error', { why: errWhy(ctx) }));
  const run = await executor.run(link.user_id, plan.steps);
  await session.set(link.user_id, { draftId: null }); // the day / site stay for the next message
  const keys = { inline_keyboard: [[{ text: t(lang, 'btn_why'), callback_data: `w|${p.id}` }]] };
  return tg.editMessage(chatId, messageId, view.result(run, plan, ctx, lang), { reply_markup: keys });
}

async function confirmByText(link, chatId) {
  const { p } = await current(link);
  if (!p) return tg.sendMessage(chatId, t(link.language, 'nothing_open'));
  const { ctx, plan } = await rebuild(link, p.payload);
  if (plan && plan.questions.length) return showQuestion(chatId, null, p, ctx, plan.questions[0], link.language);
  return confirm(chatId, p.messageId, p, link);
}

// ------------------------------------------------------------------ a message about machines
async function onText(link, chat, text, kind = 'text', preCtx = null) {
  const lang = link.language;
  if (await usage.overLimit(link.user_id)) return tg.sendMessage(chat.id, t(lang, 'limit', { n: usage.limit() }));
  const today = businessToday();
  const now = businessNow();
  let { ses, p } = await current(link);
  const said = guessDate(text, today, now.slice(11, 16));
  let date = said || (p && p.payload.date) || ses.date || today;
  let ctx = preCtx && preCtx.date === date ? preCtx : await context.load(link.user_id, date);
  if (!ctx.ok) return tg.sendMessage(chat.id, t(lang, 'server_error', { why: errWhy(ctx) }));
  const siteOf = (id) => (ctx.boards.find((b) => b.site_id === id) || {}).site_code;
  const sesInfo = () => ({ date, siteCode: (p && siteOf(p.payload.siteId)) || siteOf(ses.siteId) || null, shift: (p && p.payload.shift) || ses.shift || null });
  const args = () => ({ text, ctx, session: sesInfo(), draft: p && p.payload.date === ctx.date ? draftLib.summary(p.payload, ctx) : [], now: { date: today, time: now.slice(11, 16) }, lang });
  let parsed = await read(link, chat.id, args(), kind);
  if (!parsed) return null;
  let r = parsed.reading;
  if (!r.entries.length && ['record', 'other'].includes(r.intent) && ai.strongModel() && ctx.machines.length) {
    const again = await read(link, chat.id, { ...args(), strong: true }, 'second_look');
    if (again && (again.reading.entries.length || again.reading.intent !== r.intent)) r = again.reading;
  }
  if (r.intent === 'status') return tg.sendMessage(chat.id, await todayText(link));
  if (r.intent === 'not_recorded') return tg.sendMessage(chat.id, view.notRecorded(ctx, lang));
  if (r.intent === 'machines') return tg.sendMessage(chat.id, view.machineList(ctx, lang));
  if (r.intent === 'question' && !r.entries.length) return onQuestion(link, chat.id, text);
  if (r.intent === 'help') return tg.sendMessage(chat.id, t(lang, 'help'), { reply_markup: mainKeyboard(lang) });
  if (r.intent === 'confirm' && !r.entries.length) return confirmByText(link, chat.id);
  if (r.intent === 'cancel' && !r.entries.length) return cancelOpen(link, chat.id);

  // the day he said (the AI may read a date the code did not): read the machines of that day
  if (r.work_date && !said) {
    const d = builder.resolveDate(r.work_date, today);
    if (d.error) return tg.sendMessage(chat.id, t(lang, d.error));
    if (d.date !== ctx.date) {
      date = d.date;
      ctx = await context.load(link.user_id, date);
      if (!ctx.ok) return tg.sendMessage(chat.id, t(lang, 'server_error', { why: errWhy(ctx) }));
      parsed = await read(link, chat.id, args(), kind);
      if (!parsed) return null;
      r = parsed.reading;
    }
  }
  if (!ctx.machines.length) return tg.sendMessage(chat.id, t(lang, 'no_machines', { date: ctx.date }));

  // the board(s) he named, else the draft's, else the only one there is
  let siteId = p && p.payload.date === ctx.date ? p.payload.siteId : (ses.date === ctx.date ? ses.siteId : null);
  let shift = p && p.payload.date === ctx.date ? p.payload.shift : (ses.date === ctx.date ? ses.shift : null);
  if (r.site || r.shift) {
    const fit = matcher.boardsFor(r.site, r.shift, ctx.boards);
    if (fit.length === 1) { siteId = fit[0].site_id; shift = fit[0].shift; } else if (fit.length > 1 && new Set(fit.map((b) => b.site_id)).size === 1) { siteId = fit[0].site_id; shift = r.shift || null; }
  }
  if (!siteId && ctx.boards.length === 1) { siteId = ctx.boards[0].site_id; shift = ctx.boards[0].shift; }

  if (!p || p.payload.date !== ctx.date) p = await newDraft(link, chat.id, { date: ctx.date, siteId, shift });
  else { p.payload.siteId = siteId; p.payload.shift = shift; }

  // only the day / site said: confirm it and offer the next step
  if (!r.entries.length) {
    await saveDraft(link, p);
    if (r.intent === 'set_context' || said || r.site || r.shift) {
      const b = siteId && shift ? view.boardIntro(p.payload, ctx, lang, p.id) : null;
      if (b) return tg.sendMessage(chat.id, t(lang, 'ctx_set', { header: view.header(p.payload, ctx, lang) }), { reply_markup: b.keyboard });
      return send(chat.id, null, view.boardPicker(ctx, lang));
    }
    return tg.sendMessage(chat.id, [t(lang, r.intent === 'record' ? 'nothing' : 'nothing_for'), r.note ? t(lang, 'note', { note: tg.esc(r.note) }) : ''].filter(Boolean).join('\n\n'));
  }
  draftLib.apply(p.payload, r, ctx, { aliases: await aliases.forUser(link.user_id) });
  await saveDraft(link, p);
  return showDraft(chat.id, null, p, link, r.note);
}

/** A question about his machines: read through his own routes, answered from that data only. */
async function onQuestion(link, chatId, text) {
  const lang = link.language;
  const log = (kind, r) => usage.log(link.user_id, kind, { model: r.model, latencyMs: r.latencyMs, usage: r.usage });
  try {
    const r = await answerer.answer({ userId: link.user_id, text, today: businessToday(), lang, log });
    if (r.text) return tg.sendMessage(chatId, tg.esc(r.text));
    return tg.sendMessage(chatId, t(lang, r.key, r.vars || {}));
  } catch (e) {
    const code = e.code || 'ERROR';
    await usage.log(link.user_id, 'question', { ok: false, code });
    if (!e.code) console.error('Telegram question failed:', e.message);
    const key = ['NOT_CONFIGURED', 'TIMEOUT', 'BUSY', 'TRUNCATED'].includes(code) ? `ai_${code}` : 'ai_other';
    return tg.sendMessage(chatId, t(lang, key, { code }));
  }
}

/** A typed answer to the question the bot is waiting on (times / reason). Returns true when it was one. */
async function onAnswer(link, chatId, text) {
  const { p } = await current(link);
  if (!p || !p.payload.waiting) return false;
  const w = p.payload.waiting;
  if (w.startsWith('t:')) {
    const key = w.slice(2);
    const shift = key.split(':')[2] || 'Day';
    const times = parseTimes(text, shift);
    if (!times) return false; // not a time answer: read it as a new message (the question stays)
    draftLib.answerTimes(p.payload, key, times);
  } else if (w.startsWith('r:')) {
    if (String(text).trim().length < 2 || text.length > 300) return false;
    const [, eq, site, sh, k] = w.split(':');
    draftLib.answerReason(p.payload, `${eq}:${site}:${sh}`, k, String(text).trim());
  } else return false;
  p.payload.waiting = null;
  await saveDraft(link, p);
  await showDraft(chatId, null, p, link);
  return true;
}

async function onVoice(link, chat, voice) {
  const lang = link.language;
  if (!transcriber.isConfigured()) return tg.sendMessage(chat.id, t(lang, 'voice_off'));
  if (Number(voice.duration) > transcriber.MAX_SECONDS) return tg.sendMessage(chat.id, t(lang, 'voice_long'));
  if (await usage.overLimit(link.user_id)) return tg.sendMessage(chat.id, t(lang, 'limit', { n: usage.limit() }));
  const { ses } = await current(link);
  const ctx = await context.load(link.user_id, ses.date || businessToday());
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
  await chatlog.add(chat.id, 'in', 'voice', text, link.user_id);
  await tg.sendMessage(chat.id, t(lang, 'heard', { text: tg.esc(text) }));
  if (await onAnswer(link, chat.id, text)) return null;
  const quick = quickIntent(text);
  if (quick === 'confirm') return confirmByText(link, chat.id);
  if (quick === 'cancel') return cancelOpen(link, chat.id);
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
  return tg.sendMessage(chat.id, t(link.language, 'coming_soon'), { reply_markup: mainKeyboard(link.language) });
}

// ------------------------------------------------------------------ guided mode
async function guidedStart(link, chatId) {
  return send(chatId, null, view.dayPicker(link.language, businessToday(), addDays));
}

async function pickDay(link, chatId, messageId, date) {
  const lang = link.language;
  const d = builder.resolveDate(date, businessToday());
  if (d.error) return tg.sendMessage(chatId, t(lang, d.error));
  const ctx = await context.load(link.user_id, d.date);
  if (!ctx.ok) return tg.sendMessage(chatId, t(lang, 'server_error', { why: errWhy(ctx) }));
  if (!ctx.machines.length) return tg.editMessage(chatId, messageId, t(lang, 'no_machines', { date: d.date }));
  const one = ctx.boards.length === 1 ? ctx.boards[0] : null;
  const p = await newDraft(link, chatId, { date: d.date, siteId: one ? one.site_id : null, shift: one ? one.shift : null });
  if (one) return send(chatId, messageId, view.boardIntro(p.payload, ctx, lang, p.id));
  return send(chatId, messageId, view.boardPicker(ctx, lang));
}

async function pickBoard(link, chatId, messageId, boardKey) {
  const lang = link.language;
  const [siteId, shift] = String(boardKey).split(':');
  let { ses, p } = await current(link);
  const date = (p && p.payload.date) || ses.date || businessToday();
  const ctx = await context.load(link.user_id, date);
  if (!ctx.ok) return tg.sendMessage(chatId, t(lang, 'server_error', { why: errWhy(ctx) }));
  if (!p) p = await newDraft(link, chatId, { date, siteId: Number(siteId), shift });
  p.payload.siteId = Number(siteId);
  p.payload.shift = shift;
  await saveDraft(link, p);
  return send(chatId, messageId, view.boardIntro(p.payload, ctx, lang, p.id));
}

// ------------------------------------------------------------------ buttons
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
  await chatlog.add(chatId, 'in', 'button', cb.data, link.user_id);
  const [kind, a1, a2, a3] = String(cb.data || '').split('|');
  if (kind === 'd') return pickDay(link, chatId, messageId, a1);
  if (kind === 'b') return pickBoard(link, chatId, messageId, a1);

  const p = await pending.get(link.user_id, Number(a1) || -1);
  if (kind === 'w' && p) {
    const ctx = await context.load(link.user_id, p.payload.date);
    return tg.sendMessage(chatId, ctx.ok ? view.notRecorded(ctx, lang) : t(lang, 'server_error', { why: errWhy(ctx) }));
  }
  if (!p || p.status !== 'Open' || !p.fresh || !p.payload || p.payload.v !== 2) return tg.editMessage(chatId, messageId, t(lang, 'expired'));
  if (kind === 'x') {
    await pending.close(p.id, 'Cancelled');
    await session.set(link.user_id, { draftId: null });
    return tg.editMessage(chatId, messageId, t(lang, 'cancelled'));
  }
  if (kind === 'c') return confirm(chatId, messageId, p, link);
  if (kind === 'a') return showDraft(chatId, messageId, p, link);

  const ctx = await context.load(link.user_id, p.payload.date);
  if (!ctx.ok) return tg.sendMessage(chatId, t(lang, 'server_error', { why: errWhy(ctx) }));
  if (kind === 'ml') return send(chatId, messageId, view.machineButtons(p.payload, ctx, lang, p.id));
  if (kind === 'm') {
    const m = ctx.machines.find((x) => x.key === a2);
    if (!m) return null;
    const b = ctx.boards.find((x) => x.site_id === m.site_id && x.shift === m.shift) || {};
    return send(chatId, messageId, view.machineMenu(m, b.start, ctx, lang, p.id));
  }
  if (kind === 't') {
    const m = ctx.machines.find((x) => x.key === a2);
    if (!m) return null;
    const b = ctx.boards.find((x) => x.site_id === m.site_id && x.shift === m.shift) || {};
    draftLib.tap(p.payload, m, a3, b.start);
    await saveDraft(link, p);
    if (a3 === 'time' || a3 === 'brk') return showDraft(chatId, null, p, link);
    return send(chatId, messageId, view.machineButtons(p.payload, ctx, lang, p.id));
  }
  if (kind === 'ai') {
    const ms = draftLib.scope(p.payload, ctx);
    for (const m of ms) {
      const b = ctx.boards.find((x) => x.site_id === m.site_id && x.shift === m.shift) || {};
      if (!m.row && b.start && !p.payload.items.some((x) => x.key === m.key)) draftLib.tap(p.payload, m, 'in', b.start);
    }
    await saveDraft(link, p);
    return showDraft(chatId, messageId, p, link);
  }
  if (kind === 'q') {
    const { plan } = await rebuild(link, p.payload);
    const q = plan && plan.questions.find((x) => x.id === a2);
    if (q && q.kind === 'pick') {
      const key = a3 === 's' ? 'skip' : q.candidates[Number(a3)];
      const r = draftLib.answerPick(p.payload, q.id, key, ctx);
      if (r && r.machine && r.said) {
        const cands = (r.candidates || []).map((k) => ctx.machines.find((x) => x.key === k)).filter(Boolean);
        if (!aliases.isGeneric(r.said, cands)) await aliases.save(link.user_id, r.said, r.machine.equipment_id);
      }
    } else if (q && q.kind === 'scope') {
      draftLib.answerScope(p.payload, q.id, a3 === 'all' || a3 === 's' ? 'all' : q.options[Number(String(a3).slice(1))], ctx, await aliases.forUser(link.user_id));
    } else if (q && q.kind === 'times' && a3 === 's') {
      p.payload.items = p.payload.items.filter((x) => x.key !== q.key);
    } else if (q && q.kind === 'reason' && a3 === 's') {
      p.payload.items = p.payload.items.filter((x) => x.key !== q.key);
    }
    p.payload.waiting = null;
    await saveDraft(link, p);
    return showDraft(chatId, messageId, p, link);
  }
  return null;
}

// ------------------------------------------------------------------ entry
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
  if (text) await chatlog.add(chat.id, 'in', 'text', text, link.user_id);

  if (/^\/(en|english)$/i.test(text) || /^english$/i.test(text)) {
    await links.setLanguage(link.user_id, 'en');
    return tg.sendMessage(chat.id, t('en', 'lang_set'), { reply_markup: mainKeyboard('en') });
  }
  if (/^\/(ar|arabic)$/i.test(text) || text === 'عربي') {
    await links.setLanguage(link.user_id, 'ar');
    return tg.sendMessage(chat.id, t('ar', 'lang_set'), { reply_markup: mainKeyboard('ar') });
  }
  if (/^\/help$/i.test(text)) return tg.sendMessage(chat.id, t(link.language, 'help'), { reply_markup: mainKeyboard(link.language) });
  if (/^\/(status|today)$/i.test(text)) return tg.sendMessage(chat.id, await todayText(link));
  if (/^\/(record|day)$/i.test(text)) return guidedStart(link, chat.id);
  if (/^\/missing$/i.test(text)) {
    const ctx = await context.load(link.user_id, businessToday());
    return tg.sendMessage(chat.id, ctx.ok ? view.notRecorded(ctx, link.language) : t(link.language, 'server_error', { why: errWhy(ctx) }));
  }
  if (msg.voice || msg.audio) return onVoice(link, chat, msg.voice || msg.audio);
  if (!text) return tg.sendMessage(chat.id, t(link.language, 'help'), { reply_markup: mainKeyboard(link.language) });

  // "yes" / "cancel" first (never taken as a reason or a time)
  const quick = quickIntent(text);
  if (quick === 'confirm') return confirmByText(link, chat.id);
  if (quick === 'cancel') return cancelOpen(link, chat.id);
  // the answer to the question the bot is waiting on (times, reason)
  if (await onAnswer(link, chat.id, text)) return null;
  if (quick === 'guided') return guidedStart(link, chat.id);
  if (quick === 'help') return tg.sendMessage(chat.id, t(link.language, 'help'), { reply_markup: mainKeyboard(link.language) });
  if (quick === 'today') {
    await session.set(link.user_id, { date: null, siteId: null, shift: null, draftId: null });
    return tg.sendMessage(chat.id, await todayText(link));
  }
  if (quick === 'status') return tg.sendMessage(chat.id, await todayText(link));
  if (quick === 'not_recorded' || quick === 'machines') {
    const { ses } = await current(link);
    const ctx = await context.load(link.user_id, ses.date || businessToday());
    if (!ctx.ok) return tg.sendMessage(chat.id, t(link.language, 'server_error', { why: errWhy(ctx) }));
    return tg.sendMessage(chat.id, quick === 'machines' ? view.machineList(ctx, link.language) : view.notRecorded(ctx, link.language));
  }
  return onText(link, chat, text, 'text');
}

module.exports = { handleUpdate, todayText, guessDate, quickIntent, mainKeyboard };
