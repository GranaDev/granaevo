-- 20260811000000_revoke_purge_definer_publico.sql
-- GranaEvo — Migration: fecha o EXECUTE publico de 2 funcoes SECURITY DEFINER
-- Rollback: ver 20260811000000_revoke_purge_definer_publico.down.sql
--
-- ============================================================================
-- [SEC-001] purge_guest_invitations() e purge_profile_backups_terminal()
-- ============================================================================
-- Ambas nasceram com o EXECUTE default do Postgres, que e PUBLIC. Como estao no
-- schema `public` (exposto pelo PostgREST), qualquer um com a chave publishable
-- — que e publica, vive no bundle JS — podia chama-las SEM LOGIN:
--
--   POST /rest/v1/rpc/purge_guest_invitations
--   POST /rest/v1/rpc/purge_profile_backups_terminal
--
-- Sao SECURITY DEFINER, entao rodam como `postgres` e IGNORAM o RLS. As duas
-- ESCREVEM: uma faz DELETE em guest_invitations, a outra faz UPDATE redigindo
-- profile_backups. O filtro de idade (>7d / >30d / >90d) limita O QUE cai, mas
-- nao limita QUANTAS VEZES um anonimo pode disparar uma transacao de escrita com
-- varredura de tabela inteira — que e o vetor de exaustao.
--
-- Nenhuma das duas tem chamador na aplicacao. As duas existem para o pg_cron
-- (jobs 29 e 30), que roda como `postgres` e nao precisa de grant nenhum:
--
--   jobid 29  45 3 * * *  SELECT public.purge_profile_backups_terminal();
--   jobid 30  50 3 * * *  SELECT public.purge_guest_invitations();
--
-- E EXATAMENTE a mesma classe ja fechada em 20260723000000 para
-- purge_signup_email_codes(). Estas duas ficaram para tras. Confirmado tambem
-- pelo linter nativo do Supabase:
--   0028_anon_security_definer_function_executable (WARN, EXTERNAL) x2
--   0029_authenticated_security_definer_function_executable (WARN) x2
--
-- REVOKE de PUBLIC **e tambem** de anon/authenticated explicitamente: revogar so
-- de PUBLIC deixaria de pe um grant direto que porventura tenha sido concedido a
-- um desses papeis. Aqui nao ha (conferido em proacl), mas o REVOKE de um grant
-- inexistente e no-op e o comando fica idempotente.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.purge_guest_invitations()        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_guest_invitations()        FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_profile_backups_terminal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_profile_backups_terminal() FROM anon, authenticated;

-- service_role segue com EXECUTE (esta em proacl e nao e tocado aqui): mantem a
-- porta para execucao manual via Edge Function / suporte, se um dia precisar.

-- ============================================================================
-- VARREDURA: garante que nenhuma OUTRA SECURITY DEFINER do schema public ficou
-- executavel por anon/authenticated/PUBLIC sem estar na allow-list.
-- ============================================================================
-- Nao e enfeite. O buraco acima nasceu porque `CREATE FUNCTION` concede EXECUTE
-- a PUBLIC por padrao — ou seja, ele se reabre sozinho a cada funcao nova em que
-- alguem esquecer o REVOKE. Este bloco faz a migration REPROVAR nesse caso, em
-- vez de o linter descobrir semanas depois.
--
-- Allow-list (as duas sao legitimas e necessarias):
--   can_create_profile()  usada dentro do WITH CHECK da policy profiles_insert_own;
--                         o papel que faz o INSERT precisa poder avaliar a funcao.
--   mfa_pendente()        usada nas policies restritivas `exige_aal2`, pela mesma
--                         razao. Ambas so falam do PROPRIO auth.uid() e nao
--                         escrevem nada.
DO $$
DECLARE
    v_sobras text;
BEGIN
    SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
      INTO v_sobras
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosecdef
       AND p.proname NOT IN ('can_create_profile', 'mfa_pendente')
       AND (
             has_function_privilege('anon',          p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
       );

    IF v_sobras IS NOT NULL THEN
        RAISE EXCEPTION
            'SECURITY DEFINER executavel por anon/authenticated fora da allow-list: %', v_sobras;
    END IF;
END $$;
