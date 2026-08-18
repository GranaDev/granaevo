-- SEGURANÇA — `check_login_lockout` falhava em TODA chamada, e ninguém via
-- ============================================================================
-- Achado em 2026-08-18, enquanto se otimizava `check-user-access`.
--
--   SELECT * FROM public.check_login_lockout('x@y.z','email');
--   → ERROR 42702: column reference "locked_until" is ambiguous
--
-- Os parâmetros de saída do `RETURNS TABLE(is_locked, locked_until, lockout_level)`
-- têm os MESMOS nomes das colunas de `login_lockouts`, e o corpo referenciava
-- ambos sem qualificar. A função nunca retornou uma linha sequer.
--
-- ── POR QUE NINGUÉM VIU ────────────────────────────────────────────────────
-- `check-user-access/index.ts:141` faz:
--
--     const { data: lockData } = await supabaseAdmin.rpc('check_login_lockout', …)
--
-- Só `data` é desestruturado — o `error` é DESCARTADO. `lockData` vira undefined,
-- `lockEntry?.is_locked` vira undefined, e o `if` nunca entra. O gate de lockout
-- por conta nunca aplicou, sem deixar rastro.
--
-- ── O QUE ISSO CUSTAVA, de verdade ─────────────────────────────────────────
-- `login-lockout/index.ts:98` — o BACKSTOP DURÁVEL — chama a mesma função. Ele
-- existe justamente para valer quando o Redis degrada, e é o caminho que
-- `api/auth-session.js` consulta via `lockoutDuravel('check', …)`.
--
-- Ou seja: a camada primária (Redis) funcionava, e a de baixo estava morta. A
-- verificação de 2026-08-13 provou o backstop pela ESCRITA (`record_failed_login`,
-- que não tem ambiguidade e grava certo). A LEITURA nunca foi exercitada — e é
-- ela que decide se alguém está travado.
--
-- É [[controle_existe_caminho_nao_passa]] outra vez: o controle existe, está
-- ligado, e falha em silêncio porque quem chama joga o erro fora.
--
-- ── SEGURO LIGAR AGORA ─────────────────────────────────────────────────────
-- `login_lockouts` tem 0 linhas e 0 travados neste instante — conferido antes de
-- aplicar. Consertar a leitura não tranca ninguém hoje; passa a trancar quem
-- acumular falhas a partir de agora, que é o comportamento pretendido desde
-- sempre.
--
-- ⚠️ O outro lado do defeito NÃO se conserta aqui: `check-user-access` continua
-- descartando o `error` do rpc. Enquanto isso não mudar, qualquer falha futura
-- desta função volta a ser silenciosa. Está anotado para o mesmo ciclo que
-- reescreve aquela Edge Function.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.check_login_lockout(p_identifier text, p_identifier_type text)
RETURNS TABLE(is_locked boolean, locked_until timestamp with time zone, lockout_level integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  -- Alias `l` em tudo: sem ele, `locked_until` casa TANTO a coluna quanto o
  -- parâmetro de saída homônimo, e o Postgres recusa com 42702.
  RETURN QUERY
  SELECT
    (l.locked_until IS NOT NULL AND l.locked_until > now()),
    l.locked_until,
    l.lockout_level
  FROM public.login_lockouts l
  WHERE l.identifier      = p_identifier
    AND l.identifier_type = p_identifier_type
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::timestamptz, 0;
  END IF;
END;
$function$;

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU
--
--   1. Deixa de levantar 42702:
--      SELECT * FROM public.check_login_lockout('inexistente@teste.test','email');
--      → (false, NULL, 0)   -- e NÃO um erro
--
--   2. Reconhece um lockout de verdade:
--      BEGIN;
--      INSERT INTO public.login_lockouts (identifier, identifier_type, locked_until, lockout_level)
--      VALUES ('prova@teste.test','email', now() + interval '15 minutes', 1);
--      SELECT * FROM public.check_login_lockout('prova@teste.test','email');  -- (true, …, 1)
--      ROLLBACK;
--
-- ROLLBACK: ver supabase/rollbacks/20260818020000_fix_check_login_lockout_ambiguo.down.sql
-- ============================================================================
