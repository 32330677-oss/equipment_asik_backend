const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

before(h.resetDatabase);
after(h.closePool);
const A = () => h.auth(h.T.admin());

test('login ok returns token and user', async () => {
  const r = await h.api().post('/api/auth/login').send({ username: 'ADMIN', password: h.PASSWORD });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.token);
  assert.strictEqual(r.body.data.user.role, 'Admin');
  const me = await h.api().get('/api/auth/me').set(h.auth(r.body.data.token));
  assert.strictEqual(me.body.data.user.username, 'admin');
});

test('wrong password -> INVALID_CREDENTIALS; 5 failures lock the account', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await h.api().post('/api/auth/login').send({ username: 'sup9', password: 'wrong-password-1' });
    assert.strictEqual(r.body.code, 'INVALID_CREDENTIALS');
  }
  const locked = await h.api().post('/api/auth/login').send({ username: 'sup9', password: h.PASSWORD });
  assert.strictEqual(locked.status, 423);
  assert.strictEqual(locked.body.code, 'ACCOUNT_LOCKED');
  const hist = await h.query('SELECT COUNT(*) AS n FROM login_history WHERE username_tried = ?', ['sup9']);
  assert.strictEqual(Number(hist[0].n), 6);
  await h.query('UPDATE users SET locked_until = NULL WHERE user_id = 4');
});

test('unknown user gets the same INVALID_CREDENTIALS', async () => {
  const r = await h.api().post('/api/auth/login').send({ username: 'ghost', password: 'whatever123' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.code, 'INVALID_CREDENTIALS');
});

test('token missing / invalid / expired', async () => {
  assert.strictEqual((await h.api().get('/api/auth/me')).body.code, 'TOKEN_MISSING');
  assert.strictEqual((await h.api().get('/api/auth/me').set(h.auth('abc'))).body.code, 'TOKEN_INVALID');
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ user_id: 1, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
  assert.strictEqual((await h.api().get('/api/auth/me').set(h.auth(expired))).body.code, 'TOKEN_EXPIRED');
});

test('admin creates user; temp password works; must change before anything else', async () => {
  const c = await h.api().post('/api/users').set(A()).send({ username: 'samer', full_name: 'Samer H.', role: 'Supervisor' });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  const temp = c.body.data.temporary_password;
  assert.ok(temp && temp.length >= 10);
  assert.strictEqual(c.body.data.password_hash, undefined);
  const login = await h.api().post('/api/auth/login').send({ username: 'samer', password: temp });
  assert.strictEqual(login.body.data.user.must_change_password, true);
  const tk = login.body.data.token;
  const blocked = await h.api().get('/api/sites').set(h.auth(tk));
  assert.strictEqual(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
  const weak = await h.api().post('/api/auth/change-password').set(h.auth(tk)).send({ current_password: temp, new_password: 'short' });
  assert.strictEqual(weak.body.code, 'WEAK_PASSWORD');
  const ok = await h.api().post('/api/auth/change-password').set(h.auth(tk)).send({ current_password: temp, new_password: 'NewPassword2026' });
  assert.strictEqual(ok.status, 200);
  // the old session ends; the token returned by change-password keeps this device signed in
  const old = await h.api().get('/api/sites').set(h.auth(tk));
  assert.strictEqual(old.body.code, 'TOKEN_REVOKED');
  const now = await h.api().get('/api/sites').set(h.auth(ok.body.data.token));
  assert.strictEqual(now.status, 200);
});

test('non-admin cannot manage users; accountant cannot edit settings', async () => {
  assert.strictEqual((await h.api().get('/api/users').set(h.auth(h.T.accountant()))).body.code, 'FORBIDDEN_ROLE');
  assert.strictEqual((await h.api().get('/api/users').set(h.auth(h.T.sup8()))).status, 403);
  assert.strictEqual((await h.api().get('/api/settings').set(h.auth(h.T.accountant()))).status, 200);
  assert.strictEqual((await h.api().put('/api/settings/eq_paper_tolerance_minutes').set(h.auth(h.T.accountant())).send({ value: 5 })).status, 403);
});

test('LAST_ADMIN protection', async () => {
  const r = await h.api().patch('/api/users/1/status').set(A()).send({ status: 'Inactive' });
  assert.strictEqual(r.body.code, 'LAST_ADMIN');
  const r2 = await h.api().put('/api/users/1').set(A()).send({ role: 'Accountant' });
  assert.strictEqual(r2.body.code, 'LAST_ADMIN');
});

test('deactivated user is refused immediately', async () => {
  const tk = h.T.accountant();
  await h.api().patch('/api/users/2/status').set(A()).send({ status: 'Inactive' });
  assert.strictEqual((await h.api().get('/api/auth/me').set(h.auth(tk))).body.code, 'ACCOUNT_INACTIVE');
  await h.api().patch('/api/users/2/status').set(A()).send({ status: 'Active' });
});

test('supervisor with open site periods cannot be deactivated', async () => {
  const r = await h.api().patch('/api/users/3/status').set(A()).send({ status: 'Inactive' });
  assert.strictEqual(r.body.code, 'USER_HAS_SITE_ASSIGNMENTS');
});

test('reset password unlocks and forces change', async () => {
  const r = await h.api().post('/api/users/4/reset-password').set(A());
  assert.ok(r.body.data.temporary_password);
  const u = await h.query('SELECT must_change_password, password_changed_at FROM users WHERE user_id = 4');
  assert.strictEqual(Number(u[0].must_change_password), 1);
  assert.ok(u[0].password_changed_at, 'a reset ends the sessions of the user');
  assert.strictEqual((await h.api().get('/api/auth/me').set(h.auth(h.T.sup9()))).body.code, 'TOKEN_REVOKED');
  await h.query('UPDATE users SET must_change_password = 0, password_changed_at = NULL WHERE user_id = 4');
});

test('sites: create, duplicate code, supervisor sees only own sites', async () => {
  const c = await h.api().post('/api/sites').set(A()).send({ site_code: 's11', site_name: 'Mall', has_night_shift: true, day_shift_start: '07:00', night_shift_start: '19:00' });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.strictEqual(c.body.data.site_code, 'S11');
  const dup = await h.api().post('/api/sites').set(A()).send({ site_code: 'S11', site_name: 'Other' });
  assert.strictEqual(dup.status, 409);
  const mine = await h.api().get('/api/sites').set(h.auth(h.T.sup8()));
  assert.deepStrictEqual(mine.body.data.map((s) => s.site_code), ['S08']);
});

test('supervisor periods: overlap refused, replace ends D-1 and opens D, night needs night shift', async () => {
  const ov = await h.api().post('/api/sites/8/supervisors').set(A()).send({ user_id: 4, shift_type: 'Day', from_date: '2026-06-01' });
  assert.strictEqual(ov.body.code, 'SUPERVISOR_PERIOD_OVERLAP');
  const night = await h.api().post('/api/sites/8/supervisors').set(A()).send({ user_id: 4, shift_type: 'Night', from_date: '2026-06-01' });
  assert.strictEqual(night.body.code, 'NO_NIGHT_SHIFT');
  const rep = await h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 4, shift_type: 'Day', first_day: '2026-10-15' });
  assert.strictEqual(rep.status, 201, JSON.stringify(rep.body));
  assert.strictEqual(rep.body.data.ended.to_date, '2026-10-14');
  assert.strictEqual(rep.body.data.created.from_date, '2026-10-15');
  const notSup = await h.api().post('/api/sites/10/supervisors').set(A()).send({ user_id: 2, from_date: '2026-06-01' });
  assert.strictEqual(notSup.body.code, 'NOT_A_SUPERVISOR');
});

