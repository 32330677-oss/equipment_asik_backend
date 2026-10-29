// P36 — Telegram bot (29 Oct 2026 design): a session (day / site / shift) and a draft filled across messages and
// buttons; the AI only extracts what was SAID about each machine, the CODE finds the machine on the chosen board and
// asks what is missing (which one, times, reason); guided mode (day -> board -> all came / one by one); confirm through
// the app's own routes (Draft rows). The AI and Telegram are fakes; the day board, the routes and the database are real.
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
let sent = [];
let server;
let F;
let excB; // a second "Excavator 1" (another vendor) on the same board
let reply = () => ({ intent: 'other', entries: [] }); // (board text) -> tool input of the fake AI (read the message)
let planReply = () => ({ scope: 'out_of_scope' });
let answerReply = () => ({ answer: '' });
let aiCalls = 0;

const hook = (update) => h.api().post('/api/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update);
const say = (text) => hook({ update_id: Date.now(), message: { message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text } });
const tap = (data) => hook({ update_id: Date.now(), callback_query: { id: `cb${Date.now()}`, data, from: { id: CHAT }, message: { message_id: 99, chat: { id: CHAT, type: 'private' } } } });
const msgs = () => sent.filter((m) => ['sendMessage', 'editMessageText'].includes(m.method) && String(m.payload.chat_id) === String(CHAT));
const last = () => msgs().at(-1).payload;
/** The latest message whose text matches. */
const find = (re) => {
  const m = msgs().map((x) => x.payload).reverse().find((p) => re.test(p.text));
  assert.ok(m, `no message ${re} in ${JSON.stringify(msgs().map((x) => x.payload.text))}`);
  return m;
};
const buttons = (p) => ((p.reply_markup && p.reply_markup.inline_keyboard) || []).flat();
const button = (re, p = last()) => {
  const b = buttons(p).find((x) => re.test(x.text));
  assert.ok(b, `no button ${re} in ${JSON.stringify(buttons(p))}`);
  return b.callback_data;
};
const anyButton = (re) => {
  const m = msgs().map((x) => x.payload).reverse().find((p) => buttons(p).some((b) => re.test(b.text)));
  assert.ok(m, `no message with button ${re}`);
  return button(re, m);
};
const M = (o) => ({ type: '', number: null, vendor: '', plate: '', code: '', driver: '', ...o });
const E = (o) => ({ said: '', all: false, mention: M({}), except: [], action: 'check_in', check_in: '', check_out: '', day_status: '', reason: '', downtime_type: '', downtime_start: '', downtime_end: '', meter_start: null, meter_end: null, ...o, mention: M(o.mention || {}) });
const row = async (equipmentId, date = '2026-10-20') => (await h.query("SELECT * FROM eq_attendance WHERE equipment_id = ? AND record_date = ? AND status <> 'Cancelled'", [equipmentId, date]))[0];
const count = async (date = '2026-10-20') => Number((await h.query("SELECT COUNT(*) AS n FROM eq_attendance WHERE record_date = ? AND status <> 'Cancelled'", [date]))[0].n);

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // حفارة 1, تركس 1, رافعة متحركة 1 of Al-Bunyan on S08 Day (starts 07:00); test clock 2026-10-20 12:00
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
    const tool = request.tools[0].name;
    const content = request.messages[0].content;
    const input = tool === 'plan_reads' ? planReply(content) : tool === 'write_answer' ? answerReply(content) : reply(content);
    return { content: [{ type: 'tool_use', name: tool, input }], usage: { input_tokens: 10, output_tokens: 5 } };
  });
}

test('without an AI key the bot says so clearly and records nothing', async () => {
  sent = [];
  await say('كل الآليات دخلت 7');
  assert.match(last().text, /مو مفعّل/);
  assert.strictEqual(await count(), 0);
});

test('"all machines started at 7": the draft shows the day and the site; nothing saved before Confirm', async () => {
  fakeAi();
  reply = () => ({ intent: 'record', entries: [E({ said: 'كل الآليات', all: true, check_in: '07:00' })] });
  sent = [];
  await say('كل الآليات دخلت 7');
  const p = find(/رح سجّل/);
  assert.match(p.text, /2026-10-20/);
  assert.match(p.text, /S08/, 'one board: the site is chosen by itself');
  assert.match(p.text, /دخول 07:00/);
  assert.strictEqual(await count(), 0, 'nothing before Confirm');
  const confirm = button(/سجّل \(4\)/, p);
  sent = [];
  await tap(confirm);
  assert.match(last().text, /سجّلت 4 آلية كمسودة/);
  for (const m of [F.exc, F.loader, F.crane, excB]) {
    const r = await row(m.equipment_id);
    assert.strictEqual(r.status, 'Draft');
    assert.strictEqual(r.check_in_time, '2026-10-20 07:00:00');
    assert.strictEqual(r.recorded_by_user_id, 3);
  }
  sent = [];
  await tap(confirm);
  assert.match(last().text, /انتهى أو انسجّل/);
  assert.strictEqual(await count(), 4);
});

test('the machine is found by the code from what was SAID (type words), never by a list number; a future time is refused', async () => {
  reply = () => ({ intent: 'record', entries: [
    E({ said: 'التركس', mention: { type: 'التركس' }, action: 'check_out', check_out: '11:30', meter_end: 1520 }),
    E({ said: 'الرافعة', mention: { type: 'الرافعة' }, action: 'check_out', check_out: '17:00' }),
  ] });
  sent = [];
  await say('التركس طلع 11 ونص والعداد 1520، والرافعة طلعت 5');
  const p = find(/رح سجّل/);
  assert.match(p.text, /تركس 1 · Al-Bunyan.*خروج 11:30/);
  assert.match(p.text, /الساعة 17:00 لسا ما إجت/);
  await tap(button(/سجّل \(1\)/, p));
  const r = await row(F.loader.equipment_id);
  assert.strictEqual(r.check_out_time, '2026-10-20 11:30:00');
  assert.strictEqual(Number(r.meter_end), 1520);
  assert.strictEqual((await row(F.crane.equipment_id)).check_out_time, null);
});

test('"excavator 1" at two vendors: the bot asks which one; the vendor said picks it with no question; a special name is learned', async () => {
  reply = () => ({ intent: 'record', entries: [E({ said: 'حفارة 1', mention: { type: 'حفارة', number: 1 }, action: 'check_out', check_out: '11:00' })] });
  sent = [];
  await say('حفارة 1 طلعت 11');
  assert.match(last().text, /أي وحدة قصدك/);
  assert.ok(buttons(last()).some((b) => /Second Vendor/.test(b.text)) && buttons(last()).some((b) => /Al-Bunyan/.test(b.text)));
  await tap(button(/Second Vendor/));
  const p = find(/رح سجّل/);
  assert.match(p.text, /حفارة 1 · Second Vendor.*خروج 11:00/);
  await tap(button(/سجّل \(1\)/, p));
  assert.strictEqual((await row(excB.equipment_id)).check_out_time, '2026-10-20 11:00:00');
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null);
  assert.strictEqual((await h.query('SELECT * FROM eq_machine_aliases WHERE user_id = 3')).length, 0, '"حفارة 1" is never learned');

  // the vendor said: no question
  reply = () => ({ intent: 'record', entries: [E({ said: 'الحفارة تبع البنيان', mention: { type: 'الحفارة', vendor: 'البنيان' }, action: 'check_out', check_out: '11:10' })] });
  sent = [];
  await say('الحفارة تبع البنيان طلعت 11 و10');
  assert.doesNotMatch(msgs().map((x) => x.payload.text).join('\n'), /أي وحدة/);
  assert.match(find(/رح سجّل/).text, /حفارة 1 · Al-Bunyan.*خروج 11:10/);
  await tap(anyButton(/إلغاء/));

  // a name of his own: asked once, then known
  reply = () => ({ intent: 'record', entries: [E({ said: 'البوكلين الكبير', mention: { type: 'البوكلين' }, action: 'check_out', check_out: '11:15' })] });
  sent = [];
  await say('البوكلين الكبير طلع 11 وربع');
  await tap(button(/Al-Bunyan/));
  await tap(anyButton(/إلغاء/));
  const [alias] = await h.query('SELECT alias_text, equipment_id FROM eq_machine_aliases WHERE user_id = 3');
  assert.strictEqual(alias.equipment_id, F.exc.equipment_id);
  sent = [];
  await say('البوكلين الكبير طلع 11 وربع');
  assert.doesNotMatch(msgs().map((x) => x.payload.text).join('\n'), /أي وحدة/, 'his name is known now');
  assert.match(find(/رح سجّل/).text, /حفارة 1 · Al-Bunyan/);
  await tap(anyButton(/إلغاء/));
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null, 'cancelled: nothing recorded');
});

