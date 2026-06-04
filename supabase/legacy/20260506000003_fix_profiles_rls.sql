-- =============================================================================
-- GranaEvo — Fix RLS e constraints da tabela profiles
--
-- Contexto: tabela criada manualmente no Supabase sem migration registrada.
-- Esta migration garante estrutura correta para usuários Stripe e Cakto.
--
-- Problemas resolvidos:
--   1. photo_url NOT NULL → criação sem foto falha com 400
--   2. INSERT policy ausente ou usando can_create_profile() antigo → 400
--   3. SELECT policy ausente → carregarPerfis retorna vazio
--   4. UPDATE policy ausente → alteração de foto falha
-- =============================================================================

-- 1. Garante que photo_url aceita NULL (criação sem foto)
ALTER TABLE public.profiles ALTER COLUMN photo_url DROP NOT NULL;

-- 2. Habilita RLS (idempotente)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- 3. Concede permissões ao role authenticated
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
REVOKE DELETE ON TABLE public.profiles FROM authenticated;
REVOKE ALL ON TABLE public.profiles FROM anon;

-- 4. SELECT — usuário vê apenas seus próprios perfis
--    (proprietário pela coluna user_id; convidados herdam via dono)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'profiles' AND policyname = 'profiles_select_own'
    ) THEN
        CREATE POLICY "profiles_select_own"
          ON public.profiles FOR SELECT TO authenticated
          USING (user_id = auth.uid());
    END IF;
END $$;

-- Política para convidados lerem perfis do dono da conta
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'profiles' AND policyname = 'profiles_select_as_guest'
    ) THEN
        CREATE POLICY "profiles_select_as_guest"
          ON public.profiles FOR SELECT TO authenticated
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

-- 5. INSERT — usuário insere apenas com seu próprio user_id
--    Sem WITH CHECK em can_create_profile() — o limite é verificado
--    no cliente e via RPC separada, não bloqueando aqui.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'profiles' AND policyname = 'profiles_insert_own'
    ) THEN
        CREATE POLICY "profiles_insert_own"
          ON public.profiles FOR INSERT TO authenticated
          WITH CHECK (user_id = auth.uid());
    END IF;
END $$;

-- 6. UPDATE — usuário atualiza apenas seus próprios perfis
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'profiles' AND policyname = 'profiles_update_own'
    ) THEN
        CREATE POLICY "profiles_update_own"
          ON public.profiles FOR UPDATE TO authenticated
          USING  (user_id = auth.uid())
          WITH CHECK (user_id = auth.uid());
    END IF;
END $$;

-- 7. Remove qualquer policy antiga que use can_create_profile() no WITH CHECK
--    (evita que versão antiga da função bloqueie usuários Stripe)
DROP POLICY IF EXISTS "profiles_insert_with_limit" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_limit"      ON public.profiles;
DROP POLICY IF EXISTS "profiles_create_limit"      ON public.profiles;
DROP POLICY IF EXISTS "allow_insert_profiles"      ON public.profiles;

-- 8. Remove triggers de limite baseados em can_create_profile() se existirem
--    O limite agora é verificado pelo can_create_profile() via RPC separada,
--    não como bloqueador de INSERT.
DROP TRIGGER IF EXISTS check_profile_limit ON public.profiles;
DROP TRIGGER IF EXISTS enforce_profile_limit ON public.profiles;
DROP TRIGGER IF EXISTS trg_check_profile_limit ON public.profiles;

-- 9. Índice para lookup rápido por user_id
CREATE INDEX IF NOT EXISTS profiles_user_id_idx ON public.profiles (user_id);
