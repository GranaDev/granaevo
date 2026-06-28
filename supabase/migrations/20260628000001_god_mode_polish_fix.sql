-- =============================================================================
-- GranaEvo — Migration: GOD MODE polish FIX (2026-06-28)
-- Corrige [GM-04] da 20260628000000: REVOKE FROM anon foi no-op porque anon
-- herda EXECUTE via PUBLIC. O correto é revogar de PUBLIC. authenticated mantém
-- o grant explícito (necessário no WITH CHECK da policy profiles_insert_own).
-- =============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION public.can_create_profile() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
