-- 20260711120000_hardening_rls_lembretes_devices.sql
-- ============================================================================
-- Pacote de blindagem + otimização (análise 360º de 2026-07-11):
--  A. REVOKE de RPCs SECURITY DEFINER órfãs (sem uso no front/api/edges)
--  B. RLS initplan: auth.uid()/auth.email() → (select ...) em 26 policies
--     (advisor auth_rls_initplan — evita reavaliação por linha)
--  C. chat_parse_usage: policy deny explícita (silencia advisor; documenta intenção)
--  D. radar_notifications: tipo 'lembrete' (lembretes do usuário via chat)
--  E. user_devices: aparelhos conhecidos p/ alerta de login (edge notify-login)
--  F. cron de retenção de user_devices (180 dias sem uso → apaga; LGPD minimização)
--  G. índices: FK do archive Cakto coberta + drop dos 3 índices mortos flagados
-- ============================================================================

-- ── A. REVOKE de RPCs órfãs ─────────────────────────────────────────────────
-- has_accepted_terms / salvar_dados_usuario / salvar_perfil_usuario: nenhum
-- uso em src/, api/ ou supabase/functions (verificado 2026-07-11). Edges usam
-- service_role (não afetado). can_create_profile é LOAD-BEARING na policy
-- profiles_insert_own → authenticated PRECISA manter EXECUTE; anon não.
REVOKE EXECUTE ON FUNCTION public.has_accepted_terms(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.salvar_dados_usuario(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.salvar_perfil_usuario(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_create_profile() FROM PUBLIC, anon;
-- ARMADILHA: o REVOKE FROM PUBLIC derruba o grant implícito que authenticated
-- herdava — e a policy roda como o usuário chamador. Re-grant explícito:
GRANT EXECUTE ON FUNCTION public.can_create_profile() TO authenticated;

-- ── B. RLS initplan (mesma semântica, avaliação 1x por query) ───────────────
-- account_members
ALTER POLICY member_can_read_own_membership ON public.account_members
  USING ((select auth.uid()) = member_user_id);
ALTER POLICY owner_can_manage_own_members ON public.account_members
  USING ((select auth.uid()) = owner_user_id)
  WITH CHECK ((select auth.uid()) = owner_user_id);

-- feature_flags
ALTER POLICY feature_flags_select_auth ON public.feature_flags
  USING (target_user_id = (select auth.uid()));

-- financial_audit_log (as duas são complementares: linhas SOBRE mim e FEITAS por mim)
ALTER POLICY audit_log_owner_select ON public.financial_audit_log
  USING (actor_id = (select auth.uid()));
ALTER POLICY audit_log_select_own ON public.financial_audit_log
  USING ((select auth.uid()) = user_id);

-- guest_invitations
ALTER POLICY owner_can_view_own_invitations ON public.guest_invitations
  USING ((select auth.uid()) = owner_user_id);

-- profile_backups
ALTER POLICY profile_backups_select_own ON public.profile_backups
  USING ((select auth.uid()) = owner_user_id);

-- profiles
ALTER POLICY guest_can_view_owner_profiles ON public.profiles
  USING (((select auth.uid()) = user_id) OR (EXISTS (
    SELECT 1 FROM account_members
    WHERE account_members.owner_user_id = profiles.user_id
      AND account_members.member_user_id = (select auth.uid())
      AND account_members.is_active = true)));
ALTER POLICY guest_can_insert_owner_profiles ON public.profiles
  WITH CHECK (EXISTS (
    SELECT 1 FROM account_members
    WHERE account_members.owner_user_id = profiles.user_id
      AND account_members.member_user_id = (select auth.uid())
      AND account_members.is_active = true));
ALTER POLICY profiles_insert_own ON public.profiles
  WITH CHECK ((user_id = (select auth.uid())) AND can_create_profile());
ALTER POLICY profiles_update_own ON public.profiles
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- push_subscriptions
ALTER POLICY push_select_own ON public.push_subscriptions
  USING ((select auth.uid()) = user_id);
ALTER POLICY push_insert_own ON public.push_subscriptions
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY push_update_own ON public.push_subscriptions
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY push_delete_own ON public.push_subscriptions
  USING ((select auth.uid()) = user_id);

-- radar_notifications
ALTER POLICY radar_select_own ON public.radar_notifications
  USING ((select auth.uid()) = user_id);
ALTER POLICY radar_insert_own ON public.radar_notifications
  WITH CHECK (((select auth.uid()) = user_id) AND (status = 'pending'::text));
ALTER POLICY radar_delete_own_pending ON public.radar_notifications
  USING (((select auth.uid()) = user_id) AND (status = 'pending'::text));

-- stripe_subscriptions
ALTER POLICY stripe_sub_select_own ON public.stripe_subscriptions
  USING ((select auth.uid()) = user_id);
ALTER POLICY stripe_sub_select_by_email ON public.stripe_subscriptions
  USING ((lower(user_email) = lower((select auth.email()))) AND (EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = (select auth.uid()) AND u.email_confirmed_at IS NOT NULL)));
ALTER POLICY stripe_sub_select_as_guest ON public.stripe_subscriptions
  USING (user_id IN (
    SELECT account_members.owner_user_id FROM account_members
    WHERE account_members.member_user_id = (select auth.uid())
      AND account_members.is_active = true));

-- user_data
ALTER POLICY user_data_select ON public.user_data
  USING (((select auth.uid()) = user_id) OR (EXISTS (
    SELECT 1 FROM account_members
    WHERE account_members.owner_user_id = user_data.user_id
      AND account_members.member_user_id = (select auth.uid())
      AND account_members.is_active = true)));
ALTER POLICY user_data_insert ON public.user_data
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY user_data_update ON public.user_data
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY user_data_delete ON public.user_data
  USING ((select auth.uid()) = user_id);

-- user_data_snapshots
ALTER POLICY snapshots_select_own ON public.user_data_snapshots
  USING ((select auth.uid()) = user_id);

-- ── C. chat_parse_usage: deny explícito (era RLS-on sem policy = deny implícito) ─
DROP POLICY IF EXISTS chat_parse_usage_deny_client ON public.chat_parse_usage;
CREATE POLICY chat_parse_usage_deny_client ON public.chat_parse_usage
  AS PERMISSIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- ── D. Radar: novo tipo 'lembrete' (lembretes criados pelo usuário no chat) ──
ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY['conta_vence'::text, 'fatura_fecha'::text, 'assinatura_renova'::text, 'orcamento_estouro'::text, 'lembrete'::text]));

