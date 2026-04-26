-- =============================================================================
-- GranaEvo — Migration: RLS em todas as tabelas de dados (BLUE-02 GOD MODE)
--
-- CONTEXTO:
--   Todas as operações de escrita usam service_role (que bypassa RLS).
--   Mas sem RLS, usuários autenticados com JWT válido podem consultar
--   dados de outros usuários diretamente via PostgREST (anon/authenticated key).
--   Esta migration fecha esse vetor.
--
-- REGRA GERAL:
--   - Tabelas internas (sem coluna user_id pública): REVOKE + service_role only
--   - Tabelas de dados do usuário: RLS com user_id = auth.uid()
--   - Nenhuma policy permite DELETE (use soft-delete onde necessário)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. user_data — dados financeiros criptografados por usuário
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_data FORCE ROW LEVEL SECURITY;

-- Usuário lê apenas seus próprios dados
CREATE POLICY "user_data_owner_select" ON public.user_data
  FOR SELECT USING (user_id = auth.uid());

-- INSERT/UPDATE apenas via service_role (Edge Functions)
-- Não criamos policy para authenticated — apenas service_role bypassa

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. subscriptions — assinaturas de pagamento
--    Leitura própria permitida; escrita exclusiva via service_role (webhook/EF)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;

-- Usuário lê apenas sua própria subscription
CREATE POLICY "subscriptions_owner_select" ON public.subscriptions
  FOR SELECT USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. payment_events — log de webhooks de pagamento (interno)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_events FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_events FROM anon;
REVOKE ALL ON TABLE public.payment_events FROM authenticated;
GRANT ALL ON TABLE public.payment_events TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. terms_acceptance — aceite de termos de uso
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.terms_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terms_acceptance FORCE ROW LEVEL SECURITY;

-- Usuário lê apenas seus próprios aceites
CREATE POLICY "terms_owner_select" ON public.terms_acceptance
  FOR SELECT USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. account_members — membros vinculados a uma conta
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members FORCE ROW LEVEL SECURITY;

-- Dono vê seus membros; membro vê seu próprio vínculo
CREATE POLICY "account_members_owner_select" ON public.account_members
  FOR SELECT USING (
    owner_user_id = auth.uid() OR member_user_id = auth.uid()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. guest_invitations — convites enviados
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.guest_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_invitations FORCE ROW LEVEL SECURITY;

-- Dono vê os convites que enviou
CREATE POLICY "guest_invitations_owner_select" ON public.guest_invitations
  FOR SELECT USING (owner_user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. password_reset_codes — códigos de reset (interno — service_role only)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.password_reset_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_codes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.password_reset_codes FROM PUBLIC;
REVOKE ALL ON TABLE public.password_reset_codes FROM anon;
REVOKE ALL ON TABLE public.password_reset_codes FROM authenticated;
GRANT ALL ON TABLE public.password_reset_codes TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. invite_rate_limit — rate limiting de convites (interno)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invite_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_rate_limit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.invite_rate_limit FROM PUBLIC;
REVOKE ALL ON TABLE public.invite_rate_limit FROM anon;
REVOKE ALL ON TABLE public.invite_rate_limit FROM authenticated;
GRANT ALL ON TABLE public.invite_rate_limit TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. invite_nonces — nonces anti-replay de convites (interno)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invite_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_nonces FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.invite_nonces FROM PUBLIC;
REVOKE ALL ON TABLE public.invite_nonces FROM anon;
REVOKE ALL ON TABLE public.invite_nonces FROM authenticated;
GRANT ALL ON TABLE public.invite_nonces TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. fraud_logs — log de fraudes detectadas (interno)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fraud_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_logs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fraud_logs FROM PUBLIC;
REVOKE ALL ON TABLE public.fraud_logs FROM anon;
REVOKE ALL ON TABLE public.fraud_logs FROM authenticated;
GRANT ALL ON TABLE public.fraud_logs TO service_role;
