-- 028 — A monthly machine working two shifts, each shift at its own monthly price (decision of 16 Nov 2026).
--  * eq_rate_cards.shift_type: NULL (every card that exists now) = the card covers both shifts, exactly as before.
--    Day / Night = the card prices that shift only; a Day card and a Night card may cover the same dates. Monthly only.
--  * The terms of a month (eq_monthly_terms), the days a monthly item billed (eq_payroll_monthly_days) and the
--    adjustments get the shift too. 'All' (every row that exists now) = both shifts, exactly as before.
--  * Setting eq_shift_rate_cards_enabled (off): shift cards can be created only once it is switched on.
-- Additive only: nothing existing changes. Rollback (only before the first shift card is created):
-- database/migrations/rollback/028_shift_rate_cards.down.sql

ALTER TABLE eq_rate_cards
  ADD COLUMN shift_type ENUM('Day','Night') NULL COMMENT 'Monthly only: the shift this card prices; NULL = both shifts' AFTER billing_mode;

-- terms of the month typed per machine, month AND shift ('All' = the machine with one card for both shifts)
ALTER TABLE eq_monthly_terms
  ADD COLUMN shift_key ENUM('All','Day','Night') NOT NULL DEFAULT 'All' COMMENT 'All = both shifts (one card); Day / Night = that shift card' AFTER month;
ALTER TABLE eq_monthly_terms
  ADD UNIQUE KEY uq_eqmt_shift (equipment_id, month, shift_key);
ALTER TABLE eq_monthly_terms
  DROP INDEX uq_eqmt;

-- each monthly day is billed once per machine AND shift card
ALTER TABLE eq_payroll_monthly_days
  ADD COLUMN shift_key ENUM('All','Day','Night') NOT NULL DEFAULT 'All' COMMENT 'All = both shifts (one card); Day / Night = that shift card' AFTER day;
ALTER TABLE eq_payroll_monthly_days
  ADD KEY idx_eqpmd_batch (eq_batch_id);
ALTER TABLE eq_payroll_monthly_days
  DROP PRIMARY KEY, ADD PRIMARY KEY (eq_batch_id, equipment_id, day, shift_key);

-- an adjustment of a machine with a Day and a Night card says which shift it belongs to
ALTER TABLE eq_adjustments
  ADD COLUMN shift_type ENUM('Day','Night') NULL COMMENT 'Machine with shift cards: the shift card it goes to; NULL = the machine card' AFTER site_id;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('eq_shift_rate_cards_enabled', 'false', 'Monthly machines: allow a Day card and a Night card (each shift at its own monthly price)');
