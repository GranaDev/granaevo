-- =============================================================================
-- Recria can_create_profile() para verificar Cakto + Stripe
-- A versão anterior só verificava a tabela subscriptions (Cakto).
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

    -- 1. Plano via Cakto (subscriptions) por user_id
    SELECT lower(p.name) INTO v_plan_name
    FROM public.subscriptions s
    JOIN public.plans p ON p.id = s.plan_id
    WHERE s.user_id = v_user_id
      AND s.is_active = true
      AND s.payment_status = 'approved'
      AND (s.expires_at IS NULL OR s.expires_at > now())
    LIMIT 1;

    -- 2. Plano via Stripe por user_id
    IF v_plan_name IS NULL THEN
        SELECT lower(plan_name) INTO v_plan_name
        FROM public.stripe_subscriptions
        WHERE user_id = v_user_id
          AND status IN ('active', 'trialing')
          AND (current_period_end IS NULL OR current_period_end > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    -- 3. Plano via Stripe por email (ainda não vinculado)
    IF v_plan_name IS NULL AND v_user_email IS NOT NULL THEN
        SELECT lower(plan_name) INTO v_plan_name
        FROM public.stripe_subscriptions
        WHERE lower(user_email) = v_user_email
          AND status IN ('active', 'trialing')
          AND (current_period_end IS NULL OR current_period_end > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    -- 4. Membership (convidado — herda limite do dono)
    IF v_plan_name IS NULL THEN
        SELECT lower(p.name) INTO v_plan_name
        FROM public.account_members am
        JOIN public.subscriptions s ON s.user_id = am.owner_user_id
        JOIN public.plans p ON p.id = s.plan_id
        WHERE am.member_user_id = v_user_id
          AND am.is_active = true
          AND s.is_active = true
          AND s.payment_status = 'approved'
          AND (s.expires_at IS NULL OR s.expires_at > now())
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
