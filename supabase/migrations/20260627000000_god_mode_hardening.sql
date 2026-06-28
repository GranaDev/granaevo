-- =============================================================================
-- GranaEvo — Migration: GOD MODE hardening (2026-06-27)
-- Gerada pela auditoria /god-mode (MCP read-only). REVISAR antes de aplicar.
--
-- Corrige 2 vetores CONFIRMADOS por evidência no banco de produção + cruft de RPC.
--
--   [GM-01] ESCALADA DE PLANO via stripe_subscriptions (authenticated)
--           authenticated tinha UPDATE table-wide + policy stripe_sub_update_claim
--           cujo WITH CHECK só validava user_id. Durante o "claim"
--           (user_id IS NULL e e-mail confere) o cliente podia, no MESMO UPDATE,
--           reescrever plan_name / status / current_period_end e se auto-conceder
--           o plano mais alto de forma permanente (get_user_access_data e
--           can_create_profile leem esses campos como fonte de entitlement).
--           O auto-link legítimo é feito server-side pela edge function
--           link-user-subscription (service_role, atualiza SÓ user_id), portanto
--           a superfície de UPDATE no cliente é desnecessária → REMOVER.
--
--   [GM-02] EXECUÇÃO NÃO AUTENTICADA de funções SECURITY DEFINER destrutivas
--           Estas funções tinham EXECUTE para PUBLIC (anon/authenticated) e são
--           expostas como RPC em /rest/v1/rpc/<fn>. Rodam como postgres
--           (SECURITY DEFINER) e ignoram RLS:
--             cleanup_abandoned_accounts    → apaga contas + auth.users
--             purge_audit_log_retention     → apaga financial_audit_log (>6m) e
--                                              burla a trigger de imutabilidade
--             cleanup_expired_rate_limits   → zera rate limits (amplifica brute force)
--             cleanup_push_subscriptions    → apaga push subscriptions
--             identificar_dados_para_retencao → varredura de PII
--           (purge_unpaid_accounts, purge_expired_cancelled_accounts e
--            take_daily_snapshot JÁ estavam corretamente revogadas — padronizar.)
--
--   [GM-03] Cruft de RPC: trigger functions expostas como RPC (sem uso legítimo).
-- =============================================================================

BEGIN;

-- ── [GM-01] Remover a superfície de UPDATE no cliente em stripe_subscriptions ──
--   service_role (edge function link-user-subscription) continua escrevendo
--   normalmente porque possui BYPASSRLS.
DROP POLICY IF EXISTS "stripe_sub_update_claim" ON public.stripe_subscriptions;
REVOKE UPDATE ON public.stripe_subscriptions FROM authenticated;

-- ── [GM-02] Revogar EXECUTE de funções de manutenção/cron (cron-only) ─────────
REVOKE EXECUTE ON FUNCTION public.cleanup_abandoned_accounts()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_audit_log_retention()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_rate_limits()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_push_subscriptions()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.identificar_dados_para_retencao() FROM PUBLIC, anon, authenticated;

-- ── [GM-03] Trigger functions não devem ser chamáveis como RPC ───────────────
REVOKE EXECUTE ON FUNCTION public.enforce_profile_limit_stripe()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_profile_user_id()             FROM PUBLIC, anon, authenticated;

-- Recarrega o schema cache do PostgREST
NOTIFY pgrst, 'reload schema';

COMMIT;
