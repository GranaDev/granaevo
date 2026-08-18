-- 20260812000000_lockout_duravel_alinhado.down.sql
-- Rollback de 20260812000000_lockout_duravel_alinhado.sql
--
-- ⚠️ ORDEM IMPORTA: primeiro apagar as linhas com identifier_type='email_sha256',
-- depois estreitar o CHECK. O caminho inverso falha, porque o CHECK novo seria
-- violado pelas linhas que a Edge Function `login-lockout` já gravou.
--
-- ⚠️ ANTES DE RODAR ISTO: reverter também o cliente. Um banco com a função antiga
-- e uma `login-lockout` ainda no ar volta a acumular falhas SEM janela e tranca em
-- 3 falhas — que é exatamente o defeito que a migration veio corrigir.

DELETE FROM public.login_lockouts WHERE identifier_type = 'email_sha256';

ALTER TABLE public.login_lockouts
    DROP CONSTRAINT IF EXISTS login_lockouts_identifier_type_check;

ALTER TABLE public.login_lockouts
    ADD CONSTRAINT login_lockouts_identifier_type_check
    CHECK (identifier_type = ANY (ARRAY['email'::text, 'ip'::text]));

-- Restaura a versão anterior: degraus 3/5/8, sem janela, SELECT FOR UPDATE.
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
  v_rec      public.login_lockouts%ROWTYPE;
  v_now      timestamptz := now();
  v_level    integer;
  v_until    timestamptz;
  v_attempts integer;
BEGIN
  SELECT * INTO v_rec
    FROM public.login_lockouts
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.login_lockouts
      (identifier, identifier_type, failed_attempts, lockout_level, last_attempt_at)
    VALUES
      (p_identifier, p_identifier_type, 1, 0, v_now);
    RETURN QUERY SELECT false, NULL::timestamptz, 1, 0;
    RETURN;
  END IF;

  IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
    UPDATE public.login_lockouts
       SET failed_attempts = v_rec.failed_attempts + 1,
           last_attempt_at = v_now
     WHERE id = v_rec.id;
    RETURN QUERY SELECT true, v_rec.locked_until, v_rec.failed_attempts + 1, v_rec.lockout_level;
    RETURN;
  END IF;

  v_attempts := v_rec.failed_attempts + 1;
  v_level    := v_rec.lockout_level;

  IF v_attempts >= 8 THEN
    v_level := 3; v_until := v_now + interval '24 hours';
  ELSIF v_attempts >= 5 THEN
    v_level := 2; v_until := v_now + interval '1 hour';
  ELSIF v_attempts >= 3 THEN
    v_level := 1; v_until := v_now + interval '15 minutes';
  ELSE
    v_level := 0; v_until := NULL;
  END IF;

  UPDATE public.login_lockouts
     SET failed_attempts = v_attempts,
         lockout_level   = v_level,
         locked_until    = v_until,
         last_attempt_at = v_now
   WHERE id = v_rec.id;

  RETURN QUERY SELECT (v_until IS NOT NULL AND v_until > v_now), v_until, v_attempts, v_level;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.record_failed_login(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_failed_login(text, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_failed_login(text, text) TO service_role;
