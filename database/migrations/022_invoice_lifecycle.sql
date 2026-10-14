-- 022 — Invoices: issue, hand over to finance, withdraw, debit / credit notes (decisions of 13-14 Oct 2026).
--
--  * The app records attendance and issues invoices; it does not record payments any more. Payments, balances carried
--    to a later batch and opening balances are removed (no data existed: confirmed 13 Oct 2026).
--  * An invoice covers a PERIOD of each of its machines: two active invoices of one machine never overlap (by site when
--    the invoice is made for one site). eq_invoice_coverage keeps what each batch covers.
--  * Life of an invoice batch (eq_payroll_batches.status + is_finalized):
--      Generated, is_finalized = 0  Draft       (no number; reserves the period)
--      Generated, is_finalized = 1  Issued      (numbered; still in the office: kept up to date with the SAME numbers)
--      HandedOver                   Handed over to finance (locked for everybody)
--      Returned                     Withdrawn from finance by a signed acknowledgement (Admin may change it)
--      Voided                       Cancelled (numbers kept as cancelled, never reused)
--      Superseded                   An older calculation of the same invoice (same numbers)
--      Replaced                     Withdrawn and re-issued with NEW numbers
--  * Debit / credit notes: stand-alone documents (a machine or the vendor in general), numbered DN- / CN-.
-- Rollback: database/migrations/rollback/022_invoice_lifecycle.down.sql (only before any new data exists).

-- ------------------------------------------------------------------ 1. payments, carried balances, opening balances
DROP TABLE IF EXISTS eq_payment_carryovers;
DROP TABLE IF EXISTS eq_opening_balances;
DROP TABLE IF EXISTS eq_payments;

-- ------------------------------------------------------------------ 2. batch states
UPDATE eq_payroll_batches SET status = 'Generated' WHERE status = 'Paid';
ALTER TABLE eq_payroll_batches
  MODIFY status ENUM('Generated','HandedOver','Returned','Superseded','Voided','Replaced') NOT NULL DEFAULT 'Generated',
  ADD COLUMN handed_over_at DATETIME NULL COMMENT 'Last hand-over to finance' AFTER finalized_at,
  ADD COLUMN handover_id INT NULL COMMENT 'Last hand-over sheet' AFTER handed_over_at,
  ADD COLUMN returned_at DATETIME NULL COMMENT 'Last withdrawal from finance' AFTER handover_id,
  ADD COLUMN withdrawal_id INT NULL COMMENT 'Last withdrawal acknowledgement' AFTER returned_at,
  ADD COLUMN replaced_by_batch_id INT NULL COMMENT 'Re-issued with new numbers as this batch' AFTER withdrawal_id;

