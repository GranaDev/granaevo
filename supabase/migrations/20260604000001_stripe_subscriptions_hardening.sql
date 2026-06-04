-- =============================================================================
-- GranaEvo — Migration: Hardening stripe_subscriptions
--
-- Problemas corrigidos:
--   [HARD-01] stripe_subscriptions sem FORCE ROW LEVEL SECURITY
--             → role postgres (owner da tabela) poderia bypassar RLS silenciosamente.
--
--   [HARD-02] Policy stripe_sub_select_by_email usava auth.jwt()->>'email' sem
--             verificar se o email foi confirmado. Um usuário que registrou com
--             o email de outra pessoa poderia ler a subscription antes de confirmar,
--             pois o JWT já carrega o email mesmo sem confirmação.
--             Correção: adicionar verificação de email_confirmed_at via auth.users.
--
-- Nota sobre stripe_sub_update_claim (auto-link):
--   A policy de UPDATE para auto-link já está correta — ela só permite UPDATE
--   quando user_id IS NULL e email bate. Mantida sem alteração.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- [HARD-01] FORCE RLS em stripe_subscriptions
--   Impede que o role postgres/owner bypasse as políticas.
--   ENABLE já estava ativo; FORCE adiciona a segunda camada.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stripe_subscriptions FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- [HARD-02] Recriar stripe_sub_select_by_email com verificação de email confirmado
--
--   BEFORE (vulnerável):
--     USING (lower(user_email) = lower(auth.jwt()->>'email'))
--     → JWT contém o email mesmo antes da confirmação.
--       Usuário com email não confirmado poderia ver subscriptions do email real.
--
--   AFTER (corrigido):
--     USING (
--       lower(user_email) = lower(auth.jwt()->>'email')
--       AND EXISTS (
--         SELECT 1 FROM auth.users u
--         WHERE u.id = auth.uid()
--           AND u.email_confirmed_at IS NOT NULL
--       )
--     )
--     → Só permite SELECT se o email do JWT foi confirmado.
--       Protege contra registros fraudulentos com email alheio.
--
--   Uso desta policy: fallback de auto-link quando user_id ainda é NULL
--   (compra feita sem login). Após auto-link, a policy stripe_sub_owner_select
--   cobre o acesso por user_id.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "stripe_sub_select_by_email" ON public.stripe_subscriptions;

CREATE POLICY "stripe_sub_select_by_email"
  ON public.stripe_subscriptions FOR SELECT
  TO authenticated
  USING (
    -- auth.email() é a função oficial do Supabase para o email autenticado
    lower(user_email) = lower(auth.email())
    -- Exige confirmação de email para evitar acesso com email não verificado
    AND EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
        AND u.email_confirmed_at IS NOT NULL
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Comentário de documentação
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.stripe_subscriptions IS
  'Assinaturas Stripe. RLS: SELECT por user_id (owner) ou por email confirmado (fallback pré-link). UPDATE de auto-link apenas quando user_id é NULL e email bate. INSERT/DELETE exclusivos do service_role (webhook).';
