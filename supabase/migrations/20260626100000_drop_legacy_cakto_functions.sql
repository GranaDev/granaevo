-- =============================================================================
-- GranaEvo — Remove o split-brain de fonte de plano (M1) + função morta (L4)
-- Rollback: 20260626100000_drop_legacy_cakto_functions.down.sql
--
-- Auditoria god-mode 2026-06-26, confirmada LIVE em 2026-06-26 via Management API:
--   A relação legada `subscriptions` (Cakto) NÃO EXISTE no banco (nem tabela nem
--   view — só `subscriptions_cakto_archive`). Logo NÃO há bypass de RLS: as funções
--   abaixo são DEAD CODE QUEBRADO (erram em runtime "relation subscriptions does
--   not exist"). O sistema vivo de planos é `stripe_subscriptions`
--   (can_create_profile / get_user_access_data).
--
-- Verificado LIVE antes de remover:
--   - 0 triggers usam estas funções (pg_trigger).
--   - 0 referências no código da app / edge functions (grep .rpc + nome).
--   - Único cross-call interno: check_profile_limit -> max_profiles_for_user
--     (par morto auto-contido; check_profile_limit NÃO está anexado a profiles —
--      o limite vivo é o trigger enforce_profile_limit_stripe).
--   - `validate_access_token` tinha EXECUTE para `anon` (oráculo de token) — o DROP
--     remove o grant junto. Como lia `subscriptions`, só errava; não vazava.
--   - revoke_user_access / sync_subscription_user_id também liam `subscriptions`
--     (refund-revoke e sync de user_id ESTAVAM QUEBRADOS). Refund/cancelamento é
--     agora 100% via webhook do Stripe. sync_subscription_user_id é trigger órfão.
--   - cleanup_expired_passwords lia `temp_passwords` (tabela inexistente) — L4.
--
-- cron job #1 (`SELECT expire_pending_payments()`, hourly) vinha errando de hora em
-- hora — removido junto.
-- =============================================================================

-- 1) Desagenda o cron que chamava a função morta (idempotente, por comando)
DO $$
DECLARE j bigint;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%expire_pending_payments%'
  LOOP
    PERFORM cron.unschedule(j);
  END LOOP;
END $$;

-- 2) Dropa as funções legadas Cakto (todas leem a relação inexistente `subscriptions`
--    ou `temp_passwords`). Sem CASCADE: nenhuma tem dependência real (verificado LIVE).
DROP FUNCTION IF EXISTS public.validate_access_token(token_input text);
DROP FUNCTION IF EXISTS public.generate_access_token();
DROP FUNCTION IF EXISTS public.can_upgrade(user_uuid uuid, new_plan_name text);
DROP FUNCTION IF EXISTS public.get_user_subscription(user_uuid uuid);
DROP FUNCTION IF EXISTS public.check_email_payment_status(email_input text);
DROP FUNCTION IF EXISTS public.check_profile_limit();
DROP FUNCTION IF EXISTS public.max_profiles_for_user(uid uuid);
DROP FUNCTION IF EXISTS public.update_user_profile_management();
DROP FUNCTION IF EXISTS public.expire_pending_payments();
DROP FUNCTION IF EXISTS public.revoke_user_access(p_user_id uuid, p_reason text);
DROP FUNCTION IF EXISTS public.sync_subscription_user_id();
DROP FUNCTION IF EXISTS public.cleanup_expired_passwords();
