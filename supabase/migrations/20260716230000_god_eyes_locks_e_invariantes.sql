-- ============================================================================
-- /god-eyes 2026-07-16 — corrige 4 achados de concorrência/invariante
-- (3 deles no código escrito hoje mesmo; achados pelo auditor de cron/triggers)
-- ============================================================================

-- ── MÉDIO 1: DELETE podia deixar a reserva compartilhada NEGATIVA ───────────
-- `srm_forcar_owner` valida saldo só no INSERT, mas a policy
-- `srm_delete_recente_proprio` permite apagar o PRÓPRIO movimento por 10 min.
-- Sequência que quebrava a invariante:
--    aporte  +100                → saldo 100
--    retirada -100 (passa)       → saldo   0
--    DELETE do aporte (10 min)   → saldo -100   ← ninguém revalidava
-- Sem dinheiro real e contido ao grupo familiar, mas é a invariante do próprio
-- trigger sendo furada pela porta dos fundos. Revalida no BEFORE DELETE.
CREATE OR REPLACE FUNCTION public.srm_barrar_delete_negativo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saldo numeric(12,2);
BEGIN
    -- Mesmo lock do INSERT (mesma chave): serializa DELETE contra INSERT
    -- concorrente na MESMA reserva, senão os dois leem o saldo pré-mudança.
    PERFORM pg_advisory_xact_lock(hashtext(OLD.reserve_id::text)::bigint);

    SELECT COALESCE(SUM(CASE WHEN tipo = 'aporte' THEN valor ELSE -valor END), 0)
    INTO v_saldo
    FROM public.shared_reserve_movements
    WHERE reserve_id = OLD.reserve_id
      AND id <> OLD.id;               -- saldo SEM a linha que está saindo

    IF v_saldo < 0 THEN
        RAISE EXCEPTION 'desfazer este lancamento deixaria a reserva negativa (saldo ficaria %)', v_saldo;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_srm_barrar_delete_negativo ON public.shared_reserve_movements;
CREATE TRIGGER trg_srm_barrar_delete_negativo
    BEFORE DELETE ON public.shared_reserve_movements
    FOR EACH ROW EXECUTE FUNCTION public.srm_barrar_delete_negativo();

-- ── MÉDIO 2: limite de perfis não serializava o PRIMEIRO perfil ─────────────
-- `PERFORM 1 FROM profiles WHERE user_id = NEW.user_id FOR UPDATE` trava as
-- LINHAS EXISTENTES. Com zero perfis, trava ZERO linhas — dois INSERTs
-- simultâneos leem `count = 0 < 1` e AMBOS passam: 2 perfis no plano individual.
-- O lock só protegia do 2º perfil em diante, justo quando já não era o caso
-- apertado. Advisory lock não depende de a linha existir.
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
    -- Trava pelo USUÁRIO, não pelas linhas dele (que podem não existir ainda).
    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || NEW.user_id::text)::bigint);

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

    IF v_count >= v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NEW;
END;
$function$;

-- ── MÉDIO 3 + BAIXO 4: teto de reservas sem lock, e burlável por unarchive ──
-- (a) `SELECT count(*)` sem serialização: dois INSERTs simultâneos veem 4 e
--     ambos passam → 6 reservas.
-- (b) o teto só era checado no INSERT, e o titular pode zerar `archived_at`
--     (policy `shared_reserves_update`): arquiva 5 → cria 5 → desarquiva = 10.
-- Vira BEFORE INSERT OR UPDATE, com lock por conta.
CREATE OR REPLACE FUNCTION public.shared_reserves_limite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n integer;
BEGIN
    -- Só interessa quando a reserva PASSA a contar como ativa: INSERT ativo, ou
    -- UPDATE que desarquiva. Renomear/mudar objetivo não deve pagar o pedágio.
    IF TG_OP = 'UPDATE' AND NOT (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
        RETURN NEW;
    END IF;
    IF NEW.archived_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('sr:' || NEW.owner_user_id::text)::bigint);

    SELECT count(*) INTO v_n
    FROM public.shared_reserves
    WHERE owner_user_id = NEW.owner_user_id
      AND archived_at IS NULL
      AND id <> NEW.id;              -- não conta a própria linha no UPDATE

    IF v_n >= 5 THEN
        RAISE EXCEPTION 'limite de 5 reservas compartilhadas por conta atingido';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shared_reserves_limite ON public.shared_reserves;
CREATE TRIGGER trg_shared_reserves_limite
    BEFORE INSERT OR UPDATE ON public.shared_reserves
    FOR EACH ROW EXECUTE FUNCTION public.shared_reserves_limite();

-- ── BAIXO 5: search_path sem pg_temp em SECURITY DEFINER ────────────────────
-- `registrar_auditoria_user_data` é SECURITY DEFINER com
-- `SET search_path TO 'public','extensions'` e faz INSERT em financial_audit_log
-- SEM qualificar o schema. Quando `pg_temp` não está na lista, ele é procurado
-- PRIMEIRO para relações — e PUBLIC tem TEMP neste banco. Em tese, uma temp
-- table homônima desviaria o registro de auditoria.
-- NÃO é explorável hoje (exigiria DDL arbitrário como `authenticated`, que o
-- PostgREST não permite — só SELECT/INSERT/UPDATE/DELETE/RPC parametrizados).
-- É hardening de uma palavra; o custo de deixar aberto é maior que o de fechar.
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS fn
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef                                  -- só SECURITY DEFINER
          AND p.proconfig IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
          AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE '%pg_temp%')
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', r.fn);
        RAISE NOTICE '[god-eyes] pg_temp adicionado ao search_path de %', r.fn;
    END LOOP;
END $$;

COMMENT ON FUNCTION public.srm_barrar_delete_negativo() IS
    'Revalida o saldo no DELETE: a policy de desfazer (10 min) permitia apagar o proprio aporte e deixar a reserva negativa. Achado /god-eyes 2026-07-16.';
