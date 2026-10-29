// services/telegram/view.js — the bot's messages built from a plan (proposal, one question, result, what is missing).
// Fixed templates only (messages.js); machine names come from the day board.
const { t } = require('./messages');
const { esc } = require('./telegramApi');
const { machineName } = require('./context');

const ROW_MAX = 30; // lines per section, then "+N"

function boardOf(ctx, m) { return ctx.boards.find((b) => b.site_id === m.site_id && b.shift === m.shift) || {}; }
function manyBoards(ctx) { return new Set(ctx.machines.map((m) => `${m.site_id}|${m.shift}`)).size > 1; }

function name(ctx, n, lang) {
  const m = ctx.machines.find((x) => x.n === n);
  if (!m) return '?';
  const base = machineName(m, lang);
  return manyBoards(ctx) ? `${base} (${m.site_code} ${t(lang, `shift_${m.shift}`)})` : base;
}

function nameByKey(ctx, key, lang) {
  const m = ctx.machines.find((x) => x.key === key);
  return m ? name(ctx, m.n, lang) : '?';
}

/** "📅 2026-10-28 · 📍 S-BRIDGES · نهاري": what the draft is about. */
function header(draft, ctx, lang) {
  const b = draft && draft.siteId ? ctx.boards.find((x) => x.site_id === draft.siteId && (!draft.shift || x.shift === draft.shift)) : null;
  const parts = [`📅 <b>${esc(ctx.date)}</b>`];
  if (b) parts.push(`📍 <b>${esc(b.site_code)}</b>`);
  if (draft && draft.shift) parts.push(t(lang, `shift_${draft.shift}`));
  return parts.join(' · ');
}

function boardLabel(ctx, key, lang) {
  const [siteId, shift] = String(key).split(':');
  const b = ctx.boards.find((x) => String(x.site_id) === siteId && x.shift === shift) || {};
  return `${b.site_code || siteId} · ${t(lang, `shift_${shift}`)}`;
}

function lineText(l, ctx, lang) {
  const parts = [];
  if (l.status) {
    parts.push(t(lang, `ds_${l.status}`));
    if (l.reason) parts.push(t(lang, 'l_reason', { r: esc(l.reason) }));
    if (l.discards) parts.push(t(lang, 'l_discards'));
  }
  if (l.in) parts.push(t(lang, 'l_in', { t: l.in }));
  if (l.editIn) parts.push(t(lang, 'l_edit_in', l.editIn));
  if (l.out) parts.push(t(lang, 'l_out', { t: l.out }));
  if (l.editOut) parts.push(t(lang, 'l_edit_out', l.editOut));
  if (l.meterStart !== null && l.meterStart !== undefined) parts.push(t(lang, 'l_meter_start', { v: l.meterStart }));
  if (l.meterEnd !== null && l.meterEnd !== undefined) parts.push(t(lang, 'l_meter_end', { v: l.meterEnd }));
  if (l.replaces && l.replaces !== 'Working') parts.push(t(lang, 'l_replaces', { s: t(lang, `ds_${l.replaces}`) }));
  for (const d of l.downtimes || []) {
    parts.push(t(lang, 'l_downtime', { type: t(lang, `dt_${d.type}`), start: d.start, end: d.end ? `–${d.end}` : '' }) + (d.reason ? ` (${esc(d.reason)})` : ''));
  }
  return `• ${esc(name(ctx, l.n, lang))}: ${parts.join('، ')}`;
}

function skippedText(s, ctx, lang) {
  const who = s.n ? esc(name(ctx, s.n, lang)) : '';
  const why = t(lang, `why_${s.why}`, { said: esc(s.said), ...Object.fromEntries(Object.entries(s.vars || {}).map(([k, v]) => [k, esc(v)])) });
  return `• ${who ? `${who}: ` : ''}${why}`;
}

function cut(lines) {
  return lines.length > ROW_MAX ? [...lines.slice(0, ROW_MAX), `… +${lines.length - ROW_MAX}`] : lines;
}

/** The proposal: what will be recorded, what not and why, the questions still open, with its buttons. */
function proposal(plan, ctx, lang, id, draft = null) {
  const out = [`${t(lang, 'proposal_title', { date: '' }).replace(/\s*·\s*$/, '')}\n${header(draft, ctx, lang)}`];
  if (plan.lines.length) out.push(cut(plan.lines.map((l) => lineText(l, ctx, lang))).join('\n'));
  if (plan.skipped.length) out.push(`${t(lang, 'skipped_title')}\n${cut(plan.skipped.map((s) => skippedText(s, ctx, lang))).join('\n')}`);
  if (plan.questions.length) out.push(t(lang, 'questions_count', { n: plan.questions.length }));
  const n = new Set(plan.steps.map((s) => s.n)).size;
  const row = [];
  if (n) row.push({ text: t(lang, plan.questions.length ? 'btn_confirm_clear' : 'btn_confirm', { n }), callback_data: `c|${id}` });
  if (plan.questions.length) row.push({ text: t(lang, 'btn_answer', { n: plan.questions.length }), callback_data: `a|${id}` });
  const keys = [row, [{ text: t(lang, 'btn_each'), callback_data: `ml|${id}` }, { text: t(lang, 'btn_cancel'), callback_data: `x|${id}` }]].filter((r) => r.length);
  return { text: out.join('\n\n'), keyboard: { inline_keyboard: keys } };
}

