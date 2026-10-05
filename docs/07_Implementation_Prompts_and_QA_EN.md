# Implementation Prompts — & QA Plan

**Copy-paste prompts for Claude Code, phase by phase**

What to do step by step, master prompt, one prompt per phase (P0–P10), test plan, UAT and deployment.

_Equipment Flow · Doc 07 · v2.0 standalone · 2026-10-03_

---

# 1. What to do, step by step

1. **Create two empty repositories** on GitHub: `equipment_flow_backend` and `equipment_flow_app`. Clone both into one folder, e.g. `~/equipment-flow/`.
2. **Copy this package** into `equipment_flow_backend/docs/`:
   - the `.md` files;
   - the `source_files/` folder;
   - the sample PDFs S1 and S2.

   Commit it. Claude Code will read the documents from there.
3. **Prepare tools on your machine:**
   - Node.js 20 LTS;
   - MySQL 8 locally (or Docker: `docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=root mysql:8`);
   - the Flutter SDK (stable).
4. **Open Claude Code** in `~/equipment-flow/`.
5. In each session, paste **the master prompt (§2)** and then **one phase prompt (§3)**. Do one phase per session.
6. After each phase:
   - read the summary and the diff;
   - run the tests (`npm test` for the backend, `flutter analyze` for the app);
   - try the acceptance checklist;
   - commit.

   Then start a new session for the next phase.
7. If Claude Code wants to change a rule, a name or a status that the documents fix, it must stop and ask you. **The documents are the contract.**

# 2. Master prompt (paste first in every session)

```text
You are a senior full-stack engineer. We are building "Equipment Flow", a STANDALONE system
(own database, own users and login, NOT connected to any other system) for rented construction machinery
of ASIK Engineering Construction.

Repositories in this folder:
- equipment_flow_backend  (Node.js 20, Express 5, mysql2/promise, MySQL 8, JWT, bcryptjs, multer,
  pdfkit, exceljs, qrcode, helmet, cors, express-rate-limit; tests with node --test + supertest)
- equipment_flow_app      (Flutter 3, Android/iOS/Web, dio, flutter_secure_storage, setState + small
  ChangeNotifier services, font Cairo, navy #1A2A6C / gold #B8963E)

The specification is in equipment_flow_backend/docs/:
01_Equipment_Master_Plan, 02_Database_Schema, 03_Backend_API_Spec, 04_Billing_Engine_Spec,
05_Paper_Timesheet_and_Documents, 06_Flutter_App_Spec, 07_Implementation_Prompts_and_QA,
source_files/ (exact SQL and the billing engine — copy them, never retype), S1/S2 sample PDFs.
These documents are the contract: table/column names, endpoints, roles, status values, error codes and
business rules (BR-xx, BR-Px) must be followed exactly.

Mandatory conventions:
- Business dates/times only through utils/businessDate.js and utils/dateTime.js (APP_TIME_ZONE,
  default Asia/Beirut). Never derive business dates from UTC toISOString() or MySQL NOW()/CURDATE().
- All date ranges inclusive on both ends, NULL end = open (utils/ranges.js).
- Multi-row writes inside withTransaction() with SELECT ... FOR UPDATE; lock checks inside the transaction.
- Every create/update/status change is written to audit_logs.
- Response shape: { status:'success', data, meta? } / { status:'error', code, message, details? }
  via AppError + errorHandler.
- Role checks with requireRole on every route; Supervisors are scoped by site_supervisors on the record
  date and never receive price/amount fields.
- Money as integer cents and durations as integer minutes inside the billing engine.
- Before coding: list the documents/sections you will implement and the files you will create.
  After coding: run the tests, show the results, summarize, and give manual test steps.
- If anything is ambiguous or contradicts the documents: STOP and ask me.
```

# 3. Phase prompts

## P0 — Backend skeleton and database

```text
Phase P0 (equipment_flow_backend). Implement document 03 §1 and §2 and document 02:
- package.json (scripts: start, dev, test, migrate, create-admin), .env.example (03 §1.2), .gitignore.
- config/env.js (fail fast; JWT_SECRET >= 32 chars), config/db.js (pool + withTransaction), app.js, server.js.
- middleware: requestId, errorHandler, rateLimits (requireAuth/requireRole come in P1).
- utils: AppError, businessDate, dateTime, ranges, money, validate.
- services: settings (cached), audit.
- database/: copy schema.sql, seed.sql, rollback_drop_all.sql from docs/source_files EXACTLY;
  scripts/migrate.js (schema_migrations table, applies database/migrations/*.sql in order).
- GET /api/health (pings DB).
- tests/helpers.js: resetDatabase() on a DB whose name must end with _test (schema + seed + fixtures:
  1 Admin, 1 Accountant, 2 Supervisors, 3 sites S08/S09/S10 with supervisor periods), startServer(),
  token(userId). Tests: schema applied twice without error (25 tables), settings seeded, health ok,
  utils unit tests (businessToday with a fixed clock, ranges overlap incl. NULL ends, money rounding).
```

