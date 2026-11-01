-- Rollback of 027_coverage_currency.sql (invoices made after it block every currency again).
ALTER TABLE eq_invoice_coverage DROP COLUMN currency;
DELETE FROM schema_migrations WHERE filename = '027_coverage_currency.sql';