/** One open question with its buttons. */
function question(q, ctx, lang, id) {
  const skip = { text: t(lang, 'btn_skip'), callback_data: `q|${id}|${q.id}|s` };
  if (q.kind === 'pick') {
    const keys = q.candidates.map((key, k) => [{ text: nameByKey(ctx, key, lang).slice(0, 60), callback_data: `q|${id}|${q.id}|${k}` }]);
    const text = q.candidates.length && !q.weak ? t(lang, 'q_pick', { said: esc(q.said) }) : t(lang, 'q_pick_none', { said: esc(q.said) });
    return { text, keyboard: { inline_keyboard: [...keys, [skip]] } };
  }
  if (q.kind === 'scope') {
    const keys = q.options.map((key, k) => [{ text: boardLabel(ctx, key, lang), callback_data: `q|${id}|${q.id}|b${k}` }]);
    keys.push([{ text: t(lang, 'btn_all'), callback_data: `q|${id}|${q.id}|all` }]);
    return { text: t(lang, 'q_scope'), keyboard: { inline_keyboard: keys } };
  }
  if (q.kind === 'times') {
    if (q.key === '*') return { text: t(lang, 'q_times_all', { n: q.count }), keyboard: { inline_keyboard: [[skip]] } };
    return { text: t(lang, 'q_times', { name: esc(nameByKey(ctx, q.key, lang)) }), keyboard: { inline_keyboard: [[skip]] } };
  }
  const what = t(lang, q.downtime ? `dt_${q.status}` : `ds_${q.status}`);
  return { text: t(lang, 'q_reason', { name: esc(name(ctx, q.n, lang)), what }), keyboard: { inline_keyboard: [[skip]] } };
}

/** After Confirm: saved, refused (with the app's reason), still open. */
function result(run, plan, ctx, lang) {
  const out = [];
  out.push(run.done.length ? t(lang, 'res_done', { n: run.done.length }) : t(lang, 'res_none'));
  const bad = [
    ...run.failed.map((f) => `• ${esc(name(ctx, f.n, lang))}: ${esc(f.message || f.code)}`),
    ...plan.skipped.map((s) => skippedText(s, ctx, lang)),
    ...plan.questions.map((q) => (q.n ? `• ${esc(name(ctx, q.n, lang))}: ${t(lang, 'why_unanswered')}` : `• «${esc(q.said || '')}»: ${t(lang, 'why_unanswered')}`)),
  ];
  if (bad.length) out.push(`${t(lang, 'res_failed')}\n${cut(bad).join('\n')}`);
  if (run.late) out.push(t(lang, 'res_late'));
  if (run.done.length) out.push(t(lang, 'res_submit'));
  return out.join('\n\n');
}

/** "What is missing": per site / shift, machines with no row and machines still checked in. */
function notRecorded(ctx, lang) {
  const out = [t(lang, 'nr_title', { date: ctx.date })];
  let any = false;
  for (const b of ctx.boards) {
    const ms = ctx.machines.filter((m) => m.site_id === b.site_id && m.shift === b.shift);
    const missing = ms.filter((m) => !m.row).map((m) => esc(machineName(m, lang)));
    const open = ms.filter((m) => m.row && m.row.day_status === 'Working' && m.row.in && !m.row.out).map((m) => esc(machineName(m, lang)));
    if (!missing.length && !open.length) continue;
    any = true;
    const lines = [t(lang, 'proposal_board', { site: esc(`${b.site_code} ${b.site_name || ''}`.trim()), shift: t(lang, `shift_${b.shift}`) })];
    if (missing.length) lines.push(t(lang, 'nr_missing', { list: missing.join('، ') }));
    if (open.length) lines.push(t(lang, 'nr_open', { list: open.join('، ') }));
    out.push(lines.join('\n'));
  }
  if (!any) out.push(t(lang, 'nr_all_done'));
  return out.join('\n\n');
}

const STATE_KEY = { Working: 'working', OnBreak: 'on_break', Breakdown: 'breakdown', Standby: 'standby', NotArrived: 'not_arrived', Finished: 'finished', Absent: 'absent', Holiday: 'holiday' };

