-- 010: an Accountant cannot void or replace a FINALIZED batch alone (when only the Admin closes payroll):
-- the request waits here until an Admin approves (the action then runs) or rejects it.
CREATE TABLE IF NOT EXISTS eq_batch_requests (
  request_id       INT NOT NULL AUTO_INCREMENT,
  eq_batch_id      INT NOT NULL,
  action           ENUM('void','supersede') NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  accept_blockers  TINYINT(1) NOT NULL DEFAULT 0,
  status           ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  requested_by_user_id INT NOT NULL,
  requested_at     DATETIME NOT NULL,
  decided_by_user_id INT NULL,
  decided_at       DATETIME NULL,
  decision_note    VARCHAR(500) NULL,
  result_batch_id  INT NULL COMMENT 'New version created on approval of a supersede',
  PRIMARY KEY (request_id),
  KEY idx_eqbr_batch (eq_batch_id, status),
  CONSTRAINT fk_eqbr_batch FOREIGN KEY (eq_batch_id) REFERENCES eq_payroll_batches (eq_batch_id),
  CONSTRAINT fk_eqbr_req_by FOREIGN KEY (requested_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_eqbr_dec_by FOREIGN KEY (decided_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
