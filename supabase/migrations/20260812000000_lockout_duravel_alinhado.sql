-- 20260812000000_lockout_duravel_alinhado.sql
-- GranaEvo — Migration: torna o lockout do BANCO um backstop utilizável
-- Rollback: ver 20260812000000_lockout_duravel_alinhado.down.sql
--
-- ============================================================================
-- [ACHADO-02] O lockout do banco existia e não podia disparar
-- ============================================================================
-- Auditoria de 2026-08-12. `check-user-access` chama `check_login_lockout`, a
-- tabela `login_lockouts` existe, tem RLS, tem índice único e até um cron
-- (`granaevo-limpar-lockouts`) que a limpa todo dia às 03:00.
--
-- E `record_failed_login` NUNCA teve um chamador. Nenhum, em api/, src/,
-- supabase/functions/ ou scripts/. Medido no banco de produção:
--
--     SELECT count(*), max(last_attempt_at) FROM login_lockouts;
--     →  0  |  NULL
--
-- Ou seja: `is_locked` é sempre false, e sempre foi. Um controle que aparece no
-- código, tem tabela, tem cron e não protege ninguém — a mesma classe do
-- `check_profile_limit` desconectado de 2026-06-25.
--
-- O lockout que FUNCIONA hoje é o do Redis (api/auth-session.js). O problema não
-- é ele estar errado — é ele estar sozinho. Quando o Upstash cai, `_checkRedis` e
-- `_redisCmd` caem para um Map por instância serverless, e como o gate de captcha
-- lê `readCounter(kFail)` da MESMA fonte, uma única indisponibilidade desliga o
-- lockout por conta E o captcha adaptativo ao mesmo tempo.
--
-- Esta migration prepara o banco para ser o backstop durável dessa queda.
--
-- ============================================================================
-- POR QUE NÃO BASTAVA "SÓ LIGAR" A FUNÇÃO QUE JÁ EXISTIA
-- ============================================================================
-- As duas camadas tinham semânticas DIFERENTES, e a do banco era muito mais
-- dura. Ligar como estava teria trancado usuário legítimo:
--
--                        REDIS (hoje, em produção)      BANCO (como estava)
--   1º degrau  15 min    5 falhas                       3 falhas
--   2º degrau   1 h      10 falhas                      5 falhas
--   3º degrau  24 h      20 falhas                      8 falhas
--   janela              24 h (TTL da chave)             NENHUMA — cumulativo
--
-- O "cumulativo" é o pior dos dois. O comentário na função dizia "acumulando
-- falhas dentro da janela", mas não havia janela no corpo: `failed_attempts`
-- só crescia. Quem errasse a senha 8 vezes ao longo de dois dias levava 24 h de
-- bloqueio. O único reset era `clear_login_lockout` num login bem-sucedido — e
-- quem está trancado, por definição, não consegue fazer login para se destravar.
--
-- Aqui os degraus passam a ser 5/10/20 e a janela passa a ser real: falha
-- anterior a 24 h não conta mais. Os dois lados dizem a mesma coisa, e trocar de
-- camada durante uma queda do Redis deixa de mudar a regra debaixo do usuário.
--
-- ============================================================================
-- SEM PII NOVA: o identificador é o MESMO hash que o Redis já usa
-- ============================================================================
-- `api/auth-session.js` usa `chaveConta(email)` = SHA-256 do e-mail, 32 hex,
-- justamente para não espalhar e-mail em claro pelas chaves do Redis. Não faria
-- sentido a camada durável reintroduzir a PII que a volátil evitou.
--
-- Por isso o CHECK ganha 'email_sha256'. Os tipos antigos continuam aceitos: a
-- tabela está vazia, mas `check-user-access` ainda chama com 'email', e uma
-- migration de segurança não pode quebrar um chamador existente pelo caminho.
-- ============================================================================

ALTER TABLE public.login_lockouts
    DROP CONSTRAINT IF EXISTS login_lockouts_identifier_type_check;

ALTER TABLE public.login_lockouts
    ADD CONSTRAINT login_lockouts_identifier_type_check
    CHECK (identifier_type = ANY (ARRAY['email'::text, 'ip'::text, 'email_sha256'::text]));

