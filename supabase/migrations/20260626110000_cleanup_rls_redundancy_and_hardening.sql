-- =============================================================================
-- GranaEvo — Limpeza de RLS: redundância (L1) + role hygiene (L2) + flags (L3)
-- Rollback: 20260626110000_cleanup_rls_redundancy_and_hardening.down.sql
--
-- Tudo confirmado LIVE (predicados exatos) em 2026-06-26 via Management API.
-- NENHUM destes é explorável hoje (anon só tem grant em `plans`); é dívida/defesa.
--
-- PRESERVADAS de propósito (parecem dup mas NÃO são — NÃO remover):
--   financial_audit_log (audit_log_owner_select actor_id vs audit_log_select_own user_id)
--   stripe_subscriptions (own / guest / by_email têm predicados distintos)
-- =============================================================================

-- ─── L1: políticas redundantes (subconjuntos / idênticas confirmadas) ─────────

-- profiles: ambas são subconjunto estrito de guest_can_view_owner_profiles (own OR membro)
DROP POLICY IF EXISTS "profiles_select_own"      ON public.profiles;  -- USING (user_id = auth.uid())
DROP POLICY IF EXISTS "profiles_select_as_guest" ON public.profiles;  -- USING (membro ativo)
-- UPDATE idêntica a profiles_update_own (mantida)
DROP POLICY IF EXISTS "Users can update own profiles" ON public.profiles;

-- terms_acceptance: idênticas às policies authenticated (mantidas)
DROP POLICY IF EXISTS "terms_owner_insert" ON public.terms_acceptance;  -- == "Users can insert own terms acceptance"
DROP POLICY IF EXISTS "terms_owner_select" ON public.terms_acceptance;  -- == "Users can view own terms acceptance"

-- plans: ambas SELECT USING(true); "Anyone can view plans" (authenticated,anon) é mantida
DROP POLICY IF EXISTS "plans_select_public" ON public.plans;

-- account_members: owner_select (owner OR membro) coberto por owner_can_manage_own_members
-- (ALL, owner) + member_can_read_own_membership (membro). owner_update coberto pela policy ALL.
DROP POLICY IF EXISTS "account_members_owner_select" ON public.account_members;
DROP POLICY IF EXISTS "account_members_owner_update" ON public.account_members;

-- ─── L2: trocar role `public` (inclui anon) por `authenticated` ───────────────
-- Predicados usam auth.uid() (NULL p/ anon) — não explorável, mas higiene/defesa.
-- NOTA: guest_invitations já estava limpa em prod (só owner_can_view_own_invitations
--       authenticated + service_role) — nenhuma policy TO public a alterar lá.
ALTER POLICY "profile_backups_select_own"      ON public.profile_backups     TO authenticated;
ALTER POLICY "snapshots_select_own"            ON public.user_data_snapshots TO authenticated;
ALTER POLICY "push_select_own"                 ON public.push_subscriptions  TO authenticated;
ALTER POLICY "push_insert_own"                 ON public.push_subscriptions  TO authenticated;
ALTER POLICY "push_update_own"                 ON public.push_subscriptions  TO authenticated;
ALTER POLICY "push_delete_own"                 ON public.push_subscriptions  TO authenticated;

-- ─── L3: feature_flags — esconder flags globais (kill-switches/gating) ────────
-- Antes: qualquer authenticated lê flags globais (target_user_id IS NULL).
-- Depois: só lê as próprias flags. Flags globais ficam só p/ service_role.
-- (Confirmado LIVE: nenhum código de app/edge lê feature_flags → sem regressão.)
ALTER POLICY "feature_flags_select_auth" ON public.feature_flags
  USING (target_user_id = auth.uid());

-- ─── Salvaguarda idempotente (auto-correção) ──────────────────────────────────
-- Durante a aplicação LIVE 2026-06-26, ao remover os irmãos redundantes, duas
-- políticas LOAD-BEARING ficaram ausentes no banco (causa não determinística —
-- provável inconsistência de leitura do Management API / consolidação prévia):
--   * plans."Anyone can view plans"  (leitura pública dos planos — quebra o app)
--   * account_members.member_can_read_own_membership (compartilhamento casal/família:
--       user_data_select depende deste SELECT via EXISTS sob RLS do membro)
-- Recriadas e verificadas no data-plane (anon lê plans; predicado do membro confere).
-- Os blocos abaixo GARANTEM o estado correto mesmo se a migration for reaplicada.
DROP POLICY IF EXISTS "Anyone can view plans" ON public.plans;
CREATE POLICY "Anyone can view plans" ON public.plans
  FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS "member_can_read_own_membership" ON public.account_members;
CREATE POLICY "member_can_read_own_membership" ON public.account_members
  FOR SELECT TO authenticated USING (auth.uid() = member_user_id);
