-- 017 — Undo of a Finalize within eq_finalize_undo_hours (decision of 11 Oct 2026).
-- The batch goes back to a draft; its official numbers are WITHDRAWN (kept, reserved) and given back to the same
-- vendor / machine when the batch (or its next version) is finalized again. Additive only.
ALTER TABLE eq_payroll_batches
  ADD COLUMN finalize_undo_count INT NOT NULL DEFAULT 0 AFTER finalized_at;

ALTER TABLE eq_invoices
  ADD COLUMN status ENUM('Issued','Withdrawn') NOT NULL DEFAULT 'Issued' AFTER amount,
  ADD COLUMN reissued_at DATETIME NULL AFTER issued_at;

ALTER TABLE eq_batch_requests
  MODIFY action ENUM('void','supersede','unfinalize') NOT NULL;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('eq_finalize_undo_hours', '72', 'Hours after Finalize during which the batch can go back to a draft with the same invoice numbers (0 = never)');
