# Equipment Flow — Master Plan

**Rented machinery: attendance, paper timesheets, live board & vendor payroll**

Scope, roles, life cycle, business rules, state machines, phases and decisions. Standalone system — not connected to Team Flow. Read this document first.

_Equipment Flow · Doc 01 · v2.0 standalone · 2026-10-03_

---

# 1. How to use this package

This package fully specifies **Equipment Flow**, a **standalone** system for the rented construction machinery of ASIK Engineering Construction. It is **not connected to Team Flow**. It has its own database, backend, users, login, sites and mobile/web app. The rules and documents follow the same professional standard as the company's other systems, but nothing is shared at runtime.

| # | File | What it contains | Who reads it |
|---|------|------------------|--------------|
| 01 | Master Plan (this file) | Scope, architecture, roles, life cycle, business rules, state machines, phases, decisions | Everyone — read first |
| 02 | Database Schema | Full schema SQL (25 tables), seed, constraints, settings, query recipes | Backend |
| 03 | Backend API Specification | Project skeleton, foundation services, auth, users, sites, and every equipment endpoint | Backend |
| 04 | Billing Engine Specification | Exact calculation rules, reference JavaScript implementation, worked examples used as unit tests | Backend + finance review |
| 05 | Paper Timesheet & Documents | Monthly paper sheet, QR, upload / versioning / reconciliation, every PDF & Excel layout | Backend + Flutter |
| 06 | Flutter App Specification | New app skeleton, login and role routing, every screen with wireframes | Flutter |
| 07 | Implementation Prompts & QA | Copy-paste prompts for Claude Code, phase by phase, acceptance criteria, test plan, deployment | Whoever drives Claude Code |
| 08 | Arabic version | Full Arabic explanation for management | Management |
| S1 / S2 | Samples | Target look of the monthly paper sheet and of the vendor statement | Everyone |

> **How to give it to Claude Code.** Create two empty Git repositories, `equipment_flow_backend` and `equipment_flow_app`, put them in one folder, copy this package into `equipment_flow_backend/docs/`, and open Claude Code in the parent folder. Paste the master prompt and **one phase prompt per session** from document 07. Review, run the tests, commit, then move on.

# 2. Goal and scope

## 2.1 Problem

Machines such as excavators, loaders, cranes, trucks and generators are rented from **vendor companies**. Each machine comes to a site with an **operator (driver)** employed by the vendor. Hours are tracked on paper only today. That makes the monthly payment to each vendor slow, hard to verify and easy to dispute.

## 2.2 Goal

1. The site supervisor records electronically **when each machine starts and stops work** every day.
2. A **signed paper record** is kept in parallel. There is one sheet per machine, per site, per month, and every new record adds a row to the same sheet. **Our employee** and **the operator** sign each row. The scan is stored in the system and **reconciled row by row** with the electronic record.
3. A **live dashboard** shows the machines on site right now and what they are doing.
4. Payroll statements are produced **on demand** per machine, per vendor and overall, for any period. Pricing is flexible per machine.
5. Everything can be exported as **professional PDFs** with the company identity, and as Excel.

## 2.3 In scope

- **Platform:** users and login (JWT), roles, password policy, sites and site supervisors, settings, and an audit log.
- **Equipment master data:** vendors, contracts (with the signed document), equipment types, machines, operators, effective-dated rate cards, and deployment of machines to sites and shifts.
- **Daily equipment attendance:**
  - check-in, check-out and meter readings;
  - break, refuel, breakdown and standby periods;
  - full-day statuses;
  - submission, approval or rejection, and anomalies;
  - corrections inside finalized periods.
- **Monthly paper timesheet:** PDF with a QR code, scan upload (immutable, versioned) and row-by-row reconciliation.
- **Money and reports:**
  - fuel issues and manual adjustments;
  - payroll: preview, generate, finalize, paid, void, supersede;
  - statements per machine, per vendor and as a summary, in PDF and Excel;
  - live dashboard, daily site report and utilization report.
- **Apps:** a Flutter app for Admin, Accountant and Supervisor (Android, iOS and Web from one code base).

## 2.4 Out of scope (version 1)

