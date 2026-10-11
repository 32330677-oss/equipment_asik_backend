-- Rollback of 019_billing_units.sql
-- Warning: batches made for machines chosen by hand keep scope_equipment_id = NULL; after the rollback they look like
-- whole-vendor batches. Check SELECT DISTINCT eq_batch_id FROM eq_payroll_batch_machines before running it.
DROP TABLE IF EXISTS eq_payroll_monthly_days;
DROP TABLE IF EXISTS eq_payroll_batch_machines;
DELETE FROM schema_migrations WHERE filename = '019_billing_units.sql';
