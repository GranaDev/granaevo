-- =============================================================================
-- DOWN de 20260626110000_cleanup_rls_redundancy_and_hardening.sql
-- Recria as políticas removidas e reverte os ALTERs (TO public + flags globais).
-- =============================================================================

-- L1 — recriar políticas removidas (definições LIVE 2026-06-26)
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "profiles_select_as_guest" ON public.profiles
  FOR SELECT TO authenticated
  USING (user_id IN (SELECT account_members.owner_user_id FROM account_members
                     WHERE account_members.member_user_id = auth.uid() AND account_members.is_active = true));
CREATE POLICY "Users can update own profiles" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "terms_owner_insert" ON public.terms_acceptance
  FOR INSERT TO public WITH CHECK (user_id = auth.uid());
CREATE POLICY "terms_owner_select" ON public.terms_acceptance
  FOR SELECT TO public USING (user_id = auth.uid());

CREATE POLICY "plans_select_public" ON public.plans
  FOR SELECT TO public USING (true);

CREATE POLICY "account_members_owner_select" ON public.account_members
  FOR SELECT TO public USING (owner_user_id = auth.uid() OR member_user_id = auth.uid());
CREATE POLICY "account_members_owner_update" ON public.account_members
  FOR UPDATE TO authenticated USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

-- L2 — reverter roles para public (guest_invitations não foi alterada — ver UP)
ALTER POLICY "profile_backups_select_own"      ON public.profile_backups     TO public;
ALTER POLICY "snapshots_select_own"            ON public.user_data_snapshots TO public;
ALTER POLICY "push_select_own"                 ON public.push_subscriptions  TO public;
ALTER POLICY "push_insert_own"                 ON public.push_subscriptions  TO public;
ALTER POLICY "push_update_own"                 ON public.push_subscriptions  TO public;
ALTER POLICY "push_delete_own"                 ON public.push_subscriptions  TO public;

-- L3 — reverter feature_flags para incluir flags globais
ALTER POLICY "feature_flags_select_auth" ON public.feature_flags
  USING ((target_user_id IS NULL) OR (target_user_id = auth.uid()));
