-- ─────────────────────────────────────────────────────────────────────────────
-- FIX: excluir um perfil que JÁ TEVE backup devolvia 500
--
-- ACHADO no segundo teste real (2026-08-15), com o erro exato do Postgres:
--
--   duplicate key value violates unique constraint
--   "idx_profile_backups_active_per_member"
--   Key (owner_user_id, original_member_id, source_table) = (…, 66, profiles)
--
-- O índice existe desde antes e está CERTO — um backup ativo por membro:
--
--   UNIQUE (owner_user_id, original_member_id, source_table)
--   WHERE status IN ('pending','active')
--
-- O que eu não cobri foi o ciclo: excluir → restaurar → excluir de novo. Minha
-- guarda de idempotência olhava só `is_active = false` (perfil ainda excluído).
-- Um perfil ATIVO que já teve backup — porque foi restaurado — caía direto no
-- INSERT e batia no índice.
--
-- ⚠️ E a restauração NÃO consome o backup, de propósito (para permitir tentar de
-- novo se a escrita do blob falhar). Ou seja: todo perfil restaurado carrega um
-- backup ativo. O caso não era raro — era o SEGUNDO uso da feature.
--
-- Conserto: UPSERT. Excluir de novo SUBSTITUI o backup pelo estado atual, que é
-- o que o usuário espera — ele quer poder desfazer a exclusão de AGORA, não uma
-- de dias atrás. E o prazo de 7 dias recomeça, pelo mesmo motivo.
--
-- A falha fechada seguiu funcionando nas duas vezes: o INSERT estourava ANTES
-- de qualquer remoção, e nenhum perfil foi perdido.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.excluir_perfil(
    p_user_id    uuid,
    p_profile_id text,
    p_member_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_perfil    public.profiles%ROWTYPE;
    v_backup_id uuid;
    v_plano     text;
    v_expira    timestamptz := now() + interval '7 days';
BEGIN
    IF p_user_id IS NULL OR p_profile_id IS NULL OR p_profile_id = '' THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'PARAMETROS_INVALIDOS');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || p_user_id::text)::bigint);

    SELECT * INTO v_perfil
    FROM public.profiles
    WHERE id::text = p_profile_id AND user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'PERFIL_NAO_ENCONTRADO');
    END IF;

    -- Já excluído: devolve o backup vigente sem tocar em nada. Protege o duplo
    -- clique, e impede que o 2º clique sobrescreva o backup bom com o estado
    -- já esvaziado.
    IF v_perfil.is_active = false THEN
        SELECT id INTO v_backup_id
        FROM public.profile_backups
        WHERE owner_user_id = p_user_id
          AND source_table = 'profiles'
          AND original_member_id = p_profile_id
          AND status = 'active'
          AND backup_expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1;

        RETURN jsonb_build_object(
            'ok', true, 'ja_excluido', true,
            'backup_id', v_backup_id, 'expira_em', v_expira
        );
    END IF;

    -- O CHECK da tabela só aceita os três planos reais; qualquer outra coisa
    -- vira 'individual', o mesmo fail-closed de `limite_de_perfis`.
    SELECT lower(ss.plan_name) INTO v_plano
    FROM public.stripe_subscriptions ss
    WHERE ss.user_id = p_user_id
    ORDER BY ss.created_at DESC
    LIMIT 1;

    IF v_plano IS NULL OR v_plano NOT IN ('individual', 'casal', 'familia') THEN
        v_plano := 'individual';
    END IF;

    INSERT INTO public.profile_backups (
        owner_user_id, original_member_id, member_name, member_email,
        member_data, scheduled_removal_at, backup_expires_at, status,
        original_plan, target_plan, source_table
    ) VALUES (
        p_user_id, p_profile_id, v_perfil.name, NULL,
        COALESCE(p_member_data, '{}'::jsonb),
        now(), v_expira, 'active',
        v_plano, v_plano, 'profiles'
    )
    -- O alvo é o índice parcial que já existia. Excluir de novo substitui o
    -- backup pelo estado ATUAL e recomeça os 7 dias: quem exclui hoje quer
    -- poder desfazer a exclusão de hoje.
    ON CONFLICT (owner_user_id, original_member_id, source_table)
    WHERE status IN ('pending', 'active')
    DO UPDATE SET
        member_name       = EXCLUDED.member_name,
        member_data       = EXCLUDED.member_data,
        backup_expires_at = EXCLUDED.backup_expires_at,
        scheduled_removal_at = EXCLUDED.scheduled_removal_at,
        original_plan     = EXCLUDED.original_plan,
        target_plan       = EXCLUDED.target_plan,
        status            = 'active',
        updated_at        = now()
    RETURNING id INTO v_backup_id;

    RETURN jsonb_build_object(
        'ok', true, 'backup_id', v_backup_id,
        'expira_em', v_expira, 'nome', v_perfil.name
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.excluir_perfil(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.excluir_perfil(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.excluir_perfil(uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.excluir_perfil(uuid, text, jsonb) TO service_role;
