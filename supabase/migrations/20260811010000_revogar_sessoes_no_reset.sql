-- 20260811010000_revogar_sessoes_no_reset.sql
-- GranaEvo — Migration: RPC para revogar todas as sessoes de um usuario
-- Rollback: ver 20260811010000_revogar_sessoes_no_reset.down.sql
--
-- ============================================================================
-- [SEC-008] Trocar a senha nao expulsava ninguem
-- ============================================================================
-- `verify-and-reset-password` trocava a senha, marcava o codigo como usado, e
-- acabava ali. Nenhuma revogacao de sessao no caminho inteiro.
--
-- O cenario e justamente aquele para o qual o reset existe: a conta foi
-- comprometida (token roubado, aparelho perdido, sessao esquecida), a vitima faz
-- "esqueci minha senha" e acredita ter expulsado o invasor. A sessao do invasor
-- sobrevivia, e o refresh token seguia rotacionando por 30 dias.
--
-- Pior no caminho de fallback (`updatePasswordViaRecoveryFlow`): ele chama
-- verifyOtp, que CRIA mais uma sessao — somava as antigas em vez de encerra-las.
--
-- O `delete-account` ja fazia a coisa certa (`admin.signOut(token, 'global')`),
-- e o CLAUDE.md lista esta armadilha como critica. A defesa existia; faltava num
-- dos dois lugares onde precisava existir.
--
-- POR QUE UMA RPC E NAO admin.signOut(jwt, 'global'):
-- aquele metodo exige o JWT do usuario, e no reset por codigo nos NAO temos JWT
-- nenhum — a pessoa esta deslogada, e prova identidade pelo codigo do e-mail.
-- O que temos e o user_id. O schema `auth` nao e alcancavel pelo PostgREST, e e
-- por isso que isto precisa ser uma funcao no banco.
--
-- POR QUE BASTA APAGAR auth.sessions:
-- `auth.refresh_tokens.session_id` e `auth.mfa_amr_claims.session_id` tem FK para
-- auth.sessions com ON DELETE CASCADE (conferido em pg_constraint, confdeltype='c').
-- Apagar a sessao derruba os dois. A limpeza extra de refresh_tokens abaixo cobre
-- linhas legadas com session_id NULL, de versoes antigas do GoTrue.
--
-- search_path = '' e tudo qualificado: SECURITY DEFINER roda como `postgres`, e
-- um search_path herdado do chamador seria escalada de privilegio.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revogar_sessoes_usuario(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_n integer;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    DELETE FROM auth.sessions WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    -- Legado: refresh_tokens.user_id e varchar(255), nao uuid. Linhas antigas
    -- podem nao ter session_id e portanto nao caem no CASCADE.
    DELETE FROM auth.refresh_tokens
     WHERE user_id = p_user_id::text
       AND session_id IS NULL;

    RETURN v_n;
END;
$function$;

-- ============================================================================
-- FECHAR O EXECUTE PUBLICO — na mesma transacao em que a funcao nasce
-- ============================================================================
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC por padrao. Sem estas linhas, esta
-- migration criaria uma SECURITY DEFINER que apaga sessoes de QUALQUER usuario
-- chamavel por `anon` — ou seja, um logout forcado de qualquer conta, sem login,
-- so sabendo o uuid. Seria uma falha pior que a que ela vem consertar, e da
-- MESMA classe do SEC-001 que a migration anterior acabou de fechar.
REVOKE EXECUTE ON FUNCTION public.revogar_sessoes_usuario(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revogar_sessoes_usuario(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revogar_sessoes_usuario(uuid) TO service_role;

-- ============================================================================
-- AUTOVERIFICACAO — a mesma varredura da migration 20260811000000
-- ============================================================================
-- Repetida aqui de proposito: cada migration que cria SECURITY DEFINER tem de
-- provar, ela mesma, que nao reabriu o buraco. Depender da varredura de uma
-- migration ANTERIOR nao funciona — ela ja rodou.
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

COMMENT ON FUNCTION public.revogar_sessoes_usuario(uuid) IS
    'SEC-008: encerra TODAS as sessoes do usuario. Chamada pela Edge Function '
    'verify-and-reset-password depois de uma troca de senha bem-sucedida. '
    'Somente service_role — jamais conceder a anon/authenticated: seria logout '
    'forcado de qualquer conta conhecendo so o uuid.';
