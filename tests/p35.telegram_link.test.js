// P35 — Telegram bot for supervisors, phase 2 (28 Oct 2026): linking from the app with a one-time code, the webhook
// secret, today's status read through the app's own routes (loopback), language, unlinking, and the rules
// (Active supervisors only, private chats only, one chat <-> one account). Telegram is never called (fake transport).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet } = require('./fixtures');
const { env } = require('../config/env');
const tg = require('../services/telegram/telegramApi');
const loopback = require('../services/telegram/loopback');

const SECRET = 'webhook-secret-1234567890';
const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const A = () => h.auth(h.T.admin());
const ACC = () => h.auth(h.T.accountant());
let sent = [];
let server;
let F;

const hook = (update, secret = SECRET) => h.api().post('/api/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send(update);
const msg = (chatId, text, type = 'private') => ({ update_id: Date.now(), message: { message_id: 1, chat: { id: chatId, type }, from: { id: chatId, username: `tg${chatId}` }, text } });
const textsTo = (chatId) => sent.filter((m) => m.method === 'sendMessage' && String(m.payload.chat_id) === String(chatId)).map((m) => m.payload.text);
const codeOf = (url) => url.split('?start=')[1];
async function linkCode(auth = S8()) { return ok(h.api().post('/api/telegram/link-code').set(auth)); }

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // 3 machines on S08 Day from 2026-09-01 (supervisor sup8); the test clock is 2026-10-20
  Object.assign(env.telegram, { enabled: true, botToken: 'test-token', botUsername: 'eq_test_bot', webhookSecret: SECRET, publicUrl: 'https://eq.example.com' });
  tg.setTransport(async (method, payload) => { sent.push({ method, payload }); return { message_id: sent.length }; });
  const app = require('../app').buildApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  env.telegram.loopbackUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  tg.setTransport(null);
  await new Promise((resolve) => server.close(resolve));
  await h.closePool();
});

test('webhook: 503 when not configured, 401 with a wrong secret, 200 with the right one', async () => {
  env.telegram.webhookSecret = '';
  assert.strictEqual((await hook(msg(1, 'hi'))).status, 503);
  env.telegram.webhookSecret = SECRET;
  assert.strictEqual((await hook(msg(1, 'hi'), 'wrong-secret-wrong-secret')).status, 401);
  assert.strictEqual((await h.api().post('/api/telegram/webhook').send(msg(1, 'hi'))).status, 401);
  assert.strictEqual((await hook(msg(1, 'hi'))).status, 200);
});

test('link code: supervisors only, a t.me link valid 15 minutes; off when the bot is off', async () => {
  const d = await linkCode();
  assert.match(d.url, /^https:\/\/t\.me\/eq_test_bot\?start=[A-Za-z0-9_-]{20,}$/);
  assert.strictEqual(d.valid_minutes, 15);
  assert.strictEqual((await h.api().post('/api/telegram/link-code').set(A())).status, 403);
  assert.strictEqual((await h.api().post('/api/telegram/link-code').set(ACC())).status, 403);
  assert.strictEqual((await h.api().post('/api/telegram/link-code')).status, 401);
  env.telegram.enabled = false;
  assert.strictEqual((await h.api().post('/api/telegram/link-code').set(S8())).status, 503);
  env.telegram.enabled = true;
  const [[{ n }]] = [await h.query('SELECT COUNT(*) AS n FROM tg_link_codes WHERE user_id = 3 AND used_at IS NULL')];
  assert.strictEqual(Number(n), 1, 'a new code replaces the unused one');
});

test('/start <code> links the chat and shows today\'s machines read through the app routes; the code works once', async () => {
  sent = [];
  const d = await linkCode();
  assert.strictEqual((await hook(msg(555, `/start ${codeOf(d.url)}`))).status, 200);
  const [row] = await h.query('SELECT chat_id, telegram_username, language FROM tg_links WHERE user_id = 3');
  assert.strictEqual(String(row.chat_id), '555');
  assert.strictEqual(row.telegram_username, 'tg555');
  assert.strictEqual(row.language, 'ar');
  const texts = textsTo(555);
  assert.match(texts[0], /أهلاً Supervisor/);
  assert.match(texts[1], /2026-10-20/);
  assert.match(texts[1], /S08/);
  assert.match(texts[1], /نهاري/);
  assert.match(texts[1], /3 آلية: 3 بدون سجل/);
  assert.match(texts[2], /بكلامك العادي/);
  const me = await ok(h.api().get('/api/telegram/me').set(S8()));
  assert.strictEqual(me.linked, true);
  sent = [];
  await hook(msg(556, `/start ${codeOf(d.url)}`));
  assert.match(textsTo(556)[0], /غلط أو انتهت صلاحيته/);
  const [still] = await h.query('SELECT chat_id FROM tg_links WHERE user_id = 3');
  assert.strictEqual(String(still.chat_id), '555', 'a used code changes nothing');
});

test('an expired code is refused', async () => {
  const d = await linkCode(S9());
  await h.query('UPDATE tg_link_codes SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE user_id = 4 AND used_at IS NULL');
  sent = [];
  await hook(msg(777, `/start ${codeOf(d.url)}`));
  assert.match(textsTo(777)[0], /غلط أو انتهت صلاحيته/);
  assert.strictEqual((await h.query('SELECT * FROM tg_links WHERE user_id = 4')).length, 0);
});

