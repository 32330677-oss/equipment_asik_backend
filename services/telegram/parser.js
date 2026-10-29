// services/telegram/parser.js — reads ONE supervisor message about machines into a fixed shape (AI, forced tool).
// The AI does NOT choose machines: it only writes what he SAID about each machine (type words, number, vendor words,
// plate, code, driver). matcher.js finds the machine in code, on the board he is working on. The AI also gets the
// session (day / site / shift) and the open draft, so a message can add to what was said before.
const ai = require('./ai');

const MAX_TEXT = 3000;

const MENTION = {
  type: 'object',
  description: 'what he said about ONE machine (or one kind, with all=true)',
  properties: {
    type: { type: 'string', description: 'the type words as he said them ("بوبكات", "الحفارة الصغيرة", "تركس"), else empty' },
    number: { type: ['integer', 'null'], description: 'the machine number he said ("واحد"/"الأول" = 1, "التاني" = 2), else null' },
    vendor: { type: 'string', description: 'the vendor / owner words he said ("تبع الشهم", "لأحمد منسي") without تبع / عند / ل, else empty' },
    plate: { type: 'string', description: 'plate number if said' },
    code: { type: 'string', description: 'the machine code from the list (EQ-…) ONLY if he said the code, or he refers to a machine of the open draft' },
    driver: { type: 'string', description: 'driver name if he named the machine by its driver' },
  },
};

const TOOL = {
  name: 'read_machine_attendance',
  description: 'What the supervisor said, in a fixed shape.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['record', 'set_context', 'status', 'not_recorded', 'machines', 'question', 'confirm', 'help', 'cancel', 'other'] },
      work_date: { type: 'string', description: "'' (not said), 'today', 'yesterday', 'YYYY-MM-DD', or a day of the month like '15'" },
      site: { type: 'string', description: 'site name / code if he said one, else empty' },
      shift: { type: 'string', enum: ['', 'Day', 'Night'] },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            said: { type: 'string', description: 'his words for the machine(s), as said' },
            all: { type: 'boolean', description: 'every machine of the board ("كل الآليات", "الكل", "الباقي")' },
            mention: MENTION,
            except: { type: 'array', items: MENTION, description: 'with all=true: the machines he excluded' },
            action: { type: 'string', enum: ['check_in', 'check_out', 'in_out', 'day_status', 'downtime', 'need_times', 'remove'] },
            check_in: { type: 'string', description: "24h 'HH:MM' or ''" },
            check_out: { type: 'string', description: "24h 'HH:MM' or ''" },
            day_status: { type: 'string', enum: ['', 'Standby', 'Breakdown', 'Absent', 'Holiday'] },
            reason: { type: 'string' },
            downtime_type: { type: 'string', enum: ['', 'Break', 'Refuel', 'Breakdown', 'Standby'] },
            downtime_start: { type: 'string', description: "24h 'HH:MM' or ''" },
            downtime_end: { type: 'string', description: "24h 'HH:MM' or ''" },
            meter_start: { type: ['number', 'null'] },
            meter_end: { type: ['number', 'null'] },
          },
          required: ['said', 'action'],
        },
      },
      note: { type: 'string', description: "one short line in HIS language when part of the message could not be read: what and why. '' otherwise" },
    },
    required: ['intent', 'entries'],
  },
};

