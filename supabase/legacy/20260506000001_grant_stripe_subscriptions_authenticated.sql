-- =============================================================================
-- Concede permissões de SELECT/UPDATE ao role authenticated em
-- stripe_subscriptions para que o auth-guard do frontend possa consultar
-- as assinaturas do usuário logado via RLS (anon key + JWT).
--
-- Sem este GRANT o PostgREST retorna 403 (Forbidden) mesmo com RLS correto,
-- pois o role não tem permissão a nível de tabela para executar a query.
-- O service_role bypassa isso, mas o cliente usa authenticated.
-- =============================================================================

-- Permissão de leitura (SELECT) — necessária para auth-guard verificar plano
GRANT SELECT ON TABLE public.stripe_subscriptions TO authenticated;

-- Permissão de escrita parcial (UPDATE) — necessária para auto-link
-- (auth-guard faz UPDATE SET user_id = auth.uid() WHERE user_id IS NULL)
-- A RLS policy "stripe_sub_update_claim" garante que só rows do próprio email
-- com user_id NULL podem ser atualizadas.
GRANT UPDATE ON TABLE public.stripe_subscriptions TO authenticated;

-- anon nunca deve ver stripe_subscriptions
REVOKE ALL ON TABLE public.stripe_subscriptions FROM anon;

-- Confirma que RLS está ativo (idempotente)
ALTER TABLE public.stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_subscriptions FORCE ROW LEVEL SECURITY;

-- Garante que as policies existam (idempotente com DO $$)
DO $$
BEGIN
    -- SELECT por user_id vinculado
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions' AND policyname = 'stripe_sub_select_own'
    ) THEN
        CREATE POLICY "stripe_sub_select_own"
          ON public.stripe_subscriptions FOR SELECT TO authenticated
          USING (auth.uid() = user_id);
    END IF;

    -- SELECT por email (primeiro login — user_id ainda NULL)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions' AND policyname = 'stripe_sub_select_by_email'
    ) THEN
        CREATE POLICY "stripe_sub_select_by_email"
          ON public.stripe_subscriptions FOR SELECT TO authenticated
          USING (lower(user_email) = lower((auth.jwt() ->> 'email')));
    END IF;

    -- UPDATE para auto-link (user_id NULL → auth.uid())
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'stripe_subscriptions' AND policyname = 'stripe_sub_update_claim'
    ) THEN
        CREATE POLICY "stripe_sub_update_claim"
          ON public.stripe_subscriptions FOR UPDATE TO authenticated
          USING  (user_id IS NULL AND lower(user_email) = lower((auth.jwt() ->> 'email')))
          WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;

-- Índice para lookup rápido por email (cobre as policies de email)
CREATE INDEX IF NOT EXISTS stripe_subscriptions_lower_email_idx
  ON public.stripe_subscriptions (lower(user_email));
