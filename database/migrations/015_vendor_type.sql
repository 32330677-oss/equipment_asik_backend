-- 015: a vendor is a company OR an individual (one person renting us a machine, no company).
-- Additive only: every existing vendor becomes 'Company' (as before) and keeps all its data; national_id starts empty.
-- Rollback: database/migrations/rollback/015_vendor_type.down.sql
ALTER TABLE eq_vendors
  ADD COLUMN vendor_type ENUM('Company','Individual') NOT NULL DEFAULT 'Company' COMMENT 'Individual = a person, printed with the national ID' AFTER vendor_name,
  ADD COLUMN national_id VARCHAR(100) NULL COMMENT 'ID card number of an Individual vendor (printed on vouchers and invoices)' AFTER tax_number;