- Any link or synchronisation with Team Flow, and single sign-on.
- GPS / telematics, machine maintenance, spare parts and insurance.
- Accounting journal export (Excel is provided instead), OCR of the sheet, and a vendor self-service portal.
- An offline mode for the supervisor app.

# 3. Architecture and technology

| Layer | Choice | Why |
|---|---|---|
| Database | **MySQL 8** (any managed MySQL, e.g. Aiven / PlanetScale-compatible / own server) | Relational data with strong constraints; the team already knows it |
| Backend | **Node.js 20 LTS + Express 5**, `mysql2/promise`, `jsonwebtoken`, `bcryptjs`, `multer`, `pdfkit`, `exceljs`, `qrcode`, `helmet`, `cors`, `express-rate-limit`, `dotenv` | Simple, well known, good PDF/Excel libraries |
| Tests | `node --test` + a local MySQL test database (+ `supertest` for HTTP) | No heavy framework |
| Files | Storage adapter: **S3-compatible bucket** (recommended: Cloudflare R2) or local persistent disk | Signed scans are legal evidence and must survive restarts |
| App | **Flutter 3** (Android / iOS / Web), `dio`, `flutter_secure_storage`, `intl`, `image_picker`, `file_selector`, `printing`, `pdf`, `share_plus`, `fl_chart` | One code base for phones on site and desktop in the office |
| Hosting | Backend on any Node host (Render / Railway / VPS) **with** the storage adapter; Flutter Web on static hosting | Low cost |
| Fonts / identity | Cairo (UI), Noto Naskh Arabic (PDF Arabic), company logo, navy `#1A2A6C` + gold `#B8963E` | Company identity |

```
  Flutter app (Admin · Accountant · Supervisor)
          │  HTTPS + JWT (Authorization: Bearer)
          ▼
  Express API  /api/...   ──►  MySQL 8 (equipment_flow)
          │
          └──► File storage (R2/S3 bucket or persistent disk): contracts, photos, scans, receipts
```

# 4. Glossary

| Term | Meaning |
|---|---|
| Vendor | A company that rents machines to us (المتعهد / الشركة المؤجرة). |
| Vendor contract | The rental agreement with a vendor. It fixes the currency and holds the signed document. |
| Machine | One physical unit, with an internal code (`EQ-0012`) and a plate or serial number. |
| Operator | The driver supplied by the vendor. |
| Rate card | The effective-dated pricing policy of one machine under one contract. |
| Site | A construction site managed in this system (code `S08`, name, Day/Night shifts). |
| Site supervisor | The user in charge of recording at a site and shift between two dates. |
| Deployment | A machine assigned to a site and shift between two dates (inclusive). |
| Attendance row | One machine × site × shift × business date. |
| Downtime period | A timed Break, Refuel, Breakdown or Standby interval inside a working day. |
| Breakdown | The machine is unusable because of the vendor. It is billed at `breakdown_billable_pct` (default 0 %). |
| Standby | The machine is ready but idle because of **us**. It is billed at `standby_billable_pct` (default 50 %). |
| Minimum guarantee | Optional minimum billable hours on Working and Standby days. |
| Timesheet | The monthly paper sheet of one machine at one site. |
| Scan | An uploaded image or PDF of the sheet. It is immutable and versioned. |
| Paper check | The result of comparing one row with the paper: Matched, Mismatch or Missing. |
| Payroll batch | A saved calculation for a period and scope, in one currency. |
| Statement | The PDF given to the vendor. |

# 5. Roles and permissions

There are three roles, stored in `users.role`:

- **Admin** — has full access, including users, sites, settings, master data, prices, approvals, reconciliation, payroll and reports.
- **Accountant** — reads all master data and attendance, prices fuel, manages adjustments, reconciles paper, and runs payroll and statements. Cannot manage users, sites or settings. Cannot approve attendance (segregation of duties).
- **Supervisor** — records attendance only for the sites and shifts assigned to him on that date (`site_supervisors`). Prints and uploads sheets for those machines and enters fuel litres. **Never sees prices or amounts.**

