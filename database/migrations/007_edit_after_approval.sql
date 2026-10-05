-- 007: edit / lock policy, phase 3.
-- An Admin may change an Approved row (not in a finalized period) with a reason: it stays Approved but is flagged.
ALTER TABLE eq_attendance
  ADD COLUMN edited_after_approval TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Changed by an Admin after approval (shown in another colour)',
  ADD COLUMN admin_edit_reason VARCHAR(1000) NULL COMMENT 'Reason of the last Admin change after approval',
  ADD COLUMN admin_edit_by_user_id INT NULL,
  ADD COLUMN admin_edit_at DATETIME NULL,
  ADD CONSTRAINT fk_eqa_admin_edit_by FOREIGN KEY (admin_edit_by_user_id) REFERENCES users (user_id);