-- ── E. user_devices: aparelhos conhecidos por conta (alerta de login) ────────
-- Escrita SÓ pela edge notify-login (service_role). O usuário pode LER os seus
-- (painel Segurança). Nada sensível: hash SHA-256(user_id|UA) + rótulo do UA.
CREATE TABLE IF NOT EXISTS public.user_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_hash text NOT NULL CHECK (char_length(device_hash) BETWEEN 16 AND 128),
  ua_label    text CHECK (ua_label IS NULL OR char_length(ua_label) <= 120),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_hash)
);
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_devices_select_own ON public.user_devices;
CREATE POLICY user_devices_select_own ON public.user_devices
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS user_devices_service_all ON public.user_devices;
CREATE POLICY user_devices_service_all ON public.user_devices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Grants mínimos e EXPLÍCITOS. ARMADILHA: tabela criada via Management API
-- (role postgres) NÃO herda os default privileges p/ anon/authenticated —
-- nasce só com postgres+service_role. Então o modelo é: conceder só o SELECT
-- que a policy select_own precisa; anon fica sem nada.
GRANT SELECT ON public.user_devices TO authenticated;
REVOKE ALL ON public.user_devices FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_devices FROM authenticated;

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON public.user_devices(user_id);

-- ── F. Retenção: aparelho sem uso há 180 dias sai da lista (minimização LGPD) ─
SELECT cron.schedule(
  'granaevo-limpar-user-devices',
  '30 4 * * 0',
  $$ DELETE FROM public.user_devices WHERE last_seen < now() - interval '180 days'; $$
);

-- ── G. Índices: cobre a FK do archive; remove os 3 mortos flagados ──────────
CREATE INDEX IF NOT EXISTS idx_cakto_archive_plan_id ON public.subscriptions_cakto_archive(plan_id);
DROP INDEX IF EXISTS public.idx_subscriptions_refunded;
DROP INDEX IF EXISTS public.idx_subscriptions_cakto_order;
DROP INDEX IF EXISTS public.idx_subscriptions_cakto_order_id;
