// P36 — Telegram bot, phase 3 (28 Oct 2026): recording machine attendance from a message or a voice note.
// The AI and Telegram are fakes; everything else is real: the day board, the proposal, the questions (which machine,
// the reason of a breakdown), Confirm through the app's own routes (Draft rows), cancel, double tap, limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet } = require('./fixtures');
const { env } = require('../config/env');
const tg = require('../services/telegram/telegramApi');
const ai = require('../services/telegram/ai');
const transcriber = require('../services/telegram/transcriber');
const builder = require('../services/telegram/builder');
const loopback = require('../services/telegram/loopback');

const SECRET = 'webhook-secret-1234567890';
const CHAT = 4242;
const A = () => h.auth(h.T.admin());
const S8 = () => h.auth(h.T.sup8());
let sent = [];
let server;
let F;
let excB; // a second "Excavator 1" (another vendor) on the same board
let reply = null; // (listText) -> tool input of the fake AI
let aiCalls = 0;

const hook = (update) => h.api().post('/api/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update);
const say = (text) => hook({ update_id: Date.now(), message: { message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text } });
const tap = (data) => hook({ update_id: Date.now(), callback_query: { id: `cb${Date.now()}`, data, from: { id: CHAT }, message: { message_id: 99, chat: { id: CHAT, type: 'private' } } } });
const msgs = () => sent.filter((m) => ['sendMessage', 'editMessageText'].includes(m.method) && String(m.payload.chat_id) === String(CHAT));
const last = () => msgs().at(-1).payload;
const buttons = (p = last()) => ((p.reply_markup && p.reply_markup.inline_keyboard) || []).flat();
const button = (re, p = last()) => {
  const b = buttons(p).find((x) => re.test(x.text));
  assert.ok(b, `no button ${re} in ${JSON.stringify(buttons(p))}`);
  return b.callback_data;
};
/** The number of a machine (by its code) in the list the bot gave the AI. */
const nOf = (list, code) => {
  const line = list.split('\n').find((l) => l.includes(`| ${code}`));
  assert.ok(line, `machine ${code} not in the list`);
  return Number(line.split('.')[0]);
};
const E = (o) => ({ said: '', all: false, targets: [], ambiguous: false, except: [], not_found: false, action: 'check_in', check_in: '', check_out: '', day_status: '', reason: '', downtime_type: '', downtime_start: '', downtime_end: '', meter_start: null, meter_end: null, ...o });
const row = async (equipmentId) => (await h.query("SELECT * FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-20' AND status <> 'Cancelled'", [equipmentId]))[0];

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // excavator, loader, crane of one vendor on S08 Day; the test clock is 2026-10-20 12:00
  // a second vendor with its own "Excavator 1" on the same board
  const v2 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Second Vendor' }));
  const c2 = await ok(h.api().post(`/api/equipment/vendors/${v2.vendor_id}/contracts`).set(A()).send({ contract_number: 'SV-1', start_date: '2026-07-01', currency: 'USD' }));
  excB = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: v2.vendor_id, type_id: 1, plate_number: 'P-900', make: 'CAT' }));
  await ok(h.api().post(`/api/equipment/machines/${excB.equipment_id}/rate-cards`).set(A()).send({ vendor_contract_id: c2.vendor_contract_id, effective_from: '2026-07-01', billing_mode: 'Hourly', hourly_rate: 30 }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: excB.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-09-01' }));

  Object.assign(env.telegram, { enabled: true, botToken: 'test-token', botUsername: 'eq_test_bot', webhookSecret: SECRET });
  tg.setTransport(async (method, payload) => { sent.push({ method, payload }); return { message_id: 1000 + sent.length }; });
  const app = require('../app').buildApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  env.telegram.loopbackUrl = `http://127.0.0.1:${server.address().port}`;
  await h.query('INSERT INTO tg_links (user_id, chat_id, language, linked_at) VALUES (3, ?, \'ar\', NOW())', [CHAT]);
});
after(async () => {
  tg.setTransport(null);
  ai.setTransport(null);
  transcriber.setTransport(null);
  await new Promise((resolve) => server.close(resolve));
  await h.closePool();
});

function fakeAi() {
  ai.setTransport(async (request) => {
    aiCalls += 1;
    const input = reply(request.messages[0].content);
    return { content: [{ type: 'tool_use', name: request.tools[0].name, input }], usage: { input_tokens: 10, output_tokens: 5 } };
  });
}

test('without an AI key the bot says so clearly and records nothing', async () => {
  sent = [];
  await say('كل الآليات دخلت 7');
  assert.match(last().text, /مو مفعّل/);
  assert.strictEqual((await h.query("SELECT COUNT(*) AS n FROM eq_attendance WHERE record_date = '2026-10-20'"))[0].n, 0);
});