const SYSTEM = `You read messages from a construction site supervisor (Syrian Arabic dialect, sometimes English, often a voice note turned into text) about RENTED MACHINES. Return ONLY the tool call. Understand the intent in any wording; examples are not a fixed list.

Intents:
- 'record': he says what machines did (came, left, did not come, broke down, stopped, times).
- 'set_context': he only says WHICH day / site / shift he wants to work on, with nothing to record yet ("بدي دخّل حضور Bridges ليوم 28", "خلينا على الليلي", "بدي سجل مبارح"). Fill work_date / site / shift.
- 'status' ("شو الوضع"), 'not_recorded' ("شو ناقص", "مين ما تسجل"), 'machines' (which machines he has), 'question' (any other question about his machines, hours, stops, drivers, rejected rows, change requests, timesheets, or prices), 'confirm' (a short yes), 'cancel' (cancel what was proposed), 'help', 'other'.
- entries ONLY for 'record'. A message can set the day / site AND record: then intent 'record' with work_date / site filled.

Machines — DO NOT choose a machine. For each machine he names, copy what he SAID into mention:
- type: his type words ("بوبكات", "الحفارة", "تركس", "جي سي بي"); number: the number he said ("واحد", "1", "الأول" = 1; "التاني" = 2); vendor: the owner / vendor words ("تبع الشهم" -> "الشهم", "لأحمد منسي الثاني" -> "أحمد منسي الثاني"); plate, driver if said.
- code: only if he SAID the code, or he clearly refers to a machine of the open draft (then use its code from the draft).
- "كل الآليات" / "الكل" / "الباقي": all = true (+ except for those he excluded or already said something else for).
- Several machines named together: one entry per machine.

Actions (one entry per machine and action):
- check_in ("دخلت", "بلشت"), check_out ("طلعت", "خلصت"), in_out (both times, "من 7 لـ 5").
- need_times: he names a machine to record but gives NO time ("بدي دخّل بوبكات 1 ساعة الدخول والخروج" with no numbers): the bot will ask.
- day_status for the whole day: Absent ("ما إجت"), Holiday ("عطلة"), Breakdown ("معطلة اليوم كله"), Standby ("واقفة كل اليوم"). His reason in reason.
- downtime: a stop inside the day WITH its times ("تعطلت من 10 لـ 12", "وقفت ساعة من 1 لـ 2"). A break / lunch WITHOUT times ("مع الاستراحة", "مع استراحة الغدا") is NOT a downtime: ignore it (the office applies the break policy).
- remove: take a machine out of the open draft ("شيل البوبكات", "لا مو هي").
- Meter readings only if said ("العداد 1520").

Times: 24h 'HH:MM'. Day shift: check-in "7" = 07:00, check-out "5" = 17:00. Night shift: check-in "7" = 19:00, check-out "5" = 05:00. "ونص" = :30, "وربع" = :15, "الا ربع" = :45 before. Minutes as said.
Dates: work_date '' unless he says one: "مبارح" = 'yesterday', "28 أكتوبر" / "28 تشرين الأول" / "28/10" / "يوم 28" = 'YYYY-MM-DD' (this year), a full date.
Do not drop a machine because one word is unclear; say what you could not read in note.`;

function boardText(ctx, session, draft) {
  const lines = ctx.machines.map((m) => {
    const type = [m.type_name_ar, m.type_name].filter(Boolean).join(' / ');
    const row = m.row ? `${m.row.day_status}${m.row.in ? ` in ${String(m.row.in).slice(11, 16)}` : ''}${m.row.out ? ` out ${String(m.row.out).slice(11, 16)}` : ''} (${m.row.status})` : 'no record';
    return `- ${m.code}: ${type} ${m.type_seq || ''} · ${m.vendor_name || ''}${m.plate ? ` · plate ${m.plate}` : ''}${m.operator ? ` · driver ${m.operator}` : ''} · ${m.site_code} ${m.shift} · ${row}`;
  });
  const sites = ctx.boards.map((b) => `${b.site_code} (${b.site_name || ''}) ${b.shift}`).join('; ');
  const ses = `Working on: ${session.date || ctx.date}${session.siteCode ? `, site ${session.siteCode}` : ''}${session.shift ? `, ${session.shift} shift` : ''}`;
  const d = (draft || []).map((x) => `- ${x.code}: ${x.summary}`).join('\n');
  return `${ses}\nSites: ${sites || 'none'}\nMachines (for reading his words; never choose one yourself):\n${lines.join('\n') || '(none)'}${d ? `\nOpen draft:\n${d}` : ''}`;
}

