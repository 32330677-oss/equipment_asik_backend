-- 005: edit / lock policy, phase 1.
-- Billing settings frozen in each batch (shown on it, reused by official corrections).
ALTER TABLE eq_payroll_batches
  ADD COLUMN settings_snapshot JSON NULL COMMENT 'Billing settings in force when the batch was generated' AFTER generated_at;

-- Official numbers of a voided or superseded batch stay (never reused) and are marked cancelled here.
CREATE TABLE IF NOT EXISTS eq_invoice_cancellations (
  invoice_id       INT NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at     DATETIME NOT NULL,
  PRIMARY KEY (invoice_id),
  CONSTRAINT fk_eqic_invoice FOREIGN KEY (invoice_id) REFERENCES eq_invoices (invoice_id),
  CONSTRAINT fk_eqic_user FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
