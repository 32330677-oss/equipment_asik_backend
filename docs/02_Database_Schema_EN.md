# Database Schema — & Migration

**Standalone database equipment_flow — 33 tables (25 base + 7 from migrations + schema_migrations), idempotent**

Full schema SQL, seed, table reference, settings and query recipes. Run twice on an empty database without error.

_Equipment Flow · Doc 02 · v2.4 standalone · 2026-10-05 — consolidated: schema.sql + migrations 001–009 (edit / lock policy)_

---

# 1. Overview

Equipment Flow has **its own MySQL database** (`equipment_flow`) with **33 tables**:

- 7 platform tables: `users`, `login_history`, `sites`, `site_supervisors`, `settings`, `audit_logs`, `schema_migrations`.
- 26 equipment tables, prefixed `eq_` (19 in `schema.sql` + 4 from migration 001: `eq_fuel_prices`, `eq_fuel_terms`, `eq_invoice_counters`, `eq_invoices`; + `eq_invoice_cancellations` (005), `eq_correction_events` (006), `eq_file_versions` (009)).

**Changes since v2.0 (applied by migrations, `schema.sql` itself is unchanged):**

| Migration | Change |
|---|---|
| `009_versioned_files.sql` | New table `eq_file_versions`: fuel receipts and contract documents are versioned (a new upload never replaces the old file; replacing needs a reason). Existing `receipt_path` / `document_path` become version 1; those columns keep pointing to the current version. |
| `008_shifts.sql` | `eq_rate_cards.second_shift_pct` (Daily: work above one day the same day billed at this %, default 0, CHECK 0–100). `eq_payroll_lines.line_type` + `'SecondShift'`. `eq_payroll_attendance_snapshot.calc_detail` JSON (regular minutes allowed for continuous shifts, part of the day used before the row). Setting `eq_shift_continuity_minutes = 30`. |
| `007_edit_after_approval.sql` | `eq_attendance` + `edited_after_approval`, `admin_edit_reason`, `admin_edit_by_user_id`, `admin_edit_at`: an Admin may change an Approved row (outside finalized periods) with a reason; it stays Approved and is flagged. |
| `006_official_corrections.sql` | Official corrections of finalized periods: `eq_attendance_corrections` + `request_status` (Requested → Reviewed → Approved / Cancelled), `proposed_changes`, `delta_amount`, `delta_detail`, `currency`, `amount_override`, `override_reason`, review / approval columns, `return_count`, `note_invoice_id`. New table `eq_correction_events`. `eq_invoices.kind` / `eq_invoice_counters.kind` + `'DebitNote'`, `'CreditNote'` (numbers DN-YYYY-NNNNN / CN-YYYY-NNNNN). `eq_adjustments.adjustment_type` + `'Correction'`, + `correction_id`. |
| `005_lock_policy.sql` | `eq_payroll_batches.settings_snapshot` JSON (billing settings frozen in each batch). New table `eq_invoice_cancellations`: numbers of a voided / superseded finalized batch are never reused, they are marked cancelled. |
| `001_fuel_difference_invoices_scans.sql` | New tables `eq_fuel_prices`, `eq_fuel_terms`, `eq_invoice_counters`, `eq_invoices`. `eq_payroll_lines.line_type` + `'FuelPriceDifference'`; `source_table` + `'eq_fuel_terms'`. Settings: `eq_finalize_requires_scan=true`, `payroll_finalize_admin_only=true`, `eq_payroll_requires_paper_match` → `false`. Clears old `operator_license_expired` anomalies (licence no longer an anomaly). |
| `004_standby_hours_given.sql` | Monthly machines: the standby % is replaced by hours given per row. `eq_attendance` + `standby_credit_minutes` (NULL = not decided), `standby_credit_by_user_id`, `standby_credit_at`, `standby_credit_note`; `eq_payroll_attendance_snapshot` + `standby_credit_minutes`. New payroll blocker `STANDBY_HOURS_NOT_SET`. |
| `003_monthly_hours_and_roles.sql` | `eq_payroll_lines.line_type` + `'HoursShortfall'` (monthly machines billed on hours due). Setting `eq_weekly_off_day = 5` (Friday). `eq_rate_cards.monthly_working_days` is no longer used by billing (working days = days of the month minus the weekly day off). |
| `002_fuel_diff_deduct_when_lower.sql` | `eq_fuel_diff_allow_negative=true`: when the official price falls below the machine base price, the difference is deducted from the vendor. |

| Item | Value |
|---|---|
| Files | `database/schema.sql`, `database/seed.sql`, `database/migrations/NNN_*.sql`, `database/applyMigrations.js`, `database/reset_data.sql`, `database/rollback_drop_all.sql` (dev only) |
| Engine / charset | InnoDB, utf8mb4 (`utf8mb4_unicode_ci` on CREATE DATABASE; MySQL 8 may use `utf8mb4_0900_ai_ci`) |
| Idempotent | Yes. `CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`. Both files were run twice on an empty database without error; the rollback was then run and the schema re-applied (verified while writing this document). |
| First admin | `node scripts/createAdmin.js --username admin --name "System Admin"` prints a temporary password (bcrypt hash stored). |
| Changes | Numbered files in `database/migrations/NNN_description.sql`, applied once each in name order by `database/applyMigrations.js` (`npm run migrate`, initDb, tests) and recorded in `schema_migrations`. Never edit an applied file. |

Create the database:

```sql
CREATE DATABASE equipment_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'eqflow'@'%' IDENTIFIED BY '<strong password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON equipment_flow.* TO 'eqflow'@'%';
```

In production, run `npm run harden-db` once afterwards (section 7): migrations then run with a separate migration user and the app user gets table rights only, with the audit trail and the official numbers append-only.

# 2. Table reference

| # | Table | Purpose | Key rules |
|---|---|---|---|
| A1 | `users` | Accounts: Admin / Accountant / Supervisor | unique username/email; lockout fields; must_change_password |
| A2 | `login_history` | Every login attempt | for security review |
| B1 | `sites` | Construction sites | unique code + name; Day/Night support; shift start times (live board) |
| B2 | `site_supervisors` | Who supervises a site + shift between dates | no overlap per site+shift (service) |
| C1 | `settings` | Key/value configuration | seeded |
| C2 | `audit_logs` | Every change, old/new JSON | append-only |
| 1 | `eq_vendors` | Companies renting machines to us | unique code + name |
| 2 | `eq_vendor_contracts` | Rental agreements, currency, signed document | unique (vendor, number) |
| 3 | `eq_types` | Machine types + meter unit | 13 seeded (EN + AR) |
| 4 | `eq_equipment` | Machines | unique code / plate |
| 5 | `eq_operators` | Drivers of a vendor | licence expiry → anomaly |
| 6 | `eq_rate_cards` | Effective-dated pricing per machine | CHECKs per mode and %; no overlap (service) |
| 7 | `eq_site_assignments` | Deployment machine → site/shift | inclusive; no overlap (service) |
| 8 | `eq_timesheets` | Monthly paper sheet per machine × site × month | unique; row counter; verify token |
| 9 | `eq_attendance` | One row per machine × site × shift × date | workflow + day + paper status, anomalies, sheet row |
| 10 | `eq_downtime_periods` | Break / Refuel / Breakdown / Standby | cascade with row |
| 11 | `eq_fuel_issues` | Fuel given by us | cancel, never delete |
| 12 | `eq_adjustments` | Manual +/− amounts with reason | cancel, never delete |
| 13 | `eq_timesheet_scans` | Immutable scans, versioned | unique version and sha256 per sheet |
| 14 | `eq_paper_checks` | Paper vs electronic history | `is_current` |
| 15 | `eq_payroll_batches` | Saved payroll per period/scope/currency | life cycle + version chain |
| 16 | `eq_payroll_items` | Machine × site × rate card totals | rate snapshot JSON |
| 17 | `eq_payroll_lines` | Statement lines | signed amounts, source links |
| 18 | `eq_payroll_attendance_snapshot` | Frozen rows per item | unique (batch, row) |
| 19 | `eq_attendance_corrections` | Official corrections of rows paid by a finalized batch | Requested → Reviewed → Approved (debit / credit note + `Correction` adjustment in the first open period) or Cancelled; the finalized batch never changes |
| 20 | `eq_fuel_prices` | Official fuel price per currency, effective-dated | unique (currency, effective_from); valid until next row |
| 21 | `eq_fuel_terms` | Fuel-difference terms per machine (base price, L/h) | effective-dated; a change closes the old row |
| 22 | `eq_invoice_counters` | Invoice number sequence per kind + year | never reused |
| 23 | `eq_invoices` | Official invoices issued at batch finalize | unique invoice_no and (kind, year, seq) |
| 24 | `eq_invoice_cancellations` | Official numbers of voided / superseded finalized batches, marked cancelled | append-only; numbers never reused (005) |
| 25 | `eq_correction_events` | Every step of a correction (request, review, return, approve, cancel) | append-only (006) |
| 26 | `eq_file_versions` | Versions of fuel receipts and contract documents | append-only; unique (owner, version); reason when replacing (009) |
| M | `schema_migrations` | Applied migration files | created by `applyMigrations.js` |

