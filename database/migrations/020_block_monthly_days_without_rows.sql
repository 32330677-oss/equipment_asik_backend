-- 020 — Monthly machines: a deployed working day without any attendance row blocks generating (decision of 12 Oct 2026).
-- Since 12/10 ver2 such a day is deducted IN FULL as an absence (extra hours on other days never make up for it), so it
-- must be a decision: record the day, or generate with accept_blockers and a reason. Additive only.
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('eq_block_monthly_days_without_rows', 'true', 'Monthly machines: a deployed working day with no attendance row blocks generating (it is deducted in full as an absence); the batch can still be generated with a reason');