-- ------------------------------------------------------------------ 3. what each batch covers (no overlap per machine)
CREATE TABLE IF NOT EXISTS eq_invoice_coverage (
  eq_batch_id  INT NOT NULL,
  equipment_id INT NOT NULL,
  site_id      INT NULL COMMENT 'NULL = every site of the machine; set when the invoice is made for one site',
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  PRIMARY KEY (eq_batch_id, equipment_id),
  KEY idx_eqcov_machine (equipment_id, start_date, end_date),
  CONSTRAINT fk_eqcov_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqcov_machine FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT chk_eqcov_dates CHECK (end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Period of each machine covered by an invoice batch (14 Oct 2026)';

-- batches made before this migration (none expected)
INSERT IGNORE INTO eq_invoice_coverage (eq_batch_id, equipment_id, site_id, start_date, end_date)
  SELECT DISTINCT b.eq_batch_id, i.equipment_id, b.scope_site_id, b.start_date, b.end_date
  FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id;
INSERT IGNORE INTO eq_invoice_coverage (eq_batch_id, equipment_id, site_id, start_date, end_date)
  SELECT m.eq_batch_id, m.equipment_id, b.scope_site_id, b.start_date, b.end_date
  FROM eq_payroll_batch_machines m JOIN eq_payroll_batches b ON b.eq_batch_id = m.eq_batch_id;

-- ------------------------------------------------------------------ 4. numbers
ALTER TABLE eq_invoice_counters
  MODIFY kind ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote','PaymentVoucher','Handover','Withdrawal') NOT NULL;

-- ------------------------------------------------------------------ 5. debit / credit notes
CREATE TABLE IF NOT EXISTS eq_notes (
  note_id          INT NOT NULL AUTO_INCREMENT,
  note_no          VARCHAR(30) NULL COMMENT 'DN-YYYY-00001 / CN-YYYY-00001, given when issued, never reused',
  kind             ENUM('Debit','Credit') NOT NULL COMMENT 'Debit = more for the vendor, Credit = less',
  vendor_id        INT NOT NULL,
  equipment_id     INT NULL COMMENT 'NULL = the vendor in general',
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL COMMENT 'Always positive; the kind gives the direction',
  reason           VARCHAR(1000) NOT NULL,
  note_date        DATE NOT NULL,
  period_from      DATE NULL,
  period_to        DATE NULL,
  ref_batch_id     INT NULL COMMENT 'Invoice batch it belongs to (shown with that invoice in the app, never printed)',
  status           ENUM('Draft','Issued','HandedOver','Returned','Cancelled') NOT NULL DEFAULT 'Draft',
  issued_at        DATETIME NULL,
  issued_by_user_id INT NULL,
  handed_over_at   DATETIME NULL,
  handover_id      INT NULL,
  returned_at      DATETIME NULL,
  withdrawal_id    INT NULL,
  cancelled_at     DATETIME NULL,
  cancelled_by_user_id INT NULL,
  cancel_reason    VARCHAR(500) NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id),
  UNIQUE KEY uq_eqnote_no (note_no),
  KEY idx_eqnote_vendor (vendor_id, status),
  KEY idx_eqnote_batch (ref_batch_id),
  KEY idx_eqnote_machine (equipment_id),
  CONSTRAINT fk_eqnote_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqnote_machine FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqnote_batch FOREIGN KEY (ref_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqnote_created FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqnote_amount CHECK (amount > 0),
  CONSTRAINT chk_eqnote_period CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ 6. hand-over to finance and withdrawal
CREATE TABLE IF NOT EXISTS eq_handovers (
  handover_id      INT NOT NULL AUTO_INCREMENT,
  handover_no      VARCHAR(30) NOT NULL COMMENT 'HO-YYYY-00001',
  handed_on        DATE NOT NULL,
  receiver_name    VARCHAR(255) NOT NULL,
  note             VARCHAR(500) NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (handover_id),
  UNIQUE KEY uq_eqho_no (handover_no),
  CONSTRAINT fk_eqho_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS eq_handover_items (
  handover_id      INT NOT NULL,
  line_no          INT NOT NULL,
  eq_batch_id      INT NULL,
  note_id          INT NULL,
  vendor_id        INT NOT NULL,
  doc_no           VARCHAR(30) NOT NULL COMMENT 'Vendor invoice / note number at hand-over',
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL COMMENT 'Signed: a credit note is negative',
  PRIMARY KEY (handover_id, line_no),
  KEY idx_eqhoi_batch (eq_batch_id),
  KEY idx_eqhoi_note (note_id),
  CONSTRAINT fk_eqhoi_ho FOREIGN KEY (handover_id) REFERENCES eq_handovers (handover_id),
  CONSTRAINT fk_eqhoi_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqhoi_note FOREIGN KEY (note_id) REFERENCES eq_notes (note_id),
  CONSTRAINT chk_eqhoi_doc CHECK ((eq_batch_id IS NULL) <> (note_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS eq_withdrawals (
  withdrawal_id    INT NOT NULL AUTO_INCREMENT,
  withdrawal_no    VARCHAR(30) NOT NULL COMMENT 'WD-YYYY-00001',
  eq_batch_id      INT NULL,
  note_id          INT NULL,
  handover_id      INT NULL COMMENT 'Hand-over it was part of',
  reason           VARCHAR(1000) NOT NULL,
  finance_person   VARCHAR(255) NOT NULL COMMENT 'Who in finance gives it back',
  withdrawn_on     DATE NOT NULL,
  was_paid         TINYINT(1) NOT NULL DEFAULT 0,
  paid_amount      DECIMAL(14,2) NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (withdrawal_id),
  UNIQUE KEY uq_eqwd_no (withdrawal_no),
  KEY idx_eqwd_batch (eq_batch_id),
  KEY idx_eqwd_note (note_id),
  CONSTRAINT fk_eqwd_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqwd_note FOREIGN KEY (note_id) REFERENCES eq_notes (note_id),
  CONSTRAINT fk_eqwd_ho FOREIGN KEY (handover_id) REFERENCES eq_handovers (handover_id),
  CONSTRAINT fk_eqwd_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqwd_doc CHECK ((eq_batch_id IS NULL) <> (note_id IS NULL)),
  CONSTRAINT chk_eqwd_paid CHECK (paid_amount IS NULL OR paid_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ 7. settings
DELETE FROM settings WHERE setting_key IN ('eq_paid_undo_hours', 'eq_finalize_undo_hours');
-- decision of 14 Oct 2026: the Accountant issues invoices too (hand-over, cancel, withdrawal stay with the Admin)
UPDATE settings SET setting_value = 'false',
  description = 'Only the Admin may issue invoices (off: the Accountant issues too; hand-over, cancel and withdrawal stay Admin only)'
  WHERE setting_key = 'payroll_finalize_admin_only';
UPDATE settings SET description = 'An invoice is handed over to finance only when the signed monthly sheets are uploaded for all its rows'
  WHERE setting_key = 'eq_finalize_requires_scan';
