-- 026 — Telegram bot: the working session and the conversation log (29 Oct 2026).
--  * tg_session: what the supervisor is working on (the day, the site, the shift) and the open draft, so the next
--    messages add to the same draft. Forgotten after 3 hours without a message.
--  * tg_chat_log: the messages (his text, what was heard from a voice note, button taps, the bot's replies), for the
--    Admin to check mistakes. Kept BOT_KEEP_CHAT_DAYS days (default 30; 0 = nothing kept), then deleted.
-- Nothing existing is changed. Rollback: database/migrations/rollback/026_telegram_session.down.sql
CREATE TABLE IF NOT EXISTS tg_session (
  user_id     INT NOT NULL,
  work_date   DATE NULL,
  site_id     INT NULL,
  shift_type  ENUM('Day','Night') NULL,
  draft_id    INT NULL,
  updated_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_tgs_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tg_chat_log (
  log_id      BIGINT NOT NULL AUTO_INCREMENT,
  user_id     INT NULL,
  chat_id     BIGINT NOT NULL,
  direction   ENUM('in','out') NOT NULL,
  kind        VARCHAR(20) NOT NULL COMMENT 'text | voice | button | bot',
  text        TEXT NULL,
  created_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_tgcl_chat (chat_id, created_at),
  KEY idx_tgcl_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
