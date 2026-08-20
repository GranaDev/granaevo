-- 20260819000000_rls_deny_client_tres_tabelas.sql
-- Completa o padrao de RLS nas 3 tabelas que tinham RLS + FORCE mas NENHUMA
-- policy (advisor rls_enabled_no_policy, nivel INFO): feature_flags,
-- profile_backups, pwa_usage.
--
-- ESTADO ANTES DESTA MIGRATION (verificado em 2026-08-19):
--   • As 3 tabelas NAO concedem grant a authenticated/anon (so postgres +
--     service_role). O cliente ja nao as alcancava.
--   • service_role tem BYPASSRLS = true -> as edge functions escrevem nelas
--     ignorando RLS. authenticated/anon tem BYPASSRLS = false.
--
-- POR QUE MESMO ASSIM VALE A PENA:
--   RLS ligada SEM policy e' "nego tudo por omissao" — correto, mas implicito.
--   O projeto ja padronizou o "nego tudo EXPLICITO" via policy deny_client_access
--   em edge_rate_limits, stripe_events, login_lockouts, signup_email_codes,
--   subscriptions_cakto_archive e chat_parse_usage. Estas 3 eram as unicas fora
--   do padrao. Tornar a intencao explicita documenta o contrato e silencia o
--   linter, que e o unico jeito de "sem policy por engano" nao se confundir com
--   "sem policy de proposito" numa auditoria futura.
--
-- IMPACTO FUNCIONAL: ZERO. service_role bypassa RLS (edges intactas);
-- authenticated/anon ja estavam negados por falta de grant e agora ficam
-- negados tambem pela policy (dupla negacao, mesma resposta).

DROP POLICY IF EXISTS "deny_client_access" ON public.feature_flags;
CREATE POLICY "deny_client_access" ON public.feature_flags
  FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_client_access" ON public.profile_backups;
CREATE POLICY "deny_client_access" ON public.profile_backups
  FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_client_access" ON public.pwa_usage;
CREATE POLICY "deny_client_access" ON public.pwa_usage
  FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
