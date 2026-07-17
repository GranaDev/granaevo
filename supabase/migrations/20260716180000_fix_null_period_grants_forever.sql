-- ============================================================================
-- Fecha o vazamento de receita: `current_period_end IS NULL` dava acesso eterno
--
-- O QUE ACONTECIA (achado em 2026-07-16, com dados reais em produção):
-- `get_user_access_data` liberava acesso com
--     status IN ('active','trialing') AND (current_period_end IS NULL OR ... >= now())
-- O ramo `IS NULL` foi escrito pensando em "vitalício sem data". Só que o
-- vitalício Cakto NUNCA usou NULL — ele grava `current_period_end = 2099-12-31`
-- (censo: as 4 assinaturas manuais restantes têm todas essa data). Ou seja, o
-- ramo NULL não servia a ninguém legítimo.
--
-- Servia, isso sim, para assinatura Stripe QUEBRADA: o webhook lia
-- `sub.current_period_start/end` da raiz do objeto Subscription, mas a Stripe
-- moveu esses campos para `items.data[]` na API `2025-03-31.basil`, e
-- `fetchStripeSubscription` não fixava `Stripe-Version` — então respondia na
-- versão padrão da conta. Period vinha undefined → gravava NULL → o gate lia
-- NULL como "não expira" → **quem assinasse uma vez teria acesso para sempre,
-- mesmo cancelando e parando de pagar**.
--
-- Em produção havia 4 assinaturas Stripe reais, TODAS com period NULL e status
-- 'active' congelado desde 17/05 (o endpoint do webhook estava desabilitado no
-- painel da Stripe). Foram removidas junto com as contas de teste; hoje só
-- restam as 4 manuais com 2099-12-31, então esta mudança não tira o acesso de
-- ninguém — verificado antes de aplicar.
--
-- A CORREÇÃO: NULL passa a NEGAR (fail secure). O webhook foi corrigido no
-- mesmo commit para nunca mais gravar NULL (lê o período das duas formas da API
-- e falha alto — 500 — para a Stripe reentregar, em vez de gravar linha
-- quebrada com 200 OK).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_access_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    v_email      text;
    v_active_sub jsonb;
    v_email_sub  jsonb;
    v_frozen_sub jsonb;
    v_member     record;
    v_owner_sub  jsonb;
    v_now        timestamptz := now();
BEGIN
    -- Garante que o chamador só pode consultar seus próprios dados
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    -- Email verificado via JWT (não pode ser forjado pelo cliente)
    v_email := auth.email();

    -- ── 1. Subscription ativa por user_id ────────────────────────────────────
    -- current_period_end NOT NULL + no futuro. Sem data = dado quebrado, não
    -- vitalício: o vitalício tem data (2099-12-31).
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

    -- ── 2. Subscription ativa por email (user_id IS NULL — sem vinculação) ───
    IF v_email IS NOT NULL THEN
        SELECT jsonb_build_object(
            'id',                  id,
            'plan_name',           plan_name,
            'status',              status,
            'current_period_end',  current_period_end,
            'user_email',          user_email
        )
        INTO v_email_sub
        FROM stripe_subscriptions
        WHERE user_id IS NULL
          AND lower(user_email) = lower(v_email)
          AND status IN ('active', 'trialing')
          AND current_period_end IS NOT NULL
          AND current_period_end >= v_now
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_email_sub IS NOT NULL THEN
            RETURN jsonb_build_object(
                'type',       'active_email',
                'sub',        v_email_sub,
                'user_email', v_email
            );
        END IF;
    END IF;

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
    -- Mesma regra: o convidado herda o acesso do titular, então herda o rigor.
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

-- Guarda de banco: impede que uma assinatura Stripe volte a ser gravada sem
-- data de expiração, mesmo que algum código futuro tente. O vitalício manual
-- (cakto_*) segue livre — ele tem data real e não passa por aqui.
ALTER TABLE public.stripe_subscriptions
    DROP CONSTRAINT IF EXISTS stripe_sub_ativa_exige_periodo;

ALTER TABLE public.stripe_subscriptions
    ADD CONSTRAINT stripe_sub_ativa_exige_periodo CHECK (
        stripe_subscription_id IS NULL
        OR stripe_subscription_id NOT LIKE 'sub_%'
        OR status NOT IN ('active', 'trialing')
        OR current_period_end IS NOT NULL
    ) NOT VALID;   -- NOT VALID: não re-valida linhas antigas; vale do INSERT/UPDATE em diante

COMMENT ON CONSTRAINT stripe_sub_ativa_exige_periodo ON public.stripe_subscriptions IS
    'Assinatura Stripe (sub_*) ativa/trialing PRECISA de current_period_end. NULL era lido como "nao expira" pelo get_user_access_data e dava acesso vitalicio de graca (bug 2026-07-16).';
