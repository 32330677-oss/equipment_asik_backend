-- Rollback of 018_monthly_terms.sql
-- Note: overtime_enabled values set to 1 by 018 are left as they are (the old engine ignored the flag for Monthly cards).
DROP TABLE IF EXISTS eq_monthly_terms;
ALTER TABLE eq_rate_cards DROP COLUMN monthly_divisor;
DELETE FROM schema_migrations WHERE filename = '018_monthly_terms.sql';