| Capability | Admin | Accountant | Supervisor (own site/shift) |
|---|:-:|:-:|:-:|
| Users, roles, password reset | ✔ | ✘ | ✘ |
| Sites, site supervisors, settings | ✔ | read | own sites (read) |
| Vendors, contracts, types, machines, operators | ✔ | read | names only |
| Rate cards (prices) | ✔ | read | ✘ |
| Deploy / transfer / release machines | ✔ | ✘ | ✘ |
| Record check-in / downtime / check-out / day status | ✔ | ✘ | ✔ |
| Submit day | ✔ | ✘ | ✔ |
| Approve / reject attendance, acknowledge anomalies | ✔ | ✘ | ✘ |
| Corrections in finalized periods | ✔ | ✘ | ✘ |
| Print sheet, upload scan | ✔ | ✔ | ✔ |
| Paper reconciliation | ✔ | ✔ | ✘ |
| Fuel litres / fuel price | ✔ / ✔ | ✔ / ✔ | ✔ / ✘ |
| Adjustments | ✔ | ✔ | ✘ |
| Payroll generate / finalize / mark paid / void / supersede | ✔ | ✔ (finalize + paid need Admin if setting `payroll_finalize_admin_only = true`) | ✘ |
| Live dashboard | ✔ (with cost) | ✔ (with cost) | own sites, no money |
| Audit log | ✔ | ✘ | ✘ |

# 6. Domain model (overview)

```
 users ─┬─* site_supervisors *── sites ─────────────────────────────┐
        ├─* login_history                                           │
        └─(actor of everything: audit_logs, created_by, approved_by)│
                                                                    │
 eq_vendors 1──* eq_vendor_contracts 1──* eq_rate_cards *──1 eq_equipment *──1 eq_types
     └──* eq_operators                                     │  │  └──* eq_site_assignments *──1 sites
                └─(operator of)─* eq_attendance *───────────┘  └──* eq_timesheets (machine×site×month)
                                    │   │                                  │
           eq_downtime_periods *────┘   └─* eq_paper_checks *── eq_timesheet_scans *┘
 eq_fuel_issues *──1 eq_equipment     eq_adjustments *──1 eq_equipment
 eq_payroll_batches 1──* eq_payroll_items 1──* eq_payroll_lines
                               └──* eq_payroll_attendance_snapshot ──1 eq_attendance
 eq_attendance_corrections *──1 eq_attendance
```

The schema has 25 tables: 7 platform tables and 18 equipment tables. Full SQL is in document 02. Key decisions:

- **One attendance row per machine × site × shift × date.** Interruptions are downtime periods, not extra rows.
- **Rate cards are per machine**, because two machines of the same type often have different prices. A rate card belongs to a contract, and the contract fixes the currency.
- **Payroll snapshots** copy the rate card (JSON) and the rows used, so a statement can always be reprinted identically.

# 7. End-to-end life cycle

0. **Setup (once):** the first Admin is created by `scripts/createAdmin.js`. Admin then creates the users (supervisors, accountant), the sites, and assigns supervisors to sites and shifts.
1. **Vendor onboarding:** create the vendor and the contract (number, dates, currency, signed document).
2. **Machine registration:** create machines (type, make/model, plate, serial, photo) and the vendor's operators.
3. **Pricing:** create the machine's rate card (document 04).
4. **Deployment:** assign the machine to a site and shift from a date, optionally with a default operator.
5. **Monthly sheet:** created automatically with the first row of the month (`ETS-2026-10-EQ0012-S08`). It can be printed any time, and every new row appears on the same sheet with a permanent number.
6. **Daily recording (supervisor app):**
   - check-in with time, operator and meter reading;
   - Break / Refuel / Breakdown / Standby periods during the day;
   - check-out with time, meter, fuel received and work done;
   - or a full-day status: Standby, Breakdown, Absent or Holiday.
7. **Paper signature:** our employee and the operator sign the row.
8. **Submit:** the supervisor submits the day (Draft → Submitted). If the weekly gate is enabled, the day cannot be submitted while last week still has Draft rows for that site and shift.
9. **Review:** Admin approves or rejects. Rejected rows are fixed and resubmitted. Anomalies must be acknowledged before approval.
10. **Scan upload:** recommended weekly and mandatory at month end. Each upload is a new immutable version.
11. **Reconciliation:** Admin or Accountant marks each row Matched, Mismatch or Missing. Matched requires both signatures and a difference within tolerance.
12. **Month close:** the site engineer and the vendor representative sign off and the final scan is uploaded. When every row is Matched, the sheet becomes Reconciled.
13. **Payroll:** preview and generate for any period and scope. By default only Approved **and** Matched rows are paid. A blockers report explains anything excluded.
14. **Finalize → Paid:** finalizing locks the rows. Later fixes go through corrections and adjustments, or through a superseding version of the batch with a reason.

