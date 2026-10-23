-- ============================================================
-- Cobro de intereses de préstamos (entrada real a caja)
-- Fecha: 2026-10-22
--
-- CONTEXTO
--   La migración anterior (20261022_loans_interest.sql) añadió el interés
--   como dato INFORMATIVO: se calculaba y se mostraba, pero no tocaba la
--   caja. Esta migración habilita cobrarlo de verdad.
--
-- QUÉ AÑADE
--   loans.interest_paid  → cuánto interés se ha cobrado ya (acumulado).
--
-- QUÉ NO CAMBIA
--   - loans.total_amount sigue siendo SOLO capital. El interés nunca se
--     suma ahí, para no inflar el patrimonio ni romper los balances
--     históricos de cash_movements (que registraron únicamente el capital).
--   - loan_payments sigue registrando abonos a CAPITAL exclusivamente.
--   - El interés cobrado vive en su propia columna y genera sus propios
--     movimientos de caja (tipo 'loan_interest_received').
--
--   Invariante: 0 <= interest_paid <= interest_amount
--
-- IDEMPOTENTE: se puede ejecutar varias veces sin efectos adversos.
-- ============================================================

BEGIN;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS interest_paid numeric(10,2) NOT NULL DEFAULT 0;

-- El interés cobrado no puede ser negativo ni superar el interés pactado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loans_interest_paid_check'
  ) THEN
    ALTER TABLE loans
      ADD CONSTRAINT loans_interest_paid_check
      CHECK (interest_paid >= 0 AND interest_paid <= interest_amount);
  END IF;
END $$;

-- Índice parcial: sirve para encontrar rápido los préstamos que aún tienen
-- interés por cobrar. Es barato porque la mayoría tendrá 0.
CREATE INDEX IF NOT EXISTS idx_loans_interest_pending
  ON loans (id)
  WHERE interest_amount > 0 AND interest_paid < interest_amount;

COMMENT ON COLUMN loans.interest_paid IS
  'Interés ya cobrado (acumulado). Cada cobro genera su propio movimiento en cash_movements. Nunca se suma a total_amount.';
COMMENT ON COLUMN loans.interest_amount IS
  'Interés total pactado, calculado al crear el préstamo. Informativo hasta que se cobra; el cobro se acumula en interest_paid.';

COMMIT;