/** parse({ text, ctx, session, draft, now, lang, strong }) -> { reading, usage, model, latencyMs } (throws ai.AiError) */
async function parse({ text, ctx, session = {}, draft = [], now, lang = 'ar', strong = false }) {
  const clean = String(text || '').slice(0, MAX_TEXT);
  const year = String(ctx.date || '').slice(0, 4);
  const user = `${boardText(ctx, session, draft)}\nToday: ${now.date} (year ${year}). Time now: ${now.time}. His language: ${lang === 'en' ? 'English' : 'Arabic'}.\n\nMessage:\n${clean}`;
  const n = ctx.machines.length;
  const maxTokens = Math.min(6000, Math.max(1200, 300 + 150 * Math.min(n, 40)));
  const r = await ai.callTool({ system: SYSTEM, user, tool: TOOL, maxTokens, model: strong ? ai.strongModel() : null });
  return { reading: normalize(r.input), usage: r.usage, model: r.model, latencyMs: r.latencyMs };
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function time(v) {
  const m = HHMM.exec(String(v || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
function num(v) {
  const x = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(x) || x < 0 ? null : Math.round(x * 10) / 10;
}
const str = (v, n = 120) => String(v || '').trim().slice(0, n);
function mention(m) {
  const x = m && typeof m === 'object' ? m : {};
  const number = Number(x.number);
  return {
    type: str(x.type, 60), number: Number.isInteger(number) && number > 0 && number < 100 ? number : null,
    vendor: str(x.vendor, 80), plate: str(x.plate, 30), code: str(x.code, 30).toUpperCase(), driver: str(x.driver, 60),
  };
}
const ACTIONS = ['check_in', 'check_out', 'in_out', 'day_status', 'downtime', 'need_times', 'remove'];

/** Keeps only valid values; drops entries that say nothing to do (a break without times, an empty status). */
function normalize(input) {
  const entries = (Array.isArray(input.entries) ? input.entries : []).slice(0, 200).map((e) => ({
    said: str(e.said),
    all: e.all === true,
    mention: mention(e.mention),
    except: (Array.isArray(e.except) ? e.except : []).slice(0, 50).map(mention),
    action: ACTIONS.includes(e.action) ? e.action : null,
    check_in: time(e.check_in),
    check_out: time(e.check_out),
    day_status: ['Standby', 'Breakdown', 'Absent', 'Holiday'].includes(e.day_status) ? e.day_status : '',
    reason: str(e.reason, 300),
    downtime_type: ['Break', 'Refuel', 'Breakdown', 'Standby'].includes(e.downtime_type) ? e.downtime_type : '',
    downtime_start: time(e.downtime_start),
    downtime_end: time(e.downtime_end),
    meter_start: num(e.meter_start),
    meter_end: num(e.meter_end),
  })).map((e) => {
    // check-in / check-out / in-out with no time at all: the bot asks for the times
    if (['check_in', 'check_out', 'in_out'].includes(e.action) && !e.check_in && !e.check_out) e.action = 'need_times';
    return e;
  }).filter((e) => e.action && (
    ['check_in', 'check_out', 'in_out', 'need_times', 'remove'].includes(e.action)
    || (e.action === 'day_status' && e.day_status)
    || (e.action === 'downtime' && e.downtime_type && e.downtime_start)));
  return {
    intent: ['record', 'set_context', 'status', 'not_recorded', 'machines', 'question', 'confirm', 'help', 'cancel', 'other'].includes(input.intent) ? input.intent : 'other',
    work_date: str(input.work_date, 20),
    site: str(input.site, 60),
    shift: ['Day', 'Night'].includes(input.shift) ? input.shift : '',
    entries,
    note: str(input.note, 300),
  };
}

module.exports = { parse, normalize, TOOL, SYSTEM, MAX_TEXT, boardText };
