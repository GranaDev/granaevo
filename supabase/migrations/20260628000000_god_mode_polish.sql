-- =============================================================================
-- GranaEvo — Migration: GOD MODE polish (2026-06-28)
-- Endurecimentos cosméticos/defense-in-depth (zera o advisor de RLS).
-- Complementa 20260627000000_god_mode_hardening.sql.
--
--   [GM-04] can_create_profile: revogar EXECUTE de anon (anon nunca insere perfil;
--           authenticated mantém — é usada no WITH CHECK da policy profiles_insert_own).
--
--   [GM-05] Políticas explícitas de negação ao cliente nas tabelas hoje "deny-all
--           implícito" (RLS on, sem policy). Pura camada extra: anon/authenticated
--           não têm grant nessas tabelas, e postgres/service_role têm BYPASSRLS,
--           então crons (postgres) e webhooks (service_role) seguem intactos.
--           Protege contra um GRANT acidental futuro + silencia o lint.
-- =============================================================================

BEGIN;

-- ── [GM-04] ──────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.can_create_profile() FROM anon;

-- ── [GM-05] negação explícita ao cliente ─────────────────────────────────────
CREATE POLICY "deny_client_access" ON public.edge_rate_limits
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_client_access" ON public.login_lockouts
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_client_access" ON public.stripe_events
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "deny_client_access" ON public.subscriptions_cakto_archive
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

NOTIFY pgrst, 'reload schema';

COMMIT;
