-- ─────────────────────────────────────────────────────────────────────────────
-- EXCLUSÃO DE PERFIL COM JANELA DE ARREPENDIMENTO DE 7 DIAS
--
-- Desenho: docs/exclusao-de-perfil-desenho.md
--
-- Reusa `profile_backups`, que já é esta máquina para downgrade de plano, e o
-- cron `granaevo-expire-profile-backups`, que já zera a PII no vencimento
-- (member_data = '{}', member_name = '[Excluído]') — a conformidade com o
-- art. 18 VI da LGPD já está resolvida ali.
--
-- ── O PONTO MAIS DELICADO: A REGRA DO LIMITE ────────────────────────────────
-- `enforce_profile_limit_stripe` contava TODAS as linhas de `profiles`, sem
-- filtrar `is_active`. Isso impediria "excluir libera vaga".
--
-- Mas passar a contar só ativos, sozinho, abriria o furo oposto: excluir 3 e
-- criar 3 daria 6 perfis num plano de 4, com os 3 antigos ainda restauráveis.
--
-- Por isso a regra é ASSIMÉTRICA:
--   CRIAR      conta só ativos             → excluir libera vaga na hora
--   RESTAURAR  conta ativos + o que volta  → recusa se estourar
--
-- O limite é sempre verificado no instante em que o perfil volta a EXISTIR.
-- Perfil inativo não ocupa vaga, e também não volta sem vaga.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. O trigger de criação passa a contar só perfis ATIVOS ─────────────────
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
    --
    -- `is_active` entrou aqui em 2026-08-15, com a exclusão de perfil. Um perfil
    -- excluído não ocupa vaga — senão excluir não liberaria espaço e o usuário
    -- ficaria preso. Quem impede a burla (excluir 3, criar 3, restaurar os 3) é
    -- `public.restaurar_perfil`, que confere a soma FINAL no momento em que o
    -- perfil volta a existir.
    SELECT COUNT(*) INTO v_count
    FROM public.profiles
    WHERE user_id = NEW.user_id AND is_active = true;

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

    IF v_count > v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NULL;   -- valor ignorado em trigger AFTER
END;
$function$;

-- ── 2. Helper: o teto de perfis desta conta ─────────────────────────────────
-- Extraído porque `restaurar_perfil` precisa da mesma resposta que o trigger.
-- Duas cópias da regra de plano divergiriam, e é ela que decide se alguém passa
-- do limite pago.
CREATE OR REPLACE FUNCTION public.limite_de_perfis(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_plan text;
BEGIN
    SELECT lower(ss.plan_name) INTO v_plan
    FROM public.stripe_subscriptions ss
    WHERE ss.user_id = p_user_id
      AND ss.status IN ('active', 'trialing')
      AND ss.current_period_end IS NOT NULL
      AND ss.current_period_end > now()
    ORDER BY ss.created_at DESC
    LIMIT 1;

    IF v_plan IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan
        FROM public.account_members am
        JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
        WHERE am.member_user_id = p_user_id
          AND am.is_active = true
          AND ss.status IN ('active', 'trialing')
          AND ss.current_period_end IS NOT NULL
          AND ss.current_period_end > now()
        ORDER BY ss.created_at DESC
        LIMIT 1;
    END IF;

    RETURN CASE v_plan
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1                      -- fail-closed
    END;
END;
$function$;

-- ── 3. EXCLUIR: grava o backup e desativa, na mesma transação ───────────────
--
-- Recebe `p_member_data` porque o conteúdo do perfil vive no BLOB CIFRADO
-- (`user_data.data_json`) — só a edge consegue decifrar. Esta função é a parte
-- relacional; a edge faz a parte do blob.
--
-- ORDEM NO CHAMADOR (a edge): backup aqui → regravar o blob sem o perfil →
-- desativar. Falha em qualquer ponto deixa o perfil VIVO, nunca o contrário.
-- Por isso esta função aceita ser chamada e o blob falhar depois: sobra um
-- backup órfão que expira sozinho em 7 dias, e nada se perde.
--
-- IDEMPOTENTE: perfil já inativo devolve o backup existente em vez de criar um
-- segundo. Protege contra duplo clique e reenvio.
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

    -- O perfil pertence a ESTA conta? Um id de outra conta cai aqui e sai como
    -- "não encontrado" — nunca confirma que existe em outro lugar (anti-IDOR).
    SELECT * INTO v_perfil
    FROM public.profiles
    WHERE id::text = p_profile_id AND user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'PERFIL_NAO_ENCONTRADO');
    END IF;

    -- Já excluído: devolve o backup vigente. Sem isto, um duplo clique criaria
    -- dois backups e o segundo sobrescreveria o primeiro com dados já removidos.
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

    SELECT lower(ss.plan_name) INTO v_plano
    FROM public.stripe_subscriptions ss
    WHERE ss.user_id = p_user_id
    ORDER BY ss.created_at DESC
    LIMIT 1;
    v_plano := COALESCE(v_plano, 'desconhecido');

    INSERT INTO public.profile_backups (
        owner_user_id, original_member_id, member_name, member_email,
        member_data, scheduled_removal_at, backup_expires_at, status,
        original_plan, target_plan, source_table
    ) VALUES (
        p_user_id, p_profile_id, v_perfil.name, NULL,
        COALESCE(p_member_data, '{}'::jsonb),
        now(),          -- remoção imediata: não é downgrade agendado
        v_expira,
        'active',
        v_plano, v_plano,   -- mesmo plano nos dois: não houve mudança de plano
        'profiles'
    )
    RETURNING id INTO v_backup_id;

    RETURN jsonb_build_object(
        'ok', true, 'backup_id', v_backup_id,
        'expira_em', v_expira, 'nome', v_perfil.name
    );
