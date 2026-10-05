-- =====================================================================
-- Equipment Flow — database/schema.sql   (STANDALONE system, own database)
-- MySQL 8.0+ (also runs on MariaDB 10.6+ for local tests).
-- Idempotent: CREATE TABLE IF NOT EXISTS everywhere. Run on an EMPTY database:
--   CREATE DATABASE equipment_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   mysql equipment_flow < database/schema.sql && mysql equipment_flow < database/seed.sql
-- Conventions: InnoDB, utf8mb4, INT ids, DATE = business date (Asia/Beirut),
-- DATETIME = wall-clock business time, all date ranges INCLUSIVE on both ends.
-- =====================================================================

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
  adjustment_type  ENUM('Mobilization','Demobilization','Bonus','Penalty','Damage','FuelCorrection','Other') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL COMMENT 'Signed: + we pay more, - we pay less',
  currency         CHAR(3) NOT NULL,
  reason           VARCHAR(500) NOT NULL,
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
  line_type        ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment') NOT NULL,
  quantity         DECIMAL(12,4) NOT NULL,
  unit             ENUM('h','day','month','L','item') NOT NULL,
  unit_price       DECIMAL(12,3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL COMMENT 'Signed',
  source_table     ENUM('eq_fuel_issues','eq_adjustments') NULL,
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
  breakdown_minutes INT NOT NULL DEFAULT 0,
  break_minutes    INT NOT NULL DEFAULT 0,
  topup_minutes    INT NOT NULL DEFAULT 0,
  meter_start      DECIMAL(10,1) NULL,
  meter_end        DECIMAL(10,1) NULL,
  sheet_row_no     INT NULL,
  paper_status     ENUM('Pending','Matched','Mismatch','Missing') NOT NULL,
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
  reason           VARCHAR(1000) NOT NULL,
  locked_batch_id  INT NULL COMMENT 'Finalized/Paid batch covering the row when corrected',
  payroll_effect   ENUM('None','AdjustmentRequired') NOT NULL DEFAULT 'None',
  adjustment_status ENUM('NotApplicable','Open','Resolved') NOT NULL DEFAULT 'NotApplicable',
  resolved_adjustment_id INT NULL COMMENT 'eq_adjustments row that settled it',
  resolution_note  VARCHAR(1000) NULL,
  corrected_by_user_id INT NOT NULL,
  corrected_at     DATETIME NOT NULL,
  resolved_by_user_id INT NULL,
  resolved_at      DATETIME NULL,
  PRIMARY KEY (correction_id),
  KEY idx_eqac_row (eq_attendance_id),
  KEY idx_eqac_status (adjustment_status),
  CONSTRAINT fk_eqac_row FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id),
  CONSTRAINT fk_eqac_batch FOREIGN KEY (locked_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqac_adj FOREIGN KEY (resolved_adjustment_id) REFERENCES eq_adjustments (adjustment_id),
  CONSTRAINT fk_eqac_by FOREIGN KEY (corrected_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqac_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
