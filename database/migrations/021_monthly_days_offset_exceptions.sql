-- 021 — Monthly machines, rules of 12 Oct 2026. Additive (the Fixed divisor of the card is switched off, not dropped).
--  * Every deployed working day is due its hours on its own: missing hours are deducted, extra hours are paid as
--    overtime (when the card pays it) or kept. Extra hours cover missing hours ONLY when the Admin decides it, per
--    machine and month (eq_payroll_batches.offset_months), and an hour is either an offset or overtime, never both.
--  * The exception of a month (eq_monthly_terms) may also change the AMOUNT of the month.
--  * The card no longer divides by a fixed number of days: a month billed differently gets an exception.

ALTER TABLE eq_monthly_terms
  ADD COLUMN monthly_amount DECIMAL(14,2) NULL COMMENT 'Amount of the month typed for this machine; NULL = monthly price of the card' AFTER month,
  ADD CONSTRAINT chk_eqmt_amount CHECK (monthly_amount IS NULL OR monthly_amount > 0);

ALTER TABLE eq_payroll_batches
  ADD COLUMN offset_months JSON NULL COMMENT 'Admin decision: ["<equipment_id>|YYYY-MM"] whose extra hours cover missing hours' AFTER accept_blockers_reason;

ALTER TABLE eq_payroll_lines
  MODIFY line_type ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference','HoursShortfall','SecondShift','DeliveryNote','ExtraHoursOffset') NOT NULL;

-- cards that divided by a fixed number of days become normal months; their old setting is kept in the audit log
INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, reason, source)
  SELECT 'eq_rate_cards', rate_card_id, 'divisor_fixed_removed', JSON_OBJECT('monthly_divisor', 'Fixed', 'monthly_working_days', monthly_working_days),
    JSON_OBJECT('monthly_divisor', 'MonthDays'), 'Migration 021: "Fixed" divisor removed; type an exception for a month billed differently', 'migration'
  FROM eq_rate_cards WHERE monthly_divisor = 'Fixed';
UPDATE eq_rate_cards SET monthly_divisor = 'MonthDays' WHERE monthly_divisor = 'Fixed';