### Rules enforced in the service layer

- No overlapping **site supervisor** periods per site and shift; no overlapping **rate cards** or **deployments** per machine. Use one helper `rangesOverlap(aFrom, aTo, bFrom, bTo)` (inclusive, `NULL` = open) and run the check inside a transaction after `SELECT … FOR UPDATE` on the parent row.
- One open session per machine; no time overlap; one open downtime per row.
- Row number allocation with `SELECT last_row_no … FOR UPDATE`.
- A row appears in at most one active batch.
- The last active Admin cannot be deactivated or demoted.

# 3. Settings (`settings`)

| Key | Default | Meaning |
|---|---|---|
| `eq_payroll_requires_paper_match` | `false` | `true` = payroll includes only Matched rows (set to `false` by 001) |
| `eq_paper_tolerance_minutes` | `10` | Max paper vs electronic difference for Matched |
| `eq_meter_tolerance_pct` | `15` | Meter delta vs working hours → `meter_mismatch` |
| `eq_long_session_review_hours` | `16` | Long session → `long_session` / forgotten check-out |
| `eq_default_currency` | `USD` | Pre-filled on new contracts |
| `eq_timesheet_blank_rows` | `6` | Empty rows printed for manual entries |
| `eq_live_refresh_seconds` | `60` | Live board polling |
| `week_start_day` | `6` | 0 = Sunday … 6 = Saturday |
| `week_gate_enabled` | `true` | Weekly submit gate |
| `company_name` | `ASIK ENGINEERING CONSTRUCTION` | Printed on documents |
| `app_time_zone` | `Asia/Beirut` | Business time zone (env `APP_TIME_ZONE` overrides) |
| `eq_finalize_requires_scan` | `true` | Signed sheet scan required to FINALIZE (not to generate) — 001 |
| `eq_fuel_diff_allow_negative` | `true` | Fuel price below base → difference deducted from vendor — 002 |
| `payroll_finalize_admin_only` | `true` | Finalize / mark paid by Admin only — 001 |
| `eq_weekly_off_day` | `5` | Weekly day off for monthly machines (0=Sunday … 5=Friday) — 003 |
| `eq_shift_continuity_minutes` | `30` | Shifts of one machine closer than this are continuous: overtime starts after threshold × shifts — 008 |

The settings service caches values in memory and invalidates the cache on `PUT /api/settings/:key`. The billing settings (`eq_weekly_off_day`, `eq_fuel_diff_allow_negative`, `eq_payroll_requires_paper_match`, `eq_shift_continuity_minutes`) are frozen in each batch (`settings_snapshot`); changing one makes a generated batch stale.

# 4. Query recipes

### 4.1 Is the user the supervisor of a site/shift on a date?

```sql
SELECT 1 FROM site_supervisors
WHERE user_id = ? AND site_id = ? AND shift_type = ?
  AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)
LIMIT 1;
```

### 4.2 Rate card in force for a machine on a date

```sql
SELECT rc.*, vc.currency, vc.vendor_id
FROM eq_rate_cards rc
JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
WHERE rc.equipment_id = ?
  AND rc.effective_from <= ? AND (rc.effective_to IS NULL OR rc.effective_to >= ?)
ORDER BY rc.effective_from DESC LIMIT 1;
```

For a whole period, load every card that overlaps the period once and resolve each row in JavaScript.

### 4.3 Machines expected at a site/shift on a date (supervisor day board)

```sql
SELECT e.equipment_id, e.equipment_code, e.plate_number, t.type_name, t.type_name_ar, t.meter_unit,
       v.vendor_name, a.default_operator_id, o.full_name AS default_operator_name,
       ea.eq_attendance_id, ea.day_status, ea.status, ea.check_in_time, ea.check_out_time,
       ea.meter_start, ea.meter_end, ea.operator_id, ea.sheet_row_no, ea.paper_status, ea.anomaly_code
FROM eq_site_assignments a
JOIN eq_equipment e ON e.equipment_id = a.equipment_id AND e.status = 'Active'
JOIN eq_types t     ON t.type_id = e.type_id
JOIN eq_vendors v   ON v.vendor_id = e.vendor_id
LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id
LEFT JOIN eq_attendance ea ON ea.equipment_id = a.equipment_id AND ea.site_id = a.site_id
                          AND ea.shift_type = a.shift_type AND ea.record_date = ?
WHERE a.site_id = ? AND a.shift_type = ?
  AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)
ORDER BY t.type_name, e.equipment_code;
```

For the Night shift, also load the still-open row from D-1. Open downtime is loaded with one more query: `WHERE eq_attendance_id IN (...) AND end_time IS NULL`.

### 4.4 Open session of a machine (any site)

```sql
SELECT eq_attendance_id, site_id, shift_type, record_date, check_in_time
FROM eq_attendance
WHERE equipment_id = ? AND check_in_time IS NOT NULL AND check_out_time IS NULL
FOR UPDATE;
```

### 4.5 Time overlap with another row of the same machine

```sql
SELECT eq_attendance_id FROM eq_attendance
WHERE equipment_id = ? AND eq_attendance_id <> ?
  AND check_in_time IS NOT NULL
  AND check_in_time < ?
  AND COALESCE(check_out_time, '9999-12-31 23:59:59') > ?
LIMIT 1;
```

### 4.6 Rows eligible for payroll

```sql
SELECT ea.*
FROM eq_attendance ea
JOIN eq_equipment e ON e.equipment_id = ea.equipment_id
WHERE ea.record_date BETWEEN ? AND ?
  AND ea.status = 'Approved'
  AND (? = 0 OR ea.paper_status = 'Matched')
  AND (? IS NULL OR e.vendor_id = ?)
  AND (? IS NULL OR ea.equipment_id = ?)
  AND (? IS NULL OR ea.site_id = ?)
  AND NOT EXISTS (
      SELECT 1 FROM eq_payroll_attendance_snapshot s
      JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id
      WHERE s.eq_attendance_id = ea.eq_attendance_id
        AND b.status IN ('Generated','Paid'))
ORDER BY ea.equipment_id, ea.site_id, ea.record_date;
```

When superseding batch X, exclude X itself from the `NOT EXISTS` and mark X as `Superseded` in the same transaction.

### 4.7 Payroll lock check

```sql
SELECT b.eq_batch_id, b.start_date, b.end_date, b.status
FROM eq_payroll_batches b
WHERE b.status IN ('Generated','Paid') AND b.is_finalized = 1
  AND b.start_date <= ? AND b.end_date >= ?
  AND (b.scope_vendor_id IS NULL OR b.scope_vendor_id = ?)
  AND (b.scope_equipment_id IS NULL OR b.scope_equipment_id = ?)
  AND (b.scope_site_id IS NULL OR b.scope_site_id = ?)
ORDER BY b.eq_batch_id DESC LIMIT 1;
```

