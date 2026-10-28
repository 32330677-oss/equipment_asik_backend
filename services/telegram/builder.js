// services/telegram/builder.js — turns the model's reading into checked steps for the day board, plus the questions
// still open (which machine, which site / shift, the reason of a breakdown). Pure: no database, no HTTP.
// Every step is later sent to the app's own route (executor.js), which checks everything again.
const { addDays } = require('../../utils/businessDate');

const NIGHT_DAY_CHANGE = '12:00'; // same as eqAttendanceService: a night shift runs 12:00 -> 11:59 next day

/** The work date of the message. Returns { date } or { error: key }. */
function resolveDate(said, today, maxBack = 62) {
  const s = String(said || '').trim().toLowerCase();
  if (!s || s === 'today') return { date: today };
  if (s === 'yesterday') return { date: addDays(today, -1) };
  let date = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) date = s;
  else if (/^\d{1,2}$/.test(s)) {
    const d = Number(s);
    if (d < 1 || d > 31) return { error: 'date_bad' };
    // the latest date with that day of the month, today included
    for (let k = 0; k <= 62; k += 1) {
      const c = addDays(today, -k);
      if (Number(c.slice(8, 10)) === d) { date = c; break; }
    }
  }
  if (!date) return { error: 'date_bad' };
  if (date > today) return { error: 'date_future' };
  if (date < addDays(today, -maxBack)) return { error: 'date_too_old' };
  return { date };
}

/** 'YYYY-MM-DD HH:MM:00' of a time on the board date (a night shift's morning hours are the next calendar day). */
function stamp(date, hhmm, shift) {
  const d = shift === 'Night' && hhmm < NIGHT_DAY_CHANGE ? addDays(date, 1) : date;
  return `${d} ${hhmm}:00`;
}

const hm = (dt) => (dt ? String(dt).slice(11, 16) : '');
const editable = (row) => !row || ['Draft', 'Rejected'].includes(row.status);
const hasSession = (row) => Boolean(row && row.day_status === 'Working' && row.in);

/**
 * build({ reading, ctx, answers, nowStamp }) -> { lines, steps, questions, skipped, scopeBoards }
 *   lines:     [{ n, text-parts }] what will be recorded per machine (for the proposal)
 *   steps:     [{ n, kind, body, rowId|null, useNewRow }] in order
 *   questions: [{ id, kind: 'scope'|'pick'|'reason', ... }] still open
 *   skipped:   [{ n|null, said, why, vars }] not recorded and why
 */
