-- Função auxiliar para lookup de user_id direto em auth.users pelo email.
-- Usada como fallback final em verify-and-reset-password quando subscription
-- tables não têm user_id populado (ex: registros antigos ou migração Stripe).
-- Acesso restrito a service_role — não exposto a anon/authenticated.
CREATE OR REPLACE FUNCTION public.get_auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, public
STABLE
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_auth_user_id_by_email(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_auth_user_id_by_email(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_auth_user_id_by_email(text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_auth_user_id_by_email(text) TO service_role;