# 8. Business rules

## 8.1 Platform (users, login, sites)

- **BR-P1** Username is unique. A new user gets a temporary password and `must_change_password = 1`. The app forces a password change on first login.
- **BR-P2** Password policy: minimum 10 characters, with at least one letter and one digit. Stored as bcrypt with cost 12.
- **BR-P3** After 5 failed logins the account is locked for 15 minutes (`locked_until`). Every attempt is written to `login_history`. Login is rate-limited per IP to 20 per 15 minutes.
- **BR-P4** The JWT contains only `user_id` (12 h expiry). On **every request** the role and status are re-read from `users`. A deactivated user is refused immediately (401 `ACCOUNT_INACTIVE`).
- **BR-P5** Admin cannot deactivate or demote himself if he is the last active Admin (409 `LAST_ADMIN`).
- **BR-P6** Site codes and names are unique. A site with deployed machines cannot be set Completed or Suspended (409 `SITE_HAS_DEPLOYED_MACHINES`).
- **BR-P7** Site supervisor periods for the same site and shift must not overlap: one responsible supervisor at a time. One user may supervise several sites. `Night` is allowed only if the site has a night shift.
- **BR-P8** Every create, update and status change writes `audit_logs` with old and new values, and with the reason when one is required.

## 8.2 Master data

- **BR-01** Vendor name and code are unique. A vendor with machines is never deleted, only made Inactive. It cannot be made Inactive while one of its machines is deployed.
- **BR-02** A contract has one currency (`USD` by default, `SYP` allowed). Rate cards, adjustments and payroll batches inherit it. **One payroll batch = one currency.**
- **BR-03** Machine code is generated (`EQ-` + 4 digits) and unique. The plate number is unique when present.
- **BR-04** An operator belongs to one vendor. An operator of another vendor is **blocked**. An expired licence is **allowed with an anomaly**.
- **BR-05** Rate cards of one machine never overlap. A rate card used by a finalized (active) batch cannot be edited: close it and create a new one.
- **BR-06** Rate card dates must lie inside the contract dates.

## 8.3 Deployment

- **BR-07** All date ranges are **inclusive** on both ends; `NULL` end means open.
- **BR-08** A machine cannot have overlapping deployments.
- **BR-09** Deployment requires an Active machine and an Active site. A missing rate card on the start date produces a warning only.
- **BR-10** A deployment cannot end before existing attendance rows on later dates.

## 8.4 Attendance

- **BR-11** A row is allowed only when all of these hold on that date:
  - the machine is deployed to the site and shift;
  - the machine is Active;
  - the caller supervises that site and shift on that date (or is Admin);
  - the date is not in the future in business time (Asia/Beirut).
- **BR-12** A machine has at most one open session across all sites.
- **BR-13** Sessions of the same machine never overlap in time.
- **BR-14** Night shift: the record date is the date of the check-in, and check-out may be on the next day.
- **BR-15** Working rows need check-in and check-out before submit. A full-day Standby or Breakdown may have no times; the standard hours of the rate card are then used. Absent and Holiday rows have no times.
- **BR-16** Downtime periods stay inside the session, do not overlap, and only one can be open. An open period is auto-closed at check-out.
- **BR-17** Stored minutes (recomputed on every change):
  - `gross`
  - `break` (Break + Refuel)
  - `breakdown`
  - `standby`
  - `working = gross − break − breakdown − standby` (never below 0)
- **BR-18** Meter readings:
  - meter end ≥ meter start;
  - a start below the previous end raises the anomaly `meter_backwards`;
  - an hour-meter delta that differs from working hours by more than `eq_meter_tolerance_pct` raises `meter_mismatch`.
- **BR-19** A session longer than `eq_long_session_review_hours` raises `long_session`. Anomalies are warnings only and never change values.
- **BR-20** Workflow: Draft → Submitted → Approved, or Rejected → (fix) → Submitted. The supervisor edits only Draft and Rejected rows.
- **BR-21** A row with an unacknowledged anomaly cannot be approved.
- **BR-22** Weekly gate (setting `week_gate_enabled`, week start `week_start_day`, default Saturday): a day cannot be submitted while Draft rows remain in the previous week for the same site and shift.
- **BR-23** Rows used by a finalized active batch, and dates inside such a batch's scope, are locked for normal operations (409 `PAYROLL_PERIOD_FINALIZED`).

## 8.5 Paper timesheet

- **BR-24** There is one timesheet per machine × site × month. It is created automatically or by "print blank sheet".
- **BR-25** A row gets `sheet_row_no = last_row_no + 1` when it is created and keeps it forever. Back-dated rows get the next number, so the paper never has to be rewritten.
- **BR-26** Scans are immutable and versioned. The same SHA-256 cannot be uploaded twice to a sheet. Nothing is ever overwritten or deleted.
- **BR-27** Matched requires both signatures and a time difference ≤ `eq_paper_tolerance_minutes` on both check-in and check-out.
- **BR-28** A correction to an Approved row sets its paper status back to Pending.
- **BR-29** Close requires a scan whose `through_row_no` is ≥ `last_row_no`. A Closed sheet with every row Matched becomes Reconciled.

## 8.6 Payroll

- **BR-30** Payroll can be run for any period, with scope all vendors, one vendor, one machine and/or one site. Preview never writes anything.
- **BR-31** Eligible rows are Approved and, if `eq_payroll_requires_paper_match` is on, Matched. They must not already be in an active batch (Generated or Paid).
- **BR-32** The rate card is resolved per row on its record date. One item = machine × site × rate card.
- **BR-33** Fuel in the period is deducted unless the card in force says `CompanySuppliesFree`. Active adjustments in the period are included once.
- **BR-34** All amounts are calculated in integer minutes and integer cents (document 04).
- **BR-35** Batch life cycle: Generated → finalized → Paid. A batch can be Voided before it is Paid. A finalized batch can be Superseded by a new version (a reason is required).
- **BR-36** Exports read only the snapshot tables.

# 9. State machines

| Object | States and transitions |
|---|---|
| Attendance workflow | Draft → Submitted → Approved; Submitted → Rejected → Submitted; Approved → (correction) Approved |
| Day status | Working · Standby · Breakdown · Absent · Holiday |
| Paper status | Pending → Matched / Mismatch / Missing; any → Pending after a correction or a new scan |
| Timesheet | Open → Closed → Reconciled; Closed → Open (reopen with reason) |
| Payroll batch | Generated → Generated + finalized → Paid; Generated → Voided; finalized → Superseded |
| User | Active ↔ Inactive; locked temporarily by failed logins |

# 10. Live dashboard

For each **deployed** machine at "now" (business time):

| State | Rule | Colour |
|---|---|---|
| Working | Open session (today, or a Night session from yesterday) with no open downtime | green |
| On break | Open Break or Refuel period | blue-grey |
| Breakdown | Open Breakdown period, or day status Breakdown | red |
| Standby | Open Standby period, or day status Standby | amber |
| Finished | Today's session is closed | grey |
| Not arrived | No row today and no open session. Red outline after `day_shift_start` / `night_shift_start` of the site, grey before | red outline |
| Absent / Holiday | Day status set | grey |
| Forgotten check-out | Open session older than `eq_long_session_review_hours` | red icon |

KPIs:

- deployed today, on site now, working, breakdown, standby, not arrived;
- hours worked today;
- estimated cost today (Admin and Accountant only).

The board can be grouped by site or by vendor. It refreshes by polling every `eq_live_refresh_seconds`. The Supervisor sees only his sites, without money.

# 11. Documents produced

| Code | Document | Format |
|---|---|---|
| D1 | Monthly Equipment Timesheet (to sign, with QR) | PDF A4 landscape |
| D2 | Machine Statement | PDF A4 + Excel |
| D3 | Vendor Statement (sent to the vendor) | PDF A4 + Excel |
| D4 | Equipment Payroll Summary | PDF A4 landscape + Excel |
| D5 | Daily Site Equipment Report | PDF A4 |
| D6 | Utilization report | Excel + PDF |

