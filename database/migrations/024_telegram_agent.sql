-- 024 — Telegram bot, phase 3: recording by text / voice (28 Oct 2026).
--  * tg_pending: what the bot proposed and waits for the supervisor to confirm (nothing is written before).
--  * tg_agent_log: one row per message read by the AI (model, time, result) for cost and the daily limit.
--    The text of the message is NOT kept.
--  * eq_machine_aliases: what a supervisor calls a machine ("البوكلين الكبير"), learned from his answers.
-- Nothing existing is changed. Rollback: database/migrations/rollback/024_telegram_agent.down.sql
CREATE TABLE IF NOT EXISTS tg_pending (
  pending_id   INT NOT NULL AUTO_INCREMENT,
  user_id      INT NOT NULL,
  chat_id      BIGINT NOT NULL,
  payload      JSON NOT NULL,
  status       ENUM('Open','Done','Cancelled','Expired') NOT NULL DEFAULT 'Open',
  message_id   BIGINT NULL COMMENT 'the bot message that shows the proposal',
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pending_id),
  KEY idx_tgp_user (user_id, status),
  CONSTRAINT fk_tgp_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tg_agent_log (
  log_id       BIGINT NOT NULL AUTO_INCREMENT,
  user_id      INT NOT NULL,
  kind         VARCHAR(20) NOT NULL COMMENT 'text | voice | second_look',
  model        VARCHAR(60) NULL,
  ok           TINYINT(1) NOT NULL DEFAULT 1,
  error_code   VARCHAR(30) NULL,
  latency_ms   INT NULL,
  input_tokens INT NULL,
  output_tokens INT NULL,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_tgal_user_day (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS eq_machine_aliases (
  alias_id      INT NOT NULL AUTO_INCREMENT,
  user_id       INT NOT NULL COMMENT 'the supervisor who uses this name',
  alias_text    VARCHAR(120) NOT NULL COMMENT 'normalized words he said',
  equipment_id  INT NOT NULL,
  created_at    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alias_id),
  UNIQUE KEY uq_ema_user_alias (user_id, alias_text),
  KEY idx_ema_machine (equipment_id),
  CONSTRAINT fk_ema_user FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT fk_ema_machine FOREIGN KEY (equipment_id) REFERENCES eq_equipment (equipment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
