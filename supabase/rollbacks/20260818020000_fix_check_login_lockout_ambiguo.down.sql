-- Rollback: 20260818020000_fix_check_login_lockout_ambiguo.sql
-- ATENCAO: reverter QUEBRA DE NOVO o lockout por conta. A funcao volta a
-- levantar 42702 em toda chamada, e como check-user-access descarta o erro, o
-- gate volta a nunca aplicar -- em silencio. So reverta com motivo muito bom.
BEGIN;
CREATE OR REPLACE FUNCTION public.check_login_lockout(p_identifier text, p_identifier_type text)
RETURNS TABLE(is_locked boolean, locked_until timestamp with time zone, lockout_level integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT (locked_until IS NOT NULL AND locked_until > now()), locked_until, lockout_level
  FROM public.login_lockouts
  WHERE identifier = p_identifier AND identifier_type = p_identifier_type
  LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::timestamptz, 0; END IF;
END;
$function$;
COMMIT;
