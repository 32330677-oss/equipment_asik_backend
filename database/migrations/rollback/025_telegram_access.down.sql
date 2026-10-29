-- Rollback of 025_telegram_access.sql: every supervisor may use the bot again.
DROP TABLE IF EXISTS tg_access;
DELETE FROM schema_migrations WHERE filename = '025_telegram_access.sql';