# 12. Non-functional requirements

- **Security:**
  - `helmet` and CORS limited to the app origins;
  - JWT secret of 32+ characters (the server refuses to start without it);
  - role and site checks on every route;
  - Supervisor responses never contain price or amount fields;
  - upload whitelist (PDF, JPEG, PNG, WEBP), 15 MB per file, 10 files per upload, magic-number check;
  - files are never public and stream only through authorized endpoints.
- **Storage:** a storage adapter (`s3` or `local`). On hosts with an ephemeral disk, such as Render without a disk, the **s3** driver is mandatory.
- **Audit:** `audit_logs` records every change.
- **Transactions:** multi-row writes use a transaction and `SELECT … FOR UPDATE`.
- **Time:** one `businessDate` service (Asia/Beirut). Never derive business dates from UTC or from MySQL `NOW()`.
- **Money:** integer cents in the engine, `DECIMAL(14,2)` in the database.
- **Performance:**
  - the live board runs a constant number of set-based queries;
  - payroll for 1 month × 100 machines takes under 5 s;
  - indexes are listed in document 02.
- **Language:** the app UI is in English, with Arabic names allowed. PDF headers are bilingual (English + Arabic).
- **Backups:** daily database dump, plus bucket versioning or disk backup.

# 13. Phases and milestones

| Phase | Deliverable | Estimate* |
|---|---|---|
| P0 | Backend skeleton, foundation services, DB schema, tests harness | 1 d |
| P1 | Auth (login, lockout, change password), users, sites, site supervisors, settings, audit | 1.5 d |
| P2 | Equipment master data: vendors, contracts, types, machines, operators, rate cards, deployments, storage adapter | 2 d |
| P3 | Attendance: day board, check-in/out, downtime, day status, submit, review, anomalies, corrections, locks, fuel, adjustments | 3 d |
| P4 | Paper timesheets: PDF D1 with QR, scans, versions, reconciliation, close | 2 d |
| P5 | Billing engine + payroll + statements D2–D4 + Excel | 3 d |
| P6 | Live board API + D5 + D6 | 1 d |
| P7 | Flutter app skeleton: theme, API client, login, change password, role routing, shell/navigation; Admin users & sites | 2 d |
| P8 | Flutter Admin / Accountant equipment screens | 4 d |
| P9 | Flutter Supervisor screens | 2 d |
| P10 | End-to-end tests, demo seed, deployment, runbook | 1.5 d |

\*Working days for one developer driving Claude Code, review included. Total about 23 days.

**Milestones:**

- **M1** (after P3): supervisors can record through the API.
- **M2** (after P4): paper flow works.
- **M3** (after P5): first vendor statement.
- **M4** (after P9): full app.
- **M5** (after P10): go-live.

# 14. Decisions and assumptions

| # | Decision | Why |
|---|---|---|
| A0 | **Standalone system**, own DB and users, no link to Team Flow | Requested |
| A1 | Pricing configurable per machine (Hourly / Daily / Monthly + all options) | Requested |
| A2 | All deductions configurable | Requested |
| A3 | One sheet per machine × site × month, with rows appended | Requested |
| A4 | Employee + operator sign each row; site engineer + vendor representative sign the month | Requested + standard practice |
| A5 | Payroll pays Approved + Matched rows by default | Paper must match electronic |
| A6 | Currency per contract, USD default | Rental contracts |
| A7 | Defaults: standby 50 %, breakdown 0 %, breaks deducted | Market practice, editable |
| A8 | Three roles: Admin, Accountant, Supervisor | Segregation of duties |
| A9 | Polling (60 s) for the live board | Simple and reliable |
| A10 | S3-compatible storage recommended | Evidence must persist |
| A11 | Same stack the team knows (Node/Express/MySQL + Flutter) | Faster delivery, easy maintenance |
| A12 | Product name "Equipment Flow" (changeable) | Placeholder |

## Questions for management (do not block development)

1. Does the minimum guarantee also apply on Standby days? Currently yes.
2. Is fuel priced per issue, or with one monthly price? Currently per issue.
3. Should the official statement be per vendor or per vendor per site? Both are available.
4. Who signs on site as "employee": the supervisor or a dedicated timekeeper?