**Acceptance:** `npm test` is green, `npm run dev` starts, and `/api/health` returns ok.

## P1 — Auth, users, sites, settings, audit

```text
Phase P1. Implement document 03 §4 (platform endpoints) and rules BR-P1..BR-P8 of document 01 §8.1:
requireAuth (re-reads user every request), requireRole, PASSWORD_CHANGE_REQUIRED gate, login with lockout
(5 attempts / 15 min), login_history, rate limit, change-password policy, users CRUD with temporary
password returned once, reset password, LAST_ADMIN protection, sites CRUD + status (BR-P6),
site supervisors assign/replace/end with overlap check (BR-P7), settings GET/PUT with per-key validation,
audit list. scripts/createAdmin.js (prints a temporary password).
Tests: login ok / wrong password / lockout / inactive; token expired; must-change gate; role 403s on every
admin route; LAST_ADMIN; supervisor overlap; replace = end D-1 + open D; audit rows written.
```

**Acceptance:** create the first admin with the script, log in with Postman/`test.http`, create a supervisor and a site, and assign the supervisor.

## P2 — Equipment master data

```text
Phase P2. Implement document 03 §3.1, §3.6 and §5.1–§5.4 with BR-01..BR-10:
services/fileStorage.js (local + s3), services/uploads.js (memory storage, limits, magic numbers),
services/equipment/eqAccess.js, vendors (+code VND-001), contracts (+document upload/stream), types,
machines (+code EQ-0001, photo upload/stream, status rules), operators, rate cards (validation per mode,
overlap, inside contract, RATE_CARD_LOCKED placeholder until P5), deployments (create, end, transfer,
default operator). POST /rate-cards/preview may answer 501 until P5.
Tests: CRUD happy paths; RATE_CARD_OVERLAP; RATE_CARD_OUTSIDE_CONTRACT; DEPLOYMENT_OVERLAP; transfer;
OPERATOR_OTHER_VENDOR; Accountant read-only; Supervisor reduced columns and no price keys; files
unreachable without a token.
```

## P3 — Attendance

```text
Phase P3. Implement document 03 §3.2–§3.5 (timesheet getOrCreate + allocateRow only) and §5.5–§5.7
with BR-11..BR-23, BR-25, BR-28: day board (incl. Night open row from D-1, live_state), my-sites,
check-in, downtime start/end/delete, check-out (auto-close downtime, fuel litres → eq_fuel_issues without
price), day-status, edit, delete Draft, submit (OPEN_SESSIONS, MISSING_CHECKOUT, weekly gate), rejected,
resubmit, review list/approve/reject/ack-anomaly/admin edit, finalized-period correction into
eq_attendance_corrections, fuel issues and adjustments endpoints, eqLock.
Tests at least: MACHINE_NOT_ASSIGNED; FUTURE_DATE; SITE_FORBIDDEN (supervisor of another site or of
another date); MACHINE_HAS_OPEN_SESSION across sites; MACHINE_TIME_OVERLAP; night 18:00→04:00 = 600 min
on the check-in date; downtime minutes and auto-close; anomalies meter_backwards / meter_mismatch /
long_session / operator_license_expired; submit blocked by open session and by previous-week drafts;
approve blocked by unacknowledged anomaly; sheet rows 1,2,3 then back-dated row = 4, deleted Draft keeps
a gap; no price keys for Supervisor; PAYROLL_PERIOD_FINALIZED with a fake finalized batch.
```

**Acceptance:** a full day for 3 machines can be recorded, submitted and approved through `test.http`.

## P4 — Paper timesheets

```text
Phase P4. Implement document 03 §5.8 and document 05 §2–§5, matching sample S1:
services/pdfKit.js shared helpers (fonts incl. NotoNaskhArabic, Arabic shaping, logo, header band,
tables, footer page x/y); eqPdf.renderTimesheet (A4 landscape, QR "TFEQ|{sheet_code}|{verify_token}" with
the qrcode package, repeated headers, blank rows, cancelled rows, totals, sign-off boxes, print stamp);
timesheet endpoints (list, get, get-or-create, print, resolve, scans upload with images merged into one
PDF, scan list, scan stream, paper-checks, close, reopen, refreshStatus).
Tests: print returns application/pdf containing the sheet code; DUPLICATE_SCAN; CANNOT_MATCH (diff 12 min
with tolerance 10; missing operator signature); FINAL_SCAN_REQUIRED; Closed + all Matched → Reconciled;
correction of a Matched row → Pending. Save docs/generated/sample_timesheet.pdf for visual review.
```

