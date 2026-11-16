-- Rollback of 028_shift_rate_cards.sql. ONLY before the first shift card (shift_type Day / Night) was created and
-- billed: the code before 028 sees a Day and a Night card of one machine as two overlapping cards.
-- Refuses to run (a duplicate-key error stops it before any change) when shift data exists.
DROP TEMPORARY TABLE IF EXISTS _rb028_guard;
CREATE TEMPORARY TABLE _rb028_guard (k INT PRIMARY KEY);
INSERT INTO _rb028_guard VALUES (1);
INSERT INTO _rb028_guard SELECT 1 FROM eq_rate_cards WHERE shift_type IS NOT NULL LIMIT 1;
INSERT INTO _rb028_guard SELECT 1 FROM eq_monthly_terms WHERE shift_key <> 'All' LIMIT 1;
INSERT INTO _rb028_guard SELECT 1 FROM eq_payroll_monthly_days WHERE shift_key <> 'All' LIMIT 1;
INSERT INTO _rb028_guard SELECT 1 FROM eq_adjustments WHERE shift_type IS NOT NULL LIMIT 1;
DROP TEMPORARY TABLE _rb028_guard;

ALTER TABLE eq_payroll_monthly_days DROP PRIMARY KEY, ADD PRIMARY KEY (eq_batch_id, equipment_id, day);
ALTER TABLE eq_payroll_monthly_days DROP INDEX idx_eqpmd_batch, DROP COLUMN shift_key;
ALTER TABLE eq_monthly_terms ADD UNIQUE KEY uq_eqmt (equipment_id, month);
ALTER TABLE eq_monthly_terms DROP INDEX uq_eqmt_shift, DROP COLUMN shift_key;
ALTER TABLE eq_adjustments DROP COLUMN shift_type;
ALTER TABLE eq_rate_cards DROP COLUMN shift_type;
DELETE FROM settings WHERE setting_key = 'eq_shift_rate_cards_enabled';
DELETE FROM schema_migrations WHERE filename = '028_shift_rate_cards.sql';
