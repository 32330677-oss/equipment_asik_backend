-- Manual rollback of 012_correction_policy.sql. NOT applied automatically: run it by hand, with the migration user, after a
-- full backup, and only together with the application code from BEFORE 012 (the 012 code needs these columns).
-- This script does NOT check anything by itself. Run the pre-flight queries below first.
--
-- PRE-FLIGHT (each must be 0, otherwise a statement below FAILS in strict mode or data is LOST):
--   SELECT COUNT(*) FROM eq_attendance WHERE status = 'Cancelled';
--       -> the status ENUM change fails, and re-adding the old unique key fails when a cancelled row shares its slot with a live row.
--          Cancelled rows (and their cancel reason / who / when) have no place in the old schema: export them, then decide row by row.
--   SELECT COUNT(*) FROM eq_attendance_corrections WHERE eq_attendance_id IS NULL;
--       -> official corrections of non-attendance money (fuel, rate card, other): making eq_attendance_id NOT NULL fails. Export them.
--   SELECT COUNT(*) FROM eq_correction_events WHERE action = 'amend';
--       -> the action ENUM change fails. Export them.
--
-- INFORMATION LOST even when the pre-flight counts are 0 (export first if it matters):
--   * eq_attendance_change_requests: the whole table is dropped (supervisor requests, decisions, notes).
--   * eq_attendance: late_entry / late_entry_days / late_entry_reason flags.
--   * eq_attendance_corrections: target_type / target_id / eq_item_id.
--   * eq_payroll_batches: payment_reference, paid_marked_at, paid_undo_count, accept_blockers_reason.
--   * audit_logs: changed_fields, related_type, related_id, payroll_effect, source (old_values / new_values / reason stay).
--   * settings eq_paid_undo_hours and eq_late_entry_days, including any value the Admin changed.
-- No business row (attendance, fuel, adjustment, payroll, invoice) is deleted by this script.

ALTER TABLE eq_attendance ADD UNIQUE KEY uq_eqa_machine_site_shift_date (equipment_id, site_id, shift_type, record_date);
ALTER TABLE eq_attendance DROP INDEX uq_eqa_live_slot;
ALTER TABLE eq_attendance DROP COLUMN live_slot;
ALTER TABLE eq_attendance
  DROP FOREIGN KEY fk_eqa_cancelled_by,
  DROP COLUMN cancelled_by_user_id, DROP COLUMN cancelled_at, DROP COLUMN cancel_reason,
  DROP COLUMN late_entry, DROP COLUMN late_entry_days, DROP COLUMN late_entry_reason,
  MODIFY status ENUM('Draft','Submitted','Approved','Rejected') NOT NULL DEFAULT 'Draft';

DROP TABLE IF EXISTS eq_attendance_change_requests;

ALTER TABLE eq_attendance_corrections
  DROP FOREIGN KEY fk_eqac_item, DROP KEY idx_eqac_target,
  DROP COLUMN eq_item_id, DROP COLUMN target_id, DROP COLUMN target_type,
  MODIFY eq_attendance_id INT NOT NULL;
ALTER TABLE eq_correction_events MODIFY action ENUM('request','review','return','approve','cancel') NOT NULL;

ALTER TABLE eq_payroll_batches
  DROP COLUMN payment_reference, DROP COLUMN paid_marked_at, DROP COLUMN paid_undo_count, DROP COLUMN accept_blockers_reason;

ALTER TABLE audit_logs
  DROP COLUMN changed_fields, DROP COLUMN related_type, DROP COLUMN related_id, DROP COLUMN payroll_effect, DROP COLUMN source;

DELETE FROM settings WHERE setting_key IN ('eq_paid_undo_hours', 'eq_late_entry_days');
DELETE FROM schema_migrations WHERE filename = '012_correction_policy.sql';
