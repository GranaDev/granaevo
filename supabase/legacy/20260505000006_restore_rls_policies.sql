-- =============================================================================
-- GranaEvo — Restauração e complementação de políticas RLS
--
-- Contexto: após migrations de Stripe + remoção de FK do audit_log,
-- verificamos que algumas tabelas estavam sem políticas adequadas.
-- Esta migration fecha todos os gaps identificados.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. financial_audit_log — RLS estava completamente ausente
--
-- Sem RLS, qualquer usuário autenticado com a anon key podia consultar
-- todos os registros de auditoria via PostgREST (logs de outros usuários).
-- O trigger bloqueia escrita — mas leitura estava aberta.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.financial_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_audit_log FORCE ROW LEVEL SECURITY;

-- Usuário lê apenas suas próprias entradas de auditoria
-- (usa actor_id — coluna do usuário que executou a ação)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'financial_audit_log'
          AND policyname = 'audit_log_owner_select'
    ) THEN
        CREATE POLICY "audit_log_owner_select"
          ON public.financial_audit_log
          FOR SELECT
          TO authenticated
          USING (actor_id = auth.uid());
    END IF;
END $$;

-- Sem policy de INSERT/UPDATE/DELETE para authenticated
-- (o trigger bloquear_alteracao_audit_log() já protege contra escrita direta)
-- service_role bypassa RLS e pode inserir via triggers automáticos

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. subscriptions (Cakto) — adiciona SELECT por email
--
-- O auth-guard faz lookup por email para assinaturas não vinculadas (user_id NULL).
-- A policy atual "subscriptions_owner_select" usa user_id = auth.uid() e bloqueia
-- linhas onde user_id IS NULL. A nova policy permite leitura pelo email do JWT.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'subscriptions'
          AND policyname = 'subscriptions_email_select'
    ) THEN
        CREATE POLICY "subscriptions_email_select"
          ON public.subscriptions
          FOR SELECT
          TO authenticated
          USING (
            lower(user_email) = lower((auth.jwt() ->> 'email'))
          );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. user_data — adiciona INSERT policy para authenticated
--
-- O fluxo de primeiroacesso.js insere dados do usuário via cliente autenticado
-- (após signIn). Sem INSERT policy, a operação falha silenciosamente.
-- WITH CHECK garante que cada usuário só insere com seu próprio user_id.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'user_data'
          AND policyname = 'user_data_owner_insert'
    ) THEN
        CREATE POLICY "user_data_owner_insert"
          ON public.user_data
          FOR INSERT
          TO authenticated
          WITH CHECK (user_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. stripe_subscriptions — FORCE RLS e garantir idempotência das policies
--
-- FORCE RLS garante que mesmo o dono da tabela (postgres) seja afetado
-- quando conectado como authenticated. Previne bypass acidental.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stripe_subscriptions FORCE ROW LEVEL SECURITY;

-- Garante que as 3 policies existam (idempotente)
DO $$
BEGIN
    -- Policy 1: SELECT pelo user_id vinculado
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions'
          AND policyname = 'stripe_sub_select_own'
    ) THEN
        CREATE POLICY "stripe_sub_select_own"
          ON public.stripe_subscriptions
          FOR SELECT
          TO authenticated
          USING (auth.uid() = user_id);
    END IF;

    -- Policy 2: SELECT pelo email do JWT (primeiro login, user_id ainda NULL)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions'
          AND policyname = 'stripe_sub_select_by_email'
    ) THEN
        CREATE POLICY "stripe_sub_select_by_email"
          ON public.stripe_subscriptions
          FOR SELECT
          TO authenticated
          USING (lower(user_email) = lower((auth.jwt() ->> 'email')));
    END IF;

    -- Policy 3: UPDATE para auto-link (user_id NULL → setado para auth.uid())
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions'
          AND policyname = 'stripe_sub_update_claim'
    ) THEN
        CREATE POLICY "stripe_sub_update_claim"
          ON public.stripe_subscriptions
          FOR UPDATE
          TO authenticated
          USING  (user_id IS NULL AND lower(user_email) = lower((auth.jwt() ->> 'email')))
          WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;

-- Índice funcional para lookup por email lowercase (cobre as policies de email)
CREATE INDEX IF NOT EXISTS stripe_subscriptions_lower_email_idx
  ON public.stripe_subscriptions (lower(user_email));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. stripe_events — confirma que está sem acesso externo
--    (sem policies = deny para anon/authenticated, service_role bypassa)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stripe_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stripe_events FROM anon;
REVOKE ALL ON TABLE public.stripe_events FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Resumo das políticas ativas por tabela após esta migration
-- ─────────────────────────────────────────────────────────────────────────────
-- financial_audit_log  → SELECT (actor_id = auth.uid())           | escrita: trigger bloqueia
-- subscriptions        → SELECT (user_id = auth.uid() OR email)   | escrita: service_role
-- user_data            → SELECT + INSERT (user_id = auth.uid())   | UPDATE: service_role
-- terms_acceptance     → SELECT + INSERT (user_id = auth.uid())   | escrita: service_role
-- account_members      → SELECT (owner ou member)                  | escrita: service_role
-- guest_invitations    → SELECT (owner_user_id = auth.uid())      | escrita: service_role
-- plans                → SELECT público (USING true)               | escrita: service_role
-- stripe_subscriptions → SELECT (user_id ou email) + UPDATE claim | escrita: service_role
-- stripe_events        → nenhum acesso externo (service_role only)
-- payment_events       → nenhum acesso externo (service_role only)
-- password_reset_codes → nenhum acesso externo (service_role only)
-- edge_rate_limits     → nenhum acesso externo (service_role only)
-- login_lockouts       → nenhum acesso externo (service_role only)
-- invite_rate_limit    → nenhum acesso externo (service_role only)
-- invite_nonces        → nenhum acesso externo (service_role only)
-- fraud_logs           → nenhum acesso externo (service_role only)
