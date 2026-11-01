-- 027 — The currency of what an invoice covers (31 Oct 2026).
--  eq_invoice_coverage.currency: the currency of the invoice that covers the period. NULL (every row that exists now)
--  = covers every currency, exactly as before. New rows get the invoice currency, so an invoice in one currency no
--  longer blocks the same machine in another currency over the same days.
-- Nothing existing changes. Rollback: database/migrations/rollback/027_coverage_currency.down.sql
ALTER TABLE eq_invoice_coverage
  ADD COLUMN currency CHAR(3) NULL COMMENT 'Currency of the invoice; NULL = every currency (rows made before 31 Oct 2026)';
