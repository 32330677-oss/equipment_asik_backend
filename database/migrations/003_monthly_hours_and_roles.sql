-- 003: monthly machines are billed on the hours due in the month (working days x hours per day).
ALTER TABLE eq_payroll_lines
  MODIFY line_type ENUM('Work','Overtime','Standby','Breakdown','MinimumTopUp','MonthlyBase','AbsenceDeduction','BreakdownDeduction','Operator','Fuel','Adjustment','FuelPriceDifference','HoursShortfall') NOT NULL;
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('eq_weekly_off_day', '5');
