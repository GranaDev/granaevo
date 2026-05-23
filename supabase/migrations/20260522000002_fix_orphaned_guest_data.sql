-- =============================================================================
-- GranaEvo — Corrige dados órfãos de convidados
--
-- Contexto: bug no auth-guard.js causava isGuest=false no fallback check-user-access,
-- fazendo o effectiveUserId ser o ID do convidado em vez do dono.
-- Efeito colateral: se o convidado clicou "Novo Perfil", criava perfil
-- sob o próprio user_id (não o do dono). Esta migration limpa esses registros.
--
-- Ações:
--   1. Remove profiles criados sob o user_id de convidados ativos
--   2. Remove user_data órfãos criados sob o user_id de convidados (se houver)
--   3. Diagnóstico de account_members — garante integridade dos vínculos
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Profiles órfãos de convidados
--    Um convidado não deve ter perfis sob o próprio user_id.
--    Seus perfis devem estar sob o user_id do dono.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.profiles p
    WHERE p.user_id IN (
        SELECT am.member_user_id
        FROM public.account_members am
        WHERE am.is_active = true
    );

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE LOG '[fix_guest_data] profiles órfãos removidos: %', v_deleted;
    RAISE NOTICE '[fix_guest_data] % profile(s) órfão(s) de convidados removidos', v_deleted;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_data órfãos de convidados
--    O save-user-data EF sempre salva sob o user_id do dono via service_role.
--    Mesmo assim, limpa qualquer registro que possa ter sido criado por bug.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.user_data ud
    WHERE ud.user_id IN (
        SELECT am.member_user_id
        FROM public.account_members am
        WHERE am.is_active = true
    );

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE LOG '[fix_guest_data] user_data órfãos removidos: %', v_deleted;
    RAISE NOTICE '[fix_guest_data] % user_data órfão(s) de convidados removidos', v_deleted;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Desativa convidados cujos donos perderam a assinatura ativa
--    Garante que account_members reflita o estado real de assinaturas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_deactivated INTEGER;
BEGIN
    UPDATE public.account_members am
    SET
        is_active  = false,
        removed_at = NOW()
    WHERE am.is_active = true
      AND NOT EXISTS (
          SELECT 1 FROM public.stripe_subscriptions ss
          WHERE ss.user_id = am.owner_user_id
            AND ss.status IN ('active', 'trialing')
            AND (ss.current_period_end IS NULL OR ss.current_period_end > NOW())
      );

    GET DIAGNOSTICS v_deactivated = ROW_COUNT;
    RAISE LOG '[fix_guest_data] convidados desativados (dono sem assinatura): %', v_deactivated;
    RAISE NOTICE '[fix_guest_data] % convidado(s) desativados por assinatura do dono expirada', v_deactivated;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Diagnóstico final — registra estado atual dos vínculos de convidados
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_ativos   INTEGER;
    v_inativos INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_ativos   FROM public.account_members WHERE is_active = true;
    SELECT COUNT(*) INTO v_inativos FROM public.account_members WHERE is_active = false;

    RAISE NOTICE '[fix_guest_data] account_members: % ativo(s), % inativo(s)', v_ativos, v_inativos;
END $$;