# 5. Full SQL

## 5.1 Consolidated schema (`schema.sql` + migrations 001–009)

For a fresh install run `schema.sql`, `seed.sql`, then `npm run migrate`. The block below is the resulting final state in one file.

```sql
-- =====================================================================
-- Equipment Flow — CONSOLIDATED CURRENT SCHEMA = schema.sql + migrations 001 … 009
-- 33 tables (25 base + eq_fuel_prices, eq_fuel_terms, eq_invoice_counters, eq_invoices, eq_invoice_cancellations,
--            eq_correction_events, eq_file_versions + schema_migrations)
-- Foreign keys point forward (corrections <-> adjustments, notes -> invoices): checks are off while creating.
-- MySQL 8.0+ (also runs on MariaDB 10.6+ for local tests).
-- Idempotent: CREATE TABLE IF NOT EXISTS everywhere. Run on an EMPTY database:
--   CREATE DATABASE equipment_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   mysql equipment_flow < database/schema.sql && mysql equipment_flow < database/seed.sql
-- Conventions: InnoDB, utf8mb4, INT ids, DATE = business date (Asia/Beirut),
-- DATETIME = wall-clock business time, all date ranges INCLUSIVE on both ends.
-- =====================================================================
SET FOREIGN_KEY_CHECKS = 0;

-- A. Users and authentication ---------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id          INT NOT NULL AUTO_INCREMENT,
  username         VARCHAR(100) NOT NULL,
  email            VARCHAR(255) NULL,
  full_name        VARCHAR(255) NOT NULL,
  phone_number     VARCHAR(50)  NULL,
  password_hash    VARCHAR(255) NOT NULL COMMENT 'bcrypt, cost 12',
  role             ENUM('Admin','Supervisor','Accountant') NOT NULL,
  status           ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until     DATETIME NULL,
  last_login_at    DATETIME NULL,
  password_changed_at DATETIME NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_history (
  login_id         BIGINT NOT NULL AUTO_INCREMENT,
  user_id          INT NULL,
  username_tried   VARCHAR(255) NOT NULL,
  success          TINYINT(1) NOT NULL,
  ip_address       VARCHAR(64) NULL,
  user_agent       VARCHAR(500) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (login_id),
  KEY idx_lh_user (user_id, created_at),
  CONSTRAINT fk_lh_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- B. Sites and who supervises them -----------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  site_id          INT NOT NULL AUTO_INCREMENT,
  site_code        VARCHAR(20)  NOT NULL COMMENT 'Short code printed on sheets, e.g. S08',
  site_name        VARCHAR(255) NOT NULL,
  project_name     VARCHAR(255) NULL COMMENT 'Free text; no project module in v1',
  location         VARCHAR(255) NULL,
  has_night_shift  TINYINT(1) NOT NULL DEFAULT 0,
  day_shift_start  TIME NULL COMMENT 'Used by the live board for "not arrived" (optional)',
  night_shift_start TIME NULL,
  status           ENUM('Active','Suspended','Completed') NOT NULL DEFAULT 'Active',
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (site_id),
  UNIQUE KEY uq_sites_code (site_code),
  UNIQUE KEY uq_sites_name (site_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A supervisor is in charge of a site + shift between two dates (inclusive).
CREATE TABLE IF NOT EXISTS site_supervisors (
  site_supervisor_id INT NOT NULL AUTO_INCREMENT,
  site_id          INT NOT NULL,
  shift_type       ENUM('Day','Night') NOT NULL DEFAULT 'Day',
  user_id          INT NOT NULL,
  from_date        DATE NOT NULL,
  to_date          DATE NULL COMMENT 'Inclusive last day; NULL = open',
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (site_supervisor_id),
  KEY idx_ss_site_shift (site_id, shift_type, from_date),
  KEY idx_ss_user (user_id, from_date),
  CONSTRAINT fk_ss_site FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_ss_user FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT fk_ss_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_ss_dates CHECK (to_date IS NULL OR to_date >= from_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- C. Settings and audit -------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key      VARCHAR(100) NOT NULL,
  setting_value    VARCHAR(255) NOT NULL,
  description      VARCHAR(500) NULL,
  updated_by_user_id INT NULL,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id           BIGINT NOT NULL AUTO_INCREMENT,
  table_name       VARCHAR(100) NOT NULL,
  record_id        BIGINT NOT NULL,
  action_type      VARCHAR(60)  NOT NULL,
  user_id          INT NULL,
  old_values       JSON NULL,
  new_values       JSON NULL,
  reason           VARCHAR(500) NULL,
  ip_address       VARCHAR(64) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_audit_record (table_name, record_id),
  KEY idx_audit_user (user_id, created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- D. Equipment domain
-- =====================================================================

-- 1. Vendors = the companies that supply machines to us ------------------
CREATE TABLE IF NOT EXISTS eq_vendors (
  vendor_id        INT NOT NULL AUTO_INCREMENT,
  vendor_code      VARCHAR(30)  NOT NULL COMMENT 'e.g. VND-001, generated',
  vendor_name      VARCHAR(255) NOT NULL,
  contact_person   VARCHAR(255) NULL,
  phone_number     VARCHAR(50)  NULL,
  email            VARCHAR(255) NULL,
  address          VARCHAR(500) NULL,
  tax_number       VARCHAR(100) NULL,
  status           ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  notes            TEXT NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_id),
  UNIQUE KEY uq_eq_vendor_code (vendor_code),
  UNIQUE KEY uq_eq_vendor_name (vendor_name),
  CONSTRAINT fk_eqv_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Rental contracts with a vendor (one vendor can have many) ----------
CREATE TABLE IF NOT EXISTS eq_vendor_contracts (
  vendor_contract_id INT NOT NULL AUTO_INCREMENT,
  vendor_id        INT NOT NULL,
  contract_number  VARCHAR(100) NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NULL COMMENT 'Inclusive; NULL = open',
  currency         CHAR(3) NOT NULL DEFAULT 'USD' COMMENT 'Every amount under this contract uses this currency',
  payment_terms    VARCHAR(255) NULL,
  status           ENUM('Draft','Active','Expired','Terminated') NOT NULL DEFAULT 'Active',
  document_path    VARCHAR(500) NULL COMMENT 'Signed contract scan, stored privately',
  document_sha256  CHAR(64) NULL,
  notes            TEXT NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_contract_id),
  UNIQUE KEY uq_eqvc_vendor_number (vendor_id, contract_number),
  KEY idx_eqvc_status (status),
  CONSTRAINT fk_eqvc_vendor  FOREIGN KEY (vendor_id)  REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqvc_user    FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqvc_dates  CHECK (end_date IS NULL OR end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Equipment types (Excavator, Loader, Crane, ...) ---------------------
CREATE TABLE IF NOT EXISTS eq_types (
  type_id          INT NOT NULL AUTO_INCREMENT,
  type_name        VARCHAR(100) NOT NULL,
  type_name_ar     VARCHAR(100) NULL,
  meter_unit       ENUM('Hours','Km','None') NOT NULL DEFAULT 'Hours' COMMENT 'What the machine meter measures',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (type_id),
  UNIQUE KEY uq_eqt_name (type_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Machines -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eq_equipment (
  equipment_id     INT NOT NULL AUTO_INCREMENT,
  equipment_code   VARCHAR(30) NOT NULL COMMENT 'Internal code printed on sheets, e.g. EQ-0012',
  vendor_id        INT NOT NULL,
  type_id          INT NOT NULL,
  make             VARCHAR(100) NULL,
  model            VARCHAR(100) NULL,
  plate_number     VARCHAR(50)  NULL,
  serial_number    VARCHAR(100) NULL COMMENT 'Chassis / serial',
  manufacture_year SMALLINT NULL,
  capacity         VARCHAR(100) NULL COMMENT 'Free text: 20 t, 1.2 m3 bucket ...',
  photo_path       VARCHAR(500) NULL,
  status           ENUM('Active','Inactive','Released') NOT NULL DEFAULT 'Active' COMMENT 'Released = returned to vendor',
  notes            TEXT NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (equipment_id),
  UNIQUE KEY uq_eqe_code (equipment_code),
  UNIQUE KEY uq_eqe_plate (plate_number),
  KEY idx_eqe_vendor (vendor_id),
  KEY idx_eqe_type (type_id),
  CONSTRAINT fk_eqe_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqe_type   FOREIGN KEY (type_id)   REFERENCES eq_types (type_id),
  CONSTRAINT fk_eqe_user   FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Operators (drivers) — employed by the vendor ------------------------
CREATE TABLE IF NOT EXISTS eq_operators (
  operator_id      INT NOT NULL AUTO_INCREMENT,
  vendor_id        INT NOT NULL,
  full_name        VARCHAR(255) NOT NULL,
  phone_number     VARCHAR(50)  NULL,
  national_id      VARCHAR(100) NULL,
  license_number   VARCHAR(100) NULL,
  license_expiry   DATE NULL,
  photo_path       VARCHAR(500) NULL,
  status           ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  notes            TEXT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (operator_id),
  KEY idx_eqo_vendor (vendor_id),
  KEY idx_eqo_name (full_name),
  CONSTRAINT fk_eqo_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. Rate cards = the billing policy of ONE machine, effective-dated -----
--    Exactly one rate card covers any (equipment, date) that is billed.
--    A rate card used by a finalized payroll is never edited: close it
--    (effective_to) and add a new one.
CREATE TABLE IF NOT EXISTS eq_rate_cards (
  rate_card_id       INT NOT NULL AUTO_INCREMENT,
  equipment_id       INT NOT NULL,
  vendor_contract_id INT NOT NULL,
  effective_from     DATE NOT NULL,
  effective_to       DATE NULL COMMENT 'Inclusive last day; NULL = open',
  billing_mode       ENUM('Hourly','Daily','Monthly') NOT NULL,
  hourly_rate        DECIMAL(12,2) NULL,
  daily_rate         DECIMAL(12,2) NULL,
  monthly_rate       DECIMAL(12,2) NULL,
  standard_hours_per_day DECIMAL(4,2) NOT NULL DEFAULT 8.00 COMMENT 'Full day; used for full-day Standby/Breakdown, Daily pro-rata, Monthly equivalents',
  min_billable_hours_per_day DECIMAL(4,2) NULL COMMENT 'Guaranteed minimum on Working/Standby days; NULL = none',
  overtime_enabled   TINYINT(1) NOT NULL DEFAULT 0,
  overtime_threshold_hours DECIMAL(4,2) NULL COMMENT 'Work hours per day above which OT starts; NULL = standard_hours_per_day',
  overtime_rate      DECIMAL(12,2) NULL COMMENT 'Per OT hour; NULL = hourly(-equivalent) x overtime_multiplier',
  overtime_multiplier DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  standby_billable_pct  DECIMAL(5,2) NOT NULL DEFAULT 50.00 COMMENT 'Standby (our fault idle) billed at this % of the normal price',
  breakdown_billable_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00 COMMENT 'Breakdown (vendor fault) billed at this %',
  break_policy       ENUM('Deduct','Paid') NOT NULL DEFAULT 'Deduct' COMMENT 'Lunch/rest breaks',
  daily_partial_rule ENUM('ProRata','FullDayIfWorked','HalfDayThreshold') NOT NULL DEFAULT 'ProRata',
  half_day_threshold_hours DECIMAL(4,2) NULL,
  monthly_working_days INT NOT NULL DEFAULT 26,
  operator_included  TINYINT(1) NOT NULL DEFAULT 1,
  operator_daily_rate DECIMAL(12,2) NULL COMMENT 'Charged per worked day when operator_included = 0',
  second_shift_pct   DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT 'Daily: second shift the same day billed at this % of the daily price (008)',
  fuel_policy        ENUM('VendorSupplies','CompanySuppliesDeducted','CompanySuppliesFree') NOT NULL DEFAULT 'VendorSupplies' COMMENT 'Fuel we issue is deducted unless CompanySuppliesFree',
  notes              VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at         TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_card_id),
  KEY idx_eqrc_equipment_from (equipment_id, effective_from),
  KEY idx_eqrc_contract (vendor_contract_id),
  CONSTRAINT fk_eqrc_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqrc_contract  FOREIGN KEY (vendor_contract_id) REFERENCES eq_vendor_contracts (vendor_contract_id),
  CONSTRAINT fk_eqrc_user      FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqrc_dates    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_eqrc_pct      CHECK (standby_billable_pct BETWEEN 0 AND 100 AND breakdown_billable_pct BETWEEN 0 AND 100),
  CONSTRAINT chk_eqrc_second_shift CHECK (second_shift_pct BETWEEN 0 AND 100),
  CONSTRAINT chk_eqrc_price    CHECK ((billing_mode = 'Hourly'  AND hourly_rate  IS NOT NULL)
                                   OR (billing_mode = 'Daily'   AND daily_rate   IS NOT NULL)
                                   OR (billing_mode = 'Monthly' AND monthly_rate IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. Deployment of a machine to a site/shift (inclusive dates, no overlap)
CREATE TABLE IF NOT EXISTS eq_site_assignments (
  eq_assignment_id INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  site_id          INT NOT NULL,
  shift_type       ENUM('Day','Night') NOT NULL DEFAULT 'Day',
  assigned_date    DATE NOT NULL COMMENT 'First day on site (inclusive)',
  unassigned_date  DATE NULL COMMENT 'Last day on site (inclusive); NULL = open',
  default_operator_id INT NULL,
  assigned_by_user_id INT NULL,
  notes            VARCHAR(500) NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (eq_assignment_id),
  KEY idx_eqsa_equipment (equipment_id, assigned_date),
  KEY idx_eqsa_site_shift (site_id, shift_type),
  CONSTRAINT fk_eqsa_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqsa_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqsa_operator  FOREIGN KEY (default_operator_id) REFERENCES eq_operators (operator_id),
  CONSTRAINT fk_eqsa_user      FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. Monthly paper timesheet: ONE sheet per machine x site x month ---------
--    Every attendance row recorded for that machine/site/month is appended
--    to the same sheet with a permanent row number.
CREATE TABLE IF NOT EXISTS eq_timesheets (
  timesheet_id     INT NOT NULL AUTO_INCREMENT,
  sheet_code       VARCHAR(40) NOT NULL COMMENT 'ETS-2026-10-EQ0012-S08',
  equipment_id     INT NOT NULL,
  site_id          INT NOT NULL,
  period_month     CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  verify_token     CHAR(16) NOT NULL COMMENT 'Random; printed inside the QR to detect forged sheets',
  status           ENUM('Open','Closed','Reconciled') NOT NULL DEFAULT 'Open',
  last_row_no      INT NOT NULL DEFAULT 0,
  print_count      INT NOT NULL DEFAULT 0,
  last_printed_at  DATETIME NULL,
  closed_by_user_id INT NULL,
  closed_at        DATETIME NULL,
  site_engineer_name VARCHAR(255) NULL COMMENT 'Month-end sign-off (paper)',
  vendor_rep_name  VARCHAR(255) NULL,
  reconciled_by_user_id INT NULL,
  reconciled_at    DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (timesheet_id),
  UNIQUE KEY uq_eqts_code (sheet_code),
  UNIQUE KEY uq_eqts_machine_site_month (equipment_id, site_id, period_month),
  KEY idx_eqts_status (status),
  CONSTRAINT fk_eqts_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqts_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqts_closed_by FOREIGN KEY (closed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqts_recon_by  FOREIGN KEY (reconciled_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. Attendance of a machine: one row per machine x site x shift x date ----
CREATE TABLE IF NOT EXISTS eq_attendance (
  eq_attendance_id INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  site_id          INT NOT NULL,
  shift_type       ENUM('Day','Night') NOT NULL DEFAULT 'Day',
  record_date      DATE NOT NULL COMMENT 'Business date of the check-in (night shift keeps the start date)',
  day_status       ENUM('Working','Standby','Breakdown','Absent','Holiday') NOT NULL DEFAULT 'Working',
  operator_id      INT NULL,
  check_in_time    DATETIME NULL,
  check_out_time   DATETIME NULL,
  meter_start      DECIMAL(10,1) NULL,
  meter_end        DECIMAL(10,1) NULL,
  gross_minutes    INT NULL COMMENT 'check_out - check_in',
  break_minutes    INT NOT NULL DEFAULT 0,
  breakdown_minutes INT NOT NULL DEFAULT 0,
  standby_minutes  INT NOT NULL DEFAULT 0,
  standby_credit_minutes INT NULL COMMENT 'Monthly machines: standby minutes paid, set by Admin/Accountant; NULL = not set',
  standby_credit_by_user_id INT NULL,
  standby_credit_at DATETIME NULL,
  standby_credit_note VARCHAR(500) NULL,
  working_minutes  INT NULL COMMENT 'Informational: gross - breaks - breakdown - standby (break policy applied at billing)',
  work_description VARCHAR(500) NULL,
  remarks          TEXT NULL,
  status           ENUM('Draft','Submitted','Approved','Rejected') NOT NULL DEFAULT 'Draft',
  recorded_by_user_id INT NOT NULL,
  submitted_by_user_id INT NULL,
  submitted_at     DATETIME NULL,
  approved_by_user_id INT NULL,
  approval_date    DATETIME NULL,
  admin_rejection_notes TEXT NULL,
  anomaly_code     VARCHAR(50) NULL,
  anomaly_detail   VARCHAR(255) NULL,
  anomaly_ack_by_user_id INT NULL,
  anomaly_ack_at   DATETIME NULL,
  anomaly_ack_note VARCHAR(500) NULL,
  timesheet_id     INT NULL,
  sheet_row_no     INT NULL COMMENT 'Permanent row number on the monthly paper sheet',
  paper_status     ENUM('Pending','Matched','Mismatch','Missing') NOT NULL DEFAULT 'Pending',
  edited_after_approval TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Changed by an Admin after approval (007)',
  admin_edit_reason VARCHAR(1000) NULL,
  admin_edit_by_user_id INT NULL,
  admin_edit_at    DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (eq_attendance_id),
  UNIQUE KEY uq_eqa_machine_site_shift_date (equipment_id, site_id, shift_type, record_date),
  UNIQUE KEY uq_eqa_sheet_row (timesheet_id, sheet_row_no),
  KEY idx_eqa_site_date (site_id, shift_type, record_date),
  KEY idx_eqa_date (record_date),
  KEY idx_eqa_status (status),
  KEY idx_eqa_paper (paper_status),
  KEY idx_eqa_open (equipment_id, check_out_time),
  CONSTRAINT fk_eqa_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqa_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqa_operator  FOREIGN KEY (operator_id) REFERENCES eq_operators (operator_id),
  CONSTRAINT fk_eqa_recorder  FOREIGN KEY (recorded_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqa_submitter FOREIGN KEY (submitted_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqa_approver  FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqa_ack_by    FOREIGN KEY (anomaly_ack_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqa_timesheet FOREIGN KEY (timesheet_id) REFERENCES eq_timesheets (timesheet_id),
  CONSTRAINT chk_eqa_times    CHECK (check_out_time IS NULL OR check_in_time IS NULL OR check_out_time > check_in_time),
  CONSTRAINT fk_eqa_credit_by FOREIGN KEY (standby_credit_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqa_credit   CHECK (standby_credit_minutes IS NULL OR standby_credit_minutes BETWEEN 0 AND 1440),
  CONSTRAINT fk_eqa_admin_edit_by FOREIGN KEY (admin_edit_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqa_meter    CHECK (meter_end IS NULL OR meter_start IS NULL OR meter_end >= meter_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. Downtime periods inside a Working day -------------------------------
CREATE TABLE IF NOT EXISTS eq_downtime_periods (
  downtime_id      INT NOT NULL AUTO_INCREMENT,
  eq_attendance_id INT NOT NULL,
  downtime_type    ENUM('Break','Breakdown','Standby','Refuel') NOT NULL COMMENT 'Refuel counts as Break',
  start_time       DATETIME NOT NULL,
  end_time         DATETIME NULL,
  reason           VARCHAR(500) NULL,
  recorded_by_user_id INT NOT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (downtime_id),
  KEY idx_eqdp_attendance (eq_attendance_id),
  CONSTRAINT fk_eqdp_attendance FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id) ON DELETE CASCADE,
  CONSTRAINT fk_eqdp_user       FOREIGN KEY (recorded_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqdp_times     CHECK (end_time IS NULL OR end_time > start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. Fuel we issue to a machine ------------------------------------------
CREATE TABLE IF NOT EXISTS eq_fuel_issues (
  fuel_issue_id    INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  site_id          INT NOT NULL,
  issue_date       DATE NOT NULL,
  liters           DECIMAL(10,2) NOT NULL,
  price_per_liter  DECIMAL(10,3) NULL COMMENT 'NULL until priced by Admin/Accountant (supervisor records litres only)',
  receipt_number   VARCHAR(100) NULL,
  receipt_path     VARCHAR(500) NULL,
  issued_by_user_id INT NOT NULL,
  is_cancelled     TINYINT(1) NOT NULL DEFAULT 0,
  cancel_reason    VARCHAR(500) NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fuel_issue_id),
  KEY idx_eqfi_equipment_date (equipment_id, issue_date),
  CONSTRAINT fk_eqfi_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqfi_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqfi_user      FOREIGN KEY (issued_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqfi_values   CHECK (liters > 0 AND (price_per_liter IS NULL OR price_per_liter >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. Manual additions / deductions (mobilization, penalty, damage, ...) --
CREATE TABLE IF NOT EXISTS eq_adjustments (
  adjustment_id    INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  site_id          INT NULL,
  adjustment_date  DATE NOT NULL COMMENT 'Decides which payroll period picks it up',
  adjustment_type  ENUM('Mobilization','Demobilization','Bonus','Penalty','Damage','FuelCorrection','Other','Correction') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL COMMENT 'Signed: + we pay more, - we pay less',
  currency         CHAR(3) NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  correction_id    INT NULL COMMENT 'Official correction settled by this adjustment (006)',
  status           ENUM('Active','Cancelled') NOT NULL DEFAULT 'Active',
  created_by_user_id INT NOT NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at     DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (adjustment_id),
  KEY idx_eqadj_equipment_date (equipment_id, adjustment_date),
  CONSTRAINT fk_eqadj_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqadj_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqadj_user      FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqadj_cancel    FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqadj_correction FOREIGN KEY (correction_id) REFERENCES eq_attendance_corrections (correction_id),
  CONSTRAINT chk_eqadj_amount   CHECK (amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. Uploaded scans of the paper sheet (immutable, versioned) ------------
CREATE TABLE IF NOT EXISTS eq_timesheet_scans (
  scan_id          INT NOT NULL AUTO_INCREMENT,
  timesheet_id     INT NOT NULL,
  version_no       INT NOT NULL,
  through_row_no   INT NULL COMMENT 'Last sheet row visible on this scan',
  storage_key      VARCHAR(500) NOT NULL COMMENT 'Private path / object key, never public',
  original_name    VARCHAR(255) NULL,
  mime_type        VARCHAR(100) NOT NULL,
  page_count       INT NOT NULL DEFAULT 1,
  size_bytes       INT NOT NULL,
  sha256           CHAR(64) NOT NULL,
  note             VARCHAR(500) NULL,
  uploaded_by_user_id INT NOT NULL,
  uploaded_at      DATETIME NOT NULL,
  PRIMARY KEY (scan_id),
  UNIQUE KEY uq_eqtss_version (timesheet_id, version_no),
  UNIQUE KEY uq_eqtss_sha (timesheet_id, sha256),
  CONSTRAINT fk_eqtss_timesheet FOREIGN KEY (timesheet_id) REFERENCES eq_timesheets (timesheet_id),
  CONSTRAINT fk_eqtss_user      FOREIGN KEY (uploaded_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 14. Row-by-row comparison of paper vs electronic (history kept) ---------
CREATE TABLE IF NOT EXISTS eq_paper_checks (
  paper_check_id   INT NOT NULL AUTO_INCREMENT,
  eq_attendance_id INT NOT NULL,
  scan_id          INT NULL,
  result           ENUM('Matched','Mismatch','Missing') NOT NULL,
  paper_check_in   DATETIME NULL,
  paper_check_out  DATETIME NULL,
  paper_meter_start DECIMAL(10,1) NULL,
  paper_meter_end  DECIMAL(10,1) NULL,
  employee_signed  TINYINT(1) NOT NULL DEFAULT 0,
  operator_signed  TINYINT(1) NOT NULL DEFAULT 0,
  diff_minutes     INT NULL,
  note             VARCHAR(500) NULL,
  is_current       TINYINT(1) NOT NULL DEFAULT 1,
  checked_by_user_id INT NOT NULL,
  checked_at       DATETIME NOT NULL,
  PRIMARY KEY (paper_check_id),
  KEY idx_eqpc_attendance (eq_attendance_id, is_current),
  CONSTRAINT fk_eqpc_attendance FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id),
  CONSTRAINT fk_eqpc_scan       FOREIGN KEY (scan_id) REFERENCES eq_timesheet_scans (scan_id),
  CONSTRAINT fk_eqpc_user       FOREIGN KEY (checked_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 15. Payroll (vendor statements) batches — Generated → finalized → Paid; Voided; Superseded
CREATE TABLE IF NOT EXISTS eq_payroll_batches (
  eq_batch_id      INT NOT NULL AUTO_INCREMENT,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  scope_vendor_id  INT NULL COMMENT 'NULL = all vendors',
  scope_equipment_id INT NULL COMMENT 'NULL = all machines in scope',
  scope_site_id    INT NULL COMMENT 'NULL = all sites',
  currency         CHAR(3) NOT NULL,
  version_number   INT NOT NULL DEFAULT 1,
  supersedes_batch_id INT NULL,
  supersede_reason VARCHAR(500) NULL,
  status           ENUM('Generated','Paid','Superseded','Voided') NOT NULL DEFAULT 'Generated',
  is_finalized     TINYINT(1) NOT NULL DEFAULT 0,
  finalized_by_user_id INT NULL,
  finalized_at     DATETIME NULL,
  paid_by_user_id  INT NULL,
  paid_at          DATETIME NULL,
  voided_by_user_id INT NULL,
  voided_at        DATETIME NULL,
  void_reason      VARCHAR(500) NULL,
  total_equipment  INT NOT NULL DEFAULT 0,
  total_gross      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deductions DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_net        DECIMAL(14,2) NOT NULL DEFAULT 0,
  generated_by_user_id INT NOT NULL,
  generated_at     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  settings_snapshot JSON NULL COMMENT 'Billing settings in force when the batch was generated (005)',
  PRIMARY KEY (eq_batch_id),
  KEY idx_eqpb_period (start_date, end_date),
  KEY idx_eqpb_status (status, is_finalized),
  CONSTRAINT fk_eqpb_vendor    FOREIGN KEY (scope_vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqpb_equipment FOREIGN KEY (scope_equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqpb_site      FOREIGN KEY (scope_site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqpb_supersedes FOREIGN KEY (supersedes_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpb_gen_by    FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqpb_fin_by    FOREIGN KEY (finalized_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqpb_paid_by   FOREIGN KEY (paid_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqpb_void_by   FOREIGN KEY (voided_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqpb_dates    CHECK (end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 16. One item per machine x site x rate card in the batch -----------------
CREATE TABLE IF NOT EXISTS eq_payroll_items (
  eq_item_id       INT NOT NULL AUTO_INCREMENT,
  eq_batch_id      INT NOT NULL,
  equipment_id     INT NOT NULL,
  vendor_id        INT NOT NULL,
  site_id          INT NOT NULL,
  rate_card_id     INT NULL COMMENT 'NULL only for an item made of adjustments/fuel alone',
  rate_snapshot    JSON NULL COMMENT 'Full copy of the rate card used',
  billing_mode     ENUM('Hourly','Daily','Monthly') NULL,
  days_recorded    INT NOT NULL DEFAULT 0,
  worked_days      INT NOT NULL DEFAULT 0,
  work_hours       DECIMAL(9,2) NOT NULL DEFAULT 0,
  overtime_hours   DECIMAL(9,2) NOT NULL DEFAULT 0,
  standby_hours    DECIMAL(9,2) NOT NULL DEFAULT 0,
  breakdown_hours  DECIMAL(9,2) NOT NULL DEFAULT 0,
  topup_hours      DECIMAL(9,2) NOT NULL DEFAULT 0,
  gross_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  deductions_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (eq_item_id),
  KEY idx_eqpi_batch (eq_batch_id),
  KEY idx_eqpi_equipment (equipment_id),
  KEY idx_eqpi_vendor (vendor_id),
  CONSTRAINT fk_eqpi_batch     FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpi_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqpi_vendor    FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqpi_site      FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqpi_rate      FOREIGN KEY (rate_card_id) REFERENCES eq_rate_cards (rate_card_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 17. Statement lines (what is printed on the vendor statement) ------------
CREATE TABLE IF NOT EXISTS eq_payroll_lines (
  eq_line_id       BIGINT NOT NULL AUTO_INCREMENT,
  eq_item_id       INT NOT NULL,
  line_type        ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference','HoursShortfall','SecondShift') NOT NULL,
  quantity         DECIMAL(12,4) NOT NULL,
  unit             ENUM('h','day','month','L','item') NOT NULL,
  unit_price       DECIMAL(12,3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL COMMENT 'Signed',
  source_table     ENUM('eq_fuel_issues','eq_adjustments','eq_fuel_terms') NULL,
  source_id        INT NULL,
  note             VARCHAR(500) NULL,
  PRIMARY KEY (eq_line_id),
  KEY idx_eqpl_item (eq_item_id),
  KEY idx_eqpl_source (source_table, source_id),
  CONSTRAINT fk_eqpl_item FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 18. Exact attendance rows used by each item (exports never read live data)
CREATE TABLE IF NOT EXISTS eq_payroll_attendance_snapshot (
  snapshot_id      BIGINT NOT NULL AUTO_INCREMENT,
  eq_batch_id      INT NOT NULL,
  eq_item_id       INT NOT NULL,
  eq_attendance_id INT NOT NULL,
  record_date      DATE NOT NULL,
  day_status       ENUM('Working','Standby','Breakdown','Absent','Holiday') NOT NULL,
  check_in_time    DATETIME NULL,
  check_out_time   DATETIME NULL,
  operator_name    VARCHAR(255) NULL,
  work_minutes     INT NOT NULL DEFAULT 0,
  overtime_minutes INT NOT NULL DEFAULT 0,
  standby_minutes  INT NOT NULL DEFAULT 0,
  standby_credit_minutes INT NULL,
  breakdown_minutes INT NOT NULL DEFAULT 0,
  break_minutes    INT NOT NULL DEFAULT 0,
  topup_minutes    INT NOT NULL DEFAULT 0,
  meter_start      DECIMAL(10,1) NULL,
  meter_end        DECIMAL(10,1) NULL,
  sheet_row_no     INT NULL,
  paper_status     ENUM('Pending','Matched','Mismatch','Missing') NOT NULL,
  calc_detail      JSON NULL COMMENT 'regular_allow, block_shifts, day_used_before (008)',
  PRIMARY KEY (snapshot_id),
  UNIQUE KEY uq_eqpas_batch_att (eq_batch_id, eq_attendance_id),
  KEY idx_eqpas_item (eq_item_id),
  KEY idx_eqpas_att (eq_attendance_id),
  CONSTRAINT fk_eqpas_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpas_item  FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id),
  CONSTRAINT fk_eqpas_att   FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 19. Corrections of rows inside a FINALIZED payroll period (never edits the payroll)
CREATE TABLE IF NOT EXISTS eq_attendance_corrections (
  correction_id    INT NOT NULL AUTO_INCREMENT,
  eq_attendance_id INT NOT NULL,
  original_values  JSON NOT NULL,
  corrected_values JSON NOT NULL,
  proposed_changes JSON NULL COMMENT 'Changes requested / reviewed (006)',
  reason           VARCHAR(1000) NOT NULL,
  request_status   ENUM('Requested','Reviewed','Approved','Cancelled') NOT NULL DEFAULT 'Approved',
  locked_batch_id  INT NULL COMMENT 'Finalized/Paid batch covering the row when corrected',
  payroll_effect   ENUM('None','AdjustmentRequired') NOT NULL DEFAULT 'None',
  adjustment_status ENUM('NotApplicable','Open','Resolved') NOT NULL DEFAULT 'NotApplicable',
  resolved_adjustment_id INT NULL COMMENT 'eq_adjustments row that settled it',
  resolution_note  VARCHAR(1000) NULL,
  corrected_by_user_id INT NOT NULL,
  corrected_at     DATETIME NOT NULL,
  resolved_by_user_id INT NULL,
  resolved_at      DATETIME NULL,
  delta_amount     DECIMAL(14,2) NULL COMMENT 'Signed: + we pay the vendor more (computed at the batch prices)',
  delta_detail     JSON NULL,
  currency         CHAR(3) NULL,
  amount_override  DECIMAL(14,2) NULL COMMENT 'Set by the accountant when the amount is not the computed one',
  override_reason  VARCHAR(1000) NULL,
  reviewed_by_user_id INT NULL,
  reviewed_at      DATETIME NULL,
  review_note      VARCHAR(1000) NULL,
  return_count     INT NOT NULL DEFAULT 0,
  approved_by_user_id INT NULL,
  approved_at      DATETIME NULL,
  note_invoice_id  INT NULL COMMENT 'Debit / credit note issued on approval',
  PRIMARY KEY (correction_id),
  KEY idx_eqac_row (eq_attendance_id),
  KEY idx_eqac_status (adjustment_status),
  KEY idx_eqac_request (request_status),
  CONSTRAINT fk_eqac_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqac_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqac_note FOREIGN KEY (note_invoice_id) REFERENCES eq_invoices (invoice_id),
  CONSTRAINT fk_eqac_row FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id),
  CONSTRAINT fk_eqac_batch FOREIGN KEY (locked_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqac_adj FOREIGN KEY (resolved_adjustment_id) REFERENCES eq_adjustments (adjustment_id),
  CONSTRAINT fk_eqac_by FOREIGN KEY (corrected_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqac_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- =====================================================================
-- E. Added by migration 001 (fuel price difference + official invoices)
-- =====================================================================

-- 20. National fuel price list (effective-dated per currency)
CREATE TABLE IF NOT EXISTS eq_fuel_prices (
  fuel_price_id    INT NOT NULL AUTO_INCREMENT,
  currency         CHAR(3) NOT NULL,
  effective_from   DATE NOT NULL,
  price_per_liter  DECIMAL(12,3) NOT NULL,
  note             VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fuel_price_id),
  UNIQUE KEY uq_eqfp_cur_from (currency, effective_from),
  CONSTRAINT fk_eqfp_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 21. Fuel price-difference terms per machine (effective-dated)
CREATE TABLE IF NOT EXISTS eq_fuel_terms (
  fuel_terms_id    INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL,
  base_price_per_liter DECIMAL(12,3) NOT NULL COMMENT 'Fuel price agreed when the machine joined the project',
  liters_per_hour  DECIMAL(8,3) NOT NULL COMMENT 'Approximate consumption per working hour',
  note             VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fuel_terms_id),
  KEY idx_eqft_equipment (equipment_id, effective_from),
  CONSTRAINT fk_eqft_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqft_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 22. Official invoice number sequences (per kind + year)
CREATE TABLE IF NOT EXISTS eq_invoice_counters (
  kind             ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote') NOT NULL,
  year             SMALLINT NOT NULL,
  last_seq         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 23. Official invoices issued at batch finalize
CREATE TABLE IF NOT EXISTS eq_invoices (
  invoice_id       INT NOT NULL AUTO_INCREMENT,
  invoice_no       VARCHAR(30) NOT NULL,
  kind             ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote') NOT NULL,
  year             SMALLINT NOT NULL,
  seq              INT NOT NULL,
  eq_batch_id      INT NOT NULL,
  vendor_id        INT NOT NULL,
  equipment_id     INT NULL,
  eq_item_id       INT NULL,
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  issued_at        DATETIME NOT NULL,
  PRIMARY KEY (invoice_id),
  UNIQUE KEY uq_eqinv_no (invoice_no),
  UNIQUE KEY uq_eqinv_kind_seq (kind, year, seq),
  KEY idx_eqinv_batch (eq_batch_id),
  CONSTRAINT fk_eqinv_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqinv_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqinv_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqinv_item FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- F. Edit / lock policy (migrations 005, 006, 009)
-- =====================================================================

-- 25. Numbers of a voided / superseded finalized batch: kept, marked cancelled (005)
CREATE TABLE IF NOT EXISTS eq_invoice_cancellations (
  invoice_id       INT NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at     DATETIME NOT NULL,
  PRIMARY KEY (invoice_id),
  CONSTRAINT fk_eqic_invoice FOREIGN KEY (invoice_id) REFERENCES eq_invoices (invoice_id),
  CONSTRAINT fk_eqic_user FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 26. Every step of an official correction, in order (006)
CREATE TABLE IF NOT EXISTS eq_correction_events (
  event_id         INT NOT NULL AUTO_INCREMENT,
  correction_id    INT NOT NULL,
  action           ENUM('request','review','return','approve','cancel') NOT NULL,
  note             VARCHAR(1000) NULL,
  data             JSON NULL,
  user_id          INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (event_id),
  KEY idx_eqce_correction (correction_id, event_id),
  CONSTRAINT fk_eqce_correction FOREIGN KEY (correction_id) REFERENCES eq_attendance_corrections (correction_id),
  CONSTRAINT fk_eqce_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 27. Versions of fuel receipts and contract documents (009)
CREATE TABLE IF NOT EXISTS eq_file_versions (
  file_version_id  INT NOT NULL AUTO_INCREMENT,
  owner_table      ENUM('eq_fuel_issues','eq_vendor_contracts') NOT NULL,
  owner_id         INT NOT NULL,
  version_no       INT NOT NULL,
  storage_key      VARCHAR(500) NOT NULL,
  sha256           CHAR(64) NULL,
  content_type     VARCHAR(100) NULL,
  size_bytes       INT NULL,
  original_name    VARCHAR(255) NULL,
  reason           VARCHAR(500) NULL COMMENT 'Why a previous version was replaced',
  uploaded_by_user_id INT NULL,
  uploaded_at      DATETIME NOT NULL,
  PRIMARY KEY (file_version_id),
  UNIQUE KEY uq_eqfv_owner_version (owner_table, owner_id, version_no),
  CONSTRAINT fk_eqfv_user FOREIGN KEY (uploaded_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 24. Migration bookkeeping (created by database/applyMigrations.js)
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename         VARCHAR(255) NOT NULL PRIMARY KEY,
  applied_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- settings added by migrations 001–008 (seed.sql has the original ones)
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('eq_finalize_requires_scan', 'true'), ('payroll_finalize_admin_only', 'true'), ('eq_fuel_diff_allow_negative', 'true'),
  ('eq_weekly_off_day', '5'), ('eq_shift_continuity_minutes', '30');

SET FOREIGN_KEY_CHECKS = 1;
```