test('"all machines started at 7": a proposal, nothing saved before Confirm, then Draft rows through the app routes', async () => {
  fakeAi();
  reply = () => ({ intent: 'record', entries: [E({ said: 'كل الآليات', all: true, check_in: '07:00' })] });
  sent = [];
  await say('كل الآليات دخلت 7');
  const p = last();
  assert.match(p.text, /رح سجّل/);
  assert.match(p.text, /دخول 07:00/);
  assert.strictEqual((await h.query("SELECT COUNT(*) AS n FROM eq_attendance WHERE record_date = '2026-10-20'"))[0].n, 0, 'nothing before Confirm');
  const confirm = button(/سجّل \(4\)/);
  sent = [];
  await tap(confirm);
  assert.match(last().text, /سجّلت 4 آلية كمسودة/);
  assert.match(last().text, /Submit من التطبيق/);
  for (const m of [F.exc, F.loader, F.crane, excB]) {
    const r = await row(m.equipment_id);
    assert.strictEqual(r.status, 'Draft');
    assert.strictEqual(r.check_in_time, '2026-10-20 07:00:00');
    assert.strictEqual(r.recorded_by_user_id, 3, 'recorded as the supervisor himself');
  }
  // a second tap on the same Confirm does nothing
  sent = [];
  await tap(confirm);
  assert.match(last().text, /انتهى أو انسجّل/);
  assert.strictEqual((await h.query("SELECT COUNT(*) AS n FROM eq_attendance WHERE record_date = '2026-10-20'"))[0].n, 4);
});

test('a check-out with the meter; a time still to come is refused before anything is sent', async () => {
  reply = (list) => ({ intent: 'record', entries: [
    E({ said: 'اللودر', targets: [nOf(list, F.loader.equipment_code)], action: 'check_out', check_out: '11:30', meter_end: 1520 }),
    E({ said: 'الكرين', targets: [nOf(list, F.crane.equipment_code)], action: 'check_out', check_out: '17:00' }),
  ] });
  sent = [];
  await say('اللودر طلع 11 ونص والعداد 1520، والكرين طلع 5');
  assert.match(last().text, /خروج 11:30/);
  assert.match(last().text, /الساعة 17:00 لسا ما إجت/);
  await tap(button(/سجّل \(1\)/));
  const r = await row(F.loader.equipment_id);
  assert.strictEqual(r.check_out_time, '2026-10-20 11:30:00');
  assert.strictEqual(Number(r.meter_end), 1520);
  assert.strictEqual((await row(F.crane.equipment_id)).check_out_time, null);
});

test('"excavator 1" at two vendors: the bot asks which one; a special name is learned, "excavator 1" never is', async () => {
  reply = (list) => ({ intent: 'record', entries: [E({ said: 'حفارة 1', targets: [nOf(list, F.exc.equipment_code), nOf(list, excB.equipment_code)], ambiguous: true, action: 'check_out', check_out: '11:00' })] });
  sent = [];
  await say('حفارة 1 طلعت 11');
  assert.match(last().text, /سؤال/);
  assert.ok(!buttons().some((b) => /سجّل/.test(b.text)), 'nothing clear to record yet');
  await tap(button(/أجب/));
  assert.match(last().text, /أي وحدة قصدك/);
  assert.ok(buttons().some((b) => /Second Vendor/.test(b.text)));
  await tap(button(/Second Vendor/));
  assert.match(last().text, /خروج 11:00/);
  await tap(button(/سجّل \(1\)/));
  assert.strictEqual((await row(excB.equipment_id)).check_out_time, '2026-10-20 11:00:00');
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null, 'the other excavator is untouched');
  assert.strictEqual((await h.query('SELECT * FROM eq_machine_aliases WHERE user_id = 3')).length, 0,
    '"excavator 1" fits both vendors: it is not learned, the bot will ask again next time');
  // a name of his own for one machine IS learned (picked, then cancelled: nothing recorded)
  reply = (list) => ({ intent: 'record', entries: [E({ said: 'البوكلين الكبير', targets: [nOf(list, F.exc.equipment_code), nOf(list, excB.equipment_code)], ambiguous: true, action: 'check_out', check_out: '11:15' })] });
  await say('البوكلين الكبير طلع 11 وربع');
  await tap(button(/أجب/));
  await tap(button(/Al-Bunyan/));
  await tap(button(/إلغاء/));
  const [alias] = await h.query('SELECT alias_text, equipment_id FROM eq_machine_aliases WHERE user_id = 3');
  assert.strictEqual(alias.equipment_id, F.exc.equipment_id);
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null, 'cancelled: nothing recorded');
  // the next message gives the AI his name for it
  let seen = '';
  reply = (list) => { seen = list; return { intent: 'help', entries: [] }; };
  await say('كيف بستعمل البوت');
  assert.match(seen, /His names: «البوكلين الكبير»/);
});

test('a breakdown with no reason: the bot asks, the next message is the reason; the session of that day is replaced', async () => {
  reply = (list) => ({ intent: 'record', entries: [E({ said: 'الكرين', targets: [nOf(list, F.crane.equipment_code)], action: 'day_status', day_status: 'Breakdown' })] });
  sent = [];
  await say('الكرين معطل اليوم');
  await tap(button(/أجب/));
  assert.match(last().text, /شو سبب/);
  sent = [];
  await say('خربان الهيدروليك');
  assert.match(last().text, /معطّلة كل اليوم/);
  assert.match(last().text, /خربان الهيدروليك/);
  assert.match(last().text, /بيلغي الدوام المسجّل/);
  await tap(button(/سجّل \(1\)/));
  const r = await row(F.crane.equipment_id);
  assert.strictEqual(r.day_status, 'Breakdown');
  assert.strictEqual(r.remarks, 'خربان الهيدروليك');
  assert.strictEqual(r.check_in_time, null);
});

