// services/telegram/draft.js — the draft of the day the supervisor is filling, across several messages and buttons.
//   draft = { v: 2, date, siteId, shift, items: [...], open: [...], waiting, seq }
//   item  = one machine of one board: { key, said, in, out, status, reason, downtimes, meterStart, meterEnd, needTimes }
//   open  = what is not decided yet: { id, kind: 'pick' (which machine), 'scope' (which site / shift for "all"), entry }
// Every message only ADDS to the draft (or changes / removes an item); nothing is lost between messages.
// The checks against the day board and the steps are done by builder.js (the same checks as before).
const matcher = require('./matcher');
const builder = require('./builder');

function create({ date, siteId = null, shift = null }) {
  return { v: 2, date, siteId, shift, items: [], open: [], waiting: null, seq: 0 };
}

/** The machines of the board(s) the draft is about (its site / shift when chosen). */
function scope(draft, ctx) {
  return ctx.machines.filter((m) => (!draft.siteId || m.site_id === draft.siteId) && (!draft.shift || m.shift === draft.shift));
}
const boardKeys = (ms) => [...new Set(ms.map((m) => `${m.site_id}:${m.shift}`))];

function itemOf(draft, m) {
  let it = draft.items.find((x) => x.key === m.key);
  if (!it) {
    it = { key: m.key, equipment_id: m.equipment_id, site_id: m.site_id, shift: m.shift, said: '', in: '', out: '', status: '', reason: '', downtimes: [], meterStart: null, meterEnd: null, needTimes: false };
    draft.items.push(it);
  }
  return it;
}

/** What one entry says about one machine, written on its item (a later message wins over an earlier one). */
function merge(draft, m, e) {
  if (e.action === 'remove') {
    draft.items = draft.items.filter((x) => x.key !== m.key);
    return;
  }
  const it = itemOf(draft, m);
  if (e.said && !it.said) it.said = e.said;
  if (e.action === 'day_status') {
    Object.assign(it, { status: e.day_status, reason: e.reason || it.reason, in: '', out: '', downtimes: [], needTimes: false });
    return;
  }
  if (e.action === 'need_times') {
    if (!it.in && !it.out && !it.status) it.needTimes = true;
    return;
  }
  if (e.action === 'downtime') {
    it.downtimes.push({ type: e.downtime_type, start: e.downtime_start, end: e.downtime_end, reason: e.reason || '' });
    return;
  }
  if (e.check_in) it.in = e.check_in;
  if (e.check_out) it.out = e.check_out;
  if (e.meter_start !== null && e.meter_start !== undefined) it.meterStart = e.meter_start;
  if (e.meter_end !== null && e.meter_end !== undefined) it.meterEnd = e.meter_end;
  if (it.in || it.out) { it.status = ''; it.needTimes = false; }
}

const mentionOf = (e) => ({ said: e.said, ...e.mention });

/**
 * apply(draft, reading, ctx, { aliases }) — adds what a message said to the draft.
 * Machines are found by matcher.js on the draft's board(s) only.
 */
function apply(draft, reading, ctx, { aliases = [] } = {}) {
  const pool = scope(draft, ctx);
  const named = new Set();
  // single machines first: they win over "all" / "the others" of the same message
  for (const e of reading.entries) {
    if (e.all) continue;
    const res = matcher.resolve(mentionOf(e), pool, { aliases });
    if (res.sure) {
      const m = pool.find((x) => x.key === res.keys[0]);
      named.add(m.key);
      merge(draft, m, e);
    } else {
      const candidates = (res.keys.length ? res.keys : matcher.closest(mentionOf(e), pool)).slice(0, 6);
      draft.seq += 1;
      draft.open.push({ id: `p${draft.seq}`, kind: 'pick', said: e.said || [e.mention.type, e.mention.number, e.mention.vendor].filter(Boolean).join(' '), candidates, weak: !res.keys.length || res.reason === 'weak', entry: e });
      if (res.reason !== 'weak') res.keys.forEach((k) => named.add(k)); // "the others" leaves out the machines he may have meant
    }
  }
  for (const e of reading.entries) {
    if (!e.all) continue;
    if (boardKeys(pool).length > 1) {
      draft.seq += 1;
      draft.open.push({ id: `s${draft.seq}`, kind: 'scope', options: boardKeys(pool), entry: e, named: [...named] });
      continue;
    }
    expandAll(draft, pool, e, named, aliases);
  }
}

function expandAll(draft, pool, e, named, aliases) {
  const except = new Set();
  for (const x of e.except || []) {
    const r = matcher.resolve({ said: '', ...x }, pool, { aliases });
    r.keys.forEach((k) => except.add(k));
  }
  for (const m of pool) if (!named.has(m.key) && !except.has(m.key)) merge(draft, m, e);
}

/** "Which one?" answered: the chosen machine gets what the message said. */
function answerPick(draft, qid, key, ctx) {
  const q = draft.open.find((x) => x.id === qid && x.kind === 'pick');
  if (!q) return null;
  draft.open = draft.open.filter((x) => x !== q);
  if (key === 'skip') return { skipped: q.said };
  const m = ctx.machines.find((x) => x.key === key);
  if (m) merge(draft, m, q.entry);
  return { machine: m, said: q.said, candidates: q.candidates };
}

