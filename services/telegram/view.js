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

function boardLabel(ctx, key, lang) {
  const [siteId, shift] = String(key).split('|');
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
function proposal(plan, ctx, lang, id) {
  const out = [t(lang, 'proposal_title', { date: ctx.date })];
  if (plan.lines.length) out.push(cut(plan.lines.map((l) => lineText(l, ctx, lang))).join('\n'));
  if (plan.skipped.length) out.push(`${t(lang, 'skipped_title')}\n${cut(plan.skipped.map((s) => skippedText(s, ctx, lang))).join('\n')}`);
  if (plan.questions.length) out.push(t(lang, 'questions_count', { n: plan.questions.length }));
  const n = new Set(plan.steps.map((s) => s.n)).size;
  const row = [];
  if (n) row.push({ text: t(lang, plan.questions.length ? 'btn_confirm_clear' : 'btn_confirm', { n }), callback_data: `c|${id}` });
  if (plan.questions.length) row.push({ text: t(lang, 'btn_answer', { n: plan.questions.length }), callback_data: `a|${id}` });
  const keys = [row, [{ text: t(lang, 'btn_cancel'), callback_data: `x|${id}` }]].filter((r) => r.length);
  return { text: out.join('\n\n'), keyboard: { inline_keyboard: keys } };
}

/** One open question with its buttons. */
function question(q, ctx, lang, id) {
  const skip = { text: t(lang, 'btn_skip'), callback_data: `q|${id}|${q.id}|s` };
  if (q.kind === 'pick') {
    const keys = q.options.map((n) => [{ text: name(ctx, n, lang).slice(0, 60), callback_data: `q|${id}|${q.id}|${n}` }]);
    return { text: t(lang, 'q_pick', { said: esc(q.said) }), keyboard: { inline_keyboard: [...keys, [skip]] } };
  }
  if (q.kind === 'scope') {
    const keys = q.options.map((key, k) => [{ text: boardLabel(ctx, key, lang), callback_data: `q|${id}|scope|b${k}` }]);
    keys.push([{ text: t(lang, 'btn_all'), callback_data: `q|${id}|scope|all` }]);
    return { text: t(lang, 'q_scope'), keyboard: { inline_keyboard: keys } };
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

module.exports = { proposal, question, result, notRecorded, name };
