-- 014: opening balances = money still owed to a vendor from BEFORE the system was used (no batch, no invoice in the app).
-- Entered once per vendor (optionally per machine, for the record) with the amount still owed after the payments already made.
-- "Add previous balances" on New payroll moves an open opening balance into the new batch exactly like the unpaid balance
-- of an older batch: it is paid there with the normal payment vouchers, and the statement of account shows it on its own
-- line ("Opening balance ..."), so the invoice of the new period is NOT inflated.
-- Voiding the new batch releases it (open again); a new version of the batch takes it along.
-- Additive only. Rollback: database/migrations/rollback/014_opening_balances.down.sql

CREATE TABLE IF NOT EXISTS eq_opening_balances (
  opening_balance_id INT NOT NULL AUTO_INCREMENT,
  vendor_id        INT NOT NULL,
  equipment_id     INT NULL COMMENT 'Optional: the machine this old amount is for (information only)',
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL COMMENT 'Still owed to the vendor on as_of_date (after old payments)',
  as_of_date       DATE NOT NULL COMMENT 'Balance date; carried only into a batch that starts after it',
  period_from      DATE NULL COMMENT 'Optional: the old period it covers',
  period_to        DATE NULL,
  description      VARCHAR(255) NOT NULL COMMENT 'Printed on the statement of account',
  reference        VARCHAR(100) NULL COMMENT 'Old invoice / statement number, if any',
  note             VARCHAR(500) NULL,
  status           ENUM('Active','Cancelled') NOT NULL DEFAULT 'Active',
  cancel_reason    VARCHAR(500) NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at     DATETIME NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (opening_balance_id),
  KEY idx_eqob_vendor (vendor_id, currency, status),
  CONSTRAINT fk_eqob_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqob_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqob_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqob_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqob_amount CHECK (amount > 0),
  CONSTRAINT chk_eqob_period CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A carried balance now comes either from an older batch (from_batch_id) or from an opening balance (opening_balance_id).
ALTER TABLE eq_payment_carryovers
  MODIFY from_batch_id INT NULL,
  ADD COLUMN opening_balance_id INT NULL AFTER from_batch_id,
  ADD KEY idx_eqco_opening (opening_balance_id, status),
  ADD CONSTRAINT fk_eqco_opening FOREIGN KEY (opening_balance_id) REFERENCES eq_opening_balances (opening_balance_id),
  ADD CONSTRAINT chk_eqco_source CHECK ((from_batch_id IS NULL) <> (opening_balance_id IS NULL));
