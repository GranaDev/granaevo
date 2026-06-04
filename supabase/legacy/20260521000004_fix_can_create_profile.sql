-- =============================================================================
-- GranaEvo — Corrige can_create_profile() após migração Cakto → Stripe
--
-- Problema: a migration 20260521000002 renomeou public.subscriptions para
-- subscriptions_cakto_archive, mas can_create_profile() ainda referencia
-- public.subscriptions nos passos 1 e 4, causando 42P01 ao criar perfil.
--
-- Solução: remove todas as referências a public.subscriptions e usa apenas
-- stripe_subscriptions (que agora contém todos os planos, incluindo Cakto
-- migrados com status='active' e current_period_end='2099-12-31').
-- =============================================================================

CREATE OR REPLACE FUNCTION public.can_create_profile()
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

    -- 1. Plano via Stripe por user_id (inclui usuários Cakto migrados)
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
