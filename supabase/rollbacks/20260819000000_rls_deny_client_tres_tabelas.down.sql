-- 20260819000000_rls_deny_client_tres_tabelas.down.sql
-- Rollback: remove as policies deny_client_access das 3 tabelas. Volta ao estado
-- "RLS ligada sem policy" (que ja era deny-all por omissao — seguro).

DROP POLICY IF EXISTS "deny_client_access" ON public.feature_flags;
DROP POLICY IF EXISTS "deny_client_access" ON public.profile_backups;
DROP POLICY IF EXISTS "deny_client_access" ON public.pwa_usage;
