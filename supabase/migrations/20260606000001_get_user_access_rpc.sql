-- ──────────────────────────────────────────────────────────────────────────────
-- RPC: get_user_access_data
-- Executa em uma única round-trip todas as queries que getActive() fazia de
-- forma sequencial no cliente. Reduz latência de ~5 queries para 1.
--
-- Retorna jsonb com campo "type":
--   "active"       → subscription ativa via user_id
--   "active_email" → subscription ativa via email (user_id IS NULL)
--   "frozen"       → assinatura cancelada < 90 dias (dados retidos)
--   "guest"        → usuário é convidado — retorna sub do dono
--   "none"         → sem acesso
--
-- Segurança:
--   SECURITY INVOKER — executa com os privilégios do chamador.
--   RLS das tabelas stripe_subscriptions e account_members é respeitado.
--   p_user_id é validado contra auth.uid() para evitar IDOR.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_user_access_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
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
      AND (current_period_end IS NULL OR current_period_end >= v_now)
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
          AND (current_period_end IS NULL OR current_period_end >= v_now)
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
      AND (current_period_end IS NULL OR current_period_end >= v_now)
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
$$;

-- Revoga execução pública por padrão; apenas roles autenticadas podem chamar
REVOKE EXECUTE ON FUNCTION get_user_access_data(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_user_access_data(uuid) TO authenticated;
