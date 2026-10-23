-- ============================================================
-- ROLLBACK de 20261022_loans_interest_paid.sql
--
-- ATENCIÓN: eliminar interest_paid BORRA el registro de cuánto interés se
-- ha cobrado. Los movimientos de caja del interés SÍ se conservan (viven en
-- cash_movements), pero se pierde el vínculo de cuánto falta por cobrar.
--
-- Antes de ejecutar, guarda un respaldo:
--   pg_dump -Fc vantix_store > respaldo_antes_de_rollback.dump
-- ============================================================

BEGIN;

-- Solo procede si nadie ha cobrado intereses todavía. Si ya hay cobros,
-- este bloque aborta el rollback para no perder información.
DO $$
DECLARE
  cobrados integer;
BEGIN
  SELECT count(*) INTO cobrados FROM loans WHERE interest_paid > 0;
  IF cobrados > 0 THEN
    RAISE EXCEPTION
      'Hay % préstamo(s) con interés ya cobrado. Eliminar la columna perdería ese registro. Revísalo antes de continuar.', cobrados;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_loans_interest_pending;

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_interest_paid_check;
ALTER TABLE loans DROP COLUMN IF EXISTS interest_paid;

COMMIT;
