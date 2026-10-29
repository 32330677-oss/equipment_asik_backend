-- 025 — Telegram bot: the Admin can switch the bot off for one supervisor (29 Oct 2026).
-- Open by default: a supervisor with NO row here may use the bot; a row with allowed = 0 blocks him
-- (he cannot link, and a linked chat gets "switched off by the office" and nothing is read or recorded).
-- Rollback: database/migrations/rollback/025_telegram_access.down.sql
CREATE TABLE IF NOT EXISTS tg_access (
  user_id             INT NOT NULL,
  allowed             TINYINT(1) NOT NULL DEFAULT 1,
  reason              VARCHAR(500) NULL,
  changed_by_user_id  INT NULL,
  changed_at          TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_tga_user FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT fk_tga_by FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