## 5.2 `database/seed.sql`

```sql
-- database/seed.sql (idempotent). The first Admin user is created by scripts/createAdmin.js (bcrypt), not here.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('eq_payroll_requires_paper_match', 'false'),  -- true = payroll only takes rows whose paper_status = Matched
  ('eq_paper_tolerance_minutes',      '10'),     -- paper vs electronic time difference still "Matched"
  ('eq_meter_tolerance_pct',          '15'),     -- meter delta vs working hours: above -> anomaly
  ('eq_long_session_review_hours',    '16'),     -- open/long session -> anomaly (warning only)
  ('eq_default_currency',             'USD'),
  ('eq_timesheet_blank_rows',         '6'),      -- empty rows printed under the recorded rows
  ('eq_live_refresh_seconds',         '60'),
  ('week_start_day',                  '6'),      -- 0=Sun..6=Sat; week used by the submit gate
  ('week_gate_enabled',               'true'),   -- a day cannot be submitted while last week has Drafts
  ('company_name',                    'ASIK ENGINEERING CONSTRUCTION'),
  ('app_time_zone',                   'Asia/Beirut');

INSERT IGNORE INTO eq_types (type_name, type_name_ar, meter_unit) VALUES
  ('Excavator', 'حفارة', 'Hours'), ('Wheel Loader', 'تركس', 'Hours'), ('Bulldozer', 'بلدوزر', 'Hours'),
  ('Mobile Crane', 'رافعة متحركة', 'Hours'), ('Tower Crane', 'رافعة برجية', 'Hours'),
  ('Dump Truck', 'قلاب', 'Km'), ('Roller', 'مدحلة', 'Hours'), ('Grader', 'جريدر', 'Hours'),
  ('Backhoe Loader', 'باكر', 'Hours'), ('Concrete Pump', 'مضخة باطون', 'Hours'),
  ('Generator', 'مولدة', 'Hours'), ('Forklift', 'رافعة شوكية', 'Hours'), ('Water Tanker', 'صهريج مياه', 'Km');
```

