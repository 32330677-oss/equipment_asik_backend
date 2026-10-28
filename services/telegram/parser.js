// services/telegram/parser.js — reads ONE supervisor message about machines into a fixed shape (AI, forced tool).
// The model never writes anything: it only says which machines of HIS list the message is about and what happened.
// The code then checks every point against the day board and the supervisor confirms before anything is saved.
const ai = require('./ai');

const MAX_TEXT = 3000;

const TOOL = {
  name: 'read_machine_attendance',
  description: 'The machine attendance the supervisor described, using the numbers of HIS machine list.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['record', 'status', 'not_recorded', 'help', 'cancel', 'other'] },
      work_date: { type: 'string', description: "'' (not said), 'today', 'yesterday', 'YYYY-MM-DD', or a day of the month like '15'" },
      site: { type: 'string', description: 'site code or name if he said one, else empty' },
      shift: { type: 'string', enum: ['', 'Day', 'Night'] },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            said: { type: 'string', description: 'his words for the machine(s), as said' },
            all: { type: 'boolean', description: 'true = every machine (of the site / shift if said)' },
            targets: { type: 'array', items: { type: 'integer' }, description: 'machine numbers from the list. Several numbers = he means ONE of them and it is not clear which (ambiguous), unless he named several machines.' },
            ambiguous: { type: 'boolean', description: 'true when targets are candidates for ONE machine he meant' },
            except: { type: 'array', items: { type: 'integer' }, description: 'with all=true: the machine numbers he excluded' },
            not_found: { type: 'boolean', description: 'he named a machine that is not in the list' },
            action: { type: 'string', enum: ['check_in', 'check_out', 'in_out', 'day_status', 'downtime'] },
            check_in: { type: 'string', description: "24h 'HH:MM' or ''" },
            check_out: { type: 'string', description: "24h 'HH:MM' or ''" },
            day_status: { type: 'string', enum: ['', 'Standby', 'Breakdown', 'Absent', 'Holiday'] },
            reason: { type: 'string', description: 'reason he gave (breakdown cause, standby reason...), else empty' },
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

const SYSTEM = `You read messages from a construction site supervisor (Syrian Arabic dialect, sometimes English, often a voice note turned into text) about RENTED MACHINES (excavators, loaders, trucks, cranes...). You get HIS list of machines for the day, numbered. Return ONLY the tool call.

Understand the intent in any wording; the examples are not a fixed list of commands.
- intent 'record': he says machines started, finished, did not come, broke down, stopped... (most messages)
- 'status': he asks how things are now ("شو الوضع", "وين صرنا"). 'not_recorded': who is not recorded / what is missing ("مين ما تسجل", "شو ناقص"). 'help': how to use the bot. 'cancel': cancel what was proposed ("الغي", "لا"). 'other': anything else.

Machines: each list line is "n. TYPE NUMBER · VENDOR | code, plate, driver, site, shift, state today". Machines are numbered PER VENDOR and TYPE: "حفارة 2" may exist at two vendors.
- He names a machine by type + number ("الحفارة 2", "البوكلين التاني" = 2, "اللودر الأول" = 1), by vendor ("حفارة 2 تبع X", "شاحنة X"), by plate, by code (EQ-0012), by driver name ("حفارة أبو أحمد"), or by one of HIS names listed under "His names".
- Arabic types: حفارة/بوكلين/باكر = excavator (بوكلين is often used for an excavator), لودر/تركس/شيول = loader, قلاب/شاحنة/تريلا = truck, كرين/رافعة = crane, بلدوزر/دوزر = bulldozer, كومبرسة = compressor, مدحلة/رصاصة = roller, جريدر = grader, بوبكات = skid steer, مولدة = generator. Use the TYPE text of the list, which wins over this table.
- If his words fit exactly one machine of the list: targets = [that number]. If they fit SEVERAL (same type + number at two vendors, or a type with no number and several of that type): targets = all of them, ambiguous = true. Never guess between them.
- Several machines named together ("الحفارة 1 و2"): targets = both, ambiguous = false.
- "كل الآليات" / "الكل" / "الباقي" (= all the others not mentioned): all = true, plus except = machines he excluded ("إلا الحفارة 2") or already gave something else in the same message.
- A machine not in the list: not_found = true, targets = [].

Actions (one entry per machine or group and per action):
- check_in ("دخلت", "بلشت", "اشتغلت من"), check_out ("طلعت", "خلصت", "وقفت شغل الساعة"), in_out (both times said, "من 7 لـ 5").
- day_status for the whole day: Absent ("ما إجت", "ما حضرت", "غايبة"), Holiday ("عطلة"), Breakdown ("معطلة اليوم كله"), Standby ("واقفة بدون شغل"/"ستاند باي" for the whole day). Put his reason in reason.
- downtime inside a working day: Breakdown ("تعطلت من 10 لـ 12"), Break ("استراحة"), Refuel ("عبّت مازوت"), Standby. Start/end in downtime_start/downtime_end.
- Meter / counter readings only if he says them ("العداد 1520"): meter_start at check-in, meter_end at check-out. Otherwise null. Never invent one.
- A correction of a time he recorded before ("عدّل", "لا مو 7، 7 ونص") is the same action with the new time.

Times: always 24h 'HH:MM'. Day shift: "7" at check-in = 07:00, "5"/"خمسة" at check-out = 17:00, "6 المسا" = 18:00. Night shift: check-in "7" = 19:00, check-out "5"/"الصبح" = 05:00. "ونص" = :30, "وربع" = :15, "الا ربع" = :45 before the hour, "و10" = :10. Use the minutes as said. "هلق"/"now" = the time now given below.

Date: work_date '' unless he says one ("مبارح" = 'yesterday', "يوم 15" = '15', a full date). Shift: 'Night' if he says الليلي/ليلي/المسائي, 'Day' if النهاري; else ''. Site: if he names a site.
Do not drop a machine because one word is unclear: read everything you can and say what you could not in note.`;

function listText(ctx, lang, aliases) {
  const lines = ctx.machines.map((m) => {
    const type = m.type_name_ar && m.type_name ? `${m.type_name_ar} / ${m.type_name}` : (m.type_name_ar || m.type_name || '');
    const row = m.row ? `${m.row.day_status}${m.row.in ? ` in ${String(m.row.in).slice(11, 16)}` : ''}${m.row.out ? ` out ${String(m.row.out).slice(11, 16)}` : ''} (${m.row.status})` : 'no record';
    return `${m.n}. ${type} ${m.type_seq || ''} · ${m.vendor_name || ''} | ${m.code}${m.plate ? `, plate ${m.plate}` : ''}${m.operator ? `, driver ${m.operator}` : ''}, site ${m.site_code} ${m.shift}, today: ${row}`;
  });
  const names = (aliases || []).map((a) => {
    const ms = ctx.machines.filter((m) => m.equipment_id === a.equipment_id).map((m) => m.n);
    return ms.length ? `«${a.alias_text}» = ${ms.join(' or ')}` : null;
  }).filter(Boolean);
  const sites = [...new Set(ctx.boards.map((b) => `${b.site_code} (${b.site_name || ''}) ${b.shift}`))].join('; ');
  return `Sites today: ${sites || 'none'}\nMachines:\n${lines.join('\n') || '(none)'}${names.length ? `\nHis names: ${names.join('; ')}` : ''}`;
}

/** parse({ text, ctx, now: 'HH:MM', lang, aliases, strong }) -> { reading, usage, model, latencyMs } (throws ai.AiError) */
async function parse({ text, ctx, now, lang = 'ar', aliases = [], strong = false }) {
  const clean = String(text || '').slice(0, MAX_TEXT);
  const user = `${listText(ctx, lang, aliases)}\nDate of the board: ${ctx.date}. Time now: ${now}. His language: ${lang === 'en' ? 'English' : 'Arabic'}.\n\nMessage:\n${clean}`;
  const n = ctx.machines.length;
  const maxTokens = Math.min(6000, Math.max(1200, 300 + 120 * Math.min(n, 40)));
  const r = await ai.callTool({ system: SYSTEM, user, tool: TOOL, maxTokens, model: strong ? ai.strongModel() : null });
  return { reading: normalize(r.input, n), usage: r.usage, model: r.model, latencyMs: r.latencyMs };
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

/** Keeps only valid values (numbers inside the list, known actions, HH:MM times). */
function normalize(input, n) {
  const inList = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= n))];
  const entries = (Array.isArray(input.entries) ? input.entries : []).slice(0, 200).map((e) => ({
    said: String(e.said || '').slice(0, 120),
    all: e.all === true,
    targets: inList(e.targets),
    ambiguous: e.ambiguous === true,
    except: inList(e.except),
    not_found: e.not_found === true,
    action: ['check_in', 'check_out', 'in_out', 'day_status', 'downtime'].includes(e.action) ? e.action : null,
    check_in: time(e.check_in),
    check_out: time(e.check_out),
    day_status: ['Standby', 'Breakdown', 'Absent', 'Holiday'].includes(e.day_status) ? e.day_status : '',
    reason: String(e.reason || '').trim().slice(0, 300),
    downtime_type: ['Break', 'Refuel', 'Breakdown', 'Standby'].includes(e.downtime_type) ? e.downtime_type : '',
    downtime_start: time(e.downtime_start),
    downtime_end: time(e.downtime_end),
    meter_start: num(e.meter_start),
    meter_end: num(e.meter_end),
  })).filter((e) => e.action);
  return {
    intent: ['record', 'status', 'not_recorded', 'help', 'cancel', 'other'].includes(input.intent) ? input.intent : 'other',
    work_date: String(input.work_date || '').trim(),
    site: String(input.site || '').trim().slice(0, 60),
    shift: ['Day', 'Night'].includes(input.shift) ? input.shift : '',
    entries,
    note: String(input.note || '').trim().slice(0, 300),
  };
}

module.exports = { parse, normalize, TOOL, SYSTEM, MAX_TEXT, listText };
