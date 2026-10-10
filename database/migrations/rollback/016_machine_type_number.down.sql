-- Rollback of 016_machine_type_number.sql
ALTER TABLE eq_equipment DROP INDEX uq_eqe_vendor_type_seq, DROP COLUMN machine_label, DROP COLUMN type_seq;
DELETE FROM schema_migrations WHERE filename = '016_machine_type_number.sql';