## P5 — Billing engine and payroll

```text
Phase P5.
1) Copy docs/source_files/equipmentBillingEngine.js to services/equipment/ unchanged; convert
   docs/source_files/equipment.billing.examples.test.js to node:test and add one test per edge case of
   document 04 §7. All must pass first.
2) eqPayrollService + eqPayrollController per document 03 §5.9 (preview, blockers, generate steps 1–7,
   batches list/detail/rows, finalize, mark-paid, void, supersede with version chain, versions, stale flag,
   provisional statements) and wire POST /rate-cards/preview to the engine; RATE_CARD_LOCKED now real.
3) eqPdf: machine statement D2, vendor statement D3 (match sample S2), summary D4; eqExcel workbook
   (document 05 §7). Exports read only snapshot tables.
Tests: end-to-end through the DB reproduces examples A/B/C/D of document 04; a row is never in two active
batches; void frees rows; supersede → old Superseded, new version+1; finalize locks edits; MIXED_CURRENCY;
FUEL_UNPRICED and PAPER_NOT_MATCHED in blockers; Supervisor 403 on payroll; payroll_finalize_admin_only.
```

## P6 — Live board and reports

```text
Phase P6. Implement eqLiveService and eqLiveController (document 03 §5.10, document 01 §10): /live,
/live/sites/:siteId, /reports/daily.pdf (D5), /reports/utilization (json/xlsx/pdf, D6). Set-based queries
in Promise.all only. Supervisor: own sites, no money. Use the site shift start times for "not arrived".
Tests: every live_state on a seeded day incl. a Night open row from yesterday; forgotten checkout;
constant query count for 5 vs 50 machines (spy on the pool); Supervisor scope and no cost fields.
```

## P7 — Flutter skeleton, login, platform screens

```text
Phase P7 (equipment_flow_app). Create the app per document 06 §1, §2 (core/, auth/, shell/, admin/,
widgets/), §3 design rules, §7 login and role routing: theme, ApiClient with interceptors and
ApiException, AuthService, AuthGate, LoginScreen (clear error messages incl. locked until), forced
ChangePasswordScreen, AppShell (NavigationRail on wide screens / Drawer on phones, items per role),
FileExport (web + io), shared widgets. Admin screens: Users (temporary password shown once), Sites +
supervisors sheet, Settings, Audit. API_BASE_URL via --dart-define. flutter analyze must be clean.
```

## P8 — Flutter Admin / Accountant equipment screens

```text
Phase P8. Implement document 06 §4 and §6: models, equipment_service.dart (one typed method per endpoint
of document 03 §5), live board (auto-refresh using refresh_seconds, paused when not visible), machines +
detail + rate card form with "Test this price", vendors + contracts + document upload/view, operators,
deploy/transfer/end sheet, attendance review (bulk approve/reject, anomaly acknowledge, edit, correction),
timesheets + reconcile screen (scan viewer left, rows right, keys M / X / ↓), payroll (blockers, preview,
generate, batch detail, finalize/paid/void/supersede, PDF/Excel exports via FileExport), fuel &
adjustments. Hide actions the role cannot use (the API still enforces). flutter analyze clean.
```

## P9 — Flutter Supervisor screens

```text
Phase P9. Implement document 06 §5: SupHomeScreen (sites/shifts from /equipment/my-sites), day board
(cards with problems first, one primary action per card), check-in / downtime / check-out / day-status
sheets with validations and quick reasons, submit with server blockers, rejected rows, sheets & scans
(print/share, camera multi-shot upload with progress, view versions), fuel litres. Never display prices.
flutter analyze clean. Optional 9b: QR scan-to-upload with mobile_scanner.
```

## P10 — End-to-end, demo data, deployment

```text
Phase P10. 1) tests/e2e.test.js covering the UAT script (document 07 §5) through HTTP.
2) scripts/seedDemo.js (2 vendors, 6 machines across the 3 billing modes, operators, 3 sites with
   supervisors, 20 days approved + matched) — refuses NODE_ENV=production.
3) Dockerfile for the backend + docs/RUNBOOK.md from document 07 §6 + docs/USER_GUIDE.md (one page per
   screen, from document 06).
4) Security review of every route (auth, role, site scope, price hiding, audit, upload limits); fix the findings.
```

