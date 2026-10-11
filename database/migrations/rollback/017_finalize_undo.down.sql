-- Rollback of 017_finalize_undo.sql
-- A Withdrawn number has no batch that stands behind it: mark it cancelled before the column goes.
INSERT IGNORE INTO eq_invoice_cancellations (invoice_id, reason, cancelled_by_user_id, cancelled_at)
  SELECT i.invoice_id, 'Rollback of 017: number was withdrawn', b.generated_by_user_id, NOW()
  FROM eq_invoices i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id WHERE i.status = 'Withdrawn';
DELETE FROM eq_batch_requests WHERE action = 'unfinalize';
ALTER TABLE eq_batch_requests MODIFY action ENUM('void','supersede') NOT NULL;
ALTER TABLE eq_invoices DROP COLUMN reissued_at, DROP COLUMN status;
ALTER TABLE eq_payroll_batches DROP COLUMN finalize_undo_count;
DELETE FROM settings WHERE setting_key = 'eq_finalize_undo_hours';
DELETE FROM schema_migrations WHERE filename = '017_finalize_undo.sql';