## 5.3 `database/rollback_drop_all.sql` (development only)

```sql
-- database/rollback_drop_all.sql — DEV ONLY: drops every table of the system.
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS eq_attendance_corrections, eq_payroll_attendance_snapshot, eq_payroll_lines, eq_payroll_items,
  eq_payroll_batches, eq_paper_checks, eq_timesheet_scans, eq_adjustments, eq_fuel_issues, eq_downtime_periods,
  eq_attendance, eq_timesheets, eq_site_assignments, eq_rate_cards, eq_operators, eq_equipment, eq_types,
  eq_vendor_contracts, eq_vendors, audit_logs, settings, site_supervisors, sites, login_history, users,
  eq_invoices, eq_invoice_counters, eq_fuel_terms, eq_fuel_prices, eq_invoice_cancellations, eq_correction_events,
  eq_file_versions, schema_migrations;
SET FOREIGN_KEY_CHECKS = 1;
```

# 6. Test database

`tests/helpers.js → resetDatabase()` drops and recreates `equipment_flow_test`, applies `schema.sql` then `seed.sql`, inserts fixtures (1 Admin, 1 Accountant, 2 Supervisors, 3 sites with supervisors), and returns JWTs for each role. The test run refuses to start if `DB_NAME` does not end with `_test`.

