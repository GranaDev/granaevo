-- 20260714150000_drop_duplicate_indexes.down.sql
-- GranaEvo — Rollback: 20260714150000_drop_duplicate_indexes.sql
-- Recria os índices duplicados removidos. Execute apenas em emergência (eles eram
-- redundantes; a UNIQUE correspondente já cobre a mesma coluna).

CREATE INDEX IF NOT EXISTS idx_user_data_user_id ON public.user_data USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_data_user_id_partial ON public.user_data USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_user_profile_management_user_id ON public.user_profile_management USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_terms_acceptance_user_version ON public.terms_acceptance USING btree (user_id, terms_version);
CREATE INDEX IF NOT EXISTS idx_invite_nonces_nonce ON public.invite_nonces USING btree (nonce);
CREATE INDEX IF NOT EXISTS idx_rate_limit_identifier ON public.invite_rate_limit USING btree (identifier, identifier_type);
CREATE INDEX IF NOT EXISTS idx_login_lockouts_identifier ON public.login_lockouts USING btree (identifier, identifier_type);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_id_idx ON public.stripe_subscriptions USING btree (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_user_date ON public.user_data_snapshots USING btree (user_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_payment ON public.subscriptions_cakto_archive USING btree (payment_id);
CREATE INDEX IF NOT EXISTS idx_financial_audit_log_actor_id ON public.financial_audit_log USING btree (actor_id) WHERE (actor_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_guest_invitations_email_status ON public.guest_invitations USING btree (guest_email, used, expires_at);
