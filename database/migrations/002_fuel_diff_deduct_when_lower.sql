-- 002: when the official fuel price falls below the machine's base price, the difference is DEDUCTED from the vendor.
INSERT INTO settings (setting_key, setting_value) VALUES ('eq_fuel_diff_allow_negative', 'true')
  ON DUPLICATE KEY UPDATE setting_value = 'true';
