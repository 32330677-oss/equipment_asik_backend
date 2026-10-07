SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1;
SHOW INDEX FROM eq_attendance WHERE Key_name = 'uq_eqa_live_slot';