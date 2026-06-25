-- =============================================================================
-- GranaEvo — BASELINE SCHEMA (public)
-- Gerado via Supabase Management API (introspecção, schema-only) em 2026-06-25T16:34:57.278Z
-- Projeto: granaevo-prod (fvrhqqeofqedmhadzzqw) · PostgreSQL 17.6
--
-- REFERÊNCIA de Disaster Recovery / Auditoria (achado M1). NÃO é migration:
-- não reaplicar contra o banco vivo. Para reconstruir do zero, ver README.md.
-- Nenhum dado de usuário está incluído (schema-only).
-- =============================================================================

-- ─── account_members ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_email text NOT NULL,
  member_user_id uuid,
  member_email text NOT NULL,
  member_name text NOT NULL,
  is_active boolean DEFAULT true,
  invitation_id uuid,
  invited_at timestamp with time zone DEFAULT now(),
  joined_at timestamp with time zone,
  removed_at timestamp with time zone,
  CONSTRAINT account_members_pkey PRIMARY KEY (id),
  CONSTRAINT account_members_unique UNIQUE (owner_user_id, member_email),
  CONSTRAINT fk_account_members_member FOREIGN KEY (member_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_account_members_owner FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members FORCE ROW LEVEL SECURITY;

-- ─── edge_rate_limits ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  key text NOT NULL,
  count integer DEFAULT 1 NOT NULL,
  window_start timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT edge_rate_limits_pkey PRIMARY KEY (key)
);
ALTER TABLE public.edge_rate_limits ENABLE ROW LEVEL SECURITY;

-- ─── feature_flags ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  flag_key text NOT NULL,
  is_enabled boolean DEFAULT false NOT NULL,
  target_plan text,
  target_user_id uuid,
  description text DEFAULT ''::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT feature_flags_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flags_key_plan_user_unique UNIQUE (flag_key, target_plan, target_user_id)
);
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags FORCE ROW LEVEL SECURITY;

-- ─── financial_audit_log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.financial_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  actor_id uuid,
  operation text NOT NULL,
  data_size_before integer,
  data_size_after integer,
  hash_before text,
  hash_after text,
  ip_address inet,
  user_agent text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT financial_audit_log_pkey PRIMARY KEY (id),
  CONSTRAINT financial_audit_log_operation_check CHECK ((operation = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);
ALTER TABLE public.financial_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_audit_log FORCE ROW LEVEL SECURITY;

-- ─── fraud_logs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fraud_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  subscription_id uuid,
  payment_id text NOT NULL,
  event_type text NOT NULL,
  reason text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fraud_logs_pkey PRIMARY KEY (id),
  CONSTRAINT fraud_logs_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES subscriptions_cakto_archive(id) ON DELETE CASCADE,
  CONSTRAINT fraud_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.fraud_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_logs FORCE ROW LEVEL SECURITY;

-- ─── guest_invitations ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guest_invitations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_email text NOT NULL,
  owner_name text NOT NULL,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used boolean DEFAULT false,
  used_at timestamp with time zone,
  verification_attempts integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  code_hash text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT guest_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT guest_invitations_owner_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.guest_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_invitations FORCE ROW LEVEL SECURITY;

-- ─── invite_nonces ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invite_nonces (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  nonce text NOT NULL,
  used boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
  CONSTRAINT invite_nonces_pkey PRIMARY KEY (id),
  CONSTRAINT invite_nonces_nonce_unique UNIQUE (nonce)
);
ALTER TABLE public.invite_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_nonces FORCE ROW LEVEL SECURITY;

-- ─── invite_rate_limit ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invite_rate_limit (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  identifier text NOT NULL,
  identifier_type text NOT NULL,
  attempt_count integer DEFAULT 1 NOT NULL,
  window_start timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
  CONSTRAINT invite_rate_limit_pkey PRIMARY KEY (id),
  CONSTRAINT invite_rate_limit_unique UNIQUE (identifier, identifier_type),
  CONSTRAINT invite_rate_limit_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['ip'::text, 'email'::text])))
);
ALTER TABLE public.invite_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_rate_limit FORCE ROW LEVEL SECURITY;

-- ─── login_lockouts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.login_lockouts (
  id bigint DEFAULT nextval('login_lockouts_id_seq'::regclass) NOT NULL,
  identifier text NOT NULL,
  identifier_type text NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  lockout_level integer DEFAULT 0 NOT NULL,
  last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT login_lockouts_pkey PRIMARY KEY (id),
  CONSTRAINT login_lockouts_identifier_type_uq UNIQUE (identifier, identifier_type),
  CONSTRAINT login_lockouts_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['email'::text, 'ip'::text])))
);
ALTER TABLE public.login_lockouts ENABLE ROW LEVEL SECURITY;

-- ─── password_reset_codes ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.password_reset_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used boolean DEFAULT false,
  used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  code_hash text NOT NULL,
  verification_attempts integer DEFAULT 0 NOT NULL,
  user_id uuid,
  CONSTRAINT password_reset_codes_pkey PRIMARY KEY (id),
  CONSTRAINT password_reset_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.password_reset_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_codes FORCE ROW LEVEL SECURITY;

-- ─── payment_events ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cakto_order_id text NOT NULL,
  event_type text NOT NULL,
  event_data jsonb DEFAULT '{}'::jsonb NOT NULL,
  processed boolean DEFAULT false,
  processed_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT payment_events_pkey PRIMARY KEY (id)
);
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events FORCE ROW LEVEL SECURITY;

-- ─── plans ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  price numeric(10,2) NOT NULL,
  max_profiles integer NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT plans_pkey PRIMARY KEY (id),
  CONSTRAINT plans_name_key UNIQUE (name)
);
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans FORCE ROW LEVEL SECURITY;

-- ─── profile_backups ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_backups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_user_id uuid NOT NULL,
  original_member_id text NOT NULL,
  member_name text,
  member_email text,
  member_data jsonb DEFAULT '{}'::jsonb NOT NULL,
  scheduled_removal_at timestamp with time zone NOT NULL,
  activated_at timestamp with time zone,
  backup_expires_at timestamp with time zone,
  status text DEFAULT 'pending'::text NOT NULL,
  original_plan text NOT NULL,
  target_plan text NOT NULL,
  stripe_subscription_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  source_table text DEFAULT 'profiles'::text NOT NULL,
  CONSTRAINT profile_backups_pkey PRIMARY KEY (id),
  CONSTRAINT profile_backups_plan_check CHECK ((original_plan = ANY (ARRAY['individual'::text, 'casal'::text, 'familia'::text]))),
  CONSTRAINT profile_backups_source_check CHECK ((source_table = ANY (ARRAY['profiles'::text, 'account_members'::text]))),
  CONSTRAINT profile_backups_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'restored'::text, 'cancelled'::text, 'deleted'::text]))),
  CONSTRAINT profile_backups_target_plan_check CHECK ((target_plan = ANY (ARRAY['individual'::text, 'casal'::text, 'familia'::text]))),
  CONSTRAINT profile_backups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.profile_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_backups FORCE ROW LEVEL SECURITY;

-- ─── profiles ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id integer DEFAULT nextval('profiles_id_seq'::regclass) NOT NULL,
  user_id uuid,
  name text NOT NULL,
  photo_url text,
  created_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true NOT NULL,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- ─── push_subscriptions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  last_used_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true,
  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;

-- ─── rate_limit_writes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limit_writes (
  user_id uuid NOT NULL,
  window_start timestamp with time zone DEFAULT date_trunc('hour'::text, now()) NOT NULL,
  write_count integer DEFAULT 1 NOT NULL,
  CONSTRAINT rate_limit_writes_pkey PRIMARY KEY (user_id, window_start),
  CONSTRAINT rate_limit_writes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.rate_limit_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_writes FORCE ROW LEVEL SECURITY;

-- ─── stripe_events ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id text NOT NULL,
  processed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT stripe_events_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events FORCE ROW LEVEL SECURITY;

-- ─── stripe_subscriptions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  user_email text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text,
  stripe_price_id text,
  plan_name text,
  status text DEFAULT 'incomplete'::text NOT NULL,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean DEFAULT false NOT NULL,
  canceled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  pending_plan_name text,
  pending_plan_effective_at timestamp with time zone,
  pending_profile_removals jsonb,
  pending_member_removals jsonb,
  CONSTRAINT stripe_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_subscriptions_stripe_customer_id_key UNIQUE (stripe_customer_id),
  CONSTRAINT stripe_subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id),
  CONSTRAINT stripe_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_subscriptions FORCE ROW LEVEL SECURITY;

