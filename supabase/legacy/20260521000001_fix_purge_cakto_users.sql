-- =============================================================================
-- CORREÇÃO CRÍTICA: purge_unpaid_accounts e purge_expired_cancelled_accounts
-- não verificavam a tabela `subscriptions` (Cakto), apenas `stripe_subscriptions`.
--
-- Efeito: usuários com assinatura Cakto ativa (sem registro Stripe) tinham
-- suas contas auth.users deletadas como "não pagantes", corrompendo o fluxo
-- de login e reset de senha.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. purge_unpaid_accounts — agora exclui CAKTO do critério de purge
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE u.created_at < v_cutoff
      -- Nunca teve assinatura Stripe paga ou em andamento
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
      -- CORREÇÃO: também protege usuários com assinatura Cakto ativa
      AND NOT EXISTS (
        SELECT 1 FROM public.subscriptions s
        WHERE (s.user_id = u.id OR lower(s.user_email) = lower(u.email))
          AND s.is_active = true
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data        WHERE user_id       = v_user_id;
      DELETE FROM public.profiles         WHERE user_id       = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id  = v_user_id;
      DELETE FROM auth.users              WHERE id            = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_unpaid] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_unpaid] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_unpaid] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. purge_expired_cancelled_accounts — também protege usuários Cakto
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id   UUID;
  v_count     integer := 0;
  v_cutoff    TIMESTAMPTZ := NOW() - INTERVAL '90 days';
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      -- Sem assinatura Stripe ativa
      AND  NOT EXISTS (
             SELECT 1 FROM public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
      -- CORREÇÃO: também protege usuários com assinatura Cakto ativa
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.subscriptions c
             JOIN   auth.users u ON lower(u.email) = lower(c.user_email)
             WHERE  (c.user_id = s.user_id OR u.id = s.user_id)
               AND  c.is_active = true
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data            WHERE user_id = v_user_id;
      DELETE FROM public.profiles             WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                  WHERE id      = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$$;
