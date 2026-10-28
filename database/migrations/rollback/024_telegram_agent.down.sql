-- Rollback of 024_telegram_agent.sql (pending proposals, AI log and learned machine names are lost).
DROP TABLE IF EXISTS eq_machine_aliases;
DROP TABLE IF EXISTS tg_agent_log;
DROP TABLE IF EXISTS tg_pending;
DELETE FROM schema_migrations WHERE filename = '024_telegram_agent.sql';
