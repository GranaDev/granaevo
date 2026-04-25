-- =============================================================================
-- GranaEvo — Migration: Progressive Login Lockout
-- Implementa lockout progressivo: 15min → 1h → 24h após tentativas falhas.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABELA: login_lockouts — rastreia tentativas falhas por email/IP
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_lockouts (
  id              bigserial   PRIMARY KEY,
  identifier      text        NOT NULL,             -- email ou IP
  identifier_type text        NOT NULL CHECK (identifier_type IN ('email', 'ip')),
  failed_attempts integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  lockout_level   integer     NOT NULL DEFAULT 0,   -- 0=livre, 1=15min, 2=1h, 3=24h
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT login_lockouts_identifier_type_uq UNIQUE (identifier, identifier_type)
);

-- Índice para busca rápida por identifier
CREATE INDEX IF NOT EXISTS idx_login_lockouts_identifier
  ON public.login_lockouts (identifier, identifier_type);

-- Apenas service_role acessa
REVOKE ALL ON TABLE public.login_lockouts FROM PUBLIC;
REVOKE ALL ON TABLE public.login_lockouts FROM anon;
REVOKE ALL ON TABLE public.login_lockouts FROM authenticated;
GRANT ALL ON TABLE public.login_lockouts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.login_lockouts_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 2. FUNÇÃO: record_failed_login — registra falha e retorna lockout info
--
-- Retorna:
--   is_locked       boolean — se o identifier está em lockout agora
--   locked_until    timestamptz — quando o lockout termina (null se livre)
--   failed_attempts integer — total de tentativas na janela atual
--   lockout_level   integer — nível atual (0-3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_failed_login(
  p_identifier      text,
  p_identifier_type text   -- 'email' ou 'ip'
)
RETURNS TABLE(
  is_locked       boolean,
  locked_until    timestamptz,
  failed_attempts integer,
  lockout_level   integer
)
SECURITY DEFINER
SET search_path = extensions, public
LANGUAGE plpgsql
AS $$
DECLARE
  v_rec     public.login_lockouts%ROWTYPE;
  v_now     timestamptz := now();
  v_level   integer;
  v_until   timestamptz;
  v_attempts integer;
BEGIN
  -- Busca registro existente
  SELECT * INTO v_rec
    FROM public.login_lockouts
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Primeira falha — insere com nível 0 (ainda sem lockout)
    INSERT INTO public.login_lockouts
      (identifier, identifier_type, failed_attempts, lockout_level, last_attempt_at)
    VALUES
      (p_identifier, p_identifier_type, 1, 0, v_now);

    RETURN QUERY SELECT false, NULL::timestamptz, 1, 0;
    RETURN;
  END IF;

  -- Verifica se lockout atual ainda está ativo
  IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
    -- Ainda em lockout — incrementa tentativas e mantém lockout
    UPDATE public.login_lockouts
       SET failed_attempts  = v_rec.failed_attempts + 1,
           last_attempt_at  = v_now
     WHERE id = v_rec.id;

    RETURN QUERY SELECT true, v_rec.locked_until, v_rec.failed_attempts + 1, v_rec.lockout_level;
    RETURN;
  END IF;

  -- Lockout expirou — incrementa tentativas e calcula próximo nível
  v_attempts := v_rec.failed_attempts + 1;
  v_level    := v_rec.lockout_level;

  -- Progressão: 3 falhas = nível 1 (15min), 5 = nível 2 (1h), 8 = nível 3 (24h)
  -- Cada nível é atingido acumulando falhas dentro da janela
  IF v_attempts >= 8 THEN
    v_level := 3;
    v_until := v_now + interval '24 hours';
  ELSIF v_attempts >= 5 THEN
    v_level := 2;
    v_until := v_now + interval '1 hour';
  ELSIF v_attempts >= 3 THEN
    v_level := 1;
    v_until := v_now + interval '15 minutes';
  ELSE
    v_level := 0;
    v_until := NULL;
  END IF;

  UPDATE public.login_lockouts
     SET failed_attempts  = v_attempts,
         lockout_level    = v_level,
         locked_until     = v_until,
         last_attempt_at  = v_now
   WHERE id = v_rec.id;

  RETURN QUERY SELECT (v_until IS NOT NULL AND v_until > v_now), v_until, v_attempts, v_level;
END;
$$;

REVOKE ALL ON FUNCTION public.record_failed_login(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_failed_login(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_failed_login(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_failed_login(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. FUNÇÃO: clear_login_lockout — limpa lockout após login bem-sucedido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_login_lockout(
  p_identifier      text,
  p_identifier_type text
)
RETURNS void
SECURITY DEFINER
SET search_path = extensions, public
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.login_lockouts
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_login_lockout(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_login_lockout(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.clear_login_lockout(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_login_lockout(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. FUNÇÃO: check_login_lockout — verifica se está bloqueado (leitura)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_login_lockout(
  p_identifier      text,
  p_identifier_type text
)
RETURNS TABLE(
  is_locked       boolean,
  locked_until    timestamptz,
  lockout_level   integer
)
SECURITY DEFINER
SET search_path = extensions, public
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (locked_until IS NOT NULL AND locked_until > now()),
    locked_until,
    lockout_level
  FROM public.login_lockouts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::timestamptz, 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_lockout(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_login_lockout(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_login_lockout(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_lockout(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Limpeza automática (cron via pg_cron — ativa se disponível)
-- ---------------------------------------------------------------------------
-- Removes lockouts expirados há mais de 48h (cleanup periódico)
-- SELECT cron.schedule('limpar-lockouts', '0 3 * * *', $$
--   DELETE FROM public.login_lockouts
--    WHERE (locked_until IS NULL AND last_attempt_at < now() - interval '48 hours')
--       OR (locked_until IS NOT NULL AND locked_until < now() - interval '48 hours');
-- $$);
