-- ROLLBACK de 20260815210000_exclusao_de_perfil.sql
--
-- ⚠️ REVERTA O CLIENTE E A EDGE PRIMEIRO. Sem estas funções, as ações
-- delete-profile / restore-profile / list-deleted-profiles passam a devolver
-- erro — falha fechada (ninguém perde dado), mas o botão fica quebrado.
--
-- ⚠️ E ATENÇÃO AO TRIGGER: o `is_active = true` volta a sair da contagem, ou
-- seja, perfis já excluídos voltam a OCUPAR VAGA. Numa conta que excluiu e
-- criou outro perfil no lugar, a soma pode passar do limite do plano — e aí
-- nenhum perfil novo entra até que os antigos expirem (7 dias).
--
-- Os backups já gravados permanecem: são linhas normais de `profile_backups`
-- e seguem o cron `granaevo-expire-profile-backups`.

CREATE OR REPLACE FUNCTION public.enforce_profile_limit_stripe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_count int; v_plan text; v_max int;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || NEW.user_id::text)::bigint);
    SELECT COUNT(*) INTO v_count FROM public.profiles WHERE user_id = NEW.user_id;
    SELECT lower(ss.plan_name) INTO v_plan FROM public.stripe_subscriptions ss
     WHERE ss.user_id = NEW.user_id AND ss.status IN ('active','trialing')
       AND ss.current_period_end IS NOT NULL AND ss.current_period_end > now()
     ORDER BY ss.created_at DESC LIMIT 1;
    IF v_plan IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan
          FROM public.account_members am
          JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
         WHERE am.member_user_id = NEW.user_id AND am.is_active = true
           AND ss.status IN ('active','trialing')
           AND ss.current_period_end IS NOT NULL AND ss.current_period_end > now()
         ORDER BY ss.created_at DESC LIMIT 1;
    END IF;
    v_max := CASE v_plan WHEN 'individual' THEN 1 WHEN 'casal' THEN 2
                         WHEN 'familia' THEN 4 ELSE 1 END;
    IF v_count > v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;
    RETURN NULL;
END;
$function$;

DROP INDEX IF EXISTS public.idx_profile_backups_restauraveis;
DROP FUNCTION IF EXISTS public.restaurar_perfil(uuid, text);
DROP FUNCTION IF EXISTS public.listar_perfis_excluidos(uuid);
DROP FUNCTION IF EXISTS public.desativar_perfil(uuid, text);
DROP FUNCTION IF EXISTS public.excluir_perfil(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.limite_de_perfis(uuid);