# 7. Database rights (append-only tables)

`npm run harden-db` (`scripts/hardenDb.js`, run once with a MySQL account that can create users):

| Account | Rights | Used by |
|---|---|---|
| `DB_MIGRATE_USER` | ALL on `equipment_flow.*` WITH GRANT OPTION | `npm run migrate` (it re-applies the app rights to new tables after each run) |
| `DB_USER` (app) | SELECT, INSERT, UPDATE, DELETE on each table | the backend |
| `DB_USER` (app) on append-only tables | **SELECT, INSERT only** | `audit_logs`, `login_history`, `eq_invoices`, `eq_invoice_cancellations`, `eq_correction_events`, `eq_file_versions`, `eq_payroll_items`, `eq_payroll_lines`, `eq_payroll_attendance_snapshot` |

```bash
DB_ROOT_USER=root DB_ROOT_PASSWORD=*** DB_MIGRATE_USER=equipment_flow_migrator DB_MIGRATE_PASSWORD=*** npm run harden-db
# then keep DB_MIGRATE_USER / DB_MIGRATE_PASSWORD in .env for npm run migrate
```

The list lives in `database/grants.js` (`APPEND_ONLY`). After hardening, `database/reset_data.sql` must be run with the migration or root account (the app user cannot empty append-only tables).


