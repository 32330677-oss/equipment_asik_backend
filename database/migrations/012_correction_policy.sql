-- 012: edit / correction policy, phase 6 (audit of 6 Oct 2026 + decisions of the same day).
-- Additive only: no data is deleted or rewritten. Rollback: database/migrations/rollback/012_correction_policy.down.sql

-- 1. Attendance: a row that should not exist is CANCELLED (kept, never deleted once sent), and late entries are flagged.
ALTER TABLE eq_attendance
  MODIFY status ENUM('Draft','Submitted','Approved','Rejected','Cancelled') NOT NULL DEFAULT 'Draft',
  ADD COLUMN cancelled_by_user_id INT NULL AFTER admin_edit_at,
  ADD COLUMN cancelled_at DATETIME NULL AFTER cancelled_by_user_id,
  ADD COLUMN cancel_reason VARCHAR(1000) NULL AFTER cancelled_at,
  ADD COLUMN late_entry TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Created more than eq_late_entry_days after its business date (warning only)' AFTER cancel_reason,
  ADD COLUMN late_entry_days INT NULL AFTER late_entry,
  ADD COLUMN late_entry_reason VARCHAR(1000) NULL AFTER late_entry_days,
  ADD CONSTRAINT fk_eqa_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id);

-- One LIVE row per machine x site x shift x date; cancelled rows stay beside it (NULL never collides in a unique key).
ALTER TABLE eq_attendance
  ADD COLUMN live_slot TINYINT AS (IF(status = 'Cancelled', NULL, 1)) STORED COMMENT 'NULL for cancelled rows' AFTER late_entry_reason;
ALTER TABLE eq_attendance
  ADD UNIQUE KEY uq_eqa_live_slot (equipment_id, site_id, shift_type, record_date, live_slot);
ALTER TABLE eq_attendance
  DROP INDEX uq_eqa_machine_site_shift_date;

-- 2. Change requests: a supervisor proposes a change the office (Admin or Accountant) approves.
--    Used for an Approved row, and for a historical row the current supervisor may not edit directly.
CREATE TABLE IF NOT EXISTS eq_attendance_change_requests (
  change_request_id INT NOT NULL AUTO_INCREMENT,
  eq_attendance_id INT NOT NULL,
  proposed_changes JSON NOT NULL,
  reason           VARCHAR(1000) NOT NULL,
  status           ENUM('Pending','Applied','Rejected','Withdrawn') NOT NULL DEFAULT 'Pending',
  requested_by_user_id INT NOT NULL,
  requested_at     DATETIME NOT NULL,
  decided_by_user_id INT NULL,
  decided_at       DATETIME NULL,
  decision_note    VARCHAR(1000) NULL,
  PRIMARY KEY (change_request_id),
  KEY idx_eqcr_row (eq_attendance_id, status),
  KEY idx_eqcr_status (status),
  CONSTRAINT fk_eqcr_row FOREIGN KEY (eq_attendance_id) REFERENCES eq_attendance (eq_attendance_id),
  CONSTRAINT fk_eqcr_req_by FOREIGN KEY (requested_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqcr_dec_by FOREIGN KEY (decided_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Official corrections also cover money that is not an attendance row (fuel, prices, adjustments, deployments).
ALTER TABLE eq_attendance_corrections
  MODIFY eq_attendance_id INT NULL,
  ADD COLUMN target_type ENUM('attendance','fuel_issue','rate_card','fuel_price','fuel_terms','adjustment','deployment','other') NOT NULL DEFAULT 'attendance' AFTER eq_attendance_id,
  ADD COLUMN target_id INT NULL COMMENT 'Record corrected (fuel issue, rate card, ...) when not an attendance row' AFTER target_type,
  ADD COLUMN eq_item_id INT NULL COMMENT 'Finalized payroll item corrected' AFTER target_id,
  ADD KEY idx_eqac_target (target_type, target_id),
  ADD CONSTRAINT fk_eqac_item FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id);
ALTER TABLE eq_correction_events
  MODIFY action ENUM('request','review','return','approve','cancel','amend') NOT NULL;

-- 4. Payment: reference, the time it was MARKED (the undo window counts from it), and the reason for accepted blockers.
ALTER TABLE eq_payroll_batches
  ADD COLUMN payment_reference VARCHAR(100) NULL AFTER paid_at,
  ADD COLUMN paid_marked_at DATETIME NULL COMMENT 'When Mark Paid was done (paid_at is the date the user gave)' AFTER payment_reference,
  ADD COLUMN paid_undo_count INT NOT NULL DEFAULT 0 AFTER paid_marked_at,
  ADD COLUMN accept_blockers_reason VARCHAR(500) NULL AFTER supersede_reason;

-- 5. Audit trail: field-level changes and context.
ALTER TABLE audit_logs
  ADD COLUMN changed_fields JSON NULL COMMENT '{field: [old, new]} for the fields that changed' AFTER new_values,
  ADD COLUMN related_type VARCHAR(40) NULL AFTER reason,
  ADD COLUMN related_id BIGINT NULL AFTER related_type,
  ADD COLUMN payroll_effect VARCHAR(120) NULL COMMENT 'none | stale:<batch> | correction:<id> | adjustment:<id> ...' AFTER related_id,
  ADD COLUMN source VARCHAR(20) NULL COMMENT 'app | script | migration' AFTER payroll_effect;

-- 6. Settings (defaults; the Admin can change them).
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('eq_paid_undo_hours', '168', 'Hours during which an Admin may undo Mark Paid (no payment reference, reason required)'),
  ('eq_late_entry_days', '3', 'A row created more than this many days after its date is flagged as a late entry (warning, reason asked)');