/** "Which machines do I have": per site / shift, every machine with its vendor and its state today. */
function machineList(ctx, lang) {
  const out = [t(lang, 'ml_title', { date: ctx.date })];
  if (!ctx.machines.length) out.push(t(lang, 'no_machines', { date: ctx.date }));
  for (const b of ctx.boards) {
    const ms = ctx.machines.filter((m) => m.site_id === b.site_id && m.shift === b.shift);
    if (!ms.length) continue;
    const head = t(lang, 'proposal_board', { site: esc(`${b.site_code} ${b.site_name || ''}`.trim()), shift: t(lang, `shift_${b.shift}`) });
    const lines = ms.map((m) => `• ${esc(machineName(m, lang))}${m.plate ? ` · ${esc(m.plate)}` : ''} — ${t(lang, `st_${STATE_KEY[m.state] || 'not_arrived'}`)}`);
    out.push(`${head} (${ms.length})\n${cut(lines).join('\n')}`);
  }
  return out.join('\n\n');
}

/** Guided mode: which day? */
function dayPicker(lang, today, addDays) {
  const d = [today, addDays(today, -1), addDays(today, -2)];
  return { text: t(lang, 'g_day'), keyboard: { inline_keyboard: [[
    { text: t(lang, 'g_today'), callback_data: `d|${d[0]}` }, { text: t(lang, 'g_yesterday'), callback_data: `d|${d[1]}` }, { text: d[2], callback_data: `d|${d[2]}` },
  ]] } };
}

/** Guided mode: which site / shift? */
function boardPicker(ctx, lang) {
  const keys = ctx.boards.map((b) => [{ text: `${b.site_code} · ${t(lang, `shift_${b.shift}`)}`, callback_data: `b|${b.site_id}:${b.shift}` }]);
  return { text: `${header(null, ctx, lang)}\n${t(lang, 'g_board')}`, keyboard: { inline_keyboard: keys } };
}

/** Guided mode: the board chosen; what next. */
function boardIntro(draft, ctx, lang, id, past = false) {
  const ms = ctx.machines.filter((m) => m.site_id === draft.siteId && m.shift === draft.shift);
  const b = ctx.boards.find((x) => x.site_id === draft.siteId && x.shift === draft.shift) || {};
  const free = ms.filter((m) => !m.row).length;
  const keys = [];
  // today: they came at the shift start (still working); an old day: one question for both times
  if (past && free) keys.push([{ text: t(lang, 'btn_all_in_past', { n: free }), callback_data: `ai|${id}` }]);
  else if (b.start && free) keys.push([{ text: t(lang, 'btn_all_in', { t: b.start, n: free }), callback_data: `ai|${id}` }]);
  keys.push([{ text: t(lang, 'btn_each'), callback_data: `ml|${id}` }]);
  return { text: `${header(draft, ctx, lang)}\n${t(lang, 'g_intro', { n: ms.length, free })}`, keyboard: { inline_keyboard: keys } };
}

/** Guided mode: every machine of the board as a button (with what the draft or the board says about it). */
function machineButtons(draft, ctx, lang, id) {
  const ms = ctx.machines.filter((m) => (!draft.siteId || m.site_id === draft.siteId) && (!draft.shift || m.shift === draft.shift)).slice(0, 40);
  const keys = ms.map((m) => {
    const it = draft.items.find((x) => x.key === m.key);
    const mark = it ? (it.status === 'Absent' ? '❌' : it.status ? '🔧' : it.needTimes ? '⏰' : '✅') : (m.row ? '☑️' : '▫️');
    return [{ text: `${mark} ${machineName(m, lang)}`.slice(0, 60), callback_data: `m|${id}|${m.key}` }];
  });
  keys.push([{ text: t(lang, 'btn_show_draft'), callback_data: `a|${id}` }]);
  return { text: `${header(draft, ctx, lang)}\n${t(lang, 'g_pick_machine')}`, keyboard: { inline_keyboard: keys } };
}

/** Guided mode: what happened to this machine? */
function machineMenu(m, start, ctx, lang, id) {
  const k = m.key;
  const row1 = [];
  if (start) row1.push({ text: t(lang, 'btn_m_in', { t: start }), callback_data: `t|${id}|${k}|in` });
  row1.push({ text: t(lang, 'btn_m_time'), callback_data: `t|${id}|${k}|time` });
  return { text: `<b>${esc(name(ctx, m.n, lang))}</b>`, keyboard: { inline_keyboard: [
    row1,
    [{ text: t(lang, 'btn_m_abs'), callback_data: `t|${id}|${k}|abs` }, { text: t(lang, 'btn_m_brk'), callback_data: `t|${id}|${k}|brk` }],
    [{ text: t(lang, 'btn_m_del'), callback_data: `t|${id}|${k}|del` }, { text: t(lang, 'btn_back'), callback_data: `ml|${id}` }],
  ] } };
}

module.exports = { proposal, question, result, notRecorded, machineList, name, header, dayPicker, boardPicker, boardIntro, machineButtons, machineMenu };