-- ─── subscriptions_cakto_archive ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions_cakto_archive (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  plan_id uuid,
  payment_id text,
  payment_method text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  user_email text,
  user_name text,
  refunded_at timestamp with time zone,
  refund_reason text,
  is_active boolean DEFAULT false,
  access_revoked_at timestamp with time zone,
  user_cpf text,
  user_phone text,
  cakto_order_id text,
  cakto_product_id text,
  password_created_at timestamp with time zone,
  password_created boolean DEFAULT false,
  payment_status payment_status_enum DEFAULT 'pending'::payment_status_enum,
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_payment_id_key UNIQUE (payment_id),
  CONSTRAINT check_approved_must_have_plan CHECK (((payment_status <> 'approved'::payment_status_enum) OR (plan_id IS NOT NULL))),
  CONSTRAINT check_cpf_hash_format CHECK (((user_cpf IS NULL) OR (length(user_cpf) = 64))),
  CONSTRAINT check_phone_format CHECK (((user_phone ~ '^\d{10,11}$'::text) OR (user_phone IS NULL))),
  CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
);
ALTER TABLE public.subscriptions_cakto_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions_cakto_archive FORCE ROW LEVEL SECURITY;

-- ─── terms_acceptance ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.terms_acceptance (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  email text NOT NULL,
  accepted boolean DEFAULT true NOT NULL,
  accepted_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  terms_version text DEFAULT '1.0'::text NOT NULL,
  CONSTRAINT terms_acceptance_pkey PRIMARY KEY (id),
  CONSTRAINT terms_acceptance_user_id_unique UNIQUE (user_id),
  CONSTRAINT terms_acceptance_user_version_unique UNIQUE (user_id, terms_version),
  CONSTRAINT fk_terms_acceptance_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT terms_acceptance_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.terms_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terms_acceptance FORCE ROW LEVEL SECURITY;

-- ─── user_data ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_data (
  id bigint DEFAULT nextval('user_data_id_seq'::regclass) NOT NULL,
  user_id uuid NOT NULL,
  email text NOT NULL,
  data_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_modified timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_data_pkey PRIMARY KEY (id),
  CONSTRAINT user_data_user_id_key UNIQUE (user_id),
  CONSTRAINT fk_user_data_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_data_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_data FORCE ROW LEVEL SECURITY;

-- ─── user_data_snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_data_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  user_email text DEFAULT ''::text NOT NULL,
  snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
  data_json jsonb NOT NULL,
  size_bytes integer DEFAULT 0 NOT NULL,
  checksum text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_data_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT uq_snapshot_user_date UNIQUE (user_id, snapshot_date),
  CONSTRAINT user_data_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.user_data_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_data_snapshots FORCE ROW LEVEL SECURITY;

-- ─── user_profile_management ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_profile_management (
  id bigint DEFAULT nextval('user_profile_management_id_seq'::regclass) NOT NULL,
  user_id uuid NOT NULL,
  email text,
  active_profiles_count integer DEFAULT 0,
  profile_names text[],
  plan_name text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_profile_management_pkey PRIMARY KEY (id),
  CONSTRAINT user_profile_management_user_id_key UNIQUE (user_id),
  CONSTRAINT user_profile_management_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.user_profile_management ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profile_management FORCE ROW LEVEL SECURITY;

-- ─── Índices ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX account_members_pkey ON public.account_members USING btree (id);
CREATE UNIQUE INDEX account_members_unique ON public.account_members USING btree (owner_user_id, member_email);
CREATE INDEX idx_acc_members_email ON public.account_members USING btree (member_email);
CREATE INDEX idx_acc_members_member ON public.account_members USING btree (member_user_id);
CREATE INDEX idx_acc_members_owner ON public.account_members USING btree (owner_user_id);
CREATE INDEX idx_account_members_member ON public.account_members USING btree (member_user_id, is_active);
CREATE INDEX idx_account_members_owner ON public.account_members USING btree (owner_user_id, is_active);
CREATE INDEX idx_account_members_removed_at ON public.account_members USING btree (removed_at) WHERE (is_active = false);
CREATE UNIQUE INDEX edge_rate_limits_pkey ON public.edge_rate_limits USING btree (key);
CREATE UNIQUE INDEX feature_flags_key_plan_user_unique ON public.feature_flags USING btree (flag_key, target_plan, target_user_id);
CREATE UNIQUE INDEX feature_flags_pkey ON public.feature_flags USING btree (id);
CREATE INDEX idx_feature_flags_key ON public.feature_flags USING btree (flag_key);
CREATE INDEX idx_feature_flags_user ON public.feature_flags USING btree (target_user_id) WHERE (target_user_id IS NOT NULL);
CREATE UNIQUE INDEX financial_audit_log_pkey ON public.financial_audit_log USING btree (id);
CREATE INDEX idx_audit_log_actor_id ON public.financial_audit_log USING btree (actor_id);
CREATE INDEX idx_audit_log_created_at ON public.financial_audit_log USING btree (created_at DESC);
CREATE INDEX idx_audit_log_user_id ON public.financial_audit_log USING btree (user_id);
CREATE INDEX idx_financial_audit_log_actor_id ON public.financial_audit_log USING btree (actor_id) WHERE (actor_id IS NOT NULL);
CREATE UNIQUE INDEX fraud_logs_pkey ON public.fraud_logs USING btree (id);
CREATE INDEX idx_fraud_logs_event ON public.fraud_logs USING btree (event_type);
CREATE INDEX idx_fraud_logs_payment ON public.fraud_logs USING btree (payment_id);
CREATE INDEX idx_fraud_logs_subscription ON public.fraud_logs USING btree (subscription_id);
CREATE INDEX idx_fraud_logs_user ON public.fraud_logs USING btree (user_id);
CREATE UNIQUE INDEX guest_invitations_pkey ON public.guest_invitations USING btree (id);
CREATE INDEX idx_guest_inv_email ON public.guest_invitations USING btree (guest_email);
CREATE INDEX idx_guest_inv_email_used_expires ON public.guest_invitations USING btree (guest_email, used, expires_at DESC);
CREATE INDEX idx_guest_inv_expires ON public.guest_invitations USING btree (expires_at);
CREATE INDEX idx_guest_inv_owner ON public.guest_invitations USING btree (owner_user_id);
CREATE INDEX idx_guest_invitations_code_hash ON public.guest_invitations USING btree (code_hash);
CREATE INDEX idx_guest_invitations_email_status ON public.guest_invitations USING btree (guest_email, used, expires_at);
CREATE INDEX idx_guest_invitations_owner_created ON public.guest_invitations USING btree (owner_user_id, created_at);
CREATE INDEX idx_invite_nonces_expires ON public.invite_nonces USING btree (expires_at) WHERE (used = false);
CREATE INDEX idx_invite_nonces_nonce ON public.invite_nonces USING btree (nonce);
CREATE UNIQUE INDEX idx_invite_nonces_nonce_unique ON public.invite_nonces USING btree (nonce);
CREATE UNIQUE INDEX invite_nonces_nonce_unique ON public.invite_nonces USING btree (nonce);
CREATE UNIQUE INDEX invite_nonces_pkey ON public.invite_nonces USING btree (id);
CREATE INDEX idx_rate_limit_expires ON public.invite_rate_limit USING btree (expires_at);
CREATE INDEX idx_rate_limit_identifier ON public.invite_rate_limit USING btree (identifier, identifier_type);
CREATE UNIQUE INDEX invite_rate_limit_pkey ON public.invite_rate_limit USING btree (id);
CREATE UNIQUE INDEX invite_rate_limit_unique ON public.invite_rate_limit USING btree (identifier, identifier_type);
CREATE INDEX idx_login_lockouts_identifier ON public.login_lockouts USING btree (identifier, identifier_type);
CREATE UNIQUE INDEX login_lockouts_identifier_type_uq ON public.login_lockouts USING btree (identifier, identifier_type);
CREATE UNIQUE INDEX login_lockouts_pkey ON public.login_lockouts USING btree (id);
CREATE INDEX idx_password_reset_codes_code_hash ON public.password_reset_codes USING btree (code_hash);
CREATE INDEX idx_password_reset_codes_email ON public.password_reset_codes USING btree (email, used, expires_at);
CREATE INDEX idx_password_reset_codes_email_used ON public.password_reset_codes USING btree (email, used, expires_at);
CREATE INDEX idx_password_reset_codes_lookup ON public.password_reset_codes USING btree (email, code_hash, used, expires_at) WHERE (used = false);
CREATE INDEX idx_password_reset_codes_user_id ON public.password_reset_codes USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_reset_codes_email ON public.password_reset_codes USING btree (email);
CREATE INDEX idx_reset_codes_expires ON public.password_reset_codes USING btree (expires_at);
CREATE UNIQUE INDEX password_reset_codes_pkey ON public.password_reset_codes USING btree (id);
CREATE INDEX idx_payment_events_created ON public.payment_events USING btree (created_at);
CREATE INDEX idx_payment_events_data ON public.payment_events USING gin (event_data);
CREATE INDEX idx_payment_events_order ON public.payment_events USING btree (cakto_order_id);
CREATE INDEX idx_payment_events_order_id ON public.payment_events USING btree (cakto_order_id, event_type);
CREATE INDEX idx_payment_events_processed ON public.payment_events USING btree (processed);
CREATE INDEX idx_payment_events_type ON public.payment_events USING btree (event_type);
CREATE UNIQUE INDEX payment_events_pkey ON public.payment_events USING btree (id);
CREATE UNIQUE INDEX plans_name_key ON public.plans USING btree (name);
CREATE UNIQUE INDEX plans_pkey ON public.plans USING btree (id);
CREATE UNIQUE INDEX idx_profile_backups_active_per_member ON public.profile_backups USING btree (owner_user_id, original_member_id, source_table) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text]));
CREATE INDEX idx_profile_backups_expires ON public.profile_backups USING btree (backup_expires_at) WHERE (status = 'active'::text);
CREATE INDEX idx_profile_backups_member ON public.profile_backups USING btree (original_member_id);
CREATE INDEX idx_profile_backups_owner ON public.profile_backups USING btree (owner_user_id);
CREATE INDEX idx_profile_backups_status ON public.profile_backups USING btree (status);
CREATE UNIQUE INDEX profile_backups_pkey ON public.profile_backups USING btree (id);
CREATE INDEX idx_profiles_user ON public.profiles USING btree (user_id);
CREATE INDEX idx_profiles_user_active ON public.profiles USING btree (user_id, is_active) WHERE (is_active = true);
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE INDEX profiles_user_id_idx ON public.profiles USING btree (user_id);
CREATE UNIQUE INDEX push_subscriptions_endpoint_unique ON public.push_subscriptions USING btree (endpoint);
CREATE UNIQUE INDEX push_subscriptions_pkey ON public.push_subscriptions USING btree (id);
CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions USING btree (user_id) WHERE (is_active = true);
CREATE UNIQUE INDEX rate_limit_writes_pkey ON public.rate_limit_writes USING btree (user_id, window_start);
CREATE UNIQUE INDEX stripe_events_pkey ON public.stripe_events USING btree (id);
CREATE INDEX stripe_events_processed_at_idx ON public.stripe_events USING btree (processed_at);
CREATE INDEX stripe_subscriptions_customer_id_idx ON public.stripe_subscriptions USING btree (stripe_customer_id);
CREATE INDEX stripe_subscriptions_lower_email_idx ON public.stripe_subscriptions USING btree (lower(user_email));
CREATE UNIQUE INDEX stripe_subscriptions_pkey ON public.stripe_subscriptions USING btree (id);
CREATE INDEX stripe_subscriptions_status_idx ON public.stripe_subscriptions USING btree (status);
CREATE UNIQUE INDEX stripe_subscriptions_stripe_customer_id_key ON public.stripe_subscriptions USING btree (stripe_customer_id);
CREATE UNIQUE INDEX stripe_subscriptions_stripe_subscription_id_key ON public.stripe_subscriptions USING btree (stripe_subscription_id);
CREATE INDEX stripe_subscriptions_user_email_idx ON public.stripe_subscriptions USING btree (user_email);
CREATE INDEX stripe_subscriptions_user_id_idx ON public.stripe_subscriptions USING btree (user_id);
CREATE INDEX idx_subscriptions_active ON public.subscriptions_cakto_archive USING btree (is_active);
CREATE INDEX idx_subscriptions_cakto_order ON public.subscriptions_cakto_archive USING btree (cakto_order_id);
CREATE INDEX idx_subscriptions_cakto_order_id ON public.subscriptions_cakto_archive USING btree (cakto_order_id) WHERE (cakto_order_id IS NOT NULL);
CREATE UNIQUE INDEX idx_subscriptions_cakto_order_id_unique ON public.subscriptions_cakto_archive USING btree (cakto_order_id) WHERE (cakto_order_id IS NOT NULL);
CREATE UNIQUE INDEX idx_subscriptions_cakto_order_unique ON public.subscriptions_cakto_archive USING btree (cakto_order_id) WHERE (cakto_order_id IS NOT NULL);
CREATE INDEX idx_subscriptions_email ON public.subscriptions_cakto_archive USING btree (user_email);
CREATE INDEX idx_subscriptions_password_created ON public.subscriptions_cakto_archive USING btree (password_created);
CREATE INDEX idx_subscriptions_payment ON public.subscriptions_cakto_archive USING btree (payment_id);
CREATE INDEX idx_subscriptions_refunded ON public.subscriptions_cakto_archive USING btree (refunded_at) WHERE (refunded_at IS NOT NULL);
CREATE INDEX idx_subscriptions_user ON public.subscriptions_cakto_archive USING btree (user_id);
CREATE INDEX idx_subscriptions_user_email ON public.subscriptions_cakto_archive USING btree (user_email);
CREATE INDEX idx_subscriptions_user_id_active ON public.subscriptions_cakto_archive USING btree (user_id, is_active, payment_status) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX subscriptions_payment_id_key ON public.subscriptions_cakto_archive USING btree (payment_id);
CREATE UNIQUE INDEX subscriptions_pkey ON public.subscriptions_cakto_archive USING btree (id);
CREATE INDEX idx_terms_acceptance_user_version ON public.terms_acceptance USING btree (user_id, terms_version);
CREATE INDEX idx_terms_accepted_at ON public.terms_acceptance USING btree (accepted_at);
CREATE INDEX idx_terms_email ON public.terms_acceptance USING btree (email);
CREATE INDEX idx_terms_user_id ON public.terms_acceptance USING btree (user_id);
CREATE UNIQUE INDEX terms_acceptance_pkey ON public.terms_acceptance USING btree (id);
CREATE UNIQUE INDEX terms_acceptance_user_id_unique ON public.terms_acceptance USING btree (user_id);
CREATE UNIQUE INDEX terms_acceptance_user_version_unique ON public.terms_acceptance USING btree (user_id, terms_version);
CREATE INDEX idx_user_data_email ON public.user_data USING btree (email);
CREATE INDEX idx_user_data_json ON public.user_data USING gin (data_json);
CREATE INDEX idx_user_data_user_id ON public.user_data USING btree (user_id);
CREATE INDEX idx_user_data_user_id_partial ON public.user_data USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX user_data_pkey ON public.user_data USING btree (id);
CREATE UNIQUE INDEX user_data_user_id_key ON public.user_data USING btree (user_id);
CREATE INDEX idx_snapshots_cleanup ON public.user_data_snapshots USING btree (snapshot_date);
CREATE INDEX idx_snapshots_dedup ON public.user_data_snapshots USING btree (user_id, checksum);
CREATE INDEX idx_snapshots_user_date ON public.user_data_snapshots USING btree (user_id, snapshot_date DESC);
CREATE UNIQUE INDEX uq_snapshot_user_date ON public.user_data_snapshots USING btree (user_id, snapshot_date);
CREATE UNIQUE INDEX user_data_snapshots_pkey ON public.user_data_snapshots USING btree (id);
CREATE INDEX idx_user_profile_management_email ON public.user_profile_management USING btree (email);
CREATE INDEX idx_user_profile_management_user_id ON public.user_profile_management USING btree (user_id);
CREATE UNIQUE INDEX user_profile_management_pkey ON public.user_profile_management USING btree (id);
CREATE UNIQUE INDEX user_profile_management_user_id_key ON public.user_profile_management USING btree (user_id);

-- ─── Políticas RLS ─────────────────────────────────────────────────────
CREATE POLICY "account_members_owner_select" ON public.account_members
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((owner_user_id = auth.uid()) OR (member_user_id = auth.uid())));
CREATE POLICY "account_members_owner_update" ON public.account_members
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((owner_user_id = auth.uid()))
  WITH CHECK ((owner_user_id = auth.uid()));
CREATE POLICY "member_can_read_own_membership" ON public.account_members
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = member_user_id));
CREATE POLICY "owner_can_manage_own_members" ON public.account_members
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((auth.uid() = owner_user_id))
  WITH CHECK ((auth.uid() = owner_user_id));
CREATE POLICY "service_role_full_access_members" ON public.account_members
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "feature_flags_select_auth" ON public.feature_flags
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((target_user_id IS NULL) OR (target_user_id = auth.uid())));
CREATE POLICY "audit_log_owner_select" ON public.financial_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((actor_id = auth.uid()));
CREATE POLICY "audit_log_select_own" ON public.financial_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY "audit_log_service_role_only" ON public.financial_audit_log
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Service role full access to fraud logs" ON public.fraud_logs
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "guest_invitations_owner_select" ON public.guest_invitations
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((owner_user_id = auth.uid()));
CREATE POLICY "owner_can_view_own_invitations" ON public.guest_invitations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = owner_user_id));
CREATE POLICY "service_role_full_access_invitations" ON public.guest_invitations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "service_role_full_access_nonces" ON public.invite_nonces
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "service_role_full_access_rate_limit" ON public.invite_rate_limit
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Service role full access to reset codes" ON public.password_reset_codes
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Service role full access to payment events" ON public.payment_events
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Anyone can view plans" ON public.plans
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);
CREATE POLICY "Service role full access to plans" ON public.plans
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "plans_select_public" ON public.plans
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (true);
CREATE POLICY "profile_backups_select_own" ON public.profile_backups
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.uid() = owner_user_id));
CREATE POLICY "Service role full access" ON public.profiles
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Users can delete own profiles" ON public.profiles
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own profiles" ON public.profiles
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id))
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "guest_can_insert_owner_profiles" ON public.profiles
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM account_members
  WHERE ((account_members.owner_user_id = profiles.user_id) AND (account_members.member_user_id = auth.uid()) AND (account_members.is_active = true))))));
CREATE POLICY "guest_can_view_owner_profiles" ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM account_members
  WHERE ((account_members.owner_user_id = profiles.user_id) AND (account_members.member_user_id = auth.uid()) AND (account_members.is_active = true))))));
CREATE POLICY "profiles_insert_own" ON public.profiles
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((user_id = auth.uid()) AND can_create_profile()));
CREATE POLICY "profiles_select_as_guest" ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id IN ( SELECT account_members.owner_user_id
   FROM account_members
  WHERE ((account_members.member_user_id = auth.uid()) AND (account_members.is_active = true)))));
CREATE POLICY "profiles_select_own" ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));
CREATE POLICY "profiles_update_own" ON public.profiles
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "push_delete_own" ON public.push_subscriptions
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING ((auth.uid() = user_id));
CREATE POLICY "push_insert_own" ON public.push_subscriptions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "push_select_own" ON public.push_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.uid() = user_id));
CREATE POLICY "push_update_own" ON public.push_subscriptions
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "rate_limit_service_only" ON public.rate_limit_writes
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "stripe_sub_select_as_guest" ON public.stripe_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id IN ( SELECT account_members.owner_user_id
   FROM account_members
  WHERE ((account_members.member_user_id = auth.uid()) AND (account_members.is_active = true)))));
CREATE POLICY "stripe_sub_select_by_email" ON public.stripe_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((lower(user_email) = lower(auth.email())) AND (EXISTS ( SELECT 1
   FROM auth.users u
  WHERE ((u.id = auth.uid()) AND (u.email_confirmed_at IS NOT NULL))))));
CREATE POLICY "stripe_sub_select_own" ON public.stripe_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY "stripe_sub_update_claim" ON public.stripe_subscriptions
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((user_id IS NULL) AND (lower(user_email) = lower((auth.jwt() ->> 'email'::text)))))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Service role has full access to terms acceptance" ON public.terms_acceptance
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Users can insert own terms acceptance" ON public.terms_acceptance
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own terms acceptance" ON public.terms_acceptance
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "terms_owner_insert" ON public.terms_acceptance
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "terms_owner_select" ON public.terms_acceptance
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((user_id = auth.uid()));
CREATE POLICY "Service role full access" ON public.user_data
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "user_data_delete" ON public.user_data
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY "user_data_insert" ON public.user_data
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "user_data_owner_insert" ON public.user_data
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "user_data_owner_select" ON public.user_data
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((user_id = auth.uid()));
CREATE POLICY "user_data_select" ON public.user_data
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM account_members
  WHERE ((account_members.owner_user_id = user_data.user_id) AND (account_members.member_user_id = auth.uid()) AND (account_members.is_active = true))))));
CREATE POLICY "user_data_update" ON public.user_data
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "snapshots_select_own" ON public.user_data_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.uid() = user_id));
CREATE POLICY "Service role can manage profiles" ON public.user_profile_management
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Users can update own profile" ON public.user_profile_management
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id))
  WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own profile" ON public.user_profile_management
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));

-- ─── Funções ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.account_members_set_removed_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_active = false AND (OLD.is_active IS NULL OR OLD.is_active = true) THEN
    NEW.removed_at = NOW();
  END IF;
  IF NEW.is_active = true THEN
    NEW.removed_at = NULL;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bloquear_alteracao_audit_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    RAISE EXCEPTION
        '[SEGURANÇA] Audit log é imutável. UPDATE e DELETE são proibidos. Operação: % | Tabela: %',
        TG_OP, TG_TABLE_NAME;
    RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.can_create_profile()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id      uuid := auth.uid();
    v_user_email   text := lower(auth.jwt() ->> 'email');
    v_profile_count int;
    v_plan_name    text;
    v_max_profiles int;
