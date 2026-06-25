-- =============================================================================
-- GranaEvo — Rollback: 20260625000001_cleanup_user_data_redundant_policies.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- Recria as políticas redundantes removidas, exatamente como estavam em prod
-- (snapshot pg_policies de 2026-06-25). Idempotente via DROP IF EXISTS + CREATE.
-- =============================================================================

-- Reverte em ordem INVERSA ao UP
DROP POLICY IF EXISTS user_data_owner_select ON public.user_data;
CREATE POLICY user_data_owner_select ON public.user_data
  FOR SELECT TO public
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_data_owner_insert ON public.user_data;
CREATE POLICY user_data_owner_insert ON public.user_data
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
