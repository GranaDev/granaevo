-- =============================================================================
-- GranaEvo — Migration: RLS de acesso de convidados + hardening profile_backups
--
-- Problema 1: account_members não tinha GRANT SELECT/UPDATE para authenticated,
--   fazendo com que a query do SubscriptionChecker (auth-guard.js step 3) e a
--   subquery da policy profiles_select_as_guest falhassem silenciosamente.
--   Efeito: effectiveUserId do convidado em vez do dono → dashboard vazio.
--
-- Problema 2: removerConvidado() (db-configuracoes.js) recebia 403 ao tentar
--   UPDATE account_members porque não havia policy de UPDATE.
--
-- Problema 3: profile_backups criado sem FORCE RLS e sem REVOKE FROM anon.
--
-- Correções:
--   1. GRANT SELECT, UPDATE em account_members para authenticated
--   2. Policy UPDATE para dono desativar convidados (WITH CHECK obrigatório)
--   3. GRANT SELECT em subscriptions para authenticated (idempotente)
--   4. Policy para convidado ler assinatura Cakto do dono
--   5. Policy para convidado ler assinatura Stripe do dono
--   6. FORCE RLS + REVOKE anon em profile_backups
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. account_members — grants ao role authenticated
--    SELECT necessário para:
--      a) SubscriptionChecker.getActive() step 3 (auth-guard.js)
--      b) Subquery da policy profiles_select_as_guest
--    UPDATE necessário para:
--      c) removerConvidado() em db-configuracoes.js (soft-delete: is_active = false)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, UPDATE ON public.account_members TO authenticated;

-- Policy: dono pode atualizar membros da própria conta (ex: desativar convidado)
-- WITH CHECK garante que owner_user_id não pode ser alterado para outro usuário
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'account_members'
          AND policyname = 'account_members_owner_update'
    ) THEN
        CREATE POLICY "account_members_owner_update"
          ON public.account_members FOR UPDATE TO authenticated
          USING     (owner_user_id = auth.uid())
          WITH CHECK (owner_user_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. subscriptions (Cakto) — grant de leitura (idempotente)
--    Já pode existir; repetir é seguro.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON public.subscriptions TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Policy: convidado pode ler assinatura Cakto do dono
--    auth-guard.js step 3 consulta subscriptions com user_id = owner_user_id
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'subscriptions'
          AND policyname = 'subscriptions_guest_select_owner'
    ) THEN
        CREATE POLICY "subscriptions_guest_select_owner"
          ON public.subscriptions FOR SELECT TO authenticated
          USING (
            user_id IN (
              SELECT owner_user_id
              FROM public.account_members
              WHERE member_user_id = auth.uid()
                AND is_active = true
            )
          );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Policy: convidado pode ler assinatura Stripe do dono
--    auth-guard.js step 3 consulta stripe_subscriptions com user_id = owner_user_id
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions'
          AND policyname = 'stripe_sub_select_as_guest'
    ) THEN
        CREATE POLICY "stripe_sub_select_as_guest"
          ON public.stripe_subscriptions FOR SELECT TO authenticated
          USING (
            user_id IN (
              SELECT owner_user_id
              FROM public.account_members
              WHERE member_user_id = auth.uid()
                AND is_active = true
            )
          );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. profile_backups — hardening
--    Migration original habilitou RLS mas sem FORCE e sem REVOKE do anon.
--    Sem FORCE: role postgres (owner) bypassa RLS silenciosamente.
--    Sem REVOKE FROM anon: role anon tem grant implícito de SELECT mas a policy
--    bloqueia tudo (auth.uid() IS NULL nunca iguala owner_user_id). Cosmético mas
--    inconsistente com o padrão das demais tabelas internas.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profile_backups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_backups FROM anon;
REVOKE ALL ON TABLE public.profile_backups FROM PUBLIC;
