-- 013: (1) DNR = Delivery Note Registry: per-unit prices (per trip, per ton, per m3 ...) of an EXISTING vendor, and the
--      delivery notes billed with them. A machine may have a time rate card (Hourly / Daily / Monthly) AND DNR prices at the
--      same time (it transports and does another job): DNR prices live in their own table and never clash with rate cards.
--      (2) Partial payments of a finalized vendor invoice (payment vouchers), and carrying an unpaid balance into a later batch.
-- Additive only: no existing row is changed or deleted. Rollback: database/migrations/rollback/013_dnr_and_partial_payments.down.sql

-- ------------------------------------------------------------------ 1. DNR price list
CREATE TABLE IF NOT EXISTS eq_dnr_rates (
  dnr_rate_id      INT NOT NULL AUTO_INCREMENT,
  vendor_id        INT NOT NULL,
  vendor_contract_id INT NOT NULL COMMENT 'Currency comes from the contract',
  equipment_id     INT NULL COMMENT 'NULL = every machine of the vendor',
  item_name        VARCHAR(255) NOT NULL COMMENT 'What is paid per unit, e.g. Sand transport Damascus - S08',
  unit             ENUM('trip','t','m3','km','pc','load') NOT NULL,
  unit_price       DECIMAL(12,3) NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL COMMENT 'Inclusive last day; NULL = open',
  status           ENUM('Active','Cancelled') NOT NULL DEFAULT 'Active' COMMENT 'Cancelled only while no delivery note uses it',
  notes            VARCHAR(500) NULL,
  created_by_user_id INT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (dnr_rate_id),
  KEY idx_eqdr_vendor (vendor_id, status, effective_from),
  KEY idx_eqdr_equipment (equipment_id, status, effective_from),
  CONSTRAINT fk_eqdr_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqdr_contract FOREIGN KEY (vendor_contract_id) REFERENCES eq_vendor_contracts (vendor_contract_id),
  CONSTRAINT fk_eqdr_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqdr_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqdr_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_eqdr_price CHECK (unit_price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ 2. Delivery notes (one row per paper DN)
CREATE TABLE IF NOT EXISTS eq_delivery_notes (
  delivery_note_id INT NOT NULL AUTO_INCREMENT,
  dn_number        VARCHAR(60) NOT NULL COMMENT 'Number printed on the paper delivery note',
  vendor_id        INT NOT NULL,
  equipment_id     INT NOT NULL,
  site_id          INT NOT NULL,
  dnr_rate_id      INT NOT NULL,
  note_date        DATE NOT NULL COMMENT 'Decides which payroll period picks it up',
  quantity         DECIMAL(12,3) NOT NULL,
  unit_price       DECIMAL(12,3) NOT NULL COMMENT 'Copied from the DNR price when saved',
  currency         CHAR(3) NOT NULL,
  from_location    VARCHAR(255) NULL,
  to_location      VARCHAR(255) NULL,
  material         VARCHAR(255) NULL,
  driver_name      VARCHAR(255) NULL,
  note             VARCHAR(500) NULL,
  status           ENUM('Active','Cancelled') NOT NULL DEFAULT 'Active',
  cancel_reason    VARCHAR(500) NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at     DATETIME NULL,
  live_slot        TINYINT AS (IF(status = 'Cancelled', NULL, 1)) STORED COMMENT 'NULL for cancelled notes: a cancelled number may be used again',
  created_by_user_id INT NOT NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (delivery_note_id),
  UNIQUE KEY uq_eqdn_vendor_number (vendor_id, dn_number, live_slot),
  KEY idx_eqdn_equipment_date (equipment_id, note_date),
  KEY idx_eqdn_site_date (site_id, note_date),
  KEY idx_eqdn_rate (dnr_rate_id),
  CONSTRAINT fk_eqdn_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqdn_equipment FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqdn_site FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_eqdn_rate FOREIGN KEY (dnr_rate_id) REFERENCES eq_dnr_rates (dnr_rate_id),
  CONSTRAINT fk_eqdn_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqdn_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqdn_qty CHECK (quantity > 0 AND unit_price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Payroll: a DNR item (machine x site, billed per delivery note) and its lines.
ALTER TABLE eq_payroll_items
  MODIFY billing_mode ENUM('Hourly','Daily','Monthly','DNR') NULL;
ALTER TABLE eq_payroll_lines
  MODIFY line_type ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference','HoursShortfall','SecondShift','DeliveryNote') NOT NULL,
  MODIFY unit ENUM('h','day','month','L','item','trip','t','m3','km','pc','load') NOT NULL,
  MODIFY source_table ENUM('eq_fuel_issues','eq_adjustments','eq_fuel_terms','eq_delivery_notes') NULL;

-- ------------------------------------------------------------------ 3. Payments (payment vouchers) of a vendor invoice
-- The invoice issued at finalize is NEVER changed. Each payment gets its own official voucher number (PV-YYYY-00001),
-- and the balance (invoice + carried in - paid - carried out) is shown on a separate statement of account.
ALTER TABLE eq_invoice_counters MODIFY kind ENUM('Vendor','Machine','FuelDiff','DebitNote','CreditNote','PaymentVoucher') NOT NULL;

CREATE TABLE IF NOT EXISTS eq_payments (
  payment_id       INT NOT NULL AUTO_INCREMENT,
  voucher_no       VARCHAR(30) NOT NULL COMMENT 'Official payment voucher number, never reused',
  eq_batch_id      INT NOT NULL,
  vendor_id        INT NOT NULL,
  invoice_id       INT NULL COMMENT 'Vendor invoice of the batch',
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  paid_on          DATE NOT NULL,
  method           ENUM('BankTransfer','Cheque','Cash','Other') NOT NULL DEFAULT 'BankTransfer',
  reference        VARCHAR(100) NULL COMMENT 'Bank transfer / cheque number',
  note             VARCHAR(500) NULL,
  source           ENUM('Payment','MarkPaid') NOT NULL DEFAULT 'Payment' COMMENT 'MarkPaid = remaining balance settled by Mark paid',
  balance_before   DECIMAL(14,2) NOT NULL COMMENT 'Frozen for the printed voucher',
  balance_after    DECIMAL(14,2) NOT NULL,
  status           ENUM('Active','Reversed') NOT NULL DEFAULT 'Active',
  reversed_by_user_id INT NULL,
  reversed_at      DATETIME NULL,
  reverse_reason   VARCHAR(500) NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (payment_id),
  UNIQUE KEY uq_eqpay_voucher (voucher_no),
  KEY idx_eqpay_batch_vendor (eq_batch_id, vendor_id, status),
  CONSTRAINT fk_eqpay_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpay_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqpay_invoice FOREIGN KEY (invoice_id) REFERENCES eq_invoices (invoice_id),
  CONSTRAINT fk_eqpay_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqpay_reversed_by FOREIGN KEY (reversed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqpay_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- An unpaid balance of an earlier finalized batch moved into a new batch (option "add previous balances" on New payroll).
-- The old batch is then closed as "carried forward" and receives no more payments; the new batch collects them.
-- Voiding the new batch releases the carry (the old balance is open again on the old batch).
CREATE TABLE IF NOT EXISTS eq_payment_carryovers (
  carryover_id     INT NOT NULL AUTO_INCREMENT,
  from_batch_id    INT NOT NULL,
  to_batch_id      INT NOT NULL,
  vendor_id        INT NOT NULL,
  currency         CHAR(3) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  status           ENUM('Active','Released') NOT NULL DEFAULT 'Active',
  released_reason  VARCHAR(500) NULL,
  released_by_user_id INT NULL,
  released_at      DATETIME NULL,
  created_by_user_id INT NOT NULL,
  created_at       DATETIME NOT NULL,
  PRIMARY KEY (carryover_id),
  KEY idx_eqco_from (from_batch_id, vendor_id, status),
  KEY idx_eqco_to (to_batch_id, vendor_id, status),
  CONSTRAINT fk_eqco_from FOREIGN KEY (from_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqco_to FOREIGN KEY (to_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqco_vendor FOREIGN KEY (vendor_id) REFERENCES eq_vendors (vendor_id),
  CONSTRAINT fk_eqco_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqco_released_by FOREIGN KEY (released_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqco_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Batches marked paid BEFORE this migration have no payment row: one MarkPaid voucher-less payment is NOT invented here.
-- The settlement treats a batch with status 'Paid' and no payment rows as fully paid (legacy), so nothing changes for them.
