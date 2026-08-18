-- SEC-001 — `is_active` de `profiles` tinha DOIS caminhos sem checagem de limite
-- ============================================================================
-- Auditoria god-mode de 2026-08-17. Ver security-audit/god-mode-god-eyes-REPORT-2026-08-17.md
--
-- O limite de perfis por plano era enforçado em três lugares — can_create_profile(),
-- o trigger enforce_profile_limit_stripe e restaurar_perfil() — e os três só cobrem
-- INSERT. enforce_profile_limit_stripe tem tgtype=5 (ROW+INSERT). O único trigger de
-- UPDATE, enforce_user_id_immutable, checa apenas user_id.
--
-- Resultado: `is_active` era coluna livre para quem falasse direto com o PostgREST.
--
--     PATCH profiles?id=eq.X {"is_active":false}   → abre vaga (só ativos contam)
--     POST  profiles {...}                          → cria outro, dentro do limite
--     (repete N vezes)
--     PATCH profiles?user_id=eq.me {"is_active":true}  → religa TODOS
--
-- → perfis ilimitados no plano individual.
--
-- A migration anterior documentava que a guarda contra essa burla era
-- restaurar_perfil(). Mas restaurar_perfil() é service_role-only: o cliente nunca
-- precisou passar por ela. A guarda morava num caminho opcional.
--
-- ESCOPO VERIFICADO ANTES DE APLICAR (regra: correção que quebra funcionalidade = rollback).
-- Levantadas no bundle de PRODUÇÃO todas as escritas do cliente em `profiles`:
--     perfil-acoes.js:260      INSERT  name, photo_url, user_id
--     perfil-acoes.js:388      UPDATE  photo_url
--     db-configuracoes.js:436  UPDATE  name
-- Nenhuma toca is_active. is_active é DEFAULT true NOT NULL, então o INSERT sem a
-- coluna continua funcionando. O 42501 que o PATCH passa a devolver JÁ é tratado em
-- perfil-acoes.js:271 (cai em mostrarPopupLimite()).
--
-- ⚠️ ESTES REVOKE SOMEM NUM RESTORE — pg_dump só emite GRANT.
--    Manter em sincronia com o privilegios.sql do backup.
-- ============================================================================

BEGIN;

-- ── 1. Grant por COLUNA: is_active deixa de ser escrevível pelo cliente ───────
-- Mata SEC-001 e, junto, toda a classe de mass-assignment nesta tabela: qualquer
-- coluna futura nasce fora do alcance do cliente por padrão, em vez de dentro.

REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT  UPDATE (name, photo_url) ON public.profiles TO authenticated;

REVOKE INSERT ON public.profiles FROM authenticated;
GRANT  INSERT (name, photo_url, user_id) ON public.profiles TO authenticated;

-- ── 2. Backstop no banco ─────────────────────────────────────────────────────
-- Os grants acima são a defesa primária. Este trigger é o que sobra de pé se um
-- GRANT amplo voltar por engano — num restore, num `db push` de outra máquina, num
-- dashboard. Custa uma comparação por UPDATE.
--
-- auth.uid() IS NULL = service_role (excluir_perfil / restaurar_perfil / os crons),
-- que já conferem o limite. O cliente autenticado nunca passa daqui.

CREATE OR REPLACE FUNCTION public.trg_profiles_guard_is_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
        RETURN NEW;                    -- renomear / trocar foto segue livre
    END IF;

    IF auth.uid() IS NOT NULL THEN
        RAISE EXCEPTION
          '[SEGURANCA] is_active de um perfil so muda por excluir_perfil/restaurar_perfil';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_is_active ON public.profiles;
CREATE TRIGGER profiles_guard_is_active
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.trg_profiles_guard_is_active();

-- ── 3. AUTORIDADE ÚNICA para reativar perfil ─────────────────────────────────
-- SEC-001b: o segundo caminho, e o motivo de esta migration não ser só dois REVOKE.
--
-- update-stripe-plan/index.ts:164 (restoreActiveBackups) religa perfis EM LOTE:
--
--     await db.from('profiles').update({ is_active: true }).in('id', intIds)
--
-- sem consultar limite_de_perfis(). Roda como service_role, então os grants do
-- passo 1 não a alcançam. E como excluir_perfil() grava todo backup já com
-- status='active', cada exclusão manual de perfil vira munição:
--
--     excluir 4 → criar 4 → excluir 4 → ... (N vezes, sempre dentro do limite)
--     → agendar downgrade → reverter/upgrade
--     → restoreActiveBackups religa os 4N de uma vez, sem checar nada
--
-- Mesmo desfecho de SEC-001, sem nenhum PATCH — só botões legítimos da interface.
--
-- Esta função existe para que só HAJA uma autoridade: quem quiser religar perfis em
-- lote passa por aqui, e aqui a soma final é conferida uma vez, sob o mesmo lock por
-- usuário que excluir_perfil/restaurar_perfil usam. O Edge Function passa a chamá-la
-- em vez de fazer UPDATE direto (ver patch em restoreActiveBackups).

