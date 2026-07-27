-- 20260727020000_mfa_aal2_enforcement.sql
-- GranaEvo — Migration: exige aal2 no RLS para quem ATIVOU o 2FA (Passo 31 · B-1b)
-- Rollback: ver 20260727020000_mfa_aal2_enforcement.down.sql
--
-- O PROBLEMA QUE ISTO RESOLVE
--   Sem isto, o 2FA protege o LOGIN, não o DADO. Um atacante com a senha e um
--   access token `aal1` continuaria lendo tudo via PostgREST, e o segundo fator
--   viraria enfeite. Estas policies fecham o caminho do dado.
--
-- ⚠️ POR QUE NÃO USAMOS A POLICY QUE A DOC DO SUPABASE MOSTRA
--   A doc sugere fazer a subquery direto em `auth.mfa_factors` dentro da policy.
--   Neste projeto isso NÃO funciona e é PERIGOSO:
--     has_table_privilege('authenticated','auth.mfa_factors','SELECT') = false
--   A policy roda com os privilégios de quem consulta. Sem SELECT na tabela, a
--   subquery levanta "permission denied" e o erro derruba a QUERY INTEIRA — em
--   vez de proteger, quebraria toda leitura de todo usuário. Por isso a checagem
--   mora numa função SECURITY DEFINER, que enxerga `auth.mfa_factors`.
--
-- MODELO OPT-IN (o único compatível com 2FA opcional)
--   `mfa_pendente()` só devolve true para quem TEM fator verificado E está numa
--   sessão não elevada. Para quem nunca ativou 2FA — hoje, 100% da base — ela
--   devolve false e a policy restritiva passa direto. É um no-op até alguém
--   optar por ligar.

-- ── A função ────────────────────────────────────────────────────────────────
-- STABLE: chamada uma vez por linha avaliada; o planner pode cachear no comando.
-- Sem argumentos e derivando tudo de auth.uid(): não há como pedir a resposta
-- "de outro usuário", que é o padrão de segurança das DEFINER deste projeto
-- (mesma forma de can_create_profile()).
CREATE OR REPLACE FUNCTION public.mfa_pendente()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
           SELECT 1 FROM auth.mfa_factors f
           WHERE f.user_id = auth.uid()
             AND f.status  = 'verified'
         )
     AND COALESCE(auth.jwt() ->> 'aal', 'aal1') <> 'aal2';
$$;

COMMENT ON FUNCTION public.mfa_pendente() IS
    'true quando o usuario TEM 2FA verificado mas a sessao nao foi elevada (aal < aal2). Usada pelas policies RESTRICTIVE de exigencia de 2FA. SECURITY DEFINER porque authenticated nao le auth.mfa_factors — ver migration 20260727020000.';

REVOKE ALL     ON FUNCTION public.mfa_pendente() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mfa_pendente() TO authenticated;

-- ── As policies ─────────────────────────────────────────────────────────────
-- RESTRICTIVE: entra em AND com as policies permissivas existentes, nunca em OR.
-- Uma policy permissiva nova (hoje ou no futuro) não consegue afrouxar isto.
-- FOR ALL + WITH CHECK: vale para leitura E escrita — sem WITH CHECK, a sessão
-- não elevada continuaria gravando.
--
-- Aplicada às 11 tabelas que `authenticated` realmente alcança via PostgREST.
-- `plans` fica de fora de propósito: é catálogo público de preços, sem PII, e
-- lido na tela de planos por quem ainda nem tem sessão elevada.
DO $$
DECLARE
    t text;
    alvos text[] := ARRAY[
        'account_members', 'financial_audit_log', 'profiles', 'push_subscriptions',
        'radar_notifications', 'stripe_subscriptions', 'terms_acceptance',
        'user_data', 'user_data_snapshots', 'user_devices', 'user_profile_management'
    ];
BEGIN
    FOREACH t IN ARRAY alvos LOOP
        EXECUTE format('DROP POLICY IF EXISTS exige_aal2 ON public.%I', t);
        EXECUTE format($f$
            CREATE POLICY exige_aal2 ON public.%I
                AS RESTRICTIVE
                FOR ALL
                TO authenticated
                USING      (NOT public.mfa_pendente())
                WITH CHECK (NOT public.mfa_pendente())
        $f$, t);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
