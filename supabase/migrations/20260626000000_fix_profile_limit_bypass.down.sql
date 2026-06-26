-- =============================================================================
-- GranaEvo — Rollback: 20260626000000_fix_profile_limit_bypass.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
-- Reverter REABRE o bypass do limite de perfis — só use se o fix causar regressão.
-- =============================================================================

-- Reverte em ordem INVERSA ao UP

-- 2) Remove trigger + função de limite
DROP TRIGGER IF EXISTS enforce_profile_limit_stripe ON public.profiles;
DROP FUNCTION IF EXISTS public.enforce_profile_limit_stripe();

-- 1) Restaura a policy de convidado com o ramo self-insert original
ALTER POLICY "guest_can_insert_owner_profiles" ON public.profiles
  WITH CHECK (
    (auth.uid() = user_id)
    OR EXISTS (
      SELECT 1 FROM public.account_members
      WHERE account_members.owner_user_id  = profiles.user_id
        AND account_members.member_user_id = auth.uid()
        AND account_members.is_active = true
    )
  );