CREATE OR REPLACE FUNCTION public.restaurar_perfis_em_lote(
    p_user_id     uuid,
    p_profile_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_ativos     int;
    v_limite     int;
    v_vagas      int;
    v_restaurar  int[];
    v_restaurados int;
BEGIN
    IF p_user_id IS NULL OR p_profile_ids IS NULL OR array_length(p_profile_ids, 1) IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'restaurados', 0, 'ignorados', 0);
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || p_user_id::text)::bigint);

    SELECT count(*) INTO v_ativos
    FROM public.profiles WHERE user_id = p_user_id AND is_active = true;

    v_limite := public.limite_de_perfis(p_user_id);
    v_vagas  := greatest(v_limite - v_ativos, 0);

    -- Restaura só até encher o plano. Os mais antigos primeiro: se o usuário
    -- excluiu A, depois B, e só cabe um, o que volta é A — a ordem em que ele os
    -- criou, não a ordem em que apagou.
    SELECT array_agg(id ORDER BY id)
      INTO v_restaurar
      FROM (
        SELECT p.id
          FROM public.profiles p
         WHERE p.user_id = p_user_id
           AND p.is_active = false
           AND p.id::text = ANY (p_profile_ids)
         ORDER BY p.id
         LIMIT v_vagas
      ) z;

    IF v_restaurar IS NULL OR array_length(v_restaurar, 1) IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true, 'restaurados', 0,
            'ids_restaurados', '[]'::jsonb,
            'ignorados', array_length(p_profile_ids, 1),
            'ativos', v_ativos, 'limite', v_limite
        );
    END IF;

    UPDATE public.profiles
       SET is_active = true
     WHERE user_id = p_user_id AND id = ANY (v_restaurar);

    GET DIAGNOSTICS v_restaurados = ROW_COUNT;

    -- `ids_restaurados` existe para o chamador marcar como 'restored' SÓ os backups
    -- que de fato entraram. Sem isso, um backup recusado por falta de vaga seria
    -- marcado como restaurado e o usuário perderia o direito de restaurá-lo depois
    -- — a correção de um bypass viraria perda de dado do usuário legítimo.
    RETURN jsonb_build_object(
        'ok', true,
        'restaurados', v_restaurados,
        'ids_restaurados', to_jsonb(v_restaurar),
        'ignorados', array_length(p_profile_ids, 1) - v_restaurados,
        'ativos', v_ativos + v_restaurados,
        'limite', v_limite
    );
END;
$$;

-- Só o service_role chama. O cliente não tem por que enxergar isto.
REVOKE ALL ON FUNCTION public.restaurar_perfis_em_lote(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.restaurar_perfis_em_lote(uuid, text[]) TO service_role;

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU (rodar como authenticated, via PostgREST)
--
--   1. Escrita legítima segue viva:
--      PATCH /rest/v1/profiles?id=eq.<meu> {"name":"Novo"}          → 200
--      PATCH /rest/v1/profiles?id=eq.<meu> {"photo_url":"x/y.jpg"}  → 200
--      POST  /rest/v1/profiles {"user_id":"<meu>","name":"P"}       → 201 (dentro do limite)
--
--   2. O vetor morre:
--      PATCH /rest/v1/profiles?id=eq.<meu> {"is_active":true}       → 42501 / 403
--      POST  /rest/v1/profiles {"user_id":"<meu>","name":"P","is_active":false} → 42501
--
--   3. O limite volta a valer de ponta a ponta:
--      SELECT user_id, count(*) FILTER (WHERE is_active) AS ativos,
--             public.limite_de_perfis(user_id) AS limite
--        FROM public.profiles GROUP BY user_id
--       HAVING count(*) FILTER (WHERE is_active) > public.limite_de_perfis(user_id);
--      → deve voltar ZERO linhas.
--
--   4. O caminho em lote respeita o teto:
--      SELECT public.restaurar_perfis_em_lote('<uid>', ARRAY['<id1>','<id2>','<id3>']);
--      → restaurados <= vagas; 'ignorados' > 0 quando o plano já está cheio.
--
-- ROLLBACK: ver 20260817000000_sec001_is_active_autoridade_unica.down.sql
-- ============================================================================
