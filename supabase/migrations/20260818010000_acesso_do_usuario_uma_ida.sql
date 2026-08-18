-- `acesso_do_usuario` — a decisão de acesso em UMA ida ao banco
-- ============================================================================
-- `check-user-access` leva 2,0–2,9s em TODAS as amostras dos logs de produção,
-- enquanto as outras Edge Functions ficam em 70–120ms. O motivo: até 7 idas
-- sequenciais à rede, uma esperando a outra —
--
--   auth.getUser → check_login_lockout → stripe_subscriptions → account_members
--   → stripe_subscriptions do dono → terms_acceptance → clear_login_lockout
--
-- 7 × ~300ms ≈ os 2,1s observados. É o maior custo isolado do login.
--
-- ── POR QUE NÃO REUSEI `get_user_access_data` ──────────────────────────────
-- Ela já resolve acesso numa ida só e parecia o atalho. NÃO SERVE: as semânticas
-- divergem, e a diferença muda quem entra.
--
--   check-user-access ..: pega a assinatura active/trialing MAIS RECENTE e SÓ
--                         ENTÃO confere current_period_end. Se a mais recente
--                         venceu, NEGA — mesmo havendo outra mais antiga válida.
--   get_user_access_data: filtra current_period_end DENTRO do WHERE, então pega
--                         a mais recente VÁLIDA e CONCEDE no mesmo caso.
--
-- Divergem quando o usuário tem duas assinaturas ativas (troca de plano sem
-- limpar a linha antiga). Nos 7 usuários reais o veredicto bate hoje — conferido
-- um a um — mas adotar a RPC mudaria a regra de acesso em silêncio.
--
-- Esta função replica a semântica de `check-user-access` LITERALMENTE. Onde o
-- comportamento do JS parece estranho, ele foi mantido de propósito e está
-- comentado. Otimizar é fazer a mesma coisa mais rápido; se o veredicto muda,
-- não é otimização, é outra regra.
--
-- ── O QUE **NÃO** DESCEU PARA O BANCO, e por quê ───────────────────────────
-- `auth.getUser(token)` FICA na Edge Function. É a validação de identidade
-- contra o servidor Auth — a fronteira de segurança. O banco recebe um user_id
-- que já foi provado; ele nunca decide QUEM é o chamador, só o que aquele id
-- pode. As camadas continuam: proxy-secret → JWT verificado → RPC service_role.
--
-- `clear_login_lockout` também fica fora: é efeito colateral, não decisão, e
-- passa a ser disparado sem await (não bloqueia a resposta).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.acesso_do_usuario(
    p_user_id       uuid,
    p_email         text,
    p_terms_version text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_lock        record;
    v_sub         record;
    v_owner       record;
    v_member      record;
    v_qtd_membros int;
    v_needs_terms boolean;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('estado', 'deny');
    END IF;

    -- ── 1. Lockout progressivo ───────────────────────────────────────────────
    IF p_email IS NOT NULL AND p_email <> '' THEN
        SELECT * INTO v_lock
          FROM public.check_login_lockout(p_email, 'email') LIMIT 1;

        IF v_lock.is_locked THEN
            RETURN jsonb_build_object(
                'estado',        'locked',
                'locked_until',  v_lock.locked_until,
                'lockout_level', COALESCE(v_lock.lockout_level, 1)
            );
        END IF;
    END IF;

    -- ── 2. needsTermsAcceptance ──────────────────────────────────────────────
    -- `!data` no JS: true quando NÃO existe aceite da versão corrente.
    SELECT NOT EXISTS (
        SELECT 1 FROM public.terms_acceptance
         WHERE user_id = p_user_id AND terms_version = p_terms_version
    ) INTO v_needs_terms;

    -- ── 3. Assinatura própria ────────────────────────────────────────────────
    -- SEM filtro de período no WHERE — é exatamente aqui que `check-user-access`
    -- difere de `get_user_access_data`, e a diferença é preservada.
    SELECT s.current_period_end, s.plan_name INTO v_sub
      FROM public.stripe_subscriptions s
     WHERE s.user_id = p_user_id
       AND s.status IN ('active', 'trialing')
     ORDER BY s.created_at DESC
     LIMIT 1;

    IF FOUND THEN
        -- Sem period_end = dado quebrado, NÃO vitalício. Foi o furo do acesso
        -- eterno de graça (ver migration 20260716180000).
        IF v_sub.current_period_end IS NULL THEN
            RETURN jsonb_build_object('estado', 'deny');
        END IF;
        IF v_sub.current_period_end < now() THEN
            RETURN jsonb_build_object('estado', 'deny');
        END IF;

        RETURN jsonb_build_object(
            'estado',     'ok',
            'isGuest',    false,
            'planName',   COALESCE(v_sub.plan_name, 'individual'),
            'needsTerms', v_needs_terms
        );
    END IF;

    -- ── 4. Convidado ─────────────────────────────────────────────────────────
    -- ⚠️ O `.maybeSingle()` do JS LEVANTA ERRO com mais de uma linha, e o erro é
    -- descartado no destructuring (`const { data } = ...`) — `data` vira null e o
    -- acesso é NEGADO. Um `LIMIT 1` aqui CONCEDERIA. A contagem existe para
    -- reproduzir a negação; não é preciosismo, é o veredicto do código atual.
    SELECT count(*) INTO v_qtd_membros
      FROM public.account_members
     WHERE member_user_id = p_user_id AND is_active = true;

    IF v_qtd_membros <> 1 THEN
        RETURN jsonb_build_object('estado', 'deny');
    END IF;

    SELECT am.owner_user_id, am.owner_email INTO v_member
      FROM public.account_members am
     WHERE am.member_user_id = p_user_id AND am.is_active = true;

    SELECT s.current_period_end, s.plan_name INTO v_owner
      FROM public.stripe_subscriptions s
     WHERE s.user_id = v_member.owner_user_id
       AND s.status IN ('active', 'trialing')
     ORDER BY s.created_at DESC
     LIMIT 1;

    -- O convidado herda o acesso do titular, então herda o mesmo rigor.
    IF NOT FOUND
       OR v_owner.current_period_end IS NULL
       OR v_owner.current_period_end < now() THEN
        RETURN jsonb_build_object('estado', 'deny');
    END IF;

    RETURN jsonb_build_object(
        'estado',     'ok',
        'isGuest',    true,
        'ownerId',    v_member.owner_user_id::text,
        'ownerEmail', v_member.owner_email,
        'planName',   COALESCE(v_owner.plan_name, 'individual'),
        'needsTerms', v_needs_terms
    );
END;
$$;

-- Só o service_role chama. O cliente não tem por que enxergar isto: quem prova
-- QUEM é o chamador é o auth.getUser da Edge Function, não esta função.
REVOKE ALL ON FUNCTION public.acesso_do_usuario(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.acesso_do_usuario(uuid, text, text) TO service_role;

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU — a troca na Edge Function só acontece DEPOIS disto
--
--   1. Comparador: a lógica do JS reimplementada em SQL, lado a lado com a RPC,
--      para TODOS os usuários reais. Exige 100% de concordância (ver o commit).
--
--   2. Privilégio fechado:
--      SELECT has_function_privilege('authenticated',
--        'public.acesso_do_usuario(uuid,text,text)', 'EXECUTE');   → false
--
--   3. Depois da troca, os logs de edge-function têm de mostrar
--      check-user-access saindo de ~2.500ms para a faixa das outras (~100-500ms).
--
-- ROLLBACK: ver supabase/rollbacks/20260818010000_acesso_do_usuario_uma_ida.down.sql
-- ============================================================================