END;
$function$;

-- ── 4. DESATIVAR: o último passo, depois de o blob já estar regravado ───────
CREATE OR REPLACE FUNCTION public.desativar_perfil(
    p_user_id    uuid,
    p_profile_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_ok boolean;
BEGIN
    -- Só desativa se HOUVER backup válido. Falha fechada: sem rede de
    -- proteção, o perfil não sai do ar. É a mesma postura do backup antes do
    -- reset (migration 20260815160000).
    IF NOT EXISTS (
        SELECT 1 FROM public.profile_backups
        WHERE owner_user_id = p_user_id
          AND source_table = 'profiles'
          AND original_member_id = p_profile_id
          AND status = 'active'
          AND backup_expires_at > now()
    ) THEN
        RETURN false;
    END IF;

    UPDATE public.profiles
       SET is_active = false
     WHERE id::text = p_profile_id AND user_id = p_user_id
    RETURNING true INTO v_ok;

    RETURN COALESCE(v_ok, false);
END;
$function$;

-- ── 5. LISTAR os excluídos que ainda dá para restaurar ──────────────────────
CREATE OR REPLACE FUNCTION public.listar_perfis_excluidos(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_lista jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'profile_id', pb.original_member_id,
               'nome',       pb.member_name,
               'excluido_em', pb.created_at,
               'expira_em',   pb.backup_expires_at
           ) ORDER BY pb.created_at DESC), '[]'::jsonb)
      INTO v_lista
      FROM public.profile_backups pb
      JOIN public.profiles p
        ON p.id::text = pb.original_member_id AND p.user_id = pb.owner_user_id
     WHERE pb.owner_user_id = p_user_id
       AND pb.source_table  = 'profiles'
       AND pb.status        = 'active'
       AND pb.backup_expires_at > now()
       AND p.is_active = false;   -- só o que está de fato fora do ar

    RETURN jsonb_build_object(
        'ok', true,
        'perfis', v_lista,
        'ativos', (SELECT count(*) FROM public.profiles
                    WHERE user_id = p_user_id AND is_active = true),
        'limite', public.limite_de_perfis(p_user_id)
    );
END;
$function$;

-- ── 6. RESTAURAR: aqui mora a trava contra burlar o limite ──────────────────
--
-- Devolve `member_data` para a edge escrever de volta no blob. NÃO consome o
-- backup: se a escrita do blob falhar depois, dá para tentar de novo. O backup
-- expira sozinho em 7 dias de qualquer forma.
--
-- A CHECAGEM DE VAGA É AQUI, e é o coração do desenho: conta os ativos e soma
-- o perfil que está voltando. Excluir 3 e criar 3 libera as vagas na criação —
-- mas nenhum dos 3 antigos consegue voltar, porque a soma final estouraria.
CREATE OR REPLACE FUNCTION public.restaurar_perfil(
    p_user_id    uuid,
    p_profile_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_backup public.profile_backups%ROWTYPE;
    v_ativos int;
    v_limite int;
BEGIN
    IF p_user_id IS NULL OR p_profile_id IS NULL OR p_profile_id = '' THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'PARAMETROS_INVALIDOS');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('profiles:' || p_user_id::text)::bigint);

    SELECT * INTO v_backup
    FROM public.profile_backups
    WHERE owner_user_id = p_user_id
      AND source_table  = 'profiles'
      AND original_member_id = p_profile_id
      AND status = 'active'
      AND backup_expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'BACKUP_NAO_ENCONTRADO');
    END IF;

    -- O perfil precisa existir e estar inativo nesta conta.
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id::text = p_profile_id AND user_id = p_user_id AND is_active = false
    ) THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'PERFIL_NAO_ENCONTRADO');
    END IF;

    SELECT count(*) INTO v_ativos
    FROM public.profiles WHERE user_id = p_user_id AND is_active = true;

    v_limite := public.limite_de_perfis(p_user_id);

    IF v_ativos + 1 > v_limite THEN
        RETURN jsonb_build_object(
            'ok', false, 'erro', 'PROFILE_LIMIT_REACHED',
            'ativos', v_ativos, 'limite', v_limite
        );
    END IF;

    UPDATE public.profiles
       SET is_active = true
     WHERE id::text = p_profile_id AND user_id = p_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'member_data', v_backup.member_data,
        'nome', v_backup.member_name
    );
END;
$function$;

-- ── 7. Índice: as consultas acima filtram sempre pelo mesmo trio ────────────
CREATE INDEX IF NOT EXISTS idx_profile_backups_restauraveis
    ON public.profile_backups (owner_user_id, source_table, original_member_id)
    WHERE status = 'active';

-- ── 8. Grants — nenhuma delas é alcançável pelo cliente ─────────────────────
-- Todas são SECURITY DEFINER e mexem em perfis. O caminho oficial é a edge
-- `user-data-backup`, que autentica o JWT e confere que quem pede é o DONO.
-- Um GRANT a `authenticated` deixaria qualquer membro excluir perfil de outro.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.excluir_perfil(uuid, text, jsonb)',
    'public.desativar_perfil(uuid, text)',
    'public.restaurar_perfil(uuid, text)',
    'public.listar_perfis_excluidos(uuid)',
    'public.limite_de_perfis(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

COMMENT ON FUNCTION public.restaurar_perfil(uuid, text) IS
  'Restaura perfil excluído. A checagem de vaga (ativos + 1 <= limite) acontece AQUI: '
  'é o que impede burlar o limite do plano excluindo e recriando perfis. '
  'Ver docs/exclusao-de-perfil-desenho.md';