BEGIN
    IF v_user_id IS NULL THEN RETURN false; END IF;

    SELECT COUNT(*) INTO v_profile_count
    FROM public.profiles
    WHERE user_id = v_user_id;

    -- 1. Plano via Stripe por user_id (inclui Cakto migrados com period_end=2099)
    SELECT lower(plan_name) INTO v_plan_name
    FROM public.stripe_subscriptions
    WHERE user_id = v_user_id
      AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end > now())
    ORDER BY created_at DESC LIMIT 1;

    -- 2. Plano via Stripe por email (user_id ainda não vinculado)
    IF v_plan_name IS NULL AND v_user_email IS NOT NULL THEN
        SELECT lower(plan_name) INTO v_plan_name
        FROM public.stripe_subscriptions
        WHERE lower(user_email) = v_user_email
          AND status IN ('active', 'trialing')
          AND (current_period_end IS NULL OR current_period_end > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    -- 3. Membership (convidado — herda limite do dono via stripe_subscriptions)
    IF v_plan_name IS NULL THEN
        SELECT lower(ss.plan_name) INTO v_plan_name
        FROM public.account_members am
        JOIN public.stripe_subscriptions ss ON ss.user_id = am.owner_user_id
        WHERE am.member_user_id = v_user_id
          AND am.is_active = true
          AND ss.status IN ('active', 'trialing')
          AND (ss.current_period_end IS NULL OR ss.current_period_end > now())
        ORDER BY ss.created_at DESC
        LIMIT 1;
    END IF;

    v_max_profiles := CASE v_plan_name
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1
    END;

    RETURN v_profile_count < v_max_profiles;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.can_upgrade(user_uuid uuid, new_plan_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    current_plan text;
    plan_order   jsonb := '{"Individual": 1, "Casal": 2, "Família": 3}'::jsonb;
BEGIN
    -- ✅ Usuário só pode consultar o próprio plano
    IF auth.uid() IS NULL THEN
        RETURN false;
    END IF;

    IF auth.uid() <> user_uuid THEN
        RAISE EXCEPTION 'Acesso negado: você só pode consultar o próprio plano.';
    END IF;

    SELECT p.name INTO current_plan
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = user_uuid
      AND s.is_active = true
      AND s.payment_status = 'approved'
    ORDER BY s.created_at DESC
    LIMIT 1;

    IF current_plan IS NULL THEN
        RETURN true;
    END IF;

    RETURN (plan_order ->> new_plan_name)::integer > (plan_order ->> current_plan)::integer;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_email_payment_status(email_input text)
 RETURNS TABLE(has_payment boolean, payment_approved boolean, has_password boolean, user_id uuid, user_name text, plan_name text, subscription_id uuid, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  sub_record RECORD;
  auth_user_record RECORD;
BEGIN
  -- ✅ Só anon pode chamar (fluxo de primeiro acesso pré-login)
  --    OU authenticated (fluxo de recuperação)
  --    Mas bloqueia chamadas sem contexto nenhum (service_role interna não precisa desta função)
  --    Na prática: mantém o fluxo funcional, apenas documenta a intenção

  SELECT s.id, s.user_id, s.user_name, s.user_email,
         s.payment_status, s.is_active, s.refunded_at,
         s.password_created, p.name as plan_name
  INTO sub_record
  FROM subscriptions s
  LEFT JOIN plans p ON s.plan_id = p.id
  WHERE LOWER(s.user_email) = LOWER(email_input)
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE, FALSE, NULL::UUID, NULL::TEXT,
      NULL::TEXT, NULL::UUID, 'Nenhuma compra encontrada para este email.'::TEXT;
    RETURN;
  END IF;

  IF sub_record.payment_status != 'approved' THEN
    RETURN QUERY SELECT TRUE, FALSE, FALSE, NULL::UUID, NULL::TEXT,
      NULL::TEXT, NULL::UUID, 'Pagamento ainda não foi aprovado. Aguarde a confirmação.'::TEXT;
    RETURN;
  END IF;

  IF NOT sub_record.is_active THEN
    RETURN QUERY SELECT TRUE, TRUE, FALSE, NULL::UUID, NULL::TEXT,
      NULL::TEXT, NULL::UUID, 'Assinatura inativa. Entre em contato com o suporte.'::TEXT;
    RETURN;
  END IF;

  IF sub_record.refunded_at IS NOT NULL THEN
    RETURN QUERY SELECT TRUE, TRUE, FALSE, NULL::UUID, NULL::TEXT,
      NULL::TEXT, NULL::UUID, 'Esta compra foi reembolsada. Acesso revogado.'::TEXT;
    RETURN;
  END IF;

  IF sub_record.user_id IS NOT NULL THEN
    SELECT id, email INTO auth_user_record
    FROM auth.users WHERE id = sub_record.user_id;

    IF FOUND THEN
      RETURN QUERY SELECT TRUE, TRUE, TRUE,
        sub_record.user_id, sub_record.user_name, sub_record.plan_name, sub_record.id,
        'Você já possui uma senha cadastrada. Use a opção "Esqueci minha senha" no login ou faça login diretamente.'::TEXT;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT TRUE, TRUE, FALSE,
    sub_record.user_id, sub_record.user_name, sub_record.plan_name,
    sub_record.id, NULL::TEXT;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_login_lockout(p_identifier text, p_identifier_type text)
 RETURNS TABLE(is_locked boolean, locked_until timestamp with time zone, lockout_level integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    (locked_until IS NOT NULL AND locked_until > now()),
    locked_until,
    lockout_level
  FROM public.login_lockouts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::timestamptz, 0;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_profile_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    current_count integer;
    limite        integer;
BEGIN
    -- ✅ Trava as linhas do usuário antes de contar — elimina race condition
    PERFORM 1 FROM profiles
    WHERE user_id = NEW.user_id
    FOR UPDATE;

    SELECT COUNT(*) INTO current_count
    FROM profiles
    WHERE user_id = NEW.user_id;

    limite := max_profiles_for_user(NEW.user_id);

    IF current_count >= limite THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', limite;
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
DECLARE
  v_count   integer;
  v_now     timestamptz := now();
  v_window  timestamptz := v_now - (p_window_seconds || ' seconds')::interval;
BEGIN
  -- Tenta inserir ou atualizar atomicamente
  INSERT INTO public.edge_rate_limits (key, count, window_start)
  VALUES (p_key, 1, v_now)
  ON CONFLICT (key) DO UPDATE SET
    count        = CASE
                     WHEN edge_rate_limits.window_start < v_window
                     THEN 1  -- janela expirou — reseta
                     ELSE edge_rate_limits.count + 1
                   END,
    window_start = CASE
                     WHEN edge_rate_limits.window_start < v_window
                     THEN v_now
                     ELSE edge_rate_limits.window_start
                   END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_abandoned_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    deleted_count INTEGER := 0;
    v_id          UUID;
BEGIN
    FOR v_id IN
        SELECT u.id
        FROM auth.users u
        WHERE u.created_at < NOW() - INTERVAL '3 days'
          AND u.email NOT LIKE '%@granaevo.com'
          -- Sem assinatura Stripe ativa (inclui Cakto migrado)
          AND NOT EXISTS (
              SELECT 1 FROM public.stripe_subscriptions ss
              WHERE ss.user_id = u.id
                AND ss.status IN ('active', 'trialing')
          )
          -- Sem dados de uso no app
          AND NOT EXISTS (
              SELECT 1 FROM public.user_data ud
              WHERE ud.user_id = u.id
          )
    LOOP
        DELETE FROM public.terms_acceptance  WHERE user_id = v_id;
        DELETE FROM public.user_data         WHERE user_id = v_id;
        DELETE FROM public.account_members
            WHERE member_user_id = v_id
               OR owner_user_id  = v_id;
        DELETE FROM public.stripe_subscriptions WHERE user_id = v_id;
        DELETE FROM auth.users WHERE id = v_id;

        deleted_count := deleted_count + 1;
    END LOOP;

    -- Limpa stripe_subscriptions sem usuário, inativas e antigas
    DELETE FROM public.stripe_subscriptions
    WHERE user_id IS NULL
      AND status NOT IN ('active', 'trialing')
      AND created_at < NOW() - INTERVAL '3 days';

    -- Limpa eventos Stripe expirados (idempotência > 90 dias)
    DELETE FROM public.stripe_events
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RAISE NOTICE '[cleanup] % usuário(s) abandonado(s) removido(s).', deleted_count;
    RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_passwords()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM temp_passwords WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.edge_rate_limits
  WHERE window_start < now() - interval '2 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_reset_codes()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM public.password_reset_codes
  WHERE expires_at < NOW() - INTERVAL '7 days';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_invite_tables()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    DELETE FROM public.invite_nonces
    WHERE used = true OR expires_at < now();

    DELETE FROM public.invite_rate_limit
    WHERE expires_at < now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_push_subscriptions()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM push_subscriptions
  WHERE is_active = false
    AND last_used_at < now() - INTERVAL '90 days';

  DELETE FROM push_subscriptions
  WHERE last_used_at < now() - INTERVAL '180 days';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.clear_login_lockout(p_identifier text, p_identifier_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
BEGIN
  DELETE FROM public.login_lockouts
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_expired_reset_codes()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM password_reset_codes 
  WHERE expires_at < NOW() OR used = TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.expire_pending_payments()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$BEGIN
  UPDATE subscriptions
  SET payment_status = 'expired'
  WHERE payment_status = 'pending'
    AND expires_at < NOW();
END;$function$
;

CREATE OR REPLACE FUNCTION public.generate_access_token()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  token TEXT;
  exists BOOLEAN;
BEGIN
  LOOP
    -- Gera token aleatório de 32 caracteres
    token := encode(gen_random_bytes(24), 'base64');
    token := replace(replace(replace(token, '/', ''), '+', ''), '=', '');
    
    -- Verifica se já existe
    SELECT EXISTS(
      SELECT 1 FROM subscriptions WHERE access_token = token
    ) INTO exists;
    
    -- Se não existe, retorna o token
    IF NOT exists THEN
      RETURN token;
    END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auth_user_by_email(p_email text)
 RETURNS TABLE(user_id uuid, email_confirmed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'auth'
AS $function$
BEGIN
  RETURN QUERY
  SELECT au.id, au.email_confirmed_at
  FROM auth.users au
  WHERE au.email = lower(trim(p_email))
  LIMIT 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auth_user_id_by_email(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_access_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_email      text;
    v_active_sub jsonb;
    v_email_sub  jsonb;
    v_frozen_sub jsonb;
    v_member     record;
    v_owner_sub  jsonb;
    v_now        timestamptz := now();
BEGIN
    -- Garante que o chamador só pode consultar seus próprios dados
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    -- Email verificado via JWT (não pode ser forjado pelo cliente)
    v_email := auth.email();

    -- ── 1. Subscription ativa por user_id ────────────────────────────────────
    SELECT jsonb_build_object(
        'id',                  id,
        'plan_name',           plan_name,
        'status',              status,
        'current_period_end',  current_period_end
    )
    INTO v_active_sub
    FROM stripe_subscriptions
    WHERE user_id = p_user_id
      AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end >= v_now)
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_active_sub IS NOT NULL THEN
        RETURN jsonb_build_object('type', 'active', 'sub', v_active_sub);
    END IF;

    -- ── 2. Subscription ativa por email (user_id IS NULL — sem vinculação) ───
    IF v_email IS NOT NULL THEN
        SELECT jsonb_build_object(
            'id',                  id,
            'plan_name',           plan_name,
            'status',              status,
            'current_period_end',  current_period_end,
            'user_email',          user_email
        )
        INTO v_email_sub
        FROM stripe_subscriptions
        WHERE user_id IS NULL
          AND lower(user_email) = lower(v_email)
          AND status IN ('active', 'trialing')
          AND (current_period_end IS NULL OR current_period_end >= v_now)
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_email_sub IS NOT NULL THEN
            RETURN jsonb_build_object(
                'type',       'active_email',
                'sub',        v_email_sub,
                'user_email', v_email
            );
        END IF;
    END IF;

    -- ── 3. Estado congelado — cancelado há menos de 90 dias ──────────────────
    SELECT jsonb_build_object(
        'plan_name',           plan_name,
        'current_period_end',  current_period_end
    )
    INTO v_frozen_sub
    FROM stripe_subscriptions
    WHERE user_id = p_user_id
      AND status = 'canceled'
      AND current_period_end IS NOT NULL
      AND current_period_end >= (v_now - interval '90 days')
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_frozen_sub IS NOT NULL THEN
        RETURN jsonb_build_object('type', 'frozen', 'sub', v_frozen_sub);
    END IF;

    -- ── 4. Verificação de convidado ──────────────────────────────────────────
    SELECT id, owner_user_id, owner_email
    INTO v_member
    FROM account_members
    WHERE member_user_id = p_user_id
      AND is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    -- ── 5. Subscription ativa do dono ────────────────────────────────────────
    SELECT jsonb_build_object(
        'id',                  id,
        'plan_name',           plan_name,
        'status',              status,
        'current_period_end',  current_period_end
    )
    INTO v_owner_sub
    FROM stripe_subscriptions
    WHERE user_id = v_member.owner_user_id
      AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end >= v_now)
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_owner_sub IS NULL THEN
        RETURN jsonb_build_object('type', 'none');
    END IF;

    RETURN jsonb_build_object(
        'type',           'guest',
        'sub',            v_owner_sub,
        'owner_user_id',  v_member.owner_user_id::text,
        'owner_email',    v_member.owner_email
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_subscription(user_uuid uuid)
 RETURNS TABLE(name text, max_profiles integer, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- ✅ Usuário só pode consultar a própria assinatura
    IF auth.uid() IS NULL THEN
        RETURN;
    END IF;

    IF auth.uid() <> user_uuid THEN
        RAISE EXCEPTION 'Acesso negado: você só pode consultar a própria assinatura.';
    END IF;

    RETURN QUERY
    SELECT
        p.name,
        p.max_profiles,
        s.payment_status,
        s.created_at
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id      = user_uuid
      AND s.is_active    = true
      AND s.payment_status = 'approved'
    ORDER BY s.created_at DESC
    LIMIT 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.has_accepted_terms(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM public.terms_acceptance 
        WHERE user_id = p_user_id 
        AND accepted = true
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.identificar_dados_para_retencao()
 RETURNS TABLE(user_id uuid, email text, ultimo_login timestamp with time zone, dias_sem_acesso integer, tem_dados_financeiros boolean, recomendacao text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        u.id                                                    AS user_id,
        u.email                                                 AS email,
        u.last_sign_in_at                                       AS ultimo_login,
        EXTRACT(DAY FROM NOW() - COALESCE(u.last_sign_in_at, u.created_at))::integer AS dias_sem_acesso,
        EXISTS(SELECT 1 FROM public.user_data ud WHERE ud.user_id = u.id) AS tem_dados_financeiros,
        CASE
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(u.last_sign_in_at, u.created_at)) > 730
            THEN '🔴 Notificar e avaliar exclusão (>2 anos sem acesso)'
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(u.last_sign_in_at, u.created_at)) > 365
            THEN '⚠️  Monitorar (>1 ano sem acesso)'
            ELSE '✅ Dentro do prazo'
        END                                                     AS recomendacao
    FROM auth.users u
    WHERE EXTRACT(DAY FROM NOW() - COALESCE(u.last_sign_in_at, u.created_at)) > 365
    ORDER BY dias_sem_acesso DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_feature_enabled(p_flag_key text, p_user_id uuid DEFAULT NULL::uuid, p_plan_name text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_result boolean;
BEGIN
    -- 1. Override por usuário específico (maior precedência)
    IF p_user_id IS NOT NULL THEN
        SELECT is_enabled INTO v_result
          FROM public.feature_flags
         WHERE flag_key = p_flag_key
           AND target_user_id = p_user_id
         LIMIT 1;
        IF FOUND THEN RETURN v_result; END IF;
    END IF;

    -- 2. Override por plano
    IF p_plan_name IS NOT NULL THEN
        SELECT is_enabled INTO v_result
          FROM public.feature_flags
         WHERE flag_key = p_flag_key
           AND target_plan = p_plan_name
           AND target_user_id IS NULL
         LIMIT 1;
        IF FOUND THEN RETURN v_result; END IF;
    END IF;

    -- 3. Flag global (sem target_plan e sem target_user_id)
    SELECT is_enabled INTO v_result
      FROM public.feature_flags
     WHERE flag_key = p_flag_key
       AND target_plan IS NULL
       AND target_user_id IS NULL
     LIMIT 1;
    IF FOUND THEN RETURN v_result; END IF;

    -- 4. Default: desabilitado
    RETURN false;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.limpar_rate_limit_antigo()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    DELETE FROM rate_limit_writes
    WHERE window_start < now() - interval '24 hours';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.max_profiles_for_user(uid uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (SELECT pl.max_profiles
         FROM subscriptions s
         JOIN plans pl ON pl.id = s.plan_id
         WHERE (
             s.user_id = uid
             OR s.user_email = (
                 SELECT email FROM auth.users WHERE id = uid
             )
         )
           AND s.is_active = true
           AND s.payment_status = 'approved'
           AND (s.expires_at IS NULL OR s.expires_at > now())
         ORDER BY s.user_id NULLS LAST
         LIMIT 1),
        0
    );
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_user_id_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'USER_ID_IMMUTABLE: user_id não pode ser alterado após criação';
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.profile_backups_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'auth'
AS $function$
DECLARE
  v_user_id   UUID;
  v_count     integer := 0;
  v_cutoff    TIMESTAMPTZ := NOW() - INTERVAL '90 days';
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      -- Sem nenhuma assinatura ativa no mesmo user (inclui vitalícios Cakto migrados)
      AND  NOT EXISTS (
             SELECT 1 FROM public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data            WHERE user_id = v_user_id;
      DELETE FROM public.profiles             WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                  WHERE id      = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'auth'
AS $function$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE u.created_at < v_cutoff
      -- Nunca teve assinatura Stripe paga (inclui usuários Cakto migrados, pois
      -- agora todos estão em stripe_subscriptions com status 'active')
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members   WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members   WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data         WHERE user_id        = v_user_id;
      DELETE FROM public.profiles          WHERE user_id        = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id    = v_user_id;
      DELETE FROM auth.users               WHERE id             = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_unpaid] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_unpaid] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_unpaid] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_failed_login(p_identifier text, p_identifier_type text)
 RETURNS TABLE(is_locked boolean, locked_until timestamp with time zone, failed_attempts integer, lockout_level integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public'
AS $function$
DECLARE
  v_rec     public.login_lockouts%ROWTYPE;
  v_now     timestamptz := now();
  v_level   integer;
  v_until   timestamptz;
  v_attempts integer;
BEGIN
  -- Busca registro existente
  SELECT * INTO v_rec
    FROM public.login_lockouts
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Primeira falha — insere com nível 0 (ainda sem lockout)
    INSERT INTO public.login_lockouts
      (identifier, identifier_type, failed_attempts, lockout_level, last_attempt_at)
    VALUES
      (p_identifier, p_identifier_type, 1, 0, v_now);

    RETURN QUERY SELECT false, NULL::timestamptz, 1, 0;
    RETURN;
  END IF;

  -- Verifica se lockout atual ainda está ativo
  IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
    -- Ainda em lockout — incrementa tentativas e mantém lockout
    UPDATE public.login_lockouts
       SET failed_attempts  = v_rec.failed_attempts + 1,
           last_attempt_at  = v_now
     WHERE id = v_rec.id;

    RETURN QUERY SELECT true, v_rec.locked_until, v_rec.failed_attempts + 1, v_rec.lockout_level;
    RETURN;
  END IF;

  -- Lockout expirou — incrementa tentativas e calcula próximo nível
  v_attempts := v_rec.failed_attempts + 1;
  v_level    := v_rec.lockout_level;

  -- Progressão: 3 falhas = nível 1 (15min), 5 = nível 2 (1h), 8 = nível 3 (24h)
  -- Cada nível é atingido acumulando falhas dentro da janela
  IF v_attempts >= 8 THEN
    v_level := 3;
    v_until := v_now + interval '24 hours';
  ELSIF v_attempts >= 5 THEN
    v_level := 2;
    v_until := v_now + interval '1 hour';
  ELSIF v_attempts >= 3 THEN
    v_level := 1;
    v_until := v_now + interval '15 minutes';
  ELSE
    v_level := 0;
    v_until := NULL;
  END IF;

  UPDATE public.login_lockouts
     SET failed_attempts  = v_attempts,
         lockout_level    = v_level,
         locked_until     = v_until,
         last_attempt_at  = v_now
   WHERE id = v_rec.id;

  RETURN QUERY SELECT (v_until IS NOT NULL AND v_until > v_now), v_until, v_attempts, v_level;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_auditoria_user_data()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_hash_before text;
    v_hash_after  text;
    v_size_before integer;
    v_size_after  integer;
BEGIN
    -- Calcula hash e tamanho do estado anterior (UPDATE/DELETE)
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_hash_before  := encode(digest(OLD.data_json::text, 'sha256'), 'hex');
        v_size_before  := length(OLD.data_json::text);
    END IF;

    -- Calcula hash e tamanho do novo estado (INSERT/UPDATE)
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_hash_after  := encode(digest(NEW.data_json::text, 'sha256'), 'hex');
        v_size_after  := length(NEW.data_json::text);
    END IF;

    INSERT INTO financial_audit_log (
        user_id,
        actor_id,
        operation,
        data_size_before,
        data_size_after,
        hash_before,
        hash_after
    ) VALUES (
        COALESCE(NEW.user_id, OLD.user_id),
        auth.uid(),         -- quem fez a ação (JWT)
        TG_OP,
        v_size_before,
        v_size_after,
        v_hash_before,
        v_hash_after
    );

    RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.revoke_user_access(p_user_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- ✅ Só service_role pode revogar acesso
  -- auth.uid() é NULL quando chamado via service_role (webhook/backend)
  -- auth.uid() tem valor quando chamado via cliente autenticado — bloqueado
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Acesso negado: esta função só pode ser chamada pelo servidor.';
  END IF;

  UPDATE public.subscriptions
  SET 
    is_active         = false,
    payment_status    = 'refunded',
    access_revoked_at = NOW(),
    refund_reason     = p_reason,
    refunded_at       = NOW()
  WHERE user_id = p_user_id;

  UPDATE auth.users
  SET 
    email_confirmed_at = NULL,
    banned_until       = NOW() + INTERVAL '100 years'
  WHERE id = p_user_id;

  RAISE NOTICE 'Acesso revogado para user_id: %, motivo: %', p_user_id, p_reason;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.salvar_dados_usuario(p_data_json jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_user_id  uuid := auth.uid();
    v_profiles jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Não autenticado');
    END IF;

    IF NOT verificar_rate_limit_escrita(v_user_id) THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Limite de salvamentos excedido. Tente novamente em alguns minutos.');
    END IF;

    IF p_data_json IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Dados nulos não são permitidos');
    END IF;

    IF NOT (p_data_json ? 'profiles') THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Estrutura inválida: campo profiles ausente');
    END IF;

    v_profiles := p_data_json -> 'profiles';

    IF jsonb_typeof(v_profiles) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Estrutura inválida: profiles deve ser array');
    END IF;

    IF jsonb_array_length(v_profiles) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Número de perfis excede o limite de 200');
    END IF;

    IF length(p_data_json::text) > 5242880 THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Dados excedem o tamanho máximo permitido');
    END IF;

    INSERT INTO user_data (user_id, email, data_json, last_modified)
    VALUES (
        v_user_id,
        (SELECT email FROM auth.users WHERE id = v_user_id),
        p_data_json,
        now()
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
        data_json     = EXCLUDED.data_json,
        last_modified = now();

    RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'salvar_dados_usuario error for user %: %', v_user_id, SQLERRM;
    RETURN jsonb_build_object('ok', false, 'erro', 'Erro interno ao salvar dados');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.salvar_perfil_usuario(p_profile_id text, p_profile_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_user_id     uuid := auth.uid();
    v_profile_idx int;
    v_profiles    jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Não autenticado');
    END IF;

    IF NOT verificar_rate_limit_escrita(v_user_id) THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Limite de salvamentos excedido. Tente novamente em alguns minutos.');
    END IF;

    IF p_profile_id IS NULL OR p_profile_id = '' THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'profile_id ausente');
    END IF;

    IF NOT (p_profile_id ~ '^[a-zA-Z0-9_\-]{1,64}$') THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'profile_id possui caracteres inválidos');
    END IF;

    IF p_profile_data IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Dados do perfil nulos');
    END IF;

    IF length(p_profile_data::text) > 5242880 THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Perfil excede tamanho máximo permitido');
    END IF;

    SELECT data_json -> 'profiles'
    INTO   v_profiles
    FROM   user_data
    WHERE  user_id = v_user_id;

    IF v_profiles IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'Registro do usuário não encontrado');
    END IF;

    SELECT (t.idx - 1)::int
    INTO   v_profile_idx
    FROM   jsonb_array_elements(v_profiles)
           WITH ORDINALITY AS t(profile, idx)
    WHERE  t.profile ->> 'id' = p_profile_id;

    IF v_profile_idx IS NOT NULL THEN
        UPDATE user_data
        SET
            data_json     = jsonb_set(
                                data_json,
                                ARRAY['profiles', v_profile_idx::text],
                                p_profile_data || jsonb_build_object(
                                    'lastUpdate',
                                    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                )
                            ),
            last_modified = now()
        WHERE user_id = v_user_id;
    ELSE
        IF jsonb_array_length(v_profiles) >= 200 THEN
            RETURN jsonb_build_object('ok', false, 'erro', 'Limite de 200 perfis atingido');
        END IF;

        UPDATE user_data
        SET
            data_json     = jsonb_set(
                                data_json,
                                '{profiles}',
                                v_profiles || jsonb_build_array(
                                    p_profile_data || jsonb_build_object(
                                        'lastUpdate',
                                        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                    )
                                )
                            ),
            last_modified = now()
        WHERE user_id = v_user_id;
    END IF;

    RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'salvar_perfil_usuario error for user %: %', v_user_id, SQLERRM;
    RETURN jsonb_build_object('ok', false, 'erro', 'Erro interno ao salvar perfil');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_profile_user_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- Só sobrescreve se vier nulo ou diferente do usuário autenticado
    -- (protege também contra tentativa de forçar outro UUID)
    NEW.user_id := auth.uid();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_subscription_user_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Quando um usuário é criado ou atualizado no auth.users,
    -- vincula o user_id em todas as subscriptions com o mesmo email
    UPDATE public.subscriptions
    SET 
        user_id    = NEW.id,
        updated_at = now()
    WHERE lower(user_email) = lower(NEW.email)
      AND user_id IS NULL;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.take_daily_snapshot()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'auth'
AS $function$
DECLARE
    v_inserted integer := 0;
    v_deleted  integer := 0;
BEGIN
    -- Cria snapshot do dia para usuários cujos dados mudaram
    INSERT INTO public.user_data_snapshots
        (user_id, user_email, snapshot_date, data_json, size_bytes, checksum)
    SELECT
        ud.user_id,
        COALESCE(ud.email, ''),
        CURRENT_DATE,
        ud.data_json,
        length(ud.data_json::text),
        md5(ud.data_json::text)
    FROM public.user_data ud
    WHERE ud.data_json IS NOT NULL
      -- Idempotência: pula se snapshot de hoje já existe
      AND NOT EXISTS (
          SELECT 1 FROM public.user_data_snapshots s
          WHERE s.user_id       = ud.user_id
            AND s.snapshot_date = CURRENT_DATE
      )
      -- Dedup: pula se blob idêntico foi salvo nos últimos 5 dias
      AND NOT EXISTS (
          SELECT 1 FROM public.user_data_snapshots s2
          WHERE s2.user_id  = ud.user_id
            AND s2.checksum = md5(ud.data_json::text)
            AND s2.snapshot_date >= CURRENT_DATE - INTERVAL '5 days'
      )
    ON CONFLICT (user_id, snapshot_date) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    -- Remove snapshots com mais de 5 dias (retenção rolling)
    DELETE FROM public.user_data_snapshots
    WHERE snapshot_date < CURRENT_DATE - INTERVAL '5 days';

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_inserted > 0 OR v_deleted > 0 THEN
        RAISE LOG '[take_daily_snapshot] % snapshot(s) criado(s), % expirado(s) removido(s)',
            v_inserted, v_deleted;
    END IF;

    RETURN v_inserted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_profiles_enforce_user_id_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'user_id de um perfil não pode ser alterado após a criação';
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_user_data_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.last_modified = NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_user_profile_management()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Atualizar ou inserir na tabela de gerenciamento
  INSERT INTO user_profile_management (
    user_id,
    email,
    active_profiles_count,
    profile_names,
    plan_name
  )
  SELECT 
    NEW.user_id,
    (SELECT email FROM auth.users WHERE id = NEW.user_id),
    COUNT(*),
    ARRAY_AGG(name ORDER BY id),
    (SELECT plans.name 
     FROM subscriptions 
     JOIN plans ON subscriptions.plan_id = plans.id 
     WHERE subscriptions.user_id = NEW.user_id 
     AND payment_status = 'approved' 
     ORDER BY subscriptions.created_at DESC
     LIMIT 1)
  FROM profiles
  WHERE user_id = NEW.user_id
  GROUP BY user_id
  ON CONFLICT (user_id) 
  DO UPDATE SET
    email = EXCLUDED.email,
    active_profiles_count = EXCLUDED.active_profiles_count,
    profile_names = EXCLUDED.profile_names,
    plan_name = EXCLUDED.plan_name,
    updated_at = NOW();
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_access_token(token_input text)
 RETURNS TABLE(is_valid boolean, subscription_id uuid, user_email text, plan_name text, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  sub_record RECORD;
BEGIN
  -- Busca a subscription pelo token
  SELECT 
    s.id,
    s.user_email,
    s.access_token_used,
    s.access_token_expires_at,
    s.payment_status,
    s.is_active,
    s.refunded_at,
    p.name as plan_name
  INTO sub_record
  FROM subscriptions s
  LEFT JOIN plans p ON s.plan_id = p.id
  WHERE s.access_token = token_input;

  -- Token não existe
  IF NOT FOUND THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Token inválido ou não encontrado'::TEXT;
    RETURN;
  END IF;

  -- Token já foi usado
  IF sub_record.access_token_used THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Este link já foi utilizado. Use a opção "Esqueci minha senha" na tela de login.'::TEXT;
    RETURN;
  END IF;

  -- Token expirado
  IF sub_record.access_token_expires_at < NOW() THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Este link expirou. Entre em contato com o suporte.'::TEXT;
    RETURN;
  END IF;

  -- Pagamento não aprovado
  IF sub_record.payment_status != 'approved' THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Pagamento ainda não foi aprovado. Aguarde a confirmação.'::TEXT;
    RETURN;
  END IF;

  -- Assinatura não está ativa
  IF NOT sub_record.is_active THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Assinatura inativa. Entre em contato com o suporte.'::TEXT;
    RETURN;
  END IF;

  -- Reembolsado
  IF sub_record.refunded_at IS NOT NULL THEN
    RETURN QUERY SELECT 
      FALSE, 
      NULL::UUID, 
      NULL::TEXT, 
      NULL::TEXT,
      'Esta compra foi reembolsada. Acesso revogado.'::TEXT;
    RETURN;
  END IF;

  -- Token válido!
  RETURN QUERY SELECT 
    TRUE, 
    sub_record.id, 
    sub_record.user_email,
    sub_record.plan_name,
    NULL::TEXT;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.verificar_rate_limit_escrita(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_count  integer;
    -- ✅ 120 saves/hora — comporta auto-save inteligente sem abrir flood
    --    Antes era 60, o que bloqueava auto-save legítimo nos primeiros minutos
    v_limite integer := 120;
BEGIN
    INSERT INTO rate_limit_writes (user_id, window_start, write_count)
    VALUES (p_user_id, date_trunc('hour', now()), 1)
    ON CONFLICT (user_id, window_start)
    DO UPDATE SET write_count = rate_limit_writes.write_count + 1
    RETURNING write_count INTO v_count;

    IF v_count > v_limite THEN
        INSERT INTO fraud_logs (
            user_id, payment_id, event_type, reason, metadata
        ) VALUES (
            p_user_id,
            'RATE_LIMIT',
            'rate_limit_exceeded',
            'Limite de escritas excedido: ' || v_count || ' na última hora',
            jsonb_build_object(
                'writes_count', v_count,
                'limit',        v_limite,
                'window',       date_trunc('hour', now())
            )
        );
        RETURN false;
    END IF;

    RETURN true;
END;
$function$
;

-- ─── Triggers ──────────────────────────────────────────────────────────
CREATE TRIGGER account_members_removed_at BEFORE UPDATE ON public.account_members FOR EACH ROW EXECUTE FUNCTION account_members_set_removed_at();
CREATE TRIGGER trg_feature_flags_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_audit_log_imutavel BEFORE DELETE OR UPDATE ON public.financial_audit_log FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_audit_log();
CREATE TRIGGER profile_backups_updated_at BEFORE UPDATE ON public.profile_backups FOR EACH ROW EXECUTE FUNCTION profile_backups_set_updated_at();
CREATE TRIGGER enforce_user_id_immutable BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION trg_profiles_enforce_user_id_immutable();
CREATE TRIGGER tg_auditoria_user_data AFTER INSERT OR DELETE OR UPDATE ON public.user_data FOR EACH ROW EXECUTE FUNCTION registrar_auditoria_user_data();
CREATE TRIGGER trigger_update_user_data_timestamp BEFORE UPDATE ON public.user_data FOR EACH ROW EXECUTE FUNCTION update_user_data_timestamp();