## 5.5 Migration 012 — correction policy (6 Oct 2026)

Additive only (no data deleted or rewritten; rollback script in `database/migrations/rollback/012_correction_policy.down.sql`):

| Table | Change |
|---|---|
| `eq_attendance` | status `Cancelled`; `cancelled_by_user_id`, `cancelled_at`, `cancel_reason`; `late_entry`, `late_entry_days`, `late_entry_reason`; generated `live_slot` (NULL when Cancelled) with unique key `uq_eqa_live_slot (equipment_id, site_id, shift_type, record_date, live_slot)` replacing `uq_eqa_machine_site_shift_date` (one live row per slot, cancelled rows kept beside it) |
| `eq_attendance_change_requests` | new: supervisor change requests (Pending / Applied / Rejected / Withdrawn) |
| `eq_attendance_corrections` | `eq_attendance_id` nullable; `target_type`, `target_id`, `eq_item_id` (official corrections of non-attendance money) |
| `eq_correction_events` | action `amend` |
| `eq_payroll_batches` | `payment_reference`, `paid_marked_at` (undo window starts here), `paid_undo_count`, `accept_blockers_reason` |
| `audit_logs` | `changed_fields` (`{field: [old, new]}`), `related_type`, `related_id`, `payroll_effect`, `source` |
| `settings` | `eq_paid_undo_hours` = 168, `eq_late_entry_days` = 3 (`INSERT IGNORE`) |

