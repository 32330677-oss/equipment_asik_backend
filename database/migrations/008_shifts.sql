-- 008: edit / lock policy, phase 4 — shifts.
-- Daily machines: work above one day (a second shift the same day) is billed at this % of the daily price (0..100).
ALTER TABLE eq_rate_cards
  ADD COLUMN second_shift_pct DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT 'Daily: second shift the same day billed at this % of the daily price',
  ADD CONSTRAINT chk_eqrc_second_shift CHECK (second_shift_pct BETWEEN 0 AND 100);

ALTER TABLE eq_payroll_lines
  MODIFY line_type ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference','HoursShortfall','SecondShift') NOT NULL;

-- How each row was billed beside its minutes: regular minutes allowed (continuous shifts), part of the day used before it.
ALTER TABLE eq_payroll_attendance_snapshot
  ADD COLUMN calc_detail JSON NULL COMMENT 'regular_allow, block_shifts, day_used_before';

-- Shifts of one machine closer than this are continuous: overtime after threshold x shifts.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('eq_shift_continuity_minutes', '30');