test('an unknown machine is listed with the reason; Cancel records nothing', async () => {
  reply = (list) => ({ intent: 'record', entries: [
    E({ said: 'البلدوزر', not_found: true, action: 'day_status', day_status: 'Absent' }),
    E({ said: 'الحفارة تبع البنيان', targets: [nOf(list, F.exc.equipment_code)], action: 'check_out', check_out: '11:45' }),
  ] });
  sent = [];
  await say('البلدوزر ما إجا والحفارة تبع البنيان طلعت 11 و45');
  assert.match(last().text, /«البلدوزر»: ما لقيتها/);
  await tap(button(/إلغاء/));
  assert.match(last().text, /تم الإلغاء/);
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null);
  const [p] = await h.query('SELECT status FROM tg_pending WHERE user_id = 3 ORDER BY pending_id DESC LIMIT 1');
  assert.strictEqual(p.status, 'Cancelled');
});

test('"what is missing" lists machines still checked in, from the day board', async () => {
  reply = () => ({ intent: 'not_recorded', entries: [] });
  sent = [];
  await say('شو ناقص؟');
  assert.match(last().text, /شو ناقص/);
  assert.match(last().text, /داخلة وما طلعت: .*Al-Bunyan/);
});

test('a voice note: downloaded, turned into text, shown, then read like a message', async () => {
  tg.setDownloader(async () => Buffer.from('fake-ogg'));
  transcriber.setTransport(async () => 'الحفارة تبع البنيان طلعت الساعة 11');
  reply = (list) => ({ intent: 'record', entries: [E({ said: 'الحفارة تبع البنيان', targets: [nOf(list, F.exc.equipment_code)], action: 'check_out', check_out: '11:00' })] });
  sent = [];
  await hook({ update_id: Date.now(), message: { message_id: 2, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, voice: { file_id: 'v1', duration: 6, mime_type: 'audio/ogg' } } });
  assert.match(msgs()[0].payload.text, /سمعت: «الحفارة تبع البنيان طلعت الساعة 11»/);
  await tap(button(/سجّل \(1\)/));
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, '2026-10-20 11:00:00');
  const [log] = await h.query("SELECT COUNT(*) AS n FROM tg_agent_log WHERE user_id = 3 AND kind = 'voice' AND ok = 1");
  assert.ok(Number(log.n) >= 1);
});

test('daily limit: the bot stops reading and says so (no AI call)', async () => {
  process.env.BOT_DAILY_LIMIT = '1';
  const before = aiCalls;
  sent = [];
  await say('كل الآليات طلعت');
  assert.match(last().text, /حد اليومي/);
  assert.strictEqual(aiCalls, before);
  delete process.env.BOT_DAILY_LIMIT;
});

test('the bot can only call the recording routes of the app (no submit, no delete, no invoices)', async () => {
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/attendance/submit', { body: {} }), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'DELETE', '/api/equipment/attendance/5'), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/attendance/recall', { body: {} }), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/payroll/generate', { body: {} }), /not allowed/);
});

test('builder rules (no database): dates, night shift times, contradictions, check-out without check-in', () => {
  assert.deepStrictEqual(builder.resolveDate('', '2026-10-20'), { date: '2026-10-20' });
  assert.deepStrictEqual(builder.resolveDate('yesterday', '2026-10-20'), { date: '2026-10-19' });
  assert.deepStrictEqual(builder.resolveDate('25', '2026-10-20'), { date: '2026-09-25' });
  assert.deepStrictEqual(builder.resolveDate('2026-10-21', '2026-10-20'), { error: 'date_future' });
  assert.strictEqual(builder.stamp('2026-10-20', '05:00', 'Night'), '2026-10-21 05:00:00');
  assert.strictEqual(builder.stamp('2026-10-20', '19:00', 'Night'), '2026-10-20 19:00:00');
  const ctx = { date: '2026-10-20', boards: [{ site_id: 8, shift: 'Day', can_edit: true }], machines: [
    { n: 1, equipment_id: 11, site_id: 8, site_code: 'S08', shift: 'Day', row: null },
    { n: 2, equipment_id: 12, site_id: 8, site_code: 'S08', shift: 'Day', row: null },
  ] };
  const plan = builder.build({ ctx, nowStamp: '2026-10-20 18:00:00', reading: { site: '', shift: '', entries: [
    E({ targets: [1], action: 'day_status', day_status: 'Absent', check_in: '07:00' }),
    E({ targets: [2], action: 'check_out', check_out: '17:00' }),
  ] } });
  assert.deepStrictEqual(plan.steps, []);
  assert.deepStrictEqual(plan.skipped.map((s) => s.why).sort(), ['conflict', 'no_check_in']);
});
