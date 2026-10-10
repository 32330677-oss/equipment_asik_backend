-- 016: every machine gets a FIXED number inside its vendor + type ("Excavator #3"), shown everywhere next to its code
-- so a supervisor does not record a day on the wrong machine of the same type and vendor.
-- Existing machines are numbered by their code (the older code gets #1). A number is never reused or changed:
-- a released machine keeps its number, a new machine takes the next one.
-- Additive only. Rollback: database/migrations/rollback/016_machine_type_number.down.sql
ALTER TABLE eq_equipment
  ADD COLUMN type_seq INT NULL COMMENT 'Fixed number of the machine inside its vendor + type (1, 2, 3...)' AFTER type_id,
  ADD COLUMN machine_label VARCHAR(140) NULL COMMENT 'Type name + number, e.g. Excavator #3 (refreshed when the type is renamed)' AFTER type_seq;

UPDATE eq_equipment e
  JOIN (SELECT equipment_id, ROW_NUMBER() OVER (PARTITION BY vendor_id, type_id ORDER BY equipment_code, equipment_id) AS n FROM eq_equipment) x
    ON x.equipment_id = e.equipment_id
  JOIN eq_types t ON t.type_id = e.type_id
  SET e.type_seq = x.n, e.machine_label = CONCAT(t.type_name, ' #', x.n);

ALTER TABLE eq_equipment ADD UNIQUE KEY uq_eqe_vendor_type_seq (vendor_id, type_id, type_seq);
