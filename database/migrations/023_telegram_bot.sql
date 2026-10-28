-- 023 — Telegram bot for site supervisors (phase 2: linking only; 28 Oct 2026).
--
--  * A supervisor links his own Telegram chat from the app: a one-time code (only its SHA-256 is stored) that the
--    bot receives as "/start <code>". One chat = one account; one account = one chat.
--  * The bot never writes attendance SQL: it calls the same API routes as the app, as the supervisor himself.
--  * Nothing existing is changed. Rollback: database/migrations/rollback/023_telegram_bot.down.sql
CREATE TABLE IF NOT EXISTS tg_links (
  user_id            INT NOT NULL,
  chat_id            BIGINT NULL COMMENT 'NULL = not linked now (the language is kept)',
  telegram_username  VARCHAR(100) NULL,
  language           ENUM('ar','en') NOT NULL DEFAULT 'ar',
  linked_at          DATETIME NULL,
  created_at         TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_tgl_chat (chat_id),
  CONSTRAINT fk_tgl_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tg_link_codes (
  code_hash   CHAR(64) NOT NULL,
  user_id     INT NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code_hash),
  KEY idx_tglc_user (user_id),
  CONSTRAINT fk_tglc_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
