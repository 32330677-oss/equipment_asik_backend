-- Rollback of 023_telegram_bot.sql: removes the Telegram links (supervisors link again after a re-run).
DROP TABLE IF EXISTS tg_link_codes;
DROP TABLE IF EXISTS tg_links;
DELETE FROM schema_migrations WHERE filename = '023_telegram_bot.sql';