test('a breakdown with no reason: the bot asks, the next message is the reason', async () => {
  reply = () => ({ intent: 'record', entries: [E({ said: 'الرافعة', mention: { type: 'الرافعة المتحركة' }, action: 'day_status', day_status: 'Breakdown' })] });
  sent = [];
  await say('الرافعة معطلة اليوم');
  assert.match(last().text, /شو سبب/);
  const before = aiCalls;
  sent = [];
  await say('خربان الهيدروليك');
  assert.strictEqual(aiCalls, before, 'the answer is read by the code');
  const p = find(/رح سجّل/);
  assert.match(p.text, /معطّلة كل اليوم/);
  assert.match(p.text, /خربان الهيدروليك/);
  assert.match(p.text, /بيلغي الدوام المسجّل/);
  await tap(button(/سجّل \(1\)/, p));
  const r = await row(F.crane.equipment_id);
  assert.strictEqual(r.day_status, 'Breakdown');
  assert.strictEqual(r.remarks, 'خربان الهيدروليك');
});

test('an unknown machine: asked with the closest ones (never guessed); Skip leaves it out', async () => {
  reply = () => ({ intent: 'record', entries: [
    E({ said: 'البلدوزر', mention: { type: 'البلدوزر' }, action: 'day_status', day_status: 'Absent' }),
    E({ said: 'الحفارة تبع البنيان', mention: { type: 'حفارة', vendor: 'البنيان' }, action: 'check_out', check_out: '11:45' }),
  ] });
  sent = [];
  await say('البلدوزر ما إجا والحفارة تبع البنيان طلعت 11 و45');
  assert.match(last().text, /«البلدوزر»: ما لقيتها بالزبط/);
  await tap(button(/تجاهل/));
  const p = find(/رح سجّل/);
  assert.match(p.text, /حفارة 1 · Al-Bunyan.*خروج 11:45/);
  await tap(button(/إلغاء/, p));
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, null);
});

test('the session: the day said once is kept for the next messages; a missing time is asked and read by the code', async () => {
  reply = () => ({ intent: 'set_context', entries: [], work_date: '2026-10-19' });
  sent = [];
  await say('بدي دخّل حضور الآليات لتاريخ 19 أكتوبر');
  assert.match(last().text, /شغّال على/);
  assert.match(last().text, /2026-10-19/);
  assert.ok(buttons(last()).some((b) => /كلها إجت 07:00/.test(b.text)));

  // no date in this message: it is for the 19th
  reply = () => ({ intent: 'record', entries: [E({ said: 'الحفارة تبع البنيان', mention: { type: 'حفارة', vendor: 'البنيان' }, action: 'in_out', check_in: '08:00', check_out: '17:00' })] });
  sent = [];
  await say('الحفارة تبع البنيان من 8 لـ 5 مع الاستراحة');
  assert.match(find(/رح سجّل/).text, /2026-10-19/);

  // a machine with no times: the bot asks; "8 لـ 5" is read by the code, added to the SAME draft
  reply = () => ({ intent: 'record', entries: [E({ said: 'التركس', mention: { type: 'تركس' }, action: 'need_times' })] });
  sent = [];
  await say('بدي دخّل التركس ساعة الدخول والخروج');
  assert.match(last().text, /شو ساعة الدخول والخروج/);
  const before = aiCalls;
  sent = [];
  await say('8 لـ 5');
  assert.strictEqual(aiCalls, before);
  const p = find(/رح سجّل/);
  assert.match(p.text, /تركس 1 · Al-Bunyan.*دخول 08:00، خروج 17:00/);
  assert.match(p.text, /حفارة 1 · Al-Bunyan.*دخول 08:00، خروج 17:00/, 'the first machine is still in the draft');
  assert.doesNotMatch(p.text, /استراحة/, 'a break without times is not a stop');
  await tap(button(/سجّل \(2\)/, p));
  for (const m of [F.exc, F.loader]) {
    const r = await row(m.equipment_id, '2026-10-19');
    assert.strictEqual(r.check_in_time, '2026-10-19 08:00:00');
    assert.strictEqual(r.check_out_time, '2026-10-19 17:00:00');
  }
});

