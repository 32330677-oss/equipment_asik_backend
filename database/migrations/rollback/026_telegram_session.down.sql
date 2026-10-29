-- Rollback of 026_telegram_session.sql (the working sessions and the conversation log are lost).
DROP TABLE IF EXISTS tg_chat_log;
DROP TABLE IF EXISTS tg_session;
DELETE FROM schema_migrations WHERE filename = '026_telegram_session.sql';