test('a status shows the recorded machines; an unlinked chat and a group get a clear answer', async () => {
  // the excavator works today (a Draft check-in through the app)
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00' }));
  sent = [];
  await hook(msg(555, '/status'));
  assert.match(textsTo(555)[0], /3 آلية: 1 شغّالة، 2 بدون سجل/);
  sent = [];
  await hook(msg(888, 'مرحبا'));
  assert.match(textsTo(888)[0], /مو مربوطة/);
  sent = [];
  await hook(msg(-100, 'مرحبا', 'group'));
  assert.match(textsTo(-100)[0], /محادثة خاصة/);
});

test('language: /en switches to English and is kept', async () => {
  sent = [];
  await hook(msg(555, '/en'));
  assert.match(textsTo(555)[0], /English/);
  sent = [];
  await hook(msg(555, '/status'));
  assert.match(textsTo(555)[0], /Your machines today/);
  assert.match(textsTo(555)[0], /Day/);
  await hook(msg(555, '/ar'));
});

test('one chat = one account: another supervisor linking the same chat takes it; re-linking moves the account', async () => {
  sent = [];
  const d = await linkCode(S9());
  await hook(msg(555, `/start ${codeOf(d.url)}`));
  const [s8] = await h.query('SELECT chat_id FROM tg_links WHERE user_id = 3');
  const [s9] = await h.query('SELECT chat_id FROM tg_links WHERE user_id = 4');
  assert.strictEqual(s8.chat_id, null);
  assert.strictEqual(String(s9.chat_id), '555');
  assert.match(textsTo(555).join('\n'), /S09/);
  assert.match(textsTo(555).join('\n'), /ليلي/, 'S09 has a night shift');
  // sup8 links a new chat; then sup9 moves from 555 to 600: 555 is told
  const d8 = await linkCode();
  await hook(msg(590, `/start ${codeOf(d8.url)}`));
  sent = [];
  const d9 = await linkCode(S9());
  await hook(msg(600, `/start ${codeOf(d9.url)}`));
  assert.match(textsTo(555)[0], /محادثة تانية/);
  const audits = await h.query("SELECT action_type FROM audit_logs WHERE table_name = 'tg_links' AND record_id = 4 ORDER BY log_id");
  assert.ok(audits.some((a) => a.action_type === 'link'));
});

test('an inactive account or a password to change: the bot says so and reads nothing', async () => {
  await h.query("UPDATE users SET status = 'Inactive' WHERE user_id = 4");
  sent = [];
  await hook(msg(600, 'شو الوضع'));
  assert.match(textsTo(600)[0], /موقوف/);
  await h.query("UPDATE users SET status = 'Active', must_change_password = 1 WHERE user_id = 4");
  sent = [];
  await hook(msg(600, 'شو الوضع'));
  assert.match(textsTo(600)[0], /كلمة السر/);
  await h.query('UPDATE users SET must_change_password = 0 WHERE user_id = 4');
});

test('the Admin lists and unlinks; the supervisor unlinks himself; the chat is told', async () => {
  const list = await ok(h.api().get('/api/telegram/links').set(A()));
  assert.deepStrictEqual(list.map((l) => l.user_id).sort(), [3, 4]);
  assert.strictEqual((await h.api().get('/api/telegram/links').set(S8())).status, 403);
  sent = [];
  await ok(h.api().delete('/api/telegram/links/4').set(A()).send({ reason: 'phone changed' }));
  assert.match(textsTo(600)[0], /فك ربط/);
  const [s9] = await h.query('SELECT chat_id FROM tg_links WHERE user_id = 4');
  assert.strictEqual(s9.chat_id, null);
  const [a] = await h.query("SELECT user_id, reason FROM audit_logs WHERE table_name = 'tg_links' AND record_id = 4 AND action_type = 'unlink' ORDER BY log_id DESC LIMIT 1");
  assert.strictEqual(a.user_id, 1);
  assert.strictEqual(a.reason, 'phone changed');
  await ok(h.api().delete('/api/telegram/me').set(S8()));
  assert.strictEqual((await ok(h.api().get('/api/telegram/me').set(S8()))).linked, false);
});

test('bot switched off (but configured): it answers that it is paused and links nothing', async () => {
  env.telegram.enabled = false;
  sent = [];
  assert.strictEqual((await hook(msg(590, 'hi'))).status, 200);
  assert.match(textsTo(590)[0], /متوقف/);
  env.telegram.enabled = true;
});

test('setup-webhook (Admin): registers the public URL with the secret', async () => {
  sent = [];
  const d = await ok(h.api().post('/api/telegram/setup-webhook').set(A()));
  assert.strictEqual(d.webhook, 'https://eq.example.com/api/telegram/webhook');
  const call = sent.find((m) => m.method === 'setWebhook');
  assert.strictEqual(call.payload.secret_token, SECRET);
  assert.strictEqual((await h.api().post('/api/telegram/setup-webhook').set(S8())).status, 403);
});

test('loopback: only the listed routes', async () => {
  await assert.rejects(() => loopback.call(3, 'POST', '/api/equipment/attendance/submit', { body: {} }), /not allowed/);
  await assert.rejects(() => loopback.call(3, 'GET', '/api/equipment/payroll/batches'), /not allowed/);
  const r = await loopback.call(3, 'GET', '/api/equipment/my-sites', { query: { date: '2026-10-20' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data[0].site_code, 'S08');
});
