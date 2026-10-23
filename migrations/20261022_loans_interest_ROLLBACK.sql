-- ============================================================
-- ROLLBACK de: 20261022_loans_interest.sql
--
-- Elimina los campos de interés de `loans`.
-- NO toca `cash_movements` ni ninguna otra tabla: como el interés
-- nunca generó movimientos de caja, quitar estas columnas deja los
-- balances exactamente igual que antes de la migración.
--
-- ADVERTENCIA: se pierde el interés guardado en los préstamos que lo
-- tengan. Respalda antes:
--   pg_dump -Fc vantix_store > backup.dump
-- ============================================================

BEGIN;

ALTER TABLE loans
  DROP CONSTRAINT IF EXISTS loans_interest_type_check,
  DROP CONSTRAINT IF EXISTS loans_interest_rate_check,
  DROP CONSTRAINT IF EXISTS loans_term_months_check,
  DROP CONSTRAINT IF EXISTS loans_interest_amount_check;

ALTER TABLE loans
  DROP COLUMN IF EXISTS interest_amount,
  DROP COLUMN IF EXISTS term_months,
  DROP COLUMN IF EXISTS interest_type,
  DROP COLUMN IF EXISTS interest_rate;

COMMIT;
