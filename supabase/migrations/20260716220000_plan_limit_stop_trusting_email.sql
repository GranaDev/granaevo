-- ============================================================================
-- As DUAS funções de limite de perfil ainda confiavam em e-mail (e em NULL)
--
-- Achadas numa varredura de confirmação, DEPOIS das migrations 20260716180000
-- (NULL = acesso eterno) e 20260716200000 (tomada de assinatura por e-mail).
-- Aquelas duas só consertaram `get_user_access_data`. Estas ficaram para trás e
-- carregavam OS DOIS bugs — e as duas são SECURITY DEFINER, ou seja, ignoram RLS:
--
--   can_create_profile()          -- RPC chamável por qualquer authenticated
--   enforce_profile_limit_stripe() -- trigger de INSERT em profiles
--
-- BUG 1 — confia em e-mail:
--   can_create_profile:        WHERE lower(user_email) = lower(auth.jwt()->>'email')
--   enforce_profile_limit:     WHERE (ss.user_id = NEW.user_id
--                                     OR lower(ss.user_email) = lower(<email do user>))
--   `/api/create-account` usa `admin.createUser({ email_confirm: true })`: a conta
--   nasce confirmada, sem verificação e sem checagem de pagamento. Logo o e-mail
--   NÃO prova posse. Quem se cadastrasse com o e-mail de um assinante herdava o
--   LIMITE DE PERFIS dele (família = 4 em vez de 1).
--
-- BUG 2 — `current_period_end IS NULL OR ...`:
--   NULL era lido como "não expira". O ramo foi escrito pensando em vitalício,
--   mas o vitalício Cakto grava 2099-12-31 — nunca NULL. Só servia para premiar
--   assinatura Stripe gravada quebrada. Mesma correção da 20260716180000.
--
-- Impacto menor que o ALTO já fechado (o acesso ao app não passa por aqui), mas é
-- a mesma classe, com privilégio de DEFINER. Fecha por completo: nenhuma função
-- do banco decide mais nada por e-mail.
--
-- Fail-closed em ambas: sem plano identificado, v_max = 1 (o mínimo).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_create_profile()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id       uuid := auth.uid();
    v_profile_count int;
    v_plan_name     text;
    v_max_profiles  int;
BEGIN
    IF v_user_id IS NULL THEN RETURN false; END IF;

    SELECT COUNT(*) INTO v_profile_count
    FROM public.profiles
    WHERE user_id = v_user_id;

    -- 1. Plano por user_id (inclui Cakto migrado, que tem period_end = 2099-12-31)
    SELECT lower(plan_name) INTO v_plan_name
    FROM public.stripe_subscriptions
    WHERE user_id = v_user_id
      AND status IN ('active', 'trialing')
      AND current_period_end IS NOT NULL
      AND current_period_end > now()
    ORDER BY created_at DESC LIMIT 1;

    -- 2. REMOVIDO: plano por e-mail. Ver cabeçalho — e-mail não é prova de posse.

    -- 3. Convidado: herda o plano do dono, e herda o mesmo rigor.
    IF v_plan_name IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan_name
        FROM public.account_members am
        JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
        WHERE am.member_user_id = v_user_id
          AND am.is_active = true
          AND ss.status IN ('active', 'trialing')
          AND ss.current_period_end IS NOT NULL
          AND ss.current_period_end > now()
        ORDER BY ss.created_at DESC
        LIMIT 1;
    END IF;

    v_max_profiles := CASE v_plan_name
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1                      -- fail-closed: plano desconhecido = mínimo
    END;

    RETURN v_profile_count < v_max_profiles;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_profile_limit_stripe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_count int;
    v_plan  text;
    v_max   int;
BEGIN
    -- Lock serializa INSERTs concorrentes do mesmo usuário: sem ele, dois perfis
    -- criados ao mesmo tempo leem a mesma contagem e ambos passam.
    PERFORM 1 FROM public.profiles WHERE user_id = NEW.user_id FOR UPDATE;

    SELECT COUNT(*) INTO v_count
    FROM public.profiles WHERE user_id = NEW.user_id;

    -- Só por user_id. O `OR lower(ss.user_email) = <email do user>` saiu daqui:
    -- deixava quem se cadastrasse com o e-mail de um assinante herdar o limite
    -- de perfis dele. Ver cabeçalho.
    SELECT lower(ss.plan_name) INTO v_plan
    FROM public.stripe_subscriptions ss
    WHERE ss.user_id = NEW.user_id
      AND ss.status IN ('active', 'trialing')
      AND ss.current_period_end IS NOT NULL
      AND ss.current_period_end > now()
    ORDER BY ss.created_at DESC
    LIMIT 1;

    -- Convidado: o perfil dele conta contra o plano do DONO da conta.
    IF v_plan IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan
        FROM public.account_members am
        JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
        WHERE am.member_user_id = NEW.user_id
          AND am.is_active = true
          AND ss.status IN ('active', 'trialing')
          AND ss.current_period_end IS NOT NULL
          AND ss.current_period_end > now()
        ORDER BY ss.created_at DESC
        LIMIT 1;
    END IF;

    v_max := CASE v_plan
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1                      -- fail-closed
    END;

    IF v_count >= v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.can_create_profile() IS
    'Limite de perfis do plano. NUNCA resolver plano por e-mail: /api/create-account usa email_confirm:true, entao e-mail nao prova posse. Ver migration 20260716220000.';
COMMENT ON FUNCTION public.enforce_profile_limit_stripe() IS
    'Trigger do limite de perfis. NUNCA resolver plano por e-mail. Ver migration 20260716220000.';
