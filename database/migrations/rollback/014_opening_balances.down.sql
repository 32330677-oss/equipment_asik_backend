-- Rollback of 014_opening_balances.sql. Run only when no carried balance uses an opening balance
-- (void the batches that carried them first), otherwise from_batch_id cannot become NOT NULL again.
ALTER TABLE eq_payment_carryovers
  DROP CHECK chk_eqco_source,
  DROP FOREIGN KEY fk_eqco_opening,
  DROP KEY idx_eqco_opening,
  DROP COLUMN opening_balance_id;
DELETE FROM eq_payment_carryovers WHERE from_batch_id IS NULL;
ALTER TABLE eq_payment_carryovers MODIFY from_batch_id INT NOT NULL;
DROP TABLE IF EXISTS eq_opening_balances;
DELETE FROM schema_migrations WHERE filename = '014_opening_balances.sql';
