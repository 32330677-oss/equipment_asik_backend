-- 019 — Every unit is billed once (decision of 11 Oct 2026, replaces the closed-period rule of 6 Oct 2026).
--  * A batch may be made for several machines of one vendor chosen by hand (eq_payroll_batch_machines).
--  * Each deployed day of a MONTHLY machine is billed by one batch only (eq_payroll_monthly_days), like the attendance
--    rows (eq_payroll_attendance_snapshot) and the fuel / adjustments / delivery notes (eq_payroll_lines).
-- After this migration run once: npm run backfill:monthly-days (fills the days of the batches made before).
-- Additive only.
CREATE TABLE IF NOT EXISTS eq_payroll_batch_machines (
  eq_batch_id  INT NOT NULL,
  equipment_id INT NOT NULL,
  PRIMARY KEY (eq_batch_id, equipment_id),
  KEY idx_eqpbm_eq (equipment_id),
  CONSTRAINT fk_eqpbm_b FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpbm_e FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Machines chosen by hand for a batch (empty = whole scope)';

CREATE TABLE IF NOT EXISTS eq_payroll_monthly_days (
  eq_batch_id  INT NOT NULL,
  eq_item_id   INT NOT NULL,
  equipment_id INT NOT NULL,
  day          DATE NOT NULL,
  site_id      INT NOT NULL,
  PRIMARY KEY (eq_batch_id, equipment_id, day),
  KEY idx_eqpmd_eq_day (equipment_id, day),
  CONSTRAINT fk_eqpmd_b FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqpmd_i FOREIGN KEY (eq_item_id) REFERENCES eq_payroll_items (eq_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Deployed working days a monthly item billed (one batch per machine-day)';
