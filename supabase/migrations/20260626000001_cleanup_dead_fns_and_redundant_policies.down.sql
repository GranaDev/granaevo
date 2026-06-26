-- =============================================================================
-- GranaEvo — Rollback: 20260626000001_cleanup_dead_fns_and_redundant_policies.sql
-- ATENÇÃO: reverte a limpeza. Execute apenas em emergência.
--
-- #1: As funções check_profile_limit()/max_profiles_for_user() NÃO são recriadas —
--     eram dead code QUEBRADO (liam tabela `subscriptions` inexistente). Recriá-las
--     reintroduziria código que falha. Se precisar de enforcement, use o trigger
--     enforce_profile_limit_stripe (migration 20260626000000). Documentado de propósito.
--
-- #2: Recria as políticas redundantes a partir do snapshot pg_policies (2026-06-26).
-- =============================================================================

-- #2 — recria políticas (ordem inversa não importa entre tabelas distintas)
CREATE POLICY member_can_read_own_membership ON public.account_members
  FOR SELECT TO authenticated USING (auth.uid() = member_user_id);

CREATE POLICY guest_invitations_owner_select ON public.guest_invitations
  FOR SELECT TO public USING (owner_user_id = auth.uid());

CREATE POLICY "Anyone can view plans" ON public.plans
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY profiles_select_as_guest ON public.profiles
  FOR SELECT TO authenticated
  USING (user_id IN (
    SELECT account_members.owner_user_id FROM account_members
    WHERE account_members.member_user_id = auth.uid() AND account_members.is_active = true));

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Users can update own profiles" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY terms_owner_insert ON public.terms_acceptance
  FOR INSERT TO public WITH CHECK (user_id = auth.uid());

CREATE POLICY terms_owner_select ON public.terms_acceptance
  FOR SELECT TO public USING (user_id = auth.uid());
