-- =============================================================================
-- GranaEvo — Estende purge para incluir usuários Cakto (LGPD Art. 16)
--
-- GOD6-L03: purge_expired_cancelled_accounts (20260507000001) apenas excluía
-- usuários com assinatura Stripe cancelada há 90+ dias.
-- Usuários Cakto com assinatura expirada/cancelada nunca eram purged — gap de
-- conformidade LGPD: dados mantidos indefinidamente após fim do acesso pago.
-- =============================================================================

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
  -- ── Bloco 1: Usuários Stripe com assinatura cancelada há 90+ dias ──────────
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
      -- [GOD6-L03] Não exclui se ainda tem assinatura Cakto ativa
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.subscriptions c
             WHERE  c.user_id   = s.user_id
               AND  c.is_active = true
               AND  c.payment_status = 'approved'
               AND  (c.expires_at IS NULL OR c.expires_at > now())
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data           WHERE user_id = v_user_id;
      DELETE FROM public.profiles            WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                 WHERE id      = v_user_id;
      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Stripe — conta excluída: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Stripe — erro user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  -- ── Bloco 2: Usuários Cakto com assinatura expirada há 90+ dias ──────────
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.subscriptions s
    WHERE  s.user_id IS NOT NULL
      AND  (
        -- Expirado explicitamente
        (s.expires_at IS NOT NULL AND s.expires_at < v_cutoff)
        OR
        -- Inativo/reprovado sem data de expiração há 90+ dias
        (s.is_active = false AND s.payment_status != 'approved' AND s.updated_at < v_cutoff)
      )
      -- Sem outra assinatura Cakto ativa
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.subscriptions s2
             WHERE  s2.user_id   = s.user_id
               AND  s2.is_active = true
               AND  s2.payment_status = 'approved'
               AND  (s2.expires_at IS NULL OR s2.expires_at > now())
           )
      -- Sem Stripe ativo (pode ter migrado de Cakto para Stripe)
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.stripe_subscriptions ss
             WHERE  ss.user_id = s.user_id
               AND  ss.status IN ('active', 'trialing', 'past_due')
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data    WHERE user_id = v_user_id;
      DELETE FROM public.profiles     WHERE user_id = v_user_id;
      DELETE FROM public.subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users          WHERE id       = v_user_id;
      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Cakto — conta excluída: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Cakto — erro user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.purge_expired_cancelled_accounts() IS
  'Exclui permanentemente dados de usuários com acesso pago encerrado há mais de 90 dias '
  '(Stripe cancelado OU Cakto expirado). Executado via pg_cron às 03:00 UTC. '
  'Conforme LGPD Art. 16. Não exclui usuários com qualquer assinatura ainda ativa.';