test('a break said without times is never a stop (the office applies the break policy)', async () => {
  reply = () => ({ intent: 'record', entries: [
    E({ said: 'الرافعة', mention: { type: 'رافعة متحركة' }, action: 'in_out', check_in: '08:00', check_out: '17:00' }),
    E({ said: 'استراحة', mention: { type: 'رافعة متحركة' }, action: 'downtime', downtime_type: 'Break' }),
  ] });
  sent = [];
  await say('الرافعة من 8 لـ 5 مع الاستراحة');
  const p = find(/رح سجّل/);
  assert.doesNotMatch(p.text, /استراحة/);
  await tap(button(/إلغاء/, p));
});

test('guided mode: Record a day -> day -> all came at the usual time -> one machine did not come -> Confirm', async () => {
  sent = [];
  await say('📋 سجّل يوم');
  await tap(`d|2026-10-18`);
  assert.match(last().text, /2026-10-18/);
  await tap(button(/كلها إجت 07:00 \(4\)/));
  let p = find(/رح سجّل/);
  assert.strictEqual((p.text.match(/دخول 07:00/g) || []).length, 4);
  await tap(button(/كل آلية لحالها/, p));
  const craneBtn = buttons(last()).find((b) => /رافعة متحركة/.test(b.text));
  await tap(craneBtn.callback_data);
  await tap(button(/ما إجت/));
  assert.ok(buttons(last()).some((b) => /❌ رافعة متحركة/.test(b.text)));
  await tap(button(/شوف المسودة/));
  p = find(/رح سجّل/);
  assert.match(p.text, /رافعة متحركة 1 · Al-Bunyan[^:\n]*: غايبة/);
  await tap(button(/سجّل \(4\)/, p));
  assert.strictEqual((await row(F.crane.equipment_id, '2026-10-18')).day_status, 'Absent');
  assert.strictEqual((await row(F.exc.equipment_id, '2026-10-18')).check_in_time, '2026-10-18 07:00:00');
  assert.strictEqual(await count('2026-10-18'), 4);
});

test('"today" brings the session back to today; short replies are read by the code alone', async () => {
  const before = aiCalls;
  sent = [];
  await say('اليوم');
  assert.match(last().text, /وضع آلياتك اليوم/);
  await say('شو ناقص');
  assert.match(last().text, /شو ناقص/);
  await say('شو آلياتي');
  assert.match(last().text, /آلياتك/);
  await say('لا');
  assert.match(last().text, /ما في شي ناطر تأكيد|تم الإلغاء/);
  assert.strictEqual(aiCalls, before);
});

test('a typed "yes" confirms the open draft like the button', async () => {
  reply = () => ({ intent: 'record', entries: [E({ said: 'التركس', mention: { type: 'تركس' }, action: 'check_out', check_out: '11:40' })] });
  sent = [];
  await say('لا التركس طلع 11:40');
  assert.match(find(/رح سجّل/).text, /تعديل الخروج 11:30 ← 11:40/);
  sent = [];
  await say('اي');
  assert.match(last().text, /سجّلت 1 آلية/);
  assert.strictEqual((await row(F.loader.equipment_id)).check_out_time, '2026-10-20 11:40:00');
  sent = [];
  await say('تمام');
  assert.match(last().text, /ما في شي ناطر تأكيد/);
});

test('a voice note: downloaded, turned into text, shown, then read like a message', async () => {
  tg.setDownloader(async () => Buffer.from('fake-ogg'));
  transcriber.setTransport(async () => 'الحفارة تبع البنيان طلعت الساعة 11');
  reply = () => ({ intent: 'record', entries: [E({ said: 'الحفارة تبع البنيان', mention: { type: 'الحفارة', vendor: 'البنيان' }, action: 'check_out', check_out: '11:00' })] });
  sent = [];
  await hook({ update_id: Date.now(), message: { message_id: 2, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, voice: { file_id: 'v1', duration: 6, mime_type: 'audio/ogg' } } });
  assert.match(msgs()[0].payload.text, /سمعت: «الحفارة تبع البنيان طلعت الساعة 11»/);
  await tap(button(/سجّل \(1\)/, find(/رح سجّل/)));
  assert.strictEqual((await row(F.exc.equipment_id)).check_out_time, '2026-10-20 11:00:00');
});