-- ============================================================================
-- record_failed_login — janela de 24 h, degraus alinhados, e sem corrida
-- ============================================================================
-- A versão anterior fazia SELECT ... FOR UPDATE e, se não achasse, INSERT. Duas
-- primeiras falhas simultâneas da mesma conta não travam uma à outra (não há
-- linha para travar), as duas chegam ao INSERT e a segunda morre com
-- unique_violation — o registro da falha se perde exatamente sob a carga de um
-- ataque paralelo, que é quando ele mais importa. `ON CONFLICT DO UPDATE`
-- resolve a corrida no próprio índice único.
CREATE OR REPLACE FUNCTION public.record_failed_login(
    p_identifier      text,
    p_identifier_type text
)
RETURNS TABLE(is_locked boolean, locked_until timestamptz, failed_attempts integer, lockout_level integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
    v_now      timestamptz := now();
    -- MANTER EM SINCRONIA com LOCK_JANELA e LOCK_DEGRAUS de api/auth-session.js.
    v_janela   interval := interval '24 hours';
    v_rec      public.login_lockouts%ROWTYPE;
    v_attempts integer;
    v_level    integer;
    v_until    timestamptz;
BEGIN
    -- Uma linha por (identifier, identifier_type), criada ou atualizada de forma
    -- atômica. `failed_attempts` recomeça do zero quando a última tentativa é
    -- mais velha que a janela — é isso que faltava na versão anterior.
    INSERT INTO public.login_lockouts
        (identifier, identifier_type, failed_attempts, lockout_level, last_attempt_at)
    VALUES
        (p_identifier, p_identifier_type, 1, 0, v_now)
    ON CONFLICT (identifier, identifier_type) DO UPDATE
       SET failed_attempts = CASE
                WHEN public.login_lockouts.last_attempt_at < v_now - v_janela THEN 1
                ELSE public.login_lockouts.failed_attempts + 1
           END,
           last_attempt_at = v_now
    RETURNING * INTO v_rec;

    v_attempts := v_rec.failed_attempts;

    -- Um lockout em vigor NÃO é reduzido por esta chamada: tentativas durante o
    -- bloqueio contam, mas não encurtam a punição nem a reiniciam do zero.
    IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
        RETURN QUERY SELECT true, v_rec.locked_until, v_attempts, v_rec.lockout_level;
        RETURN;
    END IF;

    IF    v_attempts >= 20 THEN v_level := 3; v_until := v_now + interval '24 hours';
    ELSIF v_attempts >= 10 THEN v_level := 2; v_until := v_now + interval '1 hour';
    ELSIF v_attempts >=  5 THEN v_level := 1; v_until := v_now + interval '15 minutes';
    ELSE                        v_level := 0; v_until := NULL;
    END IF;

    UPDATE public.login_lockouts
       SET lockout_level = v_level,
           locked_until  = v_until
     WHERE id = v_rec.id;

    RETURN QUERY SELECT (v_until IS NOT NULL), v_until, v_attempts, v_level;
END;
$function$;

-- ============================================================================
-- FECHAR O EXECUTE PÚBLICO — na mesma transação em que a função é redefinida
-- ============================================================================
-- `CREATE OR REPLACE` preserva o ACL existente, mas repetir o REVOKE é barato e
-- deixa a migration idempotente e auditável sozinha. Conceder isto a anon seria
-- entregar um botão de "trancar a conta de qualquer pessoa" a quem soubesse um
-- e-mail — DoS pior que a falha que a função vem cobrir.
REVOKE EXECUTE ON FUNCTION public.record_failed_login(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_failed_login(text, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_failed_login(text, text) TO service_role;

COMMENT ON FUNCTION public.record_failed_login(text, text) IS
    'ACHADO-02: backstop DURÁVEL do lockout de login. Chamada pela Edge Function '
    'login-lockout (service_role) a cada falha de senha. Degraus 5/10/20 e janela '
    'de 24 h MANTIDOS EM SINCRONIA com LOCK_DEGRAUS/LOCK_JANELA de '
    'api/auth-session.js. Identificador = SHA-256 do e-mail (email_sha256), nunca '
    'e-mail em claro.';

-- ============================================================================
-- AUTOVERIFICAÇÃO — a mesma varredura das migrations de 2026-08-11
-- ============================================================================
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