function build({ reading, ctx, answers = {}, nowStamp }) {
  const byN = new Map(ctx.machines.map((m) => [m.n, m]));
  const questions = [];
  const skipped = [];
  const orders = new Map(); // n -> [entry]
  const add = (n, e) => { if (!orders.has(n)) orders.set(n, []); orders.get(n).push(e); };

  // the machines named on their own (they win over "all" / "the others")
  const named = new Set();
  reading.entries.forEach((e) => { if (!e.all && !e.ambiguous) e.targets.forEach((n) => named.add(n)); });

  // 1. who: "all", single machines, ambiguous ones
  reading.entries.forEach((e, i) => {
    if (e.all) {
      let pool = ctx.machines.filter((m) => !e.except.includes(m.n) && !named.has(m.n));
      if (reading.site) {
        const s = reading.site.toLowerCase();
        const bySite = pool.filter((m) => m.site_code.toLowerCase() === s || ctx.boards.some((b) => b.site_id === m.site_id && String(b.site_name || '').toLowerCase().includes(s)));
        if (bySite.length) pool = bySite;
      }
      if (reading.shift) pool = pool.filter((m) => m.shift === reading.shift);
      const groups = [...new Set(pool.map((m) => `${m.site_id}|${m.shift}`))];
      if (groups.length > 1) {
        const a = answers.scope;
        if (a === undefined) {
          if (!questions.some((q) => q.id === 'scope')) questions.push({ id: 'scope', kind: 'scope', options: groups });
          return;
        }
        if (a !== 'all') pool = pool.filter((m) => `${m.site_id}|${m.shift}` === a);
      }
      if (!pool.length) skipped.push({ n: null, said: e.said, why: 'none_left' });
      pool.forEach((m) => add(m.n, e));
      return;
    }
    if (e.not_found || !e.targets.length) {
      skipped.push({ n: null, said: e.said, why: 'not_found' });
      return;
    }
    if (e.ambiguous && e.targets.length > 1) {
      const id = `pick:${i}`;
      const a = answers[id];
      if (a === undefined) { questions.push({ id, kind: 'pick', said: e.said, options: e.targets }); return; }
      if (a === 'skip') { skipped.push({ n: null, said: e.said, why: 'skipped' }); return; }
      add(Number(a), e);
      return;
    }
    e.targets.forEach((n) => add(n, e));
  });

  // 2. per machine: merge what was said, check it against its row, make the steps
  const lines = [];
  const steps = [];
  for (const [n, es] of orders) {
    const m = byN.get(n);
    if (!m) continue;
    const board = ctx.boards.find((b) => b.site_id === m.site_id && b.shift === m.shift) || {};
    const row = m.row;
    const said = es.map((e) => e.said).filter(Boolean)[0] || '';
    const skip = (why, vars = {}) => skipped.push({ n, said, why, vars });
    if (board.can_edit === false) { skip('board_locked', { reason: board.reason || '' }); continue; }
    if (!editable(row)) { skip('row_sent', { status: row.status }); continue; }

    const want = { in: '', out: '', status: '', reason: '', downtimes: [], meterStart: null, meterEnd: null };
    for (const e of es) {
      if (e.check_in) want.in = e.check_in;
      if (e.check_out) want.out = e.check_out;
      if (e.action === 'day_status' && e.day_status) want.status = e.day_status;
      if (e.reason) want.reason = e.reason;
      if (e.action === 'downtime' && e.downtime_type) want.downtimes.push({ type: e.downtime_type, start: e.downtime_start, end: e.downtime_end, reason: e.reason });
      if (e.meter_start !== null) want.meterStart = e.meter_start;
      if (e.meter_end !== null) want.meterEnd = e.meter_end;
    }
    if (want.status && (want.in || want.out)) { skip('conflict'); continue; }

    const future = (hhmm) => hhmm && ctx.date === nowStamp.slice(0, 10) && stamp(ctx.date, hhmm, m.shift) > nowStamp;
    const late = [want.in, want.out].find((t) => future(t));
    if (late) { skip('future', { time: late }); continue; }

    // a whole-day status
    if (want.status) {
      if (['Standby', 'Breakdown'].includes(want.status) && !want.reason) {
        const id = `reason:${n}`;
        const a = answers[id];
        if (a === undefined) { questions.push({ id, kind: 'reason', n, status: want.status }); continue; }
        if (a === 'skip') { skip('skipped'); continue; }
        want.reason = String(a);
      }
      if (row && row.day_status === want.status && !hasSession(row)) { skip('same', { what: want.status }); continue; }
      steps.push({ n, kind: 'day_status', rowId: null, body: {
        equipment_id: m.equipment_id, site_id: m.site_id, shift_type: m.shift, record_date: ctx.date, day_status: want.status,
        ...(want.reason ? { remarks: want.reason } : {}), ...(hasSession(row) ? { confirm_discard_session: true } : {}),
      } });
      lines.push({ n, status: want.status, reason: want.reason, discards: hasSession(row) });
      continue;
    }

    const line = { n };
    const session = hasSession(row) && !row.from_previous_day ? row : (row && row.from_previous_day && !row.out ? row : null);
    if (!session) {
      // no session yet: a check-in is needed (a check-out alone cannot be recorded)
      if (!want.in) {
        if (want.out || want.downtimes.length) { skip('no_check_in', { out: want.out }); continue; }
        continue;
      }
      if (want.out && stamp(ctx.date, want.out, m.shift) <= stamp(ctx.date, want.in, m.shift)) { skip('out_before_in'); continue; }
      steps.push({ n, kind: 'check_in', rowId: null, body: {
        equipment_id: m.equipment_id, site_id: m.site_id, shift_type: m.shift, record_date: ctx.date, check_in_time: stamp(ctx.date, want.in, m.shift),
        ...(want.out ? { check_out_time: stamp(ctx.date, want.out, m.shift) } : {}),
        ...(want.meterStart !== null ? { meter_start: want.meterStart } : {}),
        ...(want.out && want.meterEnd !== null ? { meter_end: want.meterEnd } : {}),
      } });
      Object.assign(line, { in: want.in, out: want.out, meterStart: want.meterStart, meterEnd: want.out ? want.meterEnd : null, replaces: row ? row.day_status : null });
    } else {
      const date = String(session.in).slice(0, 10);
      const rd = row.from_previous_day ? addDays(ctx.date, -1) : ctx.date;
      const edit = {};
      if (want.in && want.in !== hm(session.in)) edit.check_in_time = stamp(rd, want.in, m.shift);
      if (want.out && session.out && want.out !== hm(session.out)) edit.check_out_time = stamp(rd, want.out, m.shift);
      if (want.meterStart !== null) edit.meter_start = want.meterStart;
      if (session.out && want.meterEnd !== null) edit.meter_end = want.meterEnd;
      if (want.out && !session.out) {
        const inStamp = edit.check_in_time || `${date} ${hm(session.in)}:00`;
        if (stamp(rd, want.out, m.shift) <= inStamp) { skip('out_before_in'); continue; }
      }
      if (Object.keys(edit).length) {
        steps.push({ n, kind: 'edit', rowId: session.id, body: edit });
        if (edit.check_in_time) line.editIn = { from: hm(session.in), to: want.in };
        if (edit.check_out_time) line.editOut = { from: hm(session.out), to: want.out };
      }
      if (want.out && !session.out) {
        steps.push({ n, kind: 'check_out', rowId: session.id, body: { check_out_time: stamp(rd, want.out, m.shift), ...(want.meterEnd !== null ? { meter_end: want.meterEnd } : {}) } });
        line.out = want.out;
        if (want.meterEnd !== null) line.meterEnd = want.meterEnd;
      }
      if (!Object.keys(edit).length && !line.out && !want.downtimes.length) { skip('same', { what: want.in || want.out }); continue; }
    }

    // stops inside the day (break, refuel, breakdown, standby)
    const dts = [];
    for (const [k, d] of want.downtimes.entries()) {
      if (!d.start) { skip('downtime_no_start'); continue; }
      let reason = d.reason;
      if (['Breakdown', 'Standby'].includes(d.type) && !reason) {
        const id = `reason:${n}:${k}`;
        const a = answers[id];
        if (a === undefined) { questions.push({ id, kind: 'reason', n, status: d.type, downtime: true }); continue; }
        if (a === 'skip') { skip('skipped'); continue; }
        reason = String(a);
      }
      const rd = row && row.from_previous_day ? addDays(ctx.date, -1) : ctx.date;
      steps.push({ n, kind: 'downtime', rowId: session ? session.id : null, useNewRow: !session, body: {
        downtime_type: d.type, start_time: stamp(rd, d.start, m.shift), ...(d.end ? { end_time: stamp(rd, d.end, m.shift) } : {}), ...(reason ? { reason } : {}),
      } });
      dts.push({ type: d.type, start: d.start, end: d.end, reason });
    }
    if (dts.length) line.downtimes = dts;
    if (Object.keys(line).length > 1) lines.push(line);
  }
  return { lines, steps, questions, skipped };
}

module.exports = { build, resolveDate, stamp };
