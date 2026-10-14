-- Rollback of 022_invoice_lifecycle.sql — only while no invoice was handed over / withdrawn and no note exists.
-- The payments, carried balances and opening balances tables come back EMPTY (re-run 013 / 014 parts by hand if needed):
-- restore the old code (13/10 ver1) together with this rollback.
DROP TABLE IF EXISTS eq_withdrawals;
DROP TABLE IF EXISTS eq_handover_items;
DROP TABLE IF EXISTS eq_handovers;
DROP TABLE IF EXISTS eq_notes;
DROP TABLE IF EXISTS eq_invoice_coverage;
UPDATE eq_payroll_batches SET status = 'Generated' WHERE status IN ('HandedOver', 'Returned');
UPDATE eq_payroll_batches SET status = 'Voided' WHERE status = 'Replaced';
ALTER TABLE eq_payroll_batches
  DROP COLUMN replaced_by_batch_id, DROP COLUMN withdrawal_id, DROP COLUMN returned_at, DROP COLUMN handover_id, DROP COLUMN handed_over_at,
  MODIFY status ENUM('Generated','Paid','Superseded','Voided') NOT NULL DEFAULT 'Generated';
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('eq_paid_undo_hours', '168', 'Hours during which an Admin may undo Mark Paid'),
  ('eq_finalize_undo_hours', '72', 'Hours after Finalize during which the batch can go back to a draft');
DELETE FROM schema_migrations WHERE filename = '022_invoice_lifecycle.sql';
