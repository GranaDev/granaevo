-- =============================================================================
-- DOWN — reverte 20260628000001_god_mode_polish_fix.sql
-- =============================================================================

BEGIN;

GRANT EXECUTE ON FUNCTION public.can_create_profile() TO PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
