-- Rollback of 015_vendor_type.sql (the national IDs typed since are lost).
ALTER TABLE eq_vendors DROP COLUMN national_id, DROP COLUMN vendor_type;
DELETE FROM schema_migrations WHERE filename = '015_vendor_type.sql';
