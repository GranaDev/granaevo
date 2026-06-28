-- =============================================================================
-- DOWN — reverte 20260628000000_god_mode_polish.sql
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "deny_client_access" ON public.subscriptions_cakto_archive;
DROP POLICY IF EXISTS "deny_client_access" ON public.stripe_events;
DROP POLICY IF EXISTS "deny_client_access" ON public.login_lockouts;
DROP POLICY IF EXISTS "deny_client_access" ON public.edge_rate_limits;

GRANT EXECUTE ON FUNCTION public.can_create_profile() TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
