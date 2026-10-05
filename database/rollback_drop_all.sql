-- database/rollback_drop_all.sql — DEV ONLY: drops every table of the system.
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS eq_attendance_corrections, eq_payroll_attendance_snapshot, eq_payroll_lines, eq_payroll_items,
  eq_payroll_batches, eq_paper_checks, eq_timesheet_scans, eq_adjustments, eq_fuel_issues, eq_downtime_periods,
  eq_attendance, eq_timesheets, eq_site_assignments, eq_rate_cards, eq_operators, eq_equipment, eq_types,
  eq_vendor_contracts, eq_vendors, audit_logs, settings, site_supervisors, sites, login_history, users,
  eq_invoices, eq_invoice_counters, eq_fuel_terms, eq_fuel_prices, schema_migrations;
SET FOREIGN_KEY_CHECKS = 1;
