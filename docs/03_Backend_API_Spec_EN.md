# Backend API — Specification

**Node.js 20 / Express 5 — new repository equipment_flow_backend**

Project skeleton, foundation services, authentication, users, sites, settings and every equipment endpoint.

_Equipment Flow · Doc 03 · v2.0 standalone · 2026-10-03_

---

# 1. Project skeleton (new repository `equipment_flow_backend`)

```
equipment_flow_backend/
├─ package.json                 "type": "commonjs", scripts: start, dev, test, migrate, create-admin
├─ .env.example                 every variable of §1.2 with comments
├─ server.js                    starts the app after config validation + DB ping
├─ app.js                       builds the Express app (exported for tests)
├─ config/
│   ├─ env.js                   reads + validates env (fails fast)
│   └─ db.js                    mysql2/promise pool (dateStrings: true, timezone: 'Z'), withTransaction()
├─ middleware/
│   ├─ requireAuth.js           JWT → user re-read from DB (role, status) on every request
│   ├─ requireRole.js           requireRole('Admin','Accountant',...)
│   ├─ rateLimits.js            login limiter, upload limiter
│   ├─ requestId.js             x-request-id for logs
│   └─ errorHandler.js          AppError → JSON shape; unknown → 500
├─ utils/
│   ├─ AppError.js              class AppError(status, code, message, details)
│   ├─ businessDate.js          businessToday(), addDays(), isValidDateOnly(), dayOfWeek()
│   ├─ dateTime.js              toMySqlDateTime(), diffMinutes(), parse wall-clock strings (no TZ shift)
│   ├─ ranges.js                rangesOverlap(aFrom,aTo,bFrom,bTo), activeOnSql(alias,'?') (inclusive, NULL = open)
│   ├─ money.js                 toCents(), fromCents(), formatMoney(cents, currency)
│   └─ validate.js              small validators: id(), date(), datetime(), money(), pct(), enumOf(), page()
├─ services/
│   ├─ settings.js              cached key/value with typed getters getBool/getInt/getString
│   ├─ audit.js                 audit.log(conn, {...})
│   ├─ fileStorage.js           storage adapter: local | s3
│   ├─ uploads.js               multer memory storage + magic-number check
│   ├─ pdfKit.js                shared pdfkit helpers: fonts (Helvetica + Noto Naskh Arabic), logo, header band,
│   │                           Arabic shaping, table drawer, footer "Page x / y"
│   └─ equipment/               (see §3)
├─ controllers/
│   ├─ authController.js        login, me, change-password
│   ├─ userController.js        users CRUD, reset password, status
│   ├─ siteController.js        sites + site supervisors
│   ├─ settingsController.js    list / update settings
│   ├─ auditController.js       read audit log
│   └─ equipment/               (see §1.1)
├─ routes/
│   ├─ index.js                 mounts every router under /api
│   ├─ authRoutes.js  userRoutes.js  siteRoutes.js  settingsRoutes.js  auditRoutes.js
│   └─ equipmentRoutes.js       everything of §5, mounted at /api/equipment
├─ database/                    schema.sql, seed.sql, rollback_drop_all.sql, migrations/
├─ scripts/
│   ├─ migrate.js               applies database/migrations/*.sql in order, records schema_migrations
│   ├─ createAdmin.js           first Admin with a random temporary password
│   └─ seedDemo.js              demo data (refuses NODE_ENV=production)
├─ assets/  logo.png  fonts/NotoNaskhArabic-Regular.ttf
├─ docs/                        this specification package
└─ tests/                       helpers.js + *.test.js (node --test)
```

## 1.1 Equipment controllers and services

```
controllers/equipment/
  vendorController.js        vendors + contracts (+ document)
  fleetController.js         types, machines (+ photo), operators
  rateCardController.js      rate cards + preview
  deploymentController.js    site assignments / transfers / end
  eqAttendanceController.js  supervisor recording, submit, resubmit, my-sites
  eqReviewController.js      review, anomalies, edits, corrections
  eqFuelAdjustmentController.js
  timesheetController.js     sheets, print, scans, paper checks, close
  eqPayrollController.js     preview, blockers, generate, life cycle, exports, statements
  eqLiveController.js        live board, daily report, utilization
services/equipment/
  eqAccess.js  eqAttendanceService.js  eqLock.js  eqTimesheetService.js  weekGate.js
  equipmentBillingEngine.js (PURE, doc 04)  eqPayrollService.js  eqPdf.js  eqExcel.js  eqLiveService.js
```

