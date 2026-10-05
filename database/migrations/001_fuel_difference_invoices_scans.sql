-- 001: fuel price difference, official invoice numbers, scan-before-finalize, licence no longer an anomaly.

-- National fuel price list (effective-dated). A price is valid from effective_from until the next row of the same currency.
CREATE TABLE IF NOT EXISTS eq_fuel_prices (
  fuel_price_id    INT NOT NULL AUTO_INCREMENT,
  currency         CHAR(3) NOT NULL,
  effective_from   DATE NOT NULL,
  price_per_liter  DECIMAL(12,3) NOT NULL,
  note             VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fuel_price_id),
  UNIQUE KEY uq_eqfp_cur_from (currency, effective_from),
  CONSTRAINT fk_eqfp_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fuel difference terms of a machine (effective-dated history: a change closes the old row and opens a new one).
CREATE TABLE IF NOT EXISTS eq_fuel_terms (
  fuel_terms_id    INT NOT NULL AUTO_INCREMENT,
  equipment_id     INT NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL,
  base_price_per_liter DECIMAL(12,3) NOT NULL COMMENT 'Fuel price agreed when the machine joined the project',
  liters_per_hour  DECIMAL(8,3) NOT NULL COMMENT 'Approximate consumption per working hour',
  note             VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fuel_terms_id),
  KEY idx_eqft_equipment (equipment_id, effective_from),
  CONSTRAINT fk_eqft_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqft_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE eq_payroll_lines
  MODIFY line_type ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference') NOT NULL,
  MODIFY source_table ENUM('eq_fuel_issues','eq_adjustments','eq_fuel_terms') NULL;

-- Official invoice numbers, issued when a batch is finalized. One sequence per kind and year; never reused.
CREATE TABLE IF NOT EXISTS eq_invoice_counters (
  kind             ENUM('Vendor','Machine','FuelDiff') NOT NULL,
  year             SMALLINT NOT NULL,
  last_seq         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS eq_invoices (
  invoice_id       INT NOT NULL AUTO_INCREMENT,
  invoice_no       VARCHAR(30) NOT NULL,
  kind             ENUM('Vendor','Machine','FuelDiff') NOT NULL,
  year             SMALLINT NOT NULL,
  seq              INT NOT NULL,
  eq_batch_id      INT NOT NULL,
  vendor_id        INT NOT NULL,
  equipment_id     INT NULL,
  eq_item_id       INT NULL,
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  issued_at        DATETIME NOT NULL,
  PRIMARY KEY (invoice_id),
  UNIQUE KEY uq_eqinv_no (invoice_no),
  UNIQUE KEY uq_eqinv_kind_seq (kind, year, seq),
  KEY idx_eqinv_batch (eq_batch_id),
  CONSTRAINT fk_eqinv_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqinv_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqinv_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqinv_item FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Settings: the signed sheet is uploaded by the accountant at month end and is required to FINALIZE (not to generate).
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('eq_finalize_requires_scan', 'true'),
  ('eq_fuel_diff_allow_negative', 'false');
UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_payroll_requires_paper_match';

-- The operator licence no longer raises an anomaly: clear the old ones.
UPDATE eq_attendance SET anomaly_code = NULL, anomaly_detail = NULL WHERE anomaly_code = 'operator_license_expired';

-- Finalize / mark paid by the Admin only (the accountant prepares and uploads the signed sheets).
INSERT INTO settings (setting_key, setting_value) VALUES ('payroll_finalize_admin_only', 'true')
  ON DUPLICATE KEY UPDATE setting_value = 'true';
