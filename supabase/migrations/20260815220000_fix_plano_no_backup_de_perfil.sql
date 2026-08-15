-- ─────────────────────────────────────────────────────────────────────────────
-- FIX: `excluir_perfil` violava o CHECK de plano de `profile_backups`
--
-- ACHADO no primeiro teste real (2026-08-15). A exclusão devolvia 500 e nada
-- acontecia. A causa:
--
--   profile_backups_plan_check        CHECK (original_plan IN ('individual','casal','familia'))
--   profile_backups_target_plan_check CHECK (target_plan   IN ('individual','casal','familia'))
--
-- e `excluir_perfil` gravava `COALESCE(v_plano, 'desconhecido')`. Conta sem
-- assinatura na tabela (ou com plan_name fora dessas três) estourava o INSERT.
--
-- A tabela nasceu para o downgrade de plano, onde os dois campos SEMPRE têm um
-- plano real. Ao reaproveitá-la para exclusão voluntária eu inventei um valor
-- de preenchimento sem conferir o domínio da coluna — e o CHECK estava certo:
-- 'desconhecido' não é um plano.
--
-- Agora o fallback é 'individual', que É um plano válido e é exatamente o que
-- `limite_de_perfis` devolve quando não acha assinatura (fail-closed, 1 perfil).
-- Os dois passam a contar a mesma história.
--
-- ⚠️ A FALHA FECHADA FUNCIONOU: o INSERT do backup estourou ANTES de qualquer
-- remoção, então o perfil ficou intacto. É a ordem do desenho fazendo o que
-- prometia — backup primeiro, e sem backup não se apaga nada.
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
    v_perfil   public.profiles%ROWTYPE;
    v_backup_id uuid;
    v_plano    text;
    v_expira   timestamptz := now() + interval '7 days';
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

    -- O CHECK da tabela só aceita os três planos reais. Qualquer outra coisa
    -- (conta sem assinatura, plan_name legado, caixa diferente) vira
    -- 'individual' — o mesmo fail-closed de `limite_de_perfis`.
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