test('supervisor periods: replacing from the first day or ending at from_date - 1 cancels the period (no 500)', async () => {
  const again = await h.api().post('/api/sites/8/supervisors/replace').set(A()).send({ user_id: 3, shift_type: 'Day', first_day: '2026-10-15' });
  assert.strictEqual(again.status, 201, JSON.stringify(again.body));
  assert.strictEqual(again.body.data.ended.cancelled, true);
  const id = again.body.data.created.site_supervisor_id;
  const cancel = await h.api().patch(`/api/site-supervisors/${id}/end`).set(A()).send({ to_date: '2026-10-14' });
  assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
  assert.strictEqual(cancel.body.data.cancelled, true);
  assert.strictEqual((await h.query('SELECT COUNT(*) AS n FROM site_supervisors WHERE site_supervisor_id = ?', [id]))[0].n, 0);
});

test('settings validation + audit written', async () => {
  const bad = await h.api().put('/api/settings/eq_paper_tolerance_minutes').set(A()).send({ value: 'abc' });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR');
  const ok = await h.api().put('/api/settings/eq_paper_tolerance_minutes').set(A()).send({ value: 15 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(await require('../services/settings').getInt('eq_paper_tolerance_minutes'), 15);
  const unknown = await h.api().put('/api/settings/hack').set(A()).send({ value: 1 });
  assert.strictEqual(unknown.status, 404);
  const log = await h.api().get('/api/audit?table=settings').set(A());
  assert.ok(log.body.data.length >= 1);
  assert.strictEqual(log.body.data[0].new_values.value, '15');
});
