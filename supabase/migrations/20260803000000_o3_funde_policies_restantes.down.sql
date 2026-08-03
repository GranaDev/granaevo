-- Rollback do O-3 (policies restantes) — restaura as 5 policies originais.
--
-- Definições copiadas de `pg_policies` em produção ANTES do DROP, não escritas
-- de memória.
--
-- ⚠️ ORDEM: dropar as novas ANTES de criar as antigas. Se a criação falhar no
-- meio com as novas ainda de pé, a tabela fica com policy duplicada — e no caso
-- do `account_members` isso significaria o membro com direito de escrita.
-- Com RLS ligado, tabela sem policy nenhuma é FECHADA (ninguém lê), o que é
-- ruim mas seguro; o inverso não é.

DROP POLICY IF EXISTS account_members_select ON public.account_members;
DROP POLICY IF EXISTS account_members_insert ON public.account_members;
DROP POLICY IF EXISTS account_members_update ON public.account_members;
DROP POLICY IF EXISTS account_members_delete ON public.account_members;

CREATE POLICY owner_can_manage_own_members ON public.account_members
  FOR ALL TO authenticated
  USING      ((SELECT auth.uid()) = owner_user_id)
  WITH CHECK ((SELECT auth.uid()) = owner_user_id);

CREATE POLICY member_can_read_own_membership ON public.account_members
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = member_user_id);

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((user_id = (SELECT auth.uid())) AND can_create_profile());

CREATE POLICY guest_can_insert_owner_profiles ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.account_members
    WHERE account_members.owner_user_id  = profiles.user_id
      AND account_members.member_user_id = (SELECT auth.uid())
      AND account_members.is_active      = true
  ));

DROP POLICY IF EXISTS stripe_sub_select_own ON public.stripe_subscriptions;

CREATE POLICY stripe_sub_select_own ON public.stripe_subscriptions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY stripe_sub_select_as_guest ON public.stripe_subscriptions
  FOR SELECT TO authenticated
  USING (user_id IN (
    SELECT account_members.owner_user_id FROM public.account_members
    WHERE account_members.member_user_id = (SELECT auth.uid())
      AND account_members.is_active      = true
  ));
