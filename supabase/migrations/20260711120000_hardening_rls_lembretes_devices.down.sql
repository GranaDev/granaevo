-- Rollback de 20260711120000_hardening_rls_lembretes_devices.sql

-- G. índices
DROP INDEX IF EXISTS public.idx_cakto_archive_plan_id;
CREATE INDEX IF NOT EXISTS idx_subscriptions_refunded ON public.subscriptions_cakto_archive(refunded_at) WHERE refunded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_cakto_order ON public.subscriptions_cakto_archive(cakto_order_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_cakto_order_id ON public.subscriptions_cakto_archive(cakto_order_id);

-- F. cron
SELECT cron.unschedule('granaevo-limpar-user-devices');

-- E. user_devices
DROP TABLE IF EXISTS public.user_devices;

-- D. tipo lembrete
ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY['conta_vence'::text, 'fatura_fecha'::text, 'assinatura_renova'::text, 'orcamento_estouro'::text]));

-- C. chat_parse_usage
DROP POLICY IF EXISTS chat_parse_usage_deny_client ON public.chat_parse_usage;

-- B. RLS initplan (volta ao auth.uid() direto)
ALTER POLICY member_can_read_own_membership ON public.account_members USING (auth.uid() = member_user_id);
ALTER POLICY owner_can_manage_own_members ON public.account_members USING (auth.uid() = owner_user_id) WITH CHECK (auth.uid() = owner_user_id);
ALTER POLICY feature_flags_select_auth ON public.feature_flags USING (target_user_id = auth.uid());
ALTER POLICY audit_log_owner_select ON public.financial_audit_log USING (actor_id = auth.uid());
ALTER POLICY audit_log_select_own ON public.financial_audit_log USING (auth.uid() = user_id);
ALTER POLICY owner_can_view_own_invitations ON public.guest_invitations USING (auth.uid() = owner_user_id);
ALTER POLICY profile_backups_select_own ON public.profile_backups USING (auth.uid() = owner_user_id);
ALTER POLICY guest_can_view_owner_profiles ON public.profiles
  USING ((auth.uid() = user_id) OR (EXISTS (SELECT 1 FROM account_members WHERE account_members.owner_user_id = profiles.user_id AND account_members.member_user_id = auth.uid() AND account_members.is_active = true)));
ALTER POLICY guest_can_insert_owner_profiles ON public.profiles
  WITH CHECK (EXISTS (SELECT 1 FROM account_members WHERE account_members.owner_user_id = profiles.user_id AND account_members.member_user_id = auth.uid() AND account_members.is_active = true));
ALTER POLICY profiles_insert_own ON public.profiles WITH CHECK ((user_id = auth.uid()) AND can_create_profile());
ALTER POLICY profiles_update_own ON public.profiles USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
ALTER POLICY push_select_own ON public.push_subscriptions USING (auth.uid() = user_id);
ALTER POLICY push_insert_own ON public.push_subscriptions WITH CHECK (auth.uid() = user_id);
ALTER POLICY push_update_own ON public.push_subscriptions USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
ALTER POLICY push_delete_own ON public.push_subscriptions USING (auth.uid() = user_id);
ALTER POLICY radar_select_own ON public.radar_notifications USING (auth.uid() = user_id);
ALTER POLICY radar_insert_own ON public.radar_notifications WITH CHECK ((auth.uid() = user_id) AND (status = 'pending'::text));
ALTER POLICY radar_delete_own_pending ON public.radar_notifications USING ((auth.uid() = user_id) AND (status = 'pending'::text));
ALTER POLICY stripe_sub_select_own ON public.stripe_subscriptions USING (auth.uid() = user_id);
ALTER POLICY stripe_sub_select_by_email ON public.stripe_subscriptions
  USING ((lower(user_email) = lower(auth.email())) AND (EXISTS (SELECT 1 FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL)));
ALTER POLICY stripe_sub_select_as_guest ON public.stripe_subscriptions
  USING (user_id IN (SELECT account_members.owner_user_id FROM account_members WHERE account_members.member_user_id = auth.uid() AND account_members.is_active = true));
ALTER POLICY user_data_select ON public.user_data
  USING ((auth.uid() = user_id) OR (EXISTS (SELECT 1 FROM account_members WHERE account_members.owner_user_id = user_data.user_id AND account_members.member_user_id = auth.uid() AND account_members.is_active = true)));
ALTER POLICY user_data_insert ON public.user_data WITH CHECK (auth.uid() = user_id);
ALTER POLICY user_data_update ON public.user_data USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
ALTER POLICY user_data_delete ON public.user_data USING (auth.uid() = user_id);
ALTER POLICY snapshots_select_own ON public.user_data_snapshots USING (auth.uid() = user_id);

-- A. grants
GRANT EXECUTE ON FUNCTION public.has_accepted_terms(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_dados_usuario(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_perfil_usuario(text, jsonb) TO authenticated;