The stored generated column rebuilds `eq_attendance`: run it in a maintenance window after a backup.

## 5.6 Migration 013 — DNR (delivery notes) and partial payments (7 Oct 2026)

Additive only (rollback script in `database/migrations/rollback/013_dnr_and_partial_payments.down.sql`):

| Table | Change |
|---|---|
| `eq_dnr_rates` | new: per-unit prices (unit `trip` / `t` / `m3` / `km` / `pc` / `load`) of an EXISTING vendor, under one of its contracts (currency), effective-dated; `equipment_id` NULL = every machine of the vendor. Independent of `eq_rate_cards`: a machine may have both. |
| `eq_delivery_notes` | new: one row per paper delivery note (number unique per vendor among live notes, generated `live_slot`), machine, site, date, quantity; `unit_price` and `currency` copied from the DNR price when saved |
| `eq_payroll_items` | `billing_mode` + `DNR` (one item per machine x site x currency, `rate_card_id` NULL, snapshot of the notes in `rate_snapshot.delivery_notes`) |
| `eq_payroll_lines` | `line_type` + `DeliveryNote`; `unit` + `trip`, `t`, `m3`, `km`, `pc`, `load`; `source_table` + `eq_delivery_notes` (a note is paid once) |
| `eq_invoice_counters` | kind + `PaymentVoucher` (`PV-YYYY-00001`) |
| `eq_payments` | new: payments of a vendor invoice (partial or full), official voucher number, balance before / after frozen for printing, `source` Payment / MarkPaid, reversal kept (status `Reversed`) |
| `eq_payment_carryovers` | new: unpaid balance of an older finalized batch moved into a newer batch ("Add previous balances"); `Released` when the newer batch is voided |

Rules: the vendor invoice never changes; balance = invoice + carried in − payments − carried out; no payment above the balance; the batch becomes `Paid` by itself when every vendor balance is 0 and nothing was carried out; a batch with payments or a carried-out balance cannot be voided or replaced. Batches marked paid before 013 (status `Paid`, no payment row) are treated as fully paid.
