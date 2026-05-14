-- =============================================================================
-- GranaEvo — Restaura limite de perfis no RLS INSERT de profiles
--
-- GOD6-H01: a migration 20260506000003 removeu can_create_profile() do WITH CHECK
-- da policy profiles_insert_own para resolver conflito com usuários Stripe.
-- Isso deixou o limite de perfis por plano apenas client-side — um atacante
-- com JWT válido + anon key poderia inserir perfis ilimitados via REST direto.
--
-- Solução: recriar a policy com can_create_profile() no WITH CHECK.
-- A função can_create_profile() (20260506000002) já suporta Stripe + Cakto.
-- =============================================================================

-- Remove a policy permissiva atual (somente user_id = auth.uid())
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;

-- Recria com verificação de limite no WITH CHECK
-- USING não é aplicável a INSERT; WITH CHECK cobre o check da nova linha.
CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND can_create_profile()
  );

COMMENT ON POLICY "profiles_insert_own" ON public.profiles IS
  'Usuário só insere perfil com user_id = auth.uid() E dentro do limite do plano. '
  'can_create_profile() verifica limite para Cakto e Stripe (20260506000002).';
