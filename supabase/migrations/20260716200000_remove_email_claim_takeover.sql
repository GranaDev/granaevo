-- ============================================================================
-- Fecha a tomada de assinatura por e-mail (account pre-hijacking)
--
-- A CADEIA (cada elo verificado no código e no banco em 2026-07-16):
--   1. /api/create-account → admin.createUser({ email, password, email_confirm: true })
--      A conta nasce CONFIRMADA, sem link de verificação, e sem nenhuma checagem
--      de pagamento. Qualquer pessoa cria conta com QUALQUER e-mail.
--   2. planos.js faz login logo em seguida → JWT legítimo com o e-mail da vítima.
--   3. get_user_access_data, passo 2 ('active_email'):
--          WHERE user_id IS NULL AND lower(user_email) = lower(auth.email())
--      → casava e ENTREGAVA a assinatura de quem pagou e nunca criou conta.
--   4. E a vítima real ficava impedida de se cadastrar (409 email_exists).
--
-- NÃO É FALHA DE JWT — o JWT é honesto. O erro é tratar o e-mail como PROVA DE
-- POSSE quando o cadastro nunca provou posse nenhuma.
--
-- A DEFESA QUE JÁ EXISTIA E ESTAVA MORTA: a policy `stripe_sub_select_by_email`
-- exige `u.email_confirmed_at IS NOT NULL`. A intenção estava certa — mas como o
-- cadastro grava `email_confirm: true`, esse campo está SEMPRE preenchido e a
-- checagem nunca reprovou ninguém. Censo: os 4 usuários têm email_confirmed_at
-- preenchido com confirmation_sent_at NULO — nenhum e-mail jamais foi enviado.
--
-- POR QUE DÁ PARA REMOVER (e não só endurecer): nenhuma compra nova depende
-- disto. planos.js SEMPRE cria a conta antes do checkout (iniciarCheckout →
-- SignupModal → _checkoutComSessao com JWT), então o webhook grava `user_id` a
-- partir do metadata. O caminho por e-mail só servia ao legado Cakto que nunca
-- criou conta — hoje exatamente 1 pessoa
-- (ryanhenriquehenriquedossantos@gmail.com), que passa a ser vinculada à mão.
--
-- Se um dia existir compra anônima de verdade, a reclamação tem que exigir prova
-- de posse do e-mail (link/código assinado enviado a ele), nunca casar string.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_access_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    v_active_sub jsonb;
    v_frozen_sub jsonb;
    v_member     record;
    v_owner_sub  jsonb;
    v_now        timestamptz := now();
BEGIN
    -- Garante que o chamador só pode consultar seus próprios dados
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    -- ── 1. Subscription ativa por user_id ────────────────────────────────────
    -- current_period_end NOT NULL + no futuro. Sem data = dado quebrado, não
    -- vitalício: o vitalício manual tem data (2099-12-31).
    -- Ver migration 20260716180000.
    SELECT jsonb_build_object(
        'id',                  id,
        'plan_name',           plan_name,
        'status',              status,
        'current_period_end',  current_period_end
    )
    INTO v_active_sub
    FROM stripe_subscriptions
    WHERE user_id = p_user_id
      AND status IN ('active', 'trialing')
      AND current_period_end IS NOT NULL
      AND current_period_end >= v_now
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_active_sub IS NOT NULL THEN
        RETURN jsonb_build_object('type', 'active', 'sub', v_active_sub);
    END IF;

    -- ── 2. REMOVIDO: acesso por e-mail ('active_email') ──────────────────────
    -- Era o vetor de tomada de conta descrito no cabeçalho. Vínculo de
    -- assinatura órfã agora é MANUAL (UPDATE direto, com o titular
    -- identificado fora do app).

    -- ── 3. Estado congelado — cancelado há menos de 90 dias ──────────────────
    SELECT jsonb_build_object(
        'plan_name',           plan_name,
        'current_period_end',  current_period_end
    )
    INTO v_frozen_sub
    FROM stripe_subscriptions
    WHERE user_id = p_user_id
      AND status = 'canceled'
      AND current_period_end IS NOT NULL
      AND current_period_end >= (v_now - interval '90 days')
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_frozen_sub IS NOT NULL THEN
        RETURN jsonb_build_object('type', 'frozen', 'sub', v_frozen_sub);
    END IF;

    -- ── 4. Verificação de convidado ──────────────────────────────────────────
    SELECT id, owner_user_id, owner_email
    INTO v_member
    FROM account_members
    WHERE member_user_id = p_user_id
      AND is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    -- ── 5. Subscription ativa do dono ────────────────────────────────────────
    -- O convidado herda o acesso do titular, então herda o mesmo rigor.
    SELECT jsonb_build_object(
        'id',                  id,
        'plan_name',           plan_name,
        'status',              status,
        'current_period_end',  current_period_end
    )
    INTO v_owner_sub
    FROM stripe_subscriptions
    WHERE user_id = v_member.owner_user_id
      AND status IN ('active', 'trialing')
      AND current_period_end IS NOT NULL
      AND current_period_end >= v_now
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_owner_sub IS NULL THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    RETURN jsonb_build_object(
        'type',           'guest',
        'sub',            v_owner_sub,
        'owner_user_id',  v_member.owner_user_id::text,
        'owner_email',    v_member.owner_email
    );
END;
$function$;

-- ── A policy da defesa morta ────────────────────────────────────────────────
-- `stripe_sub_select_by_email` deixava o usuário LER qualquer assinatura órfã
-- com o mesmo e-mail. A guarda `email_confirmed_at IS NOT NULL` que ela carrega
-- é inútil enquanto o cadastro força a confirmação. Sem o caminho de acesso por
-- e-mail, ela não serve a nada além de vazar plano/valor de terceiro.
DROP POLICY IF EXISTS "stripe_sub_select_by_email" ON public.stripe_subscriptions;

COMMENT ON TABLE public.stripe_subscriptions IS
    'Assinaturas. Acesso SEMPRE por user_id (proprio ou do dono, p/ convidado). NUNCA por e-mail: e-mail nao e prova de posse enquanto /api/create-account usar email_confirm:true. Ver migration 20260716200000.';
