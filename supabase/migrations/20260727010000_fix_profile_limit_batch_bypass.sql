-- 20260727010000_fix_profile_limit_batch_bypass.sql
-- GranaEvo — Migration: fecha o bypass do limite de perfis por INSERT em lote
-- Rollback: ver 20260727010000_fix_profile_limit_batch_bypass.down.sql
-- Achado S-1 da auditoria /god-mode + /god-eyes de 2026-07-27.
--
-- O FURO
--   `enforce_profile_limit_stripe` era BEFORE INSERT ... FOR EACH ROW e contava
--   com `SELECT COUNT(*) FROM profiles WHERE user_id = NEW.user_id`. Em
--   PostgreSQL, uma query dentro de um trigger BEFORE ROW roda com o command-id
--   do comando em curso e, por isso, NÃO enxerga as linhas inseridas pelo MESMO
--   comando. Para um `INSERT ... VALUES (a),(b),(c),(d)`, a contagem devolvia o
--   mesmo valor (o anterior ao comando) nas quatro vezes.
--
--   A policy RLS `profiles_insert_own` usa `can_create_profile()`, que sofre do
--   mesmo problema — as duas camadas caíam juntas. Como `authenticated` tem
--   INSERT em `profiles` e o cliente insere direto via PostgREST, bastava um
--   POST com um ARRAY JSON para um assinante do plano Individual (limite 1)
--   criar 4 perfis: o equivalente ao plano Família por R$ 19,99.
--
-- A CORREÇÃO
--   AFTER INSERT. Triggers AFTER ROW são enfileirados e executados ao fim do
--   comando, depois do CommandCounterIncrement — suas queries enxergam TODAS as
--   linhas do comando. O lote inteiro passa a ser contado de uma vez.
--
-- ⚠️ A MUDANÇA DE COMPARAÇÃO É OBRIGATÓRIA, NÃO COSMÉTICA
--   Em BEFORE, `v_count` era o total ANTES da linha nova → `v_count >= v_max`.
--   Em AFTER, `v_count` JÁ INCLUI as linhas inseridas → tem de ser `v_count > v_max`.
--   Trocar só o timing e manter o `>=` bloquearia o PRIMEIRO perfil de todo
--   usuário do plano Individual (0 perfis, insere 1, conta 1, `1 >= 1` → erro).
--
-- O QUE NÃO MUDA
--   `can_create_profile()` continua como está. Ela erra para mais (deixa passar
--   o lote), nunca para menos, e é ela quem produz o 42501 que o cliente traduz
--   no popup amigável de limite — o caminho normal de "atingi meu limite" segue
--   idêntico. O trigger é o backstop que fecha o lote e a corrida.

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
    -- Trava pelo USUÁRIO, não pelas linhas dele. Cobre a corrida ENTRE
    -- transações; o bypass em lote (dentro de UM comando) é coberto pelo
    -- timing AFTER deste trigger.
    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || NEW.user_id::text)::bigint);

    -- AFTER INSERT: esta contagem JÁ INCLUI as linhas do comando atual.
    SELECT COUNT(*) INTO v_count
    FROM public.profiles WHERE user_id = NEW.user_id;

    -- Só por user_id — e-mail não prova posse (ver migration 20260716220000).
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
        ELSE 1                      -- fail-closed
    END;

    -- `>` e não `>=`: ver o aviso no cabeçalho desta migration.
    IF v_count > v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NULL;   -- valor ignorado em trigger AFTER
END;
$function$;

-- CONSTRAINT TRIGGER: AFTER ROW, disparado ao fim do comando (INITIALLY
-- IMMEDIATE). É o idioma canônico para invariantes que dependem de enxergar o
-- comando inteiro.
DROP TRIGGER IF EXISTS enforce_profile_limit_stripe ON public.profiles;
CREATE CONSTRAINT TRIGGER enforce_profile_limit_stripe
    AFTER INSERT ON public.profiles
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_profile_limit_stripe();
