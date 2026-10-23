-- ============================================================
-- Migración: interés en préstamos (rentabilidad)
-- Fecha: 2026-10-22
--
-- QUÉ HACE
--   Agrega 4 columnas a `loans` para guardar el interés pactado de un
--   préstamo y poder simular/mostrar la ganancia estimada.
--
-- IMPORTANTE (contabilidad)
--   `total_amount` SIGUE SIENDO EL CAPITAL PURO. Estas columnas son
--   informativas: NO generan movimientos en `cash_movements` y NO
--   alteran ningún balance existente.
--
--   La caja solo se mueve cuando el dinero se mueve de verdad (desembolso
--   y abonos), que es lo que ya hacen createLoan / registerLoanPayment.
--
-- SEGURIDAD
--   - Idempotente: se puede correr varias veces sin efecto (IF NOT EXISTS).
--   - Los préstamos existentes quedan con interest_rate = 0 e
--     interest_amount = 0 → comportamiento idéntico al de hoy.
--   - Todo dentro de una transacción.
--
-- ROLLBACK
--   Ver migrations/20261022_loans_interest_ROLLBACK.sql
-- ============================================================

BEGIN;

-- 1) Campos nuevos -------------------------------------------------
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS interest_rate   numeric(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_type   varchar(10)   NOT NULL DEFAULT 'simple',
  ADD COLUMN IF NOT EXISTS term_months     integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_amount numeric(10,2) NOT NULL DEFAULT 0;

-- 2) Restricciones (se agregan solo si no existen) -----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loans_interest_type_check'
  ) THEN
    ALTER TABLE loans
      ADD CONSTRAINT loans_interest_type_check
      CHECK (interest_type IN ('simple', 'mensual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loans_interest_rate_check'
  ) THEN
    ALTER TABLE loans
      ADD CONSTRAINT loans_interest_rate_check
      CHECK (interest_rate >= 0 AND interest_rate <= 1000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loans_term_months_check'
  ) THEN
    ALTER TABLE loans
      ADD CONSTRAINT loans_term_months_check
      CHECK (term_months >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loans_interest_amount_check'
  ) THEN
    ALTER TABLE loans
      ADD CONSTRAINT loans_interest_amount_check
      CHECK (interest_amount >= 0);
  END IF;
END $$;

-- 3) Documentación de columnas ------------------------------------
COMMENT ON COLUMN loans.interest_rate   IS 'Porcentaje de interés pactado (0 = sin interés). No afecta caja.';
COMMENT ON COLUMN loans.interest_type   IS 'simple = una vez sobre el capital | mensual = por mes durante term_months.';
COMMENT ON COLUMN loans.term_months     IS 'Plazo en meses usado para calcular el interés.';
COMMENT ON COLUMN loans.interest_amount IS 'Interés total congelado al confirmar (informativo, no contable).';

COMMIT;
