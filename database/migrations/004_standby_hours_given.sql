-- 004: monthly machines — the standby % is replaced by the hours GIVEN per row by the Admin/Accountant
--      (at most the hours per day of the rate card). NULL = not decided yet (blocks payroll for monthly machines).
ALTER TABLE eq_attendance
  ADD COLUMN standby_credit_minutes INT NULL COMMENT 'Monthly machines: standby minutes paid, set by Admin/Accountant; NULL = not set' AFTER standby_minutes,
  ADD COLUMN standby_credit_by_user_id INT NULL AFTER standby_credit_minutes,
  ADD COLUMN standby_credit_at DATETIME NULL AFTER standby_credit_by_user_id,
  ADD COLUMN standby_credit_note VARCHAR(500) NULL AFTER standby_credit_at,
  ADD CONSTRAINT fk_eqa_credit_by FOREIGN KEY (standby_credit_by_user_id) REFERENCES users (user_id),
  ADD CONSTRAINT chk_eqa_credit CHECK (standby_credit_minutes IS NULL OR standby_credit_minutes BETWEEN 0 AND 1440);

ALTER TABLE eq_payroll_attendance_snapshot
  ADD COLUMN standby_credit_minutes INT NULL AFTER standby_minutes;
