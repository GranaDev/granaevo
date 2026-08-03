-- O-3 (Passo 32) — elimina os 3 `multiple_permissive_policies` restantes
-- ===========================================================================
-- Com duas policies PERMISSIVE no mesmo comando e no mesmo papel, o Postgres
-- avalia AS DUAS em toda linha e faz OR. O advisor marca como WARN.
--
-- O GANHO AQUI NÃO É VELOCIDADE — as três tabelas têm 1, 7 e 10 linhas. É
-- deixar o advisor limpo: relatório com ruído esconde o próximo aviso de
-- verdade. Foi o próprio advisor que revelou o par de `account_members`, que a
-- minha consulta manual anterior tinha deixado passar (ela filtrava por
-- cmd='SELECT' e não via a policy `ALL` que também cobre SELECT).
--
-- ⚠️ REGRA QUE GUIOU AS TRÊS: preservar a semântica EXATA. Otimizar RLS é mexer
-- em controle de acesso com roupa de performance — se o resultado mudar quem
-- enxerga o quê, não é otimização, é bug de segurança.
-- ===========================================================================

-- ── 1. stripe_subscriptions (SELECT) — fusão trivial ───────────────────────
-- Duas condições independentes sobre a mesma tabela: "é meu" OU "sou convidado
-- do dono". `A OR B` é exatamente o que o Postgres já fazia.
DROP POLICY IF EXISTS stripe_sub_select_own      ON public.stripe_subscriptions;
DROP POLICY IF EXISTS stripe_sub_select_as_guest ON public.stripe_subscriptions;

CREATE POLICY stripe_sub_select_own ON public.stripe_subscriptions
  FOR SELECT TO authenticated
  USING (
       user_id = (SELECT auth.uid())
    OR user_id IN (
         SELECT am.owner_user_id FROM public.account_members am
         WHERE am.member_user_id = (SELECT auth.uid()) AND am.is_active = true
       )
  );

-- ── 2. profiles (INSERT) — fusão trivial ───────────────────────────────────
-- ⚠️ O ramo do convidado NÃO chama `can_create_profile()`, e isso é preservado
-- de propósito: é como já funciona hoje. Quem impede o convidado de estourar o
-- limite do plano é o CONSTRAINT TRIGGER `enforce_profile_limit_stripe`
-- (migration 20260727010000, o achado S-1), que roda AFTER INSERT e vale para
-- qualquer caminho. Endurecer aqui seria mudança de comportamento embutida
-- numa migration de performance — exatamente o que não se faz.
DROP POLICY IF EXISTS profiles_insert_own             ON public.profiles;
DROP POLICY IF EXISTS guest_can_insert_owner_profiles ON public.profiles;

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (
       (user_id = (SELECT auth.uid()) AND can_create_profile())
    OR EXISTS (
         SELECT 1 FROM public.account_members am
         WHERE am.owner_user_id  = profiles.user_id
           AND am.member_user_id = (SELECT auth.uid())
           AND am.is_active      = true
       )
  );

-- ── 3. account_members — NÃO é fusão, é SEPARAÇÃO POR COMANDO ──────────────
-- Aqui as duas policies não são equivalentes:
--   owner_can_manage_own_members   → ALL    (dono faz tudo)
--   member_can_read_own_membership → SELECT (membro só lê a própria linha)
--
-- Juntá-las numa só daria ao MEMBRO direito de INSERT/UPDATE/DELETE na própria
-- membresia — ele poderia se reativar sozinho depois de removido. Isso é
-- escalada de privilégio, não otimização.
--
-- A saída certa é quebrar o `ALL` em comandos explícitos: o SELECT passa a ser
-- uma policy única com `dono OU membro`, e escrita continua só do dono.
DROP POLICY IF EXISTS owner_can_manage_own_members   ON public.account_members;
DROP POLICY IF EXISTS member_can_read_own_membership ON public.account_members;

CREATE POLICY account_members_select ON public.account_members
  FOR SELECT TO authenticated
  USING (
       owner_user_id  = (SELECT auth.uid())
    OR member_user_id = (SELECT auth.uid())
  );

CREATE POLICY account_members_insert ON public.account_members
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = (SELECT auth.uid()));

CREATE POLICY account_members_update ON public.account_members
  FOR UPDATE TO authenticated
  USING      (owner_user_id = (SELECT auth.uid()))
  WITH CHECK (owner_user_id = (SELECT auth.uid()));

CREATE POLICY account_members_delete ON public.account_members
  FOR DELETE TO authenticated
  USING (owner_user_id = (SELECT auth.uid()));