## 1.2 Environment variables

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `5000` | |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | | `DB_SSL=true` for managed MySQL |
| `JWT_SECRET` | 64 random chars | server refuses to start if missing or < 32 chars |
| `JWT_EXPIRES_IN` | `12h` | |
| `CORS_ORIGINS` | `https://equipment.example.com,http://localhost:5173` | comma separated |
| `APP_TIME_ZONE` | `Asia/Beirut` | overrides setting |
| `FILE_STORAGE_DRIVER` | `s3` or `local` | |
| `FILE_STORAGE_DIR` | `/var/data/eqflow-files` | local driver |
| `S3_BUCKET` `S3_REGION` `S3_ENDPOINT` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | | s3 driver (R2: region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`) |
| `LOGIN_RATE_LIMIT_MAX` | `20` | per 15 min per IP |

Dependencies: `express@5 mysql2 jsonwebtoken bcryptjs multer pdfkit exceljs qrcode helmet cors express-rate-limit dotenv` (+ `@aws-sdk/client-s3` for the s3 driver); dev: `nodemon supertest`.

# 2. Conventions

## 2.1 Responses

**One response shape everywhere:**

```json
// success
{ "status": "success", "data": { ... }, "message": "optional human text" }
// list
{ "status": "success", "data": [ ... ], "meta": { "total": 120, "page": 1, "page_size": 50 } }
// error
{ "status": "error", "code": "MACHINE_NOT_ASSIGNED", "message": "Human readable English text", "details": { } }
```

HTTP codes: `200` read/update, `201` create, `400` validation, `401` auth (middleware), `403` role / site scope, `404` not found, `409` state conflict (lock, duplicate, open session, wrong workflow state), `413` file too big, `415` file type, `429` rate limit, `500` unexpected (logged with the request id, generic message to the client). Controllers throw `AppError(status, code, message, details)`; `errorHandler` formats every error.

## 2.2 Validation & types

- Dates `YYYY-MM-DD` validated with `isValidDateOnly`; datetimes `YYYY-MM-DD HH:mm[:ss]` (wall clock in the business time zone, **no** timezone conversion — `utils/dateTime.toMySqlDateTime()`).
- Ids: positive integers (`Number.isInteger(n) && n > 0`).
- Money: strings or numbers with max 2 decimals (3 for fuel price); reject negatives except `eq_adjustments.amount`.
- Percentages 0–100. Hours 0–24.
- Pagination `page` (default 1), `page_size` (default 50, max 200).

## 2.3 Transactions, locks, audit

Every write that touches more than one row runs inside `withTransaction(async (conn) => { ... })` (begin / commit / rollback / release). Rows that are read and then changed are read with `FOR UPDATE`. Every create / update / status change calls `audit.log(conn, {table, id, action, userId, oldValues, newValues, reason})` → `audit_logs`. Payroll-lock checks (`eqLock.assertEqEditable`) run **inside** the transaction.

## 2.4 Price hiding for Supervisors

Controllers that serve Supervisors must select explicit columns; never `SELECT *` from `eq_rate_cards`, `eq_payroll_*`, `eq_fuel_issues.price_per_liter`, `eq_adjustments`. A test asserts that no Supervisor response contains the keys `hourly_rate`, `daily_rate`, `monthly_rate`, `amount`, `price_per_liter`, `net_amount`.

# 3. Shared services

### 3.1 `eqAccess.js`

```js
// A Supervisor may act on (site, shift) on a date when site_supervisors covers it (doc 02 §4.1). Admin → always.
async function canActOnSite(user, siteId, shiftType, date, executor = db)
async function assertCanActOnSite(user, siteId, shiftType, date, executor = db)   // 403 SITE_FORBIDDEN
async function supervisorSites(userId, date, executor = db)                       // [{site_id, site_code, site_name, shift_type}]
async function assertMachineDeployed(executor, equipmentId, siteId, shiftType, date) // 400 MACHINE_NOT_ASSIGNED
```

The date checked is always the **record date** of the row (not today), so a supervisor replaced on the 15th can still fix his rejected rows of the 10th only if he supervised that date.

### 3.2 `eqAttendanceService.js`

- `recompute(conn, eqAttendanceId)` — reads the row + its downtime periods (`FOR UPDATE`), clips periods to the session, sums minutes per type (`Break`+`Refuel` → `break_minutes`), writes `gross_minutes, break_minutes, breakdown_minutes, standby_minutes, working_minutes`, then calls `evaluateAnomalies`.
- `evaluateAnomalies(conn, row)` — sets the **first** applicable code (priority order) and a detail text; clears `anomaly_*` when nothing applies; an acknowledged anomaly stays acknowledged only if the code is unchanged.

| Code | Condition |
|---|---|
| `open_overlap` | another row of the same machine overlaps in time (should be blocked earlier; defensive) |
| `long_session` | gross > `eq_long_session_review_hours` |
| `meter_backwards` | `meter_start` < previous row's `meter_end` for the machine |
| `meter_mismatch` | hour meter and `abs(Δmeter − working_h) / working_h × 100 > eq_meter_tolerance_pct` |
| `operator_license_expired` | operator license expiry < record date |
| `operator_missing` | Working row without operator at check-out |

- `assertNoOpenSession(conn, equipmentId, exceptId)` → 409 `MACHINE_HAS_OPEN_SESSION` (details: site, check-in).
- `assertNoTimeOverlap(conn, equipmentId, inTime, outTime, exceptId)` → 409 `MACHINE_TIME_OVERLAP`.

### 3.3 `eqLock.js`

`findLockedEqBatch(executor, {vendorId, equipmentId, siteId, date})` (doc 02 §4.7), `assertEqEditable(executor, row)` → throws `EqPayrollLockedError` (409, `PAYROLL_PERIOD_FINALIZED`), plus `rowInActiveBatch(executor, eqAttendanceId)` (used by edit endpoints: a row inside a non-finalized active batch can be edited, but the batch is flagged *stale* → the UI tells the Admin to regenerate).

### 3.4 `eqTimesheetService.js`

- `getOrCreate(conn, equipmentId, siteId, month)` — `INSERT IGNORE` then `SELECT ... FOR UPDATE`. `sheet_code = ETS-{YYYY}-{MM}-{equipment_code without dash}-{site_code}`, `verify_token = crypto.randomBytes(8).toString('hex')`.
- `allocateRow(conn, timesheetId)` → next `sheet_row_no` (BR-25). If the sheet is `Closed`, new rows are refused with 409 `TIMESHEET_CLOSED` unless the Admin reopens it.
- `refreshStatus(conn, timesheetId)` → sets `Reconciled` when Closed and all rows Matched; back to `Closed` otherwise.

### 3.5 `weekGate.js`

`weekBounds(date)` uses the setting `week_start_day` (default 6 = Saturday, so the week runs Saturday → Friday). `previousWeekDrafts(conn, siteId, shiftType, recordDate)` → `{prev_start, prev_end, days:[{record_date, drafts}]}` counting `eq_attendance.status = 'Draft'` in the previous week. Missing rows never block; only existing Drafts do. Disabled when `week_gate_enabled = false`.

### 3.6 `fileStorage.js`

```js
// driver chosen by env FILE_STORAGE_DRIVER = 'local' | 's3'
async function put({ key, buffer, contentType })   // returns { key, size, sha256 }
async function getStream(key)                      // readable stream
async function exists(key)
// local: root = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', 'uploads')
// s3: S3_BUCKET, S3_REGION, S3_ENDPOINT (R2/B2), S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
```

Keys: `equipment/contracts/{contractId}/{sha8}.pdf`, `equipment/machines/{id}/photo-{sha8}.jpg`, `equipment/timesheets/{sheetCode}/v{version}-{n}-{sha8}.{ext}`, `equipment/fuel/{id}-{sha8}.jpg`. Never use the client file name in the key; reject `..`.

Uploads use `multer.memoryStorage()` (`services/uploads.js`) with limits `fileSize: 15 MB`, `files: 10`, and a MIME + magic-number check (`%PDF`, JPEG `FF D8 FF`, PNG `89 50 4E 47`, WEBP `RIFF....WEBP`).

# 4. Platform endpoints (auth, users, sites, settings, audit)

All paths relative to **`/api`**.

## 4.1 Authentication

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public (rate-limited) | `{username, password}` → `{token, expires_at, user:{user_id, full_name, role, must_change_password}}` |
| GET | `/auth/me` | any | Current user + `sites` (for Supervisor: today's site/shifts) + feature flags |
| POST | `/auth/change-password` | any | `{current_password, new_password}` → clears `must_change_password` |

Login rules (BR-P1…P4):

1. Look up the user by username (case-insensitive).
2. If `locked_until` is in the future → 423 `ACCOUNT_LOCKED` with `details.locked_until`.
3. Compare the password with bcrypt.
4. If it is wrong: `failed_login_attempts + 1`; at 5 set `locked_until = now + 15 min` and reset the counter. Then 401 `INVALID_CREDENTIALS` (same message whether the username exists or not).
5. If the account is Inactive → 401 `ACCOUNT_INACTIVE`.
6. On success: reset the counter, set `last_login_at`, write `login_history` (every attempt is logged), and sign `{user_id}` with `JWT_EXPIRES_IN`.

While `must_change_password = 1`, every route except `/auth/me` and `/auth/change-password` answers 403 `PASSWORD_CHANGE_REQUIRED`.

`requireAuth`:

- reads the `Bearer` token;
- verifies it (`TOKEN_EXPIRED` / `TOKEN_INVALID` → 401);
- loads `user_id, role, status, must_change_password` from `users` by primary key on **every request**;
- returns `USER_NOT_FOUND` or `ACCOUNT_INACTIVE` → 401 when applicable;
- otherwise sets `req.user`.

## 4.2 Users (Admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/users?role=&status=&q=` | List (never returns password fields) |
| POST | `/users` | `{username, full_name, email?, phone_number?, role}` → creates with a random 12-char temporary password returned **once** in the response |
| GET | `/users/:id` | Details + supervised sites + last logins |
| PUT | `/users/:id` | Update name, email, phone, role (BR-P5 `LAST_ADMIN`) |
| PATCH | `/users/:id/status` | Active / Inactive (BR-P5) |
| POST | `/users/:id/reset-password` | New temporary password, `must_change_password = 1`, unlock |

## 4.3 Sites and supervisors

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/sites?status=&q=` | A, C, S (S: only his sites) | List with deployed machine counts |
| POST | `/sites` | A | `{site_code, site_name, project_name?, location?, has_night_shift, day_shift_start?, night_shift_start?}` |
| GET | `/sites/:id` | A, C | Details + current supervisors per shift + deployed machines |
| PUT | `/sites/:id` | A | Update (cannot remove night shift while Night deployments/supervisors are open) |
| PATCH | `/sites/:id/status` | A | `{status, reason}` (BR-P6) |
| GET | `/sites/:id/supervisors` | A, C | Periods history |
| POST | `/sites/:id/supervisors` | A | `{user_id (role Supervisor), shift_type, from_date, to_date?}`; 409 `SUPERVISOR_PERIOD_OVERLAP` |
| PATCH | `/site-supervisors/:id/end` | A | `{to_date}` |
| POST | `/sites/:id/supervisors/replace` | A | `{user_id, shift_type, first_day}` → ends the current period at first_day−1 and opens the new one (one transaction) |

## 4.4 Settings and audit

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/settings` | A, C | All settings with description |
| PUT | `/settings/:key` | A | `{value}` validated per key (bool / int range / enum); audited; cache invalidated |
| GET | `/audit?table=&record_id=&user_id=&from=&to=` | A | Paginated audit log |
| GET | `/health` | public | `{status:'ok', db:'ok'}` (pings DB) |

# 5. Equipment endpoints

All paths in this section are relative to **`/api/equipment`**. `A` = Admin, `C` = Accountant, `S` = Supervisor (scoped to the sites/shifts he supervises on the record date), `S*` = reduced columns, `†` = Admin only when setting `payroll_finalize_admin_only = true`. Every route uses `requireAuth`.

## 5.1 Vendors and contracts

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/vendors?q=&status=` | A, C, S* | List (S gets `vendor_id, vendor_name` only) |
| POST | `/vendors` | A | Create; generates `vendor_code` |
| GET | `/vendors/:id` | A, C | Details + counts (machines, deployed now, contracts) |
| PUT | `/vendors/:id` | A | Update fields |
| PATCH | `/vendors/:id/status` | A | `{status, reason}`; Inactive blocked if a machine is deployed (409 `VENDOR_HAS_DEPLOYED_MACHINES`) |
| GET | `/vendors/:id/contracts` | A, C | Contracts of vendor |
| POST | `/vendors/:id/contracts` | A | Create contract `{contract_number, start_date, end_date?, currency, payment_terms?, notes?}` |
| PUT | `/contracts/:id` | A | Update (dates cannot exclude existing rate cards → 409 `CONTRACT_DATES_EXCLUDE_RATE_CARDS`) |
| POST | `/contracts/:id/document` | A | multipart `file` (PDF/JPG/PNG) → stores, sets `document_path`, `document_sha256` |
| GET | `/contracts/:id/document` | A, C | Streams the file |

`POST /vendors` body and response:

```json
{ "vendor_name": "Al-Bunyan Heavy Equipment", "contact_person": "Samer", "phone_number": "+963...",
  "email": null, "address": "Damascus", "tax_number": null, "notes": null }
→ 201 { "status":"success", "data": { "vendor_id": 4, "vendor_code": "VND-004", ... } }
```

## 5.2 Types, machines, operators

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/types` | A, C, S | List types (`type_name`, `type_name_ar`, `meter_unit`) |
| POST / PUT | `/types`, `/types/:id` | A | Manage types |
| GET | `/machines?vendor_id=&type_id=&site_id=&status=&deployed=&q=` | A, C | `deployed` = `true`/`false`. Paginated list with current deployment and current rate summary (mode + main price) |
| POST | `/machines` | A | Create `{vendor_id, type_id, make, model, plate_number, serial_number, manufacture_year, capacity, notes}` → `equipment_code` generated `EQ-0001...` |
| GET | `/machines/:id` | A, C | Full card: details, vendor, current + history of deployments, rate cards, last 10 attendance rows, open session |
| PUT | `/machines/:id` | A | Update |
| PATCH | `/machines/:id/status` | A | `{status, effective_date, reason}` (status = Active, Inactive or Released); Released/Inactive requires no open deployment after `effective_date` (409 `MACHINE_STILL_DEPLOYED`) |
| POST | `/machines/:id/photo` | A | multipart `file` |
| GET | `/machines/:id/photo` | A, C, S | Stream |
| GET | `/operators?vendor_id=&q=&status=` | A, C, S* | S receives `operator_id, full_name, vendor_id, license_expiry` |
| POST / PUT | `/operators`, `/operators/:id` | A | Manage |
| PATCH | `/operators/:id/status` | A | Active / Inactive |

## 5.3 Rate cards

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/machines/:id/rate-cards` | A, C | All cards, newest first, with `used_in_finalized_payroll: bool` |
| POST | `/machines/:id/rate-cards` | A | Create (body = all columns of `eq_rate_cards` except ids/audit) |
| PUT | `/rate-cards/:id` | A | Update — 409 `RATE_CARD_LOCKED` if used by an active finalized batch |
| POST | `/rate-cards/:id/close` | A | `{effective_to}` — end a card (allowed even when locked, if `effective_to` ≥ last billed date) |
| POST | `/rate-cards/preview` | A, C | `{rate_card: {...}, sample_rows: [...]}` → engine output; powers the "test this price" panel in the UI |

Validation per mode: Hourly needs `hourly_rate`; Daily needs `daily_rate`; Monthly needs `monthly_rate` and `monthly_working_days` 1–31; `half_day_threshold_hours` required when `daily_partial_rule = HalfDayThreshold`; `operator_daily_rate` only when `operator_included = 0`; dates inside contract (409 `RATE_CARD_OUTSIDE_CONTRACT`); no overlap (409 `RATE_CARD_OVERLAP`, details: conflicting id and dates).

## 5.4 Deployments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/deployments?site_id=&equipment_id=&active_on=` | A, C | List |
| POST | `/deployments` | A | `{equipment_id, site_id, shift_type, assigned_date, unassigned_date?, default_operator_id?, notes?}` |
| PATCH | `/deployments/:id/end` | A | `{unassigned_date}` (inclusive last day); 409 `ATTENDANCE_AFTER_END` if rows exist after it |
| POST | `/deployments/:id/transfer` | A | `{target_site_id, target_shift_type, first_day_at_target}` → closes current at D-1, opens new at D (one transaction) |
| PATCH | `/deployments/:id` | A | Change `default_operator_id`, `notes` |

Errors: `MACHINE_NOT_ACTIVE`, `SITE_NOT_ACTIVE`, `DEPLOYMENT_OVERLAP` (409), `OPERATOR_OTHER_VENDOR` (400). Response includes `warnings: ["NO_RATE_CARD_ON_START_DATE"]` when applicable.

## 5.5 Supervisor recording

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/my-sites` | S, A | Sites/shifts the caller may record for (A: all active) |
| GET | `/attendance/site/:siteId?date=&shift=` | S, A | The day board (see below) |
| POST | `/attendance/check-in` | S, A | Start a session |
| POST | `/attendance/:id/downtime/start` | S, A | `{downtime_type, start_time, reason?}` |
| POST | `/attendance/:id/downtime/:downtimeId/end` | S, A | `{end_time}` |
| DELETE | `/attendance/:id/downtime/:downtimeId` | S, A | Only while row is Draft/Rejected |
| POST | `/attendance/:id/check-out` | S, A | Close the session |
| POST | `/attendance/day-status` | S, A | Full-day Standby / Breakdown / Absent / Holiday |
| PATCH | `/attendance/:id` | S, A | Edit times, operator, meters, description (Draft/Rejected only) |
| DELETE | `/attendance/:id` | S, A | Only Draft with no paper check; frees nothing (row numbers are never reused — the sheet shows "cancelled") |
| POST | `/attendance/submit` | S, A | `{site_id, shift_type, record_date}` |
| GET | `/attendance/rejected?site_id=` | S, A | Rejected rows to fix |
| PATCH | `/attendance/:id/resubmit` | S, A | Rejected → Submitted |
| POST | `/fuel-issues` | S, A | `{equipment_id, site_id, issue_date, liters, receipt_number?}` (S: price is filled from the setting/last price by Admin later; A may send `price_per_liter`) |

### GET `/attendance/site/:siteId?date=2026-10-03&shift=Day` → 200

```json
{ "status": "success", "data": {
  "site": { "site_id": 8, "site_code": "S08", "site_name": "Tower B", "shift_type": "Day" },
  "date": "2026-10-03",
  "can_submit": true, "week_gate": { "blocked": false, "previous_week_drafts": [] },
  "summary": { "deployed": 7, "working": 4, "on_break": 1, "breakdown": 1, "standby": 0, "not_arrived": 1, "finished": 0 },
  "machines": [{
     "equipment_id": 12, "equipment_code": "EQ-0012", "type_name": "Excavator", "type_name_ar": "حفارة",
     "plate_number": "123456", "vendor_name": "Al-Bunyan", "meter_unit": "Hours",
     "default_operator": { "operator_id": 31, "full_name": "Ahmad K." },
     "live_state": "Working",
     "attendance": { "eq_attendance_id": 905, "day_status": "Working", "status": "Draft",
        "check_in_time": "2026-10-03 07:02:00", "check_out_time": null, "operator_id": 31,
        "meter_start": 5120.4, "meter_end": null, "working_minutes": null,
        "open_downtime": null, "downtime": [ { "downtime_id": 77, "downtime_type": "Break", "start_time": "...", "end_time": "..." } ],
        "sheet": { "timesheet_id": 40, "sheet_code": "ETS-2026-10-EQ0012-S08", "sheet_row_no": 3 },
        "paper_status": "Pending", "anomaly_code": null, "admin_rejection_notes": null },
     "last_meter_end": 5119.9
  }]
}}
```

`live_state` ∈ `NotArrived, Working, OnBreak, Breakdown, Standby, Finished, Absent, Holiday` (doc 01 §9).

### POST `/attendance/check-in`

```json
{ "equipment_id": 12, "site_id": 8, "shift_type": "Day",
  "check_in_time": "2026-10-03 07:02", "operator_id": 31, "meter_start": 5120.4 }
```

Steps (one transaction): validate → `assertCanActOnSite` → `assertMachineDeployed` (BR-11) → not future → `eqLock.assertEqEditable` → `assertNoOpenSession` (BR-12) → `assertNoTimeOverlap` → operator belongs to the machine's vendor (BR-04) → existing row for the date? (Draft with no check-in → fill it; otherwise 409 `ATTENDANCE_EXISTS`) → `eqTimesheetService.getOrCreate` + `allocateRow` → insert `Draft / Working` → anomalies → audit → 201 with the machine object of the day board.

Errors: `SITE_FORBIDDEN` 403, `MACHINE_NOT_ASSIGNED` 400, `FUTURE_DATE` 400, `PAYROLL_PERIOD_FINALIZED` 409, `MACHINE_HAS_OPEN_SESSION` 409, `MACHINE_TIME_OVERLAP` 409, `OPERATOR_OTHER_VENDOR` 400, `OPERATOR_INACTIVE` 400, `ATTENDANCE_EXISTS` 409, `TIMESHEET_CLOSED` 409.

### POST `/attendance/:id/check-out`

```json
{ "check_out_time": "2026-10-03 17:31", "meter_end": 5130.0,
  "work_description": "Excavation axis C3-C7" }
```

Rules: row Draft/Rejected and open; `check_out_time > check_in_time`; max 24 h (else 400 `SESSION_TOO_LONG` — use correction for real multi-day cases); open downtime auto-closed at check-out (note "auto-closed at check-out"); daily fuel is **not** recorded at check-out any more (policy 6 Oct 2026: fuel follows the approximate-fuel policy and the office's fuel issues). A `fuel_liters` sent by an old app is ignored and the response carries `warnings: ["FUEL_AT_CHECKOUT_NOT_RECORDED"]`; `recompute`; operator required (400 `OPERATOR_REQUIRED`).

### POST `/attendance/day-status`

```json
{ "equipment_id": 12, "site_id": 8, "shift_type": "Day", "record_date": "2026-10-04",
  "day_status": "Breakdown", "remarks": "Hydraulic pump failure, vendor informed 08:10",
  "check_in_time": null, "check_out_time": null }
```

Creates or updates the row (Draft/Rejected only). `Absent`/`Holiday` clears times, meters and downtime. Changing a Working row that has a session to another status requires `confirm_discard_session: true` (else 409 `SESSION_WILL_BE_DISCARDED`).

### POST `/attendance/submit`

Body `{site_id, shift_type, record_date}`. Blocks with 409 and a list when: open sessions exist (`OPEN_SESSIONS`), Working rows without check-out (`MISSING_CHECKOUT`), weekly gate (`PREVIOUS_WEEK_DRAFTS`, details `{prev_start, prev_end, days:[{record_date, drafts}]}`; skipped when `week_gate_enabled = false`). Moves every Draft row of that site/shift/date to Submitted, sets `submitted_by_user_id/submitted_at`. Response: `{submitted: n}`.

## 5.6 Admin review & corrections

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/admin/attendance?from=&to=&site_id=&vendor_id=&equipment_id=&status=&paper_status=&anomaly=` | A, C | `anomaly` = `only`/`none`. Paginated review list with minutes, operator, anomaly, sheet row, paper status |
| POST | `/admin/attendance/approve` | A | `{ids:[...]}` — skips rows not Submitted, refuses rows with unacknowledged anomaly; returns `{approved:[], skipped:[{id, reason}]}` |
| POST | `/admin/attendance/reject` | A | `{ids:[...], notes}` (notes required) |
| POST | `/admin/attendance/:id/ack-anomaly` | A | `{note}` |
| PATCH | `/admin/attendance/:id` | A | Edit any non-locked row (Submitted/Approved too); Approved → paper back to Pending (BR-28) |
| POST | `/admin/attendance/:id/correction` | A | Finalized period: `{reason, changes:{...}}` → writes `eq_attendance_corrections` (`locked_batch_id`, `payroll_effect='AdjustmentRequired'`, `adjustment_status='Open'`) and applies the change; payroll untouched |
| GET | `/admin/corrections?request_status=Requested,Reviewed` | A, C | Official corrections (see 5.9b): each approved one is settled automatically by a DN/CN and a Correction adjustment |

## 5.7 Fuel and adjustments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/fuel-issues?from=&to=&equipment_id=&site_id=&unpriced=true` | A, C | List |
| PATCH | `/fuel-issues/:id` | A, C | Set `price_per_liter`, `liters`, `receipt_number` (not when consumed by an active finalized batch) |
| POST | `/fuel-issues/:id/receipt` | A, C, S | Upload receipt photo |
| PATCH | `/fuel-issues/:id/cancel` | A, C | `{reason}` |
| GET | `/adjustments?from=&to=&vendor_id=&equipment_id=` | A, C | List |
| POST | `/adjustments` | A, C | `{equipment_id, site_id?, adjustment_date, adjustment_type, amount (signed), reason}`; currency = currency of the rate card in force on that date (400 `NO_RATE_CARD` if none) |
| PATCH | `/adjustments/:id/cancel` | A, C | Not when consumed by an active batch (409 `ADJUSTMENT_IN_BATCH`) |

Payroll generation refuses rows of a fuel issue without a price: it appears in **blockers** as `FUEL_UNPRICED`.

## 5.8 Timesheets (paper)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/timesheets?month=&site_id=&equipment_id=&status=&needs=` | A, C, S | `needs` = `scan`/`check`. List with counters: rows, matched, mismatch, pending, last scan version/date |
| POST | `/timesheets` | A, C, S | `{equipment_id, site_id, period_month}` get-or-create (for printing a blank sheet before the first row) |
| GET | `/timesheets/:id` | A, C, S | Sheet + rows (row no, date, times, minutes, operator, paper status) + scans + current checks |
| GET | `/timesheets/:id/print.pdf?blank_rows=` | A, C, S | Document D1 (doc 05). Increments `print_count`, sets `last_printed_at` |
| GET | `/timesheets/resolve?code=&token=` | A, C, S | From QR scan → `{timesheet_id}`; 404 if token wrong |
| POST | `/timesheets/:id/scans` | A, C, S | multipart `files[]` (1–10 images or 1 PDF), `through_row_no`, `note` → new version; images are merged into one PDF server-side with pdfkit (one page per image) so a version = one file |
| GET | `/timesheets/:id/scans` | A, C, S | Versions list |
| GET | `/timesheets/:id/scans/:scanId/file` | A, C, S | Stream (inline) |
| POST | `/timesheets/:id/paper-checks` | A, C | `{scan_id, items:[{eq_attendance_id, result, paper_check_in, paper_check_out, paper_meter_start, paper_meter_end, employee_signed, operator_signed, note}]}` |
| PATCH | `/timesheets/:id/close` | A, C | `{site_engineer_name, vendor_rep_name}`; requires scan covering `last_row_no` (409 `FINAL_SCAN_REQUIRED`) |
| PATCH | `/timesheets/:id/reopen` | A | `{reason}` |

Paper check rules (BR-27): server recomputes `diff_minutes = max(|paper_in − in|, |paper_out − out|)`; `Matched` with diff > tolerance or a missing signature → 400 `CANNOT_MATCH` (details: diff, tolerance, missing signatures). Previous current check of the row gets `is_current = 0`; row `paper_status` updated; `refreshStatus`.

## 5.9 Payroll (equipment)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/payroll/preview` | A, C | `{start_date, end_date, vendor_id?, equipment_id?, site_id?, currency?}` → full calculation, **nothing saved** |
| GET | `/payroll/blockers?start_date=&end_date=&vendor_id=&equipment_id=&site_id=` | A, C | Why rows are not payable (see below) |
| POST | `/payroll/generate` | A, C | Same body as preview → creates batch (409 `NOTHING_TO_PAY`, `MIXED_CURRENCY` with list when currency omitted and scope has several) |
| GET | `/payroll/batches?status=&vendor_id=&from=&to=` | A, C | List |
| GET | `/payroll/batches/:id` | A, C | Batch + items + lines + stale flag |
| GET | `/payroll/batches/:id/rows?equipment_id=` | A, C | Snapshot rows |
| PATCH | `/payroll/batches/:id/finalize` | A, C† | Locks (BR-23) |
| PATCH | `/payroll/batches/:id/mark-paid` | A, C† | `{paid_at?}` finalized only |
| PATCH | `/payroll/batches/:id/void` | A, C | `{reason}`, not Paid |
| POST | `/payroll/batches/:id/supersede` | A, C | `{reason}` finalized only → new version with same scope, rows recalculated |
| GET | `/payroll/batches/:id/versions` | A, C | Chain |
| GET | `/payroll/batches/:id/export.pdf?view=&vendor_id=&equipment_id=` | A, C | D2/D3/D4 — `view` = `summary`, `vendor` or `machine` |
| GET | `/payroll/batches/:id/export.xlsx` | A, C | Workbook: Summary, Vendors, Machines, Lines, Rows |
| GET | `/statements/machine/:equipmentId.pdf?from=&to=` | A, C | D2 on demand **without** a batch — watermark "PROVISIONAL — not a payroll batch" |
| GET | `/statements/vendor/:vendorId.pdf?from=&to=` | A, C | D3 provisional |

Blocker codes (each with row ids / dates / machine): `NOT_APPROVED` (Draft/Submitted/Rejected), `PAPER_NOT_MATCHED`, `OPEN_SESSION`, `UNACK_ANOMALY`, `NO_RATE_CARD`, `FUEL_UNPRICED`, `IN_OTHER_BATCH` (with batch id), `CURRENCY_MISMATCH`.

Generate algorithm (transaction):

1. Resolve scope, load eligible rows (doc 02 §4.5) `FOR UPDATE`.
2. Load rate cards overlapping the period for the machines; resolve per row; rows without card → abort with `NO_RATE_CARD` list (never silently skip).
3. Group rows by (equipment, site, rate_card); for Monthly build `ctx.months` from deployments (assigned days per calendar month inside the period, clipped to the rate card dates).
4. Attach fuel (by issue date → rate card) and adjustments (by date; site if given, else the machine's item with the most rows) not consumed by an active batch.
5. Call `equipmentBillingEngine.billItem` for each group; check single currency.
6. Insert batch, items (with `rate_snapshot`), lines (with source links), snapshot rows (with per-row minutes from `dayMinutes`), totals. Audit.
7. Response: batch summary + warnings.

`stale = true` on a non-finalized batch when any snapshot row was edited after `generated_at` (compare `eq_attendance.updated_at`) — UI shows "Recalculate" (void + generate).

## 5.9b Correction policy (decisions of 6 Oct 2026)

Principle: **not financially committed → normal correction path; finalized or paid → official Correction path.** A finalized
period is never reopened and never paid by a new batch (no "recovery batch").

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/attendance/check-in` | A, S | adds `late_reason`, and `check_out_time` + `meter_end` to record a whole past session in one call. A row older than `eq_late_entry_days` (default 3) is saved and flagged `late_entry` (warning `LATE_ENTRY` in `warnings`, never a block) |
| POST | `/attendance/day-status` | A, S | adds `late_reason` (same late-entry warning). Overwriting a session keeps the old values in the audit log |
| PATCH | `/attendance/:id/downtime/:downtimeId` | A, S | correct a pause in place `{downtime_type?, start_time?, end_time?, reason?}` (Draft/Rejected rows) |
| PATCH | `/attendance/:id/cancel` | A, S | supervisor cancels a Rejected row that was **never approved** `{reason ≥5}`; the row stays as `Cancelled` and frees its slot. A row approved once (`approved_by_user_id` or an `approve` audit entry) → 409 `APPROVED_BEFORE`: only the office voids it or corrects it. The row view carries `was_approved` |
| POST | `/attendance/:id/change-requests` | A, S | the **current** supervisor asks the office for a change `{reason ≥5, changes:{...}}` (Approved rows, or days before their assignment) |
| GET | `/attendance/change-requests` | A, S | own requests |
| PATCH | `/attendance/change-requests/:id/withdraw` | A, S | requester only |
| GET | `/attendance/site/:siteId` | A, C, S | adds `access: {can_edit, reason: moved_away / before_assignment / ..., late_after_days, days_old}`. Historical visibility is not editing permission |
| GET | `/admin/attendance` | A, C | adds `late=only`; `Cancelled` hidden unless `status=Cancelled`; `pending_change_requests` per row; `meta.counts.late_entries` |
| GET | `/admin/attendance/:id` | A, C | adds `change_requests`, `locked_by_status` (Finalized / Paid), `generated_batch_id`, history with `changed_fields` and `payroll_effect` |
| PATCH | `/admin/attendance/:id` | A, C | office edit before the lock, several fields at once; reason ≥5 on an Approved row; paper status resets only when a paper field changes |
| PATCH | `/admin/attendance/:id/cancel` | A, C | void a row before the lock `{reason ≥5}` (kept as Cancelled) |
| GET | `/admin/change-requests?status=` | A, C | list |
| PATCH | `/admin/change-requests/:id/approve` | A, C | applies the change (another person than the requester). Locked row → 409 `ROW_LOCKED_USE_CORRECTION` unless `convert_to_correction: true` |
| PATCH | `/admin/change-requests/:id/reject` | A, C | `{note ≥3}` |
| POST | `/admin/attendance/:id/correction` | A, C | official Correction, several fields (or `cancel_row: true` alone) `{reason ≥5, changes, amount_override?, override_reason?}` |
| POST | `/admin/corrections/financial` | A, C | official Correction of money that is not attendance: `target_type` fuel_issue (with `fuel_changes`, amount computed) / rate_card / fuel_price / fuel_terms / adjustment / deployment / other (`amount`), `eq_item_id` of the finalized item |
| PATCH | `/admin/corrections/:id/review` | A, C | the requester amends (stays Requested) or another person reviews (Reviewed) |
| PATCH | `/admin/corrections/:id/approve` | A, C | by a person other than the author of the last version → applies the change, issues the debit / credit note and a Correction adjustment in the first open period |
| PATCH | `/admin/corrections/:id/return`, `/cancel` | A, C | return (not the last author); cancel (requester, reviewer or Admin). `resolve` was removed |
| PATCH | `/deployments/:id/start` | A, C | correct the first day `{assigned_date, reason ≥5}`; refused inside a closed period |
| PATCH | `/payroll/batches/:id/finalize` | A, C† | `{acknowledge_changes: true}` required when the batch pays manual changes (409 `CHANGES_NOT_ACKNOWLEDGED` with the list) |
| GET | `/payroll/batches/:id/review-summary` | A, C | manual changes the batch pays (edits after approval, late entries, standby hours, adjustments, correction settlements, fuel / rate card changes, accepted blockers) |
| PATCH | `/payroll/batches/:id/mark-paid` | A, C† | adds `payment_reference?` |
| PATCH | `/payroll/batches/:id/undo-paid` | A, C† | `{reason ≥5}`; only within `eq_paid_undo_hours` (default 168) and without payment reference (409 `UNDO_PAID_NOT_ALLOWED`) |
| PATCH | `/payroll/batches/:id/payment-reference` | A, C† | record / change (reason when changing) |
| POST | `/payroll/generate` | A, C | accepting blockers needs `accept_reason ≥5` (kept on the batch) |

Final business decisions (6 Oct 2026, confirmed):
- **Undo Mark Paid:** default window 168 h (`eq_paid_undo_hours`, control setting: a reason to change it), counted from `paid_marked_at`; only without payment reference, with a reason, for the users allowed by `payroll_finalize_admin_only`.
- **No monetary threshold** on manual adjustments; no extra approval because of an amount.
- **No extra separation of duties** in Generate / Finalize / Mark Paid (the same allowed person may do all three). The four-eyes rule applies only to official Corrections (the author of the latest version never approves it) and to supervisor change requests (the requester never applies their own request).
- **Late entries:** `eq_late_entry_days` = 3, warning and flag only, never a block and never a payroll lock; the reason is always optional; no second threshold.
- **Supervisor cancel:** only Rejected, never-approved rows.
- **No legacy clean-up:** the database is empty; no script or migration rewrites old check-out fuel rows or old Open corrections.

Other rules: blockers add `IN_CLOSED_PERIOD` (information only) and items of a closed period never block a new batch; fuel
litres / a set price change need a reason; a correction settlement adjustment cannot be cancelled
(`CORRECTION_ADJUSTMENT_LOCKED`); control settings, role changes and deactivations need a reason ≥5.

## 5.10 Live board and reports

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/live?date=&site_id=` | A, C, S | KPIs, per site, per vendor, machines with `live_state`, `refresh_seconds`; S limited to own sites; money fields only for A |
| GET | `/live/sites/:siteId?date=` | A, C, S | Drill-down: machines, timeline of the day (sessions + downtime), open problems |
| GET | `/reports/daily.pdf?site_id=&date=&shift=` | A, C, S | D5 |
| GET | `/reports/utilization?from=&to=&vendor_id=&site_id=&format=` | A, C | D6 — `format` = `json`, `xlsx` or `pdf` |

`/live` response (A):

```json
{ "status":"success", "data": {
  "as_of": "2026-10-03 11:42", "date": "2026-10-03", "refresh_seconds": 60,
  "kpis": { "deployed": 23, "on_site_now": 19, "working": 14, "on_break": 2, "breakdown": 2, "standby": 1,
            "not_arrived": 3, "finished": 0, "absent": 1, "forgotten_checkout": 0,
            "hours_today": 61.5, "estimated_cost_today": { "USD": 2460.00 } },
  "sites":   [{ "site_id": 8, "site_name": "Tower B", "deployed": 7, "working": 4, "breakdown": 1, "standby": 0, "not_arrived": 1 }],
  "vendors": [{ "vendor_id": 4, "vendor_name": "Al-Bunyan", "deployed": 9, "working": 6, "breakdown": 1 }],
  "machines":[{ "equipment_id": 12, "equipment_code": "EQ-0012", "type_name": "Excavator", "site_id": 8,
                "vendor_name": "Al-Bunyan", "operator_name": "Ahmad K.", "live_state": "Working",
                "since": "2026-10-03 07:02", "elapsed_minutes": 280, "anomaly_code": null }]
}}
```

Implementation: ~6 set-based queries in `Promise.all` (deployments active today, today's rows, open rows from yesterday, open downtime, rate cards for cost estimate, vendors/sites names) and an in-memory merge. Test that the query count does not grow with the number of machines.

# 6. Error code catalogue

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Field-level errors in `details.fields` |
| `INVALID_CREDENTIALS` | 401 | Wrong username or password |
| `ACCOUNT_LOCKED` | 423 | Too many failed logins (`details.locked_until`) |
| `ACCOUNT_INACTIVE` / `USER_NOT_FOUND` | 401 | Account disabled / deleted |
| `TOKEN_EXPIRED` / `TOKEN_INVALID` | 401 | Re-login required |
| `PASSWORD_CHANGE_REQUIRED` | 403 | First login or after reset |
| `WEAK_PASSWORD` | 400 | Policy BR-P2 |
| `FORBIDDEN_ROLE` | 403 | Role not allowed on this route |
| `LAST_ADMIN` | 409 | BR-P5 |
| `SUPERVISOR_PERIOD_OVERLAP` / `SITE_HAS_DEPLOYED_MACHINES` | 409 | BR-P7 / BR-P6 |
| `RATE_LIMITED` | 429 | Too many requests |
| `SITE_FORBIDDEN` | 403 | Supervisor not in charge of this site/shift |
| `NOT_FOUND` | 404 | Entity missing |
| `MACHINE_NOT_ASSIGNED` | 400 | Not deployed on that site/shift/date |
| `MACHINE_NOT_ACTIVE` / `SITE_NOT_ACTIVE` | 400 | |
| `FUTURE_DATE` | 400 | Date after business today |
| `MACHINE_HAS_OPEN_SESSION` | 409 | BR-12 |
| `MACHINE_TIME_OVERLAP` | 409 | BR-13 |
| `ATTENDANCE_EXISTS` | 409 | Row already exists for the date |
| `INVALID_STATE` | 409 | Workflow state does not allow the action |
| `OPEN_SESSIONS` / `MISSING_CHECKOUT` / `PREVIOUS_WEEK_DRAFTS` | 409 | Submit blocked |
| `UNACK_ANOMALY` | 409 | Approve blocked |
| `OPERATOR_OTHER_VENDOR` / `OPERATOR_INACTIVE` / `OPERATOR_REQUIRED` | 400 | BR-04 |
| `SESSION_TOO_LONG` | 400 | > 24 h |
| `DEPLOYMENT_OVERLAP` / `ATTENDANCE_AFTER_END` | 409 | BR-08 / BR-10 |
| `RATE_CARD_OVERLAP` / `RATE_CARD_OUTSIDE_CONTRACT` / `RATE_CARD_LOCKED` | 409 | BR-05 / BR-06 |
| `TIMESHEET_CLOSED` / `FINAL_SCAN_REQUIRED` / `CANNOT_MATCH` / `DUPLICATE_SCAN` | 409/400 | Paper rules |
| `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` | 413 / 415 | Uploads |
| `PAYROLL_PERIOD_FINALIZED` | 409 | BR-23 |
| `NOTHING_TO_PAY` / `MIXED_CURRENCY` / `NO_RATE_CARD` / `FUEL_UNPRICED` | 409 | Payroll |
| `BATCH_STATE` | 409 | Finalize/paid/void/supersede not allowed in current state |

# 7. Route file skeleton

```js
// routes/index.js
const router = require('express').Router();
router.use('/auth', require('./authRoutes'));
router.use('/users', require('./userRoutes'));
router.use(['/sites', '/site-supervisors'], require('./siteRoutes'));
router.use('/settings', require('./settingsRoutes'));
router.use('/audit', require('./auditRoutes'));
router.use('/equipment', require('./equipmentRoutes'));
module.exports = router;            // app.js: app.use('/api', routes); app.use(errorHandler);

// routes/equipmentRoutes.js
const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const A = requireRole('Admin');
const AC = requireRole('Admin', 'Accountant');
const ACS = requireRole('Admin', 'Accountant', 'Supervisor');
const AS = requireRole('Admin', 'Supervisor');
const vendor = require('../controllers/equipment/vendorController');
// ... other controllers

router.use(requireAuth);
router.get('/vendors', ACS, vendor.list);           // Supervisor gets reduced columns
router.post('/vendors', A, vendor.create);
router.get('/vendors/:id', AC, vendor.get);
// ... one line per endpoint of section 5, in the same order as this document
module.exports = router;
```

Put the specific paths **before** the parameterised ones (`/timesheets/resolve` before `/timesheets/:id`, `/payroll/blockers` before `/payroll/batches/:id`).
