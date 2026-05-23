-- =============================================================================
-- GranaEvo — Correção definitiva: remove TODAS as referências a subscriptions
--
-- Contexto: após migration 20260521000002 (subscriptions → subscriptions_cakto_archive),
-- vários objetos ainda referenciam o nome antigo. Este script:
--   1. DROP + RECREATE can_create_profile() (garante body limpo mesmo que
--      CREATE OR REPLACE anterior não tenha persistido por algum motivo)
--   2. Recria a RLS policy profiles_insert_own sem ambiguidade
--   3. Corrige cleanup_abandoned_accounts() que ainda usa subscriptions
--   4. Verifica e confirma que não há mais referências ao nome antigo
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REMOVE a policy que depende de can_create_profile() para poder recriar
--    a função com DROP/CREATE (evita dependência circular)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DROP + RECREATE can_create_profile()
--    Usa DROP explícito para garantir que qualquer versão antiga é removida
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.can_create_profile();

CREATE FUNCTION public.can_create_profile()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id      uuid := auth.uid();
    v_user_email   text := lower(auth.jwt() ->> 'email');
    v_profile_count int;
    v_plan_name    text;
    v_max_profiles int;
BEGIN
    IF v_user_id IS NULL THEN RETURN false; END IF;

    SELECT COUNT(*) INTO v_profile_count
    FROM public.profiles
    WHERE user_id = v_user_id;

    -- 1. Plano via Stripe por user_id (inclui Cakto migrados com period_end=2099)
    SELECT lower(plan_name) INTO v_plan_name
    FROM public.stripe_subscriptions
    WHERE user_id = v_user_id
      AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end > now())
    ORDER BY created_at DESC LIMIT 1;

    -- 2. Plano via Stripe por email (user_id ainda não vinculado)
    IF v_plan_name IS NULL AND v_user_email IS NOT NULL THEN
        SELECT lower(plan_name) INTO v_plan_name
        FROM public.stripe_subscriptions
        WHERE lower(user_email) = v_user_email
          AND status IN ('active', 'trialing')
          AND (current_period_end IS NULL OR current_period_end > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    -- 3. Membership (convidado — herda limite do dono via stripe_subscriptions)
    IF v_plan_name IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan_name
        FROM public.account_members am
        JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
        WHERE am.member_user_id = v_user_id
          AND am.is_active = true
          AND ss.status IN ('active', 'trialing')
          AND (ss.current_period_end IS NULL OR ss.current_period_end > now())
        ORDER BY ss.created_at DESC
        LIMIT 1;
    END IF;

    v_max_profiles := CASE v_plan_name
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1
    END;

    RETURN v_profile_count < v_max_profiles;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_create_profile() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Recria a RLS policy de INSERT com can_create_profile() atualizado
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND can_create_profile()
  );

COMMENT ON POLICY "profiles_insert_own" ON public.profiles IS
  'Usuário só insere perfil com user_id = auth.uid() e dentro do limite do plano. '
  'can_create_profile() verifica apenas stripe_subscriptions (Cakto migrado incluso).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Corrige cleanup_abandoned_accounts() — ainda referenciava subscriptions
--    (cron job de 3h UTC — não afeta criação de perfil, mas previne falha do cron)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_abandoned_accounts()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    v_id          UUID;
BEGIN
    FOR v_id IN
        SELECT u.id
        FROM auth.users u
        WHERE u.created_at < NOW() - INTERVAL '3 days'
          AND u.email NOT LIKE '%@granaevo.com'
          -- Sem assinatura Stripe ativa (inclui Cakto migrado)
          AND NOT EXISTS (
              SELECT 1 FROM public.stripe_subscriptions ss
              WHERE ss.user_id = u.id
                AND ss.status IN ('active', 'trialing')
          )
          -- Sem dados de uso no app
          AND NOT EXISTS (
              SELECT 1 FROM public.user_data ud
              WHERE ud.user_id = u.id
          )
    LOOP
        DELETE FROM public.terms_acceptance  WHERE user_id = v_id;
        DELETE FROM public.user_data         WHERE user_id = v_id;
        DELETE FROM public.account_members
            WHERE member_user_id = v_id
               OR owner_user_id  = v_id;
        DELETE FROM public.stripe_subscriptions WHERE user_id = v_id;
        DELETE FROM auth.users WHERE id = v_id;

        deleted_count := deleted_count + 1;
    END LOOP;

    -- Limpa stripe_subscriptions sem usuário, inativas e antigas
    DELETE FROM public.stripe_subscriptions
    WHERE user_id IS NULL
      AND status NOT IN ('active', 'trialing')
      AND created_at < NOW() - INTERVAL '3 days';

    -- Limpa eventos Stripe expirados (idempotência > 90 dias)
    DELETE FROM public.stripe_events
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RAISE NOTICE '[cleanup] % usuário(s) abandonado(s) removido(s).', deleted_count;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificação: RAISE EXCEPTION se ainda houver referências a "subscriptions"
--    nas funções corrigidas (falha rápida e visível no log de migração)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_body text;
    v_fn   text;
BEGIN
    FOR v_fn, v_body IN
        SELECT proname, prosrc
        FROM pg_proc
        WHERE proname IN ('can_create_profile', 'cleanup_abandoned_accounts')
          AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    LOOP
        IF v_body ~* '\bsubscriptions\b' AND v_body !~* 'stripe_subscriptions|subscriptions_cakto_archive' THEN
            RAISE EXCEPTION '[fix_all_subscriptions_refs] AINDA há referência a "subscriptions" em %(): %',
                v_fn, left(v_body, 300);
        END IF;
    END LOOP;
    RAISE NOTICE '[fix_all_subscriptions_refs] Verificação OK — nenhuma função referencia "subscriptions" diretamente.';
END $$;
