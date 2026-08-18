-- 20260727010000_fix_profile_limit_batch_bypass.down.sql
-- GranaEvo — Rollback de 20260727010000_fix_profile_limit_batch_bypass.sql
--
-- ⚠️ REVERTER REABRE A FALHA S-1: volta o trigger para BEFORE ROW, e um
-- `INSERT ... VALUES (a),(b),(c),(d)` via PostgREST passa a criar N perfis num
-- plano de 1. Só reverta se a correção quebrar a criação legítima de perfis —
-- e, nesse caso, abra o problema em vez de deixar assim.
--
-- A comparação volta a `>=` junto com o timing BEFORE: as duas coisas andam
-- em par (em BEFORE a contagem exclui a linha nova; em AFTER, inclui).

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
    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || NEW.user_id::text)::bigint);

    SELECT COUNT(*) INTO v_count
    FROM public.profiles WHERE user_id = NEW.user_id;

    SELECT lower(ss.plan_name) INTO v_plan
    FROM public.stripe_subscriptions ss
    WHERE ss.user_id = NEW.user_id
      AND ss.status IN ('active', 'trialing')
      AND ss.current_period_end IS NOT NULL
      AND ss.current_period_end > now()
    ORDER BY ss.created_at DESC
    LIMIT 1;

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
        ELSE 1
    END;

    IF v_count >= v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_profile_limit_stripe ON public.profiles;
CREATE TRIGGER enforce_profile_limit_stripe
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_profile_limit_stripe();