/** "Which site / shift?" for "all": the draft takes that board (or stays on all of them). */
function answerScope(draft, qid, boardKey, ctx, aliases = []) {
  const q = draft.open.find((x) => x.id === qid && x.kind === 'scope');
  if (!q) return;
  draft.open = draft.open.filter((x) => x !== q);
  if (boardKey && boardKey !== 'all') {
    const [siteId, shift] = String(boardKey).split(':');
    draft.siteId = Number(siteId);
    draft.shift = shift;
  }
  const pool = boardKey === 'all' ? ctx.machines : scope(draft, ctx);
  expandAll(draft, pool, q.entry, new Set(q.named || []), aliases);
}

function answerTimes(draft, key, times) {
  const it = draft.items.find((x) => x.key === key);
  if (!it) return;
  if (times.in) it.in = times.in;
  if (times.out) it.out = times.out;
  if (it.in || it.out) { it.needTimes = false; it.status = ''; }
}

function answerReason(draft, key, k, text) {
  const it = draft.items.find((x) => x.key === key);
  if (!it) return;
  if (k === null || k === undefined || k === '') it.reason = text;
  else if (it.downtimes[Number(k)]) it.downtimes[Number(k)].reason = text;
}

/** One button tap on a machine (guided mode): came at the shift start, absent, broken down, other times. */
function tap(draft, m, act, start) {
  if (act === 'in' && start) merge(draft, m, { action: 'check_in', check_in: start, said: '' });
  else if (act === 'abs') merge(draft, m, { action: 'day_status', day_status: 'Absent', said: '' });
  else if (act === 'brk') merge(draft, m, { action: 'day_status', day_status: 'Breakdown', said: '' });
  else if (act === 'time') { const it = itemOf(draft, m); Object.assign(it, { in: '', out: '', status: '', needTimes: true }); }
  else if (act === 'del') merge(draft, m, { action: 'remove' });
}

/**
 * plan(draft, ctx, nowStamp) -> { lines, steps, questions, skipped } — the draft checked against the (fresh) board.
 * questions: scope / pick (open), times (an item without times), reason (builder: breakdown / standby without reason).
 */
function plan(draft, ctx, nowStamp) {
  const entries = [];
  const extra = [];
  const missing = [];
  for (const it of draft.items) {
    const m = ctx.machines.find((x) => x.key === it.key);
    if (!m) { missing.push({ n: null, said: it.said || it.key, why: 'not_found' }); continue; }
    if (it.needTimes) { extra.push({ id: `t:${it.key}`, kind: 'times', key: it.key, n: m.n }); continue; }
    const base = { said: it.said, all: false, targets: [m.n], ambiguous: false, except: [], not_found: false, meter_start: it.meterStart, meter_end: it.meterEnd };
    if (it.status) entries.push({ ...base, action: 'day_status', day_status: it.status, reason: it.reason, check_in: '', check_out: '', downtime_type: '', downtime_start: '', downtime_end: '' });
    else if (it.in || it.out) entries.push({ ...base, action: 'in_out', day_status: '', reason: '', check_in: it.in, check_out: it.out, downtime_type: '', downtime_start: '', downtime_end: '' });
    it.downtimes.forEach((d) => entries.push({ ...base, action: 'downtime', day_status: '', reason: d.reason, check_in: '', check_out: '', downtime_type: d.type, downtime_start: d.start, downtime_end: d.end || '', meter_start: null, meter_end: null }));
  }
  const p = builder.build({ reading: { site: '', shift: '', entries }, ctx, answers: {}, nowStamp });
  // builder asks reasons by board number: give each question the item key so the answer lands on the item
  const reasons = p.questions.map((q) => {
    const m = ctx.machines.find((x) => x.n === q.n);
    const k = q.id.split(':')[2];
    return { ...q, key: m ? m.key : null, k: k === undefined ? null : k };
  });
  const open = [...draft.open.filter((q) => q.kind === 'scope'), ...draft.open.filter((q) => q.kind === 'pick')];
  return { ...p, skipped: [...missing, ...p.skipped], questions: [...open, ...extra, ...reasons] };
}

/** A short line per item for the AI (so "8 لـ 5" or "شيل البوبكات" can refer to the draft). */
function summary(draft, ctx) {
  return draft.items.map((it) => {
    const m = ctx.machines.find((x) => x.key === it.key);
    if (!m) return null;
    const what = it.status ? it.status : it.needTimes ? 'waiting for check-in / check-out times' : [it.in && `in ${it.in}`, it.out && `out ${it.out}`].filter(Boolean).join(', ');
    return { code: m.code, summary: `${m.type_name_ar || m.type_name} ${m.type_seq || ''} · ${m.vendor_name}: ${what || 'nothing yet'}` };
  }).filter(Boolean);
}

module.exports = { create, apply, answerPick, answerScope, answerTimes, answerReason, tap, plan, summary, scope, resolveDate: builder.resolveDate };
