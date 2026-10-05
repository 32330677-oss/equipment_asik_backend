-- 006: official corrections of finalized periods.
-- Admin requests -> Accountant reviews (may change it) -> Admin approves, or returns it to the Accountant.
-- On approval the row is corrected, the difference is settled by an adjustment in the first open period,
-- and an official debit / credit note number is issued. The finalized batch itself never changes.
ALTER TABLE eq_attendance_corrections
  ADD COLUMN request_status ENUM('Requested','Reviewed','Approved','Cancelled') NOT NULL DEFAULT 'Approved' AFTER reason,
  ADD COLUMN proposed_changes JSON NULL AFTER corrected_values,
  ADD COLUMN delta_amount DECIMAL(14,2) NULL COMMENT 'Signed: + we pay the vendor more',
  ADD COLUMN delta_detail JSON NULL,
  ADD COLUMN currency CHAR(3) NULL,
  ADD COLUMN amount_override DECIMAL(14,2) NULL COMMENT 'Set by the accountant when the amount is not the computed one',
  ADD COLUMN override_reason VARCHAR(1000) NULL,
  ADD COLUMN reviewed_by_user_id INT NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD COLUMN review_note VARCHAR(1000) NULL,
  ADD COLUMN return_count INT NOT NULL DEFAULT 0,
  ADD COLUMN approved_by_user_id INT NULL,
  ADD COLUMN approved_at DATETIME NULL,
  ADD COLUMN note_invoice_id INT NULL COMMENT 'Debit / credit note issued on approval',
  ADD KEY idx_eqac_request (request_status),
  ADD CONSTRAINT fk_eqac_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users (user_id),
  ADD CONSTRAINT fk_eqac_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id),
  ADD CONSTRAINT fk_eqac_note FOREIGN KEY (note_invoice_id) REFERENCES eq_invoices (invoice_id);

-- Every step of a correction, in order (request, review, return, approve, cancel).
CREATE TABLE IF NOT EXISTS eq_correction_events (
  event_id         INT NOT NULL AUTO_INCREMENT,
  correction_id    INT NOT NULL,
  action           ENUM('request','review','return','approve','cancel') NOT NULL,
  note             VARCHAR(1000) NULL,
  data             JSON NULL,
  user_id          INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (event_id),
  KEY idx_eqce_correction (correction_id, event_id),
  CONSTRAINT fk_eqce_correction FOREIGN KEY (correction_id) REFERENCES eq_attendance_corrections (correction_id),
  CONSTRAINT fk_eqce_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Debit / credit notes share the official numbering.
ALTER TABLE eq_invoice_counters MODIFY kind ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote') NOT NULL;
ALTER TABLE eq_invoices MODIFY kind ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote') NOT NULL;

-- The settling adjustment says what it is.
ALTER TABLE eq_adjustments
  MODIFY adjustment_type ENUM('Mobilization','Demobilization','Bonus','Penalty','Damage','FuelCorrection','Other','Correction') NOT NULL,
  ADD COLUMN correction_id INT NULL AFTER reason,
  ADD CONSTRAINT fk_eqadj_correction FOREIGN KEY (correction_id) REFERENCES eq_attendance_corrections (correction_id);