# 4. Test plan summary

| Level | Tool | Content |
|---|---|---|
| Unit | `node --test` | Billing engine (examples + 15 edge cases), utils (dates, ranges, money), minutes recompute, anomalies, paper diff, week gate |
| Integration | `node --test` + `supertest` + MySQL `_test` DB | Every endpoint group: happy path, every error code of document 03 §6, roles, site scope, price hiding, locks, audit |
| Security | integration | Lockout, must-change gate, inactive user, token expiry, file access without token |
| Performance | pool spy + timing | `/live` constant query count; payroll 1 month × 100 machines < 5 s |
| PDF | integration | Content type, size, sheet code / totals present |
| Flutter | `flutter analyze`, manual | Phone 360×780 and desktop 1440×900; Android + Web |
| UAT | humans | §5 with a site supervisor and the accountant |

# 5. UAT script

1. Run `createAdmin` and log in; the password change is forced. Create an Accountant, two Supervisors and sites **S08 Tower B** (Day) and **S09 Bridge** (Day + Night); assign the supervisors.
2. Create vendor **Al-Bunyan** and contract **AB-2026-07** (USD), and upload the PDF.
3. Create the machines:
   - **EQ-0001 Excavator** — Hourly 40, minimum 6, OT after 10 h at 50, standby 50 %;
   - **EQ-0002 Loader** — Daily 300, ProRata, operator included;
   - **EQ-0003 Crane** — Monthly 6,500 / 26 days.

   Add 3 operators and deploy all three machines to S08 Day from the 1st.
4. The S08 supervisor records in the phone app:
   - 7 days for EQ-0001 exactly as Example A (document 04);
   - 4 days for EQ-0002 as Example B;
   - the month for EQ-0003 as Example C (every other day Working 8 h).
5. The supervisor prints the three sheets, signs them, photographs and uploads them (2 versions for EQ-0001), and submits each day.
6. Admin rejects one row with a note; the supervisor fixes and resubmits it; Admin approves all.
7. The Accountant reconciles the sheets. One row is marked Mismatch (the paper shows 07:30 instead of 07:02); Admin corrects it, and it is re-checked as Matched.
8. The Accountant prices 100 L of fuel at 1.10 for EQ-0001 and adds a +150 Mobilization adjustment.
9. During a working day, the live board shows the right states. The S09 supervisor sees nothing of S08. No money is visible to supervisors.
10. Payroll: blockers show none. The preview shows **EQ-0001 1,460.00**, **EQ-0002 1,027.50**, **EQ-0003 6,115.00**. Generate, finalize, then export the vendor statement PDF and the Excel file; their totals agree.
11. The supervisor tries to edit a finalized day and is refused. Admin applies a correction, and the open correction appears in the list.
12. Supersede the batch with a reason (version 2), then mark it paid. Check the audit log.

**Pass** = every number matches, every refusal shows a clear message, and the accountant accepts the vendor statement.

# 6. Deployment runbook

1. **Database:**
   - create a managed MySQL 8 database `equipment_flow` and a dedicated user (document 02 §1);
   - run `schema.sql` then `seed.sql`;
   - enable daily backups.
2. **File storage:** create an S3-compatible bucket (Cloudflare R2 recommended), private, with versioning on. Create an access key limited to the bucket.
3. **Backend:**
   - deploy the Docker image or Node app to the host (Render / Railway / VPS);
   - set every environment variable of document 03 §1.2 (`FILE_STORAGE_DRIVER=s3`, `CORS_ORIGINS` = app URL);
   - check `/api/health`;
   - run `node scripts/createAdmin.js` once.
4. **App:**
   - `flutter build web --dart-define=API_BASE_URL=https://<api>/api`, then deploy to static hosting (Netlify / Cloudflare Pages / the same VPS);
   - `flutter build apk --dart-define=...` for Android phones (or iOS via TestFlight).
5. **Smoke test:**
   - log in as Admin;
   - create a site and a supervisor;
   - create one vendor and one machine, then deploy it;
   - check in from a phone and print the sheet;
   - upload a scan, restart the backend, and confirm the scan still opens.
6. **Rollback:** redeploy the previous image. The database is new, so there is nothing to revert on first go-live.

# 7. Definition of done

- All phases merged; `npm test` green; `flutter analyze` clean.
- UAT (§5) passed and signed by operations and finance.
- Storage verified to persist across a restart; backups configured.
- User guide available for Admin, Accountant and Supervisor.
