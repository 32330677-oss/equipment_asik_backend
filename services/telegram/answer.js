// services/telegram/answer.js — answers a supervisor's QUESTION about his machines, in his own words.
//   1. the AI picks what it needs to read from a FIXED menu (day boards of up to MAX_DAYS days, his rejected rows,
//      his change requests, his sites' paper timesheets, the drivers) — or says the question is out of scope;
//   2. the code reads it through the app's own routes AS THE SUPERVISOR (loopback.js): the server gives exactly what
//      the app shows him, nothing more (no prices, invoices, payroll, fuel cost, other sites);
//   3. the AI writes the answer from that data only ("not in the records" when it is not there).
// Nothing is written. Answers are the only free text the bot sends, and they come from the data read in step 2.
const ai = require('./ai');
const loopback = require('./loopback');
const { addDays } = require('../../utils/businessDate');

const MAX_DAYS = 14;
const MAX_DATA = 45000; // characters of data given to the AI

const PLAN_TOOL = {
  name: 'plan_reads',
  description: 'What must be read to answer the supervisor, from the fixed menu.',
  input_schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['machines', 'out_of_scope'], description: "'out_of_scope' for anything the menu cannot answer" },
      from: { type: 'string', description: "first day 'YYYY-MM-DD' of the day boards to read ('' = none)" },
      to: { type: 'string', description: "last day 'YYYY-MM-DD' ('' = same as from)" },
      boards: { type: 'boolean', description: 'read the day boards from..to (machines, times, states, hours, stops, drivers)' },
      site: { type: 'string', description: 'site code / name if he named one, else empty' },
      shift: { type: 'string', enum: ['', 'Day', 'Night'] },
      rejected: { type: 'boolean', description: 'his rows the office rejected, with the reason' },
      change_requests: { type: 'boolean', description: 'his change requests to the office and their state' },
      timesheets: { type: 'boolean', description: 'the paper timesheets of his sites (month of "to")' },
      operators: { type: 'boolean', description: 'the drivers (names, vendor, licence expired or not)' },
    },
    required: ['scope'],
  },
};

const PLAN_SYSTEM = `A construction site supervisor asks a question (Syrian Arabic dialect or English) about the RENTED MACHINES of his sites. Choose what must be read to answer it, from this menu only:
- boards: the day board of each day from..to (at most ${MAX_DAYS} days): every machine deployed to his sites that day, its check-in / check-out, state (working, breakdown, standby, absent, holiday, no record), worked minutes, breakdown / standby minutes, stops, driver, remarks, row status (Draft / Submitted / Approved / Rejected).
- rejected: his rows the office rejected and why. change_requests: his requests to the office to change a row, and their state. timesheets: the paper timesheets of his sites. operators: the drivers.
Dates: today is given; "مبارح" = yesterday, "هالأسبوع" = from the last Saturday to today, "آخر أسبوع" = the last 7 days, "يوم 15" = the latest 15th not after today. Use the smallest range that answers.
scope 'out_of_scope' when the menu cannot answer: prices, rates, invoices, payments, payroll, fuel cost, other people's data, or anything not about his machines (weather, jokes, general questions).`;

const ANSWER_TOOL = {
  name: 'write_answer',
  description: 'The answer to send to the supervisor.',
  input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
};

const ANSWER_SYSTEM = `You answer a construction site supervisor about the rented machines of his sites, ONLY from the DATA given (read from the app with his own rights). Rules:
- Use only the DATA. Never invent a number, a time, a name or a reason. If the DATA does not contain the answer, say clearly that it is not in the records (and, if useful, what is there instead).
- His language: Syrian Arabic dialect if he wrote Arabic, else English. Short and clear: at most 12 lines, a short list when there are several machines.
- Machines by their name as in the DATA (type, number, vendor). Times as HH:MM. Hours from minutes: "9 ساعات و20 دقيقة" / "9 h 20 min". worked = worked_min (already without breaks and stops).
- Days with no record for a machine: say "ما إلها سجل". Draft rows are not sent to the office yet; say so when it matters.
- Never talk about prices, invoices or money. Do not give advice beyond the question. Plain text only (no markdown).`;

const hhmm = (dt) => (dt ? String(dt).slice(11, 16) : null);

function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < MAX_DAYS + 1; d = addDays(d, 1)) out.push(d);
  return out;
}

function machineLabel(m) {
  return `${m.type_name_ar || m.type_name || m.equipment_code} ${m.type_seq || ''} · ${m.vendor_name || ''}`.replace(/\s+/g, ' ').trim();
}

