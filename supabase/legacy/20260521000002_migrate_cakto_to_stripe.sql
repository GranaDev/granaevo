-- =============================================================================
-- GranaEvo — Migração definitiva: Cakto → Stripe
--
-- O que esta migration faz:
--   1. Para cada usuário com assinatura Cakto ativa (subscriptions.is_active=true),
--      cria uma entrada em stripe_subscriptions com status='active' e
--      current_period_end='2099-12-31' (acesso vitalício).
--
--   2. Usuários que já têm stripe_subscriptions ativa são pulados (sem duplicata).
--
--   3. Usuários sem conta em auth.users (auth deletado por purge inconsistente)
--      recebem uma entrada sem user_id (preserva o acesso futuro caso a conta
--      seja recriada via auto-link por email).
--
--   4. Renomeia subscriptions → subscriptions_cakto_archive (preserva histórico).
--
--   5. Atualiza purge_unpaid_accounts e purge_expired_cancelled_accounts para
--      não mais referenciar subscriptions (agora arquivada).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Migração dos dados Cakto → stripe_subscriptions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_row        RECORD;
  v_user_id    UUID;
  v_plan_name  TEXT;
  v_migrated   INTEGER := 0;
  v_skipped    INTEGER := 0;
  v_no_account INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.user_id,
      s.user_email,
      s.created_at,
      COALESCE(p.name, 'vitalício') AS resolved_plan_name
    FROM public.subscriptions s
    LEFT JOIN public.plans p ON p.id = s.plan_id
    WHERE s.is_active      = true
      AND s.payment_status = 'approved'
  LOOP
    -- Resolver user_id: usar o salvo, ou buscar por email em auth.users
    v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      SELECT id INTO v_user_id
      FROM auth.users
      WHERE lower(email) = lower(v_row.user_email)
      LIMIT 1;
    END IF;

    v_plan_name := v_row.resolved_plan_name;

    -- Pular se já tem stripe_subscriptions ativa para este user
    IF v_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.stripe_subscriptions
      WHERE user_id = v_user_id
        AND status IN ('active', 'trialing')
    ) THEN
      v_skipped := v_skipped + 1;
      RAISE LOG '[cakto_migrate] Pulado (já tem Stripe ativa) — user_id: %', LEFT(v_user_id::text, 8);
      CONTINUE;
    END IF;

    -- Pular também por email se não temos user_id
    IF v_user_id IS NULL AND EXISTS (
      SELECT 1 FROM public.stripe_subscriptions
      WHERE lower(user_email) = lower(v_row.user_email)
        AND status IN ('active', 'trialing')
    ) THEN
      v_skipped := v_skipped + 1;
      RAISE LOG '[cakto_migrate] Pulado por email (já tem Stripe ativa) — email: %', LEFT(v_row.user_email, 20);
      CONTINUE;
    END IF;

    IF v_user_id IS NULL THEN
      v_no_account := v_no_account + 1;
      RAISE WARNING '[cakto_migrate] Sem conta auth para % — criando entrada sem user_id', LEFT(v_row.user_email, 30);
    END IF;

    -- Inserir em stripe_subscriptions como usuário vitalício migrado do Cakto
    INSERT INTO public.stripe_subscriptions (
      user_id,
      user_email,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      plan_name,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      created_at,
      updated_at
    ) VALUES (
      v_user_id,
      lower(v_row.user_email),
      'cakto_migrated_' || v_row.id::text,   -- placeholder único por subscription
      'cakto_sub_'      || v_row.id::text,   -- placeholder rastreável
      'price_cakto_lifetime',                 -- identificador semântico
      v_plan_name,
      'active',
      COALESCE(v_row.created_at, NOW()),
      '2099-12-31 23:59:59+00',              -- acesso vitalício
      FALSE,
      COALESCE(v_row.created_at, NOW()),
      NOW()
    )
    ON CONFLICT (stripe_customer_id) DO NOTHING;

    v_migrated := v_migrated + 1;
    RAISE LOG '[cakto_migrate] Migrado — email: %, plan: %',
      LEFT(v_row.user_email, 20), v_plan_name;
  END LOOP;

  RAISE LOG '[cakto_migrate] Concluído: % migrados, % pulados (já tinham Stripe), % sem conta auth',
    v_migrated, v_skipped, v_no_account;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Arquivar tabela subscriptions → subscriptions_cakto_archive
-- ---------------------------------------------------------------------------

-- Remove constraint de FK na tabela account_members se existir referência a subscriptions
-- (provavelmente não existe, mas por segurança)

-- Renomeia a tabela principal
ALTER TABLE public.subscriptions RENAME TO subscriptions_cakto_archive;

-- Mantém RLS mas bloqueia todo acesso externo — apenas service_role pode ler para auditoria
ALTER TABLE public.subscriptions_cakto_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions_cakto_archive FORCE ROW LEVEL SECURITY;

-- Remove políticas existentes que podem ter nomes variados
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'subscriptions_cakto_archive' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.subscriptions_cakto_archive', pol.policyname);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.subscriptions_cakto_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.subscriptions_cakto_archive FROM anon;
REVOKE ALL ON TABLE public.subscriptions_cakto_archive FROM authenticated;
GRANT  SELECT ON TABLE public.subscriptions_cakto_archive TO service_role;

COMMENT ON TABLE public.subscriptions_cakto_archive IS
  'Arquivo histórico das assinaturas Cakto. Migradas para stripe_subscriptions '
  'em 2026-05-21. Somente leitura via service_role para auditoria.';

-- ---------------------------------------------------------------------------
-- 3. Atualizar purge_unpaid_accounts — remove referência a subscriptions
--    (agora renomeada). Verifica apenas stripe_subscriptions.
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
      -- Nunca teve assinatura Stripe paga (inclui usuários Cakto migrados, pois
      -- agora todos estão em stripe_subscriptions com status 'active')
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members   WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members   WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data         WHERE user_id        = v_user_id;
      DELETE FROM public.profiles          WHERE user_id        = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id    = v_user_id;
      DELETE FROM auth.users               WHERE id             = v_user_id;

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
-- 4. Atualizar purge_expired_cancelled_accounts — idem
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
      -- Sem nenhuma assinatura ativa no mesmo user (inclui vitalícios Cakto migrados)
      AND  NOT EXISTS (
             SELECT 1 FROM public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
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
