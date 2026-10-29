// tests/eval/bot_eval.js — how well the bot understands REAL supervisor messages (not part of `npm test`).
// It calls the real AI (needs OPENAI_API_KEY in .env, costs a few cents) and the real matcher, on a fixed board
// (the S-BRIDGES / S-T2 machines in cases.json). No database, nothing is written.
//   node tests/eval/bot_eval.js            -> score per case + the total
//   node tests/eval/bot_eval.js --only 3   -> one case, with what the AI returned
// Add every message the bot got wrong to cases.json with what it SHOULD give; the score must not go down.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const parser = require('../../services/telegram/parser');
const matcher = require('../../services/telegram/matcher');
const { parseTimes } = require('../../services/telegram/timeParse');
const ai = require('../../services/telegram/ai');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null;

const machines = data.machines.map((m, i) => ({ n: i + 1, key: m.key, equipment_id: m.key, code: `EQ-${m.key}`, type_name: m.type || null, type_name_ar: m.type_ar || null, type_seq: m.seq || 1, vendor_name: m.vendor, site_id: 1, site_code: 'S-BRIDGES', shift: 'Day', row: null }));
const ctx = { date: data.today, machines, boards: [{ site_id: 1, site_code: 'S-BRIDGES', site_name: 'Bridges', shift: 'Day' }] };

function check(c, reading) {
  const fails = [];
  const e = c.expect;
  if (e.intent && reading.intent !== e.intent) fails.push(`intent ${reading.intent} (want ${e.intent})`);
  if (e.work_date !== undefined && reading.work_date !== e.work_date) fails.push(`date «${reading.work_date}» (want «${e.work_date}»)`);
  for (const want of e.items || []) {
    const got = reading.entries.filter((x) => !x.all).map((x) => ({ x, r: matcher.resolve({ said: x.said, ...x.mention }, machines) }));
    const hit = want.key === 'ask'
      ? got.find(({ r }) => !r.sure)
      : got.find(({ r }) => r.sure && r.keys[0] === want.key);
    if (!hit) { fails.push(`machine ${want.key} not found (${JSON.stringify(got.map(({ x, r }) => [x.mention, r.sure ? r.keys[0] : `ask ${r.keys}`]))})`); continue; }
    for (const f of ['action', 'check_in', 'check_out', 'day_status']) {
      if (want[f] !== undefined && hit.x[f] !== want[f]) fails.push(`machine ${want.key} ${f} «${hit.x[f]}» (want «${want[f]}»)`);
    }
  }
  if (e.all && !reading.entries.some((x) => x.all)) fails.push('no "all" entry');
  if (e.no_downtime && reading.entries.some((x) => x.action === 'downtime')) fails.push('a break became a stop');
  if (e.count !== undefined && reading.entries.length !== e.count) fails.push(`${reading.entries.length} entries (want ${e.count})`);
  return fails;
}

(async () => {
  if (!ai.isConfigured()) { console.log('No AI key (OPENAI_API_KEY) in .env'); process.exit(1); }
  let pass = 0;
  let total = 0;
  for (const [i, c] of data.cases.entries()) {
    if (only !== null && only !== i) continue;
    total += 1;
    let fails;
    if (c.times) { // a short time answer read by the code, no AI
      const t = parseTimes(c.text, c.shift || 'Day');
      fails = JSON.stringify(t) === JSON.stringify(c.times) ? [] : [`times ${JSON.stringify(t)} (want ${JSON.stringify(c.times)})`];
    } else {
      const { reading } = await parser.parse({ text: c.text, ctx, session: { date: data.today }, now: { date: data.today, time: '12:00' }, lang: 'ar' });
      fails = check(c, reading);
      if (only !== null) console.log(JSON.stringify(reading, null, 1));
    }
    if (!fails.length) pass += 1;
    console.log(`${fails.length ? '✗' : '✓'} ${i}. ${c.text}${fails.length ? `\n    ${fails.join('\n    ')}` : ''}`);
  }
  console.log(`\n${pass}/${total} understood (${Math.round((100 * pass) / Math.max(total, 1))}%)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
