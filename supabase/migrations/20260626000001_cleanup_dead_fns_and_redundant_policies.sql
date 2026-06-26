-- =============================================================================
-- GranaEvo — Limpeza: dead code quebrado + políticas RLS redundantes (/god-eyes)
-- Rollback: ver 20260626000001_cleanup_dead_fns_and_redundant_policies.down.sql
--
-- #1 — Funções legadas QUEBRADAS (dead code): check_profile_limit() e
--      max_profiles_for_user(uuid) leem a relação `subscriptions`, que NÃO existe
--      mais (hoje é stripe_subscriptions). Confirmado: nenhuma função/trigger/policy
--      as referencia. A enforcement de limite agora é o trigger
--      enforce_profile_limit_stripe (migration 20260626000000).
--
-- #2 — Políticas RLS redundantes (cruft de nomes antigos + snake_case). Removidas as
--      comprovadamente idênticas/subconjunto; mantida a mais ampla/correta de cada par.
--      NÃO removidas (parecem dup mas NÃO são): account_members ALL (owner vs service),
--      financial_audit_log SELECT (actor_id vs user_id), profiles INSERT (guest vs own),
--      stripe_subscriptions SELECT (own/membro/by_email).
-- =============================================================================

-- #1
DROP FUNCTION IF EXISTS public.check_profile_limit();
DROP FUNCTION IF EXISTS public.max_profiles_for_user(uuid);

-- #2
-- NOTA DE RECONCILIAÇÃO (2026-06-26): account_members e plans são tratados pela
-- migration 20260626110000 (god-mode) com a escolha OPOSTA de qual irmão manter —
-- ela MANTÉM member_can_read_own_membership e "Anyone can view plans" e dropa os
-- irmãos (account_members_owner_select / plans_select_public). Para o estado final
-- bater com produção num replay, NÃO dropamos aqui essas duas. (Antes esta migration
-- dropava member_can_read_own_membership e "Anyone can view plans" — removido p/ evitar
-- que o replay deixasse account_members/plans sem policy de leitura.)
DROP POLICY IF EXISTS guest_invitations_owner_select  ON public.guest_invitations; -- == owner_can_view_own_invitations (public dup)
DROP POLICY IF EXISTS profiles_select_as_guest        ON public.profiles;          -- subset de guest_can_view_owner_profiles
DROP POLICY IF EXISTS profiles_select_own             ON public.profiles;          -- subset de guest_can_view_owner_profiles
DROP POLICY IF EXISTS "Users can update own profiles" ON public.profiles;          -- == profiles_update_own
DROP POLICY IF EXISTS terms_owner_insert              ON public.terms_acceptance;  -- == "Users can insert own terms acceptance" (public dup)
DROP POLICY IF EXISTS terms_owner_select              ON public.terms_acceptance;  -- == "Users can view own terms acceptance" (public dup)