/** The day boards of the range, compacted. */
async function readBoards(userId, dates, site, shift) {
  const days = [];
  for (const date of dates) {
    const sites = await loopback.call(userId, 'GET', '/api/equipment/my-sites', { query: { date } });
    if (!sites.ok) { days.push({ date, error: sites.message || sites.code }); continue; }
    for (const s of Array.isArray(sites.data) ? sites.data : []) {
      const sh = s.shift_type === 'Night' ? 'Night' : 'Day';
      if (shift && sh !== shift) continue;
      if (site && !`${s.site_code} ${s.site_name || ''}`.toLowerCase().includes(site.toLowerCase().replace(/^s-?/, ''))) continue;
      const day = await loopback.call(userId, 'GET', `/api/equipment/attendance/site/${Number(s.site_id)}`, { query: { date, shift: sh } });
      if (!day.ok) { days.push({ date, site: s.site_code, shift: sh, error: day.message || day.code }); continue; }
      days.push({
        date, site: s.site_code, site_name: s.site_name, shift: sh,
        machines: ((day.data && day.data.machines) || []).map((m) => {
          const a = m.attendance;
          return {
            machine: machineLabel(m), code: m.equipment_code, plate: m.plate_number || null, driver: (a && a.operator_name) || m.default_operator_name || null,
            state: m.live_state,
            ...(a ? {
              day_status: a.day_status, row_status: a.status, in: hhmm(a.check_in_time), out: hhmm(a.check_out_time),
              worked_min: a.working_minutes ?? null, breakdown_min: a.breakdown_minutes || 0, standby_min: a.standby_minutes || 0,
              stops: (a.downtime || []).map((d) => ({ type: d.downtime_type, from: hhmm(d.start_time), to: hhmm(d.end_time), reason: d.reason || null })),
              remarks: a.remarks || null, work: a.work_description || null, rejected_because: a.admin_rejection_notes || null,
            } : { record: 'none' }),
          };
        }),
      });
    }
  }
  return days;
}

async function readList(userId, path, query, pick) {
  const r = await loopback.call(userId, 'GET', path, { query });
  if (!r.ok) return { error: r.message || r.code };
  return (Array.isArray(r.data) ? r.data : []).slice(0, 60).map(pick);
}

/**
 * answer({ userId, text, today, lang, log }) -> { text } | { key, vars } (a fixed message)
 * log(kind, result) records each AI call. Throws ai.AiError on an AI failure.
 */
async function answer({ userId, text, today, lang, log }) {
  const plan = await ai.callTool({
    system: PLAN_SYSTEM, tool: PLAN_TOOL, maxTokens: 400,
    user: `Today: ${today}. His language: ${lang === 'en' ? 'English' : 'Arabic'}.\nQuestion:\n${String(text).slice(0, 1500)}`,
  });
  await log('question', plan);
  const p = plan.input || {};
  if (p.scope === 'out_of_scope') return { key: 'ask_out_of_scope' };

  const data = {};
  const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && d <= today;
  if (p.boards && valid(p.from)) {
    const to = valid(p.to) && p.to >= p.from ? p.to : p.from;
    const dates = datesBetween(p.from, to);
    if (dates.length > MAX_DAYS) return { key: 'ask_too_long', vars: { n: MAX_DAYS } };
    data.days = await readBoards(userId, dates, String(p.site || '').trim(), ['Day', 'Night'].includes(p.shift) ? p.shift : '');
  }
  if (p.rejected) {
    data.rejected = await readList(userId, '/api/equipment/attendance/rejected', null, (r) => ({
      date: r.record_date, machine: r.machine_label || r.equipment_code, site: r.site_code, shift: r.shift_type, in: hhmm(r.check_in_time), out: hhmm(r.check_out_time),
      day_status: r.day_status, reason: r.admin_rejection_notes || null,
    }));
  }
  if (p.change_requests) {
    data.change_requests = await readList(userId, '/api/equipment/attendance/change-requests', null, (r) => ({
      date: r.record_date, machine: r.machine_label || r.equipment_code, site: r.site_code, state: r.status, asked: r.proposed_changes, reason: r.reason || null,
      decided_by: r.decided_by || null, decision_note: r.decision_note || null,
    }));
  }
  if (p.timesheets) {
    const month = String(valid(p.to) ? p.to : today).slice(0, 7);
    data.timesheets = await readList(userId, '/api/equipment/timesheets', { month }, (r) => ({
      month: r.period_month, sheet: r.sheet_code, site: r.site_code, machine: r.machine_label || r.equipment_code, state: r.status,
      rows: r.last_row_no, needs_scan: r.needs_scan, needs_check: r.needs_check,
    }));
  }
  if (p.operators) {
    data.drivers = await readList(userId, '/api/equipment/operators', { status: 'Active' }, (r) => ({ name: r.full_name, vendor: r.vendor_name, licence_expired: Boolean(r.license_expired) }));
  }
  if (!Object.keys(data).length) return { key: 'ask_nothing_read' };

  let json = JSON.stringify(data);
  if (json.length > MAX_DATA) json = `${json.slice(0, MAX_DATA)}… (cut: too much data, answer from what is here and say the rest was too long)`;
  const ans = await ai.callTool({
    system: ANSWER_SYSTEM, tool: ANSWER_TOOL, maxTokens: 900,
    user: `Today: ${today}. His language: ${lang === 'en' ? 'English' : 'Arabic'}.\nQuestion:\n${String(text).slice(0, 1500)}\n\nDATA:\n${json}`,
  });
  await log('answer', ans);
  const out = String((ans.input && ans.input.answer) || '').trim();
  return out ? { text: out.slice(0, 3500) } : { key: 'ask_nothing_read' };
}

module.exports = { answer, PLAN_TOOL, ANSWER_TOOL, MAX_DAYS };
