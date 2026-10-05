-- database/reset_data.sql — wipes ALL business data of equipment_asik and keeps:
--   the tables, the settings, the machine types, the Admin users, and the applied migrations.
-- Run it on the equipment_asik database ONLY (DBeaver: select the database first).
-- After it: restart the backend (npm run dev) so the settings cache is fresh.

USE equipment_asik;
SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE eq_invoices;
TRUNCATE TABLE eq_invoice_counters;
TRUNCATE TABLE eq_payroll_attendance_snapshot;
TRUNCATE TABLE eq_payroll_lines;
TRUNCATE TABLE eq_payroll_items;
TRUNCATE TABLE eq_payroll_batches;
TRUNCATE TABLE eq_attendance_corrections;
TRUNCATE TABLE eq_paper_checks;
TRUNCATE TABLE eq_timesheet_scans;
TRUNCATE TABLE eq_downtime_periods;
TRUNCATE TABLE eq_attendance;
TRUNCATE TABLE eq_timesheets;
TRUNCATE TABLE eq_fuel_issues;
TRUNCATE TABLE eq_adjustments;
TRUNCATE TABLE eq_fuel_terms;
TRUNCATE TABLE eq_fuel_prices;
TRUNCATE TABLE eq_site_assignments;
TRUNCATE TABLE eq_rate_cards;
TRUNCATE TABLE eq_operators;
TRUNCATE TABLE eq_equipment;
TRUNCATE TABLE eq_vendor_contracts;
TRUNCATE TABLE eq_vendors;
TRUNCATE TABLE site_supervisors;
TRUNCATE TABLE sites;
TRUNCATE TABLE audit_logs;
TRUNCATE TABLE login_history;
DELETE FROM users WHERE role <> 'Admin';
UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE role = 'Admin';
UPDATE settings SET updated_by_user_id = NULL;

SET FOREIGN_KEY_CHECKS = 1;

SELECT 'done' AS result,
  (SELECT COUNT(*) FROM users) AS users_left,
  (SELECT COUNT(*) FROM eq_types) AS machine_types,
  (SELECT COUNT(*) FROM settings) AS settings;