test('nothing to record and nothing said about a day: a clear answer, no empty draft shown', async () => {
  reply = () => ({ intent: 'other', entries: [E({ said: 'الآليات', all: true, action: 'day_status', day_status: '' })] });
  sent = [];
  await say('شو في؟');
  assert.match(last().text, /ما لقيت برسالتك شي لسجّله/);
  assert.doesNotMatch(last().text, /رح سجّل/);
});

test('"which machines do I have": the list per site / shift (nothing proposed)', async () => {
  reply = () => ({ intent: 'machines', entries: [] });
  sent = [];
  await say('شو الآليات الموجودة بالـ S08 نهاري؟');
  assert.match(last().text, /آلياتك/);
  assert.match(last().text, /Second Vendor/);
});

test('a question: read as the supervisor, answered from that data only; prices are out of scope', async () => {
  reply = () => ({ intent: 'question', entries: [] });
  planReply = () => ({ scope: 'machines', from: '2026-10-20', to: '2026-10-20', boards: true, rejected: true });
  let data = '';
  answerReply = (content) => { data = content; return { answer: 'الحفارة 1 تبع البنيان اشتغلت اليوم من 07:00 لـ 11:00.' }; };
  sent = [];
  await say('قديش اشتغلت الحفارة تبع البنيان اليوم؟');
  assert.strictEqual(last().text, 'الحفارة 1 تبع البنيان اشتغلت اليوم من 07:00 لـ 11:00.');
  assert.match(data, /Al-Bunyan/);
  assert.doesNotMatch(data, /hourly_rate|daily_rate|monthly_rate|price/i);
  planReply = () => ({ scope: 'out_of_scope' });
  sent = [];
  await say('قديش سعر ساعة الحفارة؟');
  assert.match(last().text, /برا اللي بقدر جاوب عليه/);
  planReply = () => ({ scope: 'machines', from: '2026-09-25', to: '2026-10-20', boards: true });
  sent = [];
  await say('كم ساعة اشتغلت الحفارة هالشهر؟');
  assert.match(last().text, /14 يوم أو أقل/);
});

test('the conversation is kept for the Admin (messages in and out)', async () => {
  const rows = await h.query('SELECT direction, kind FROM tg_chat_log WHERE chat_id = ?', [CHAT]);
  assert.ok(rows.some((r) => r.direction === 'in' && r.kind === 'text'));
  assert.ok(rows.some((r) => r.direction === 'in' && r.kind === 'voice'));
  assert.ok(rows.some((r) => r.direction === 'in' && r.kind === 'button'));
  assert.ok(rows.some((r) => r.direction === 'out'));
  const list = await ok(h.api().get('/api/telegram/chat-log/3').set(A()));
  assert.ok(list.length > 10);
  assert.strictEqual((await h.api().get('/api/telegram/chat-log/3').set(h.auth(h.T.sup8()))).status, 403);
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

test('the bot can only call the recording and reading routes of the app (no submit, no delete, no invoices)', async () => {
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/attendance/submit', { body: {} }), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'DELETE', '/api/equipment/attendance/5'), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/attendance/recall', { body: {} }), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/payroll/generate', { body: {} }), /not allowed/);
});

test('builder rules (no database): dates and night shift times', () => {
  assert.deepStrictEqual(builder.resolveDate('', '2026-10-20'), { date: '2026-10-20' });
  assert.deepStrictEqual(builder.resolveDate('yesterday', '2026-10-20'), { date: '2026-10-19' });
  assert.deepStrictEqual(builder.resolveDate('25', '2026-10-20'), { date: '2026-09-25' });
  assert.deepStrictEqual(builder.resolveDate('2026-10-21', '2026-10-20'), { error: 'date_future' });
  assert.strictEqual(builder.stamp('2026-10-20', '05:00', 'Night'), '2026-10-21 05:00:00');
});
