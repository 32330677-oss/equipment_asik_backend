-- 018 — Terms of the month for monthly machines (decision of 11 Oct 2026).
--  * The rate card says how the monthly price is divided: by the working days of the calendar month (default, as before)
--    or by a fixed number of days (monthly_working_days, e.g. 26).
--  * The office may type, per machine and month, the divisor D and / or the hourly price (eq_monthly_terms).
--  * Overtime of a monthly machine now follows overtime_enabled of the card.
-- Additive only.
ALTER TABLE eq_rate_cards
  ADD COLUMN monthly_divisor ENUM('MonthDays','Fixed') NOT NULL DEFAULT 'MonthDays' AFTER monthly_working_days;

-- the engine ignored overtime_enabled for Monthly until now (always paid): keep every existing amount identical
UPDATE eq_rate_cards SET overtime_enabled = 1 WHERE billing_mode = 'Monthly' AND overtime_enabled = 0;

CREATE TABLE IF NOT EXISTS eq_monthly_terms (
  monthly_terms_id INT NOT NULL AUTO_INCREMENT,
  equipment_id   INT NOT NULL,
  month          CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  working_days   TINYINT NULL COMMENT 'Divisor D typed for this month; NULL = card default',
  hourly_rate    DECIMAL(12,4) NULL COMMENT 'Hourly price typed for this month; NULL = monthly / D / hours per day',
  note           VARCHAR(500) NULL,
  set_by_user_id INT NOT NULL,
  set_at         DATETIME NOT NULL,
  PRIMARY KEY (monthly_terms_id),
  UNIQUE KEY uq_eqmt (equipment_id, month),
  CONSTRAINT fk_eqmt_eq FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id),
  CONSTRAINT fk_eqmt_user FOREIGN KEY (set_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_eqmt_days CHECK (working_days IS NULL OR working_days BETWEEN 1 AND 31),
  CONSTRAINT chk_eqmt_rate CHECK (hourly_rate IS NULL OR hourly_rate > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
