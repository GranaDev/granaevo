-- =============================================================================
-- DOWN de 20260626100000_drop_legacy_cakto_functions.sql
-- Recria as 12 funções legadas Cakto (capturadas LIVE em 2026-06-26) + o cron.
-- ATENÇÃO: estas funções leem a relação `subscriptions`/`temp_passwords` que NÃO
-- existe — elas voltam QUEBRADAS (erram em runtime). Este DOWN existe só para
-- simetria de rollback; não restaura funcionalidade.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.can_upgrade(user_uuid uuid, new_plan_name text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE current_plan text; plan_order jsonb := '{"Individual": 1, "Casal": 2, "Familia": 3}'::jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RETURN false; END IF;
    IF auth.uid() <> user_uuid THEN RAISE EXCEPTION 'Acesso negado: voce so pode consultar o proprio plano.'; END IF;
    SELECT p.name INTO current_plan FROM subscriptions s JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = user_uuid AND s.is_active = true AND s.payment_status = 'approved'
    ORDER BY s.created_at DESC LIMIT 1;
    IF current_plan IS NULL THEN RETURN true; END IF;
    RETURN (plan_order ->> new_plan_name)::integer > (plan_order ->> current_plan)::integer;
END; $function$;

CREATE OR REPLACE FUNCTION public.check_email_payment_status(email_input text)
 RETURNS TABLE(has_payment boolean, payment_approved boolean, has_password boolean, user_id uuid, user_name text, plan_name text, subscription_id uuid, error_message text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sub_record RECORD; auth_user_record RECORD;
BEGIN
  SELECT s.id, s.user_id, s.user_name, s.user_email, s.payment_status, s.is_active, s.refunded_at, s.password_created, p.name as plan_name
  INTO sub_record FROM subscriptions s LEFT JOIN plans p ON s.plan_id = p.id
  WHERE LOWER(s.user_email) = LOWER(email_input) ORDER BY s.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE, FALSE, FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, 'Nenhuma compra encontrada para este email.'::TEXT; RETURN; END IF;
  IF sub_record.payment_status != 'approved' THEN RETURN QUERY SELECT TRUE, FALSE, FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, 'Pagamento ainda nao foi aprovado.'::TEXT; RETURN; END IF;
  IF NOT sub_record.is_active THEN RETURN QUERY SELECT TRUE, TRUE, FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, 'Assinatura inativa.'::TEXT; RETURN; END IF;
  IF sub_record.refunded_at IS NOT NULL THEN RETURN QUERY SELECT TRUE, TRUE, FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, 'Esta compra foi reembolsada.'::TEXT; RETURN; END IF;
  IF sub_record.user_id IS NOT NULL THEN
    SELECT id, email INTO auth_user_record FROM auth.users WHERE id = sub_record.user_id;
    IF FOUND THEN RETURN QUERY SELECT TRUE, TRUE, TRUE, sub_record.user_id, sub_record.user_name, sub_record.plan_name, sub_record.id, 'Voce ja possui uma senha cadastrada.'::TEXT; RETURN; END IF;
  END IF;
  RETURN QUERY SELECT TRUE, TRUE, FALSE, sub_record.user_id, sub_record.user_name, sub_record.plan_name, sub_record.id, NULL::TEXT;
END; $function$;

CREATE OR REPLACE FUNCTION public.check_profile_limit()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE current_count integer; limite integer;
BEGIN
    PERFORM 1 FROM profiles WHERE user_id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO current_count FROM profiles WHERE user_id = NEW.user_id;
    limite := max_profiles_for_user(NEW.user_id);
    IF current_count >= limite THEN RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', limite; END IF;
    RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_passwords()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM temp_passwords WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END; $function$;

CREATE OR REPLACE FUNCTION public.expire_pending_payments()
 RETURNS void LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$BEGIN
  UPDATE subscriptions SET payment_status = 'expired' WHERE payment_status = 'pending' AND expires_at < NOW();
END;$function$;

CREATE OR REPLACE FUNCTION public.generate_access_token()
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE token TEXT; exists BOOLEAN;
BEGIN
  LOOP
    token := encode(gen_random_bytes(24), 'base64');
    token := replace(replace(replace(token, '/', ''), '+', ''), '=', '');
    SELECT EXISTS(SELECT 1 FROM subscriptions WHERE access_token = token) INTO exists;
    IF NOT exists THEN RETURN token; END IF;
  END LOOP;
END; $function$;

CREATE OR REPLACE FUNCTION public.get_user_subscription(user_uuid uuid)
 RETURNS TABLE(name text, max_profiles integer, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN RETURN; END IF;
    IF auth.uid() <> user_uuid THEN RAISE EXCEPTION 'Acesso negado: voce so pode consultar a propria assinatura.'; END IF;
    RETURN QUERY SELECT p.name, p.max_profiles, s.payment_status, s.created_at
    FROM subscriptions s JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = user_uuid AND s.is_active = true AND s.payment_status = 'approved'
    ORDER BY s.created_at DESC LIMIT 1;
END; $function$;

CREATE OR REPLACE FUNCTION public.max_profiles_for_user(uid uuid)
 RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE((SELECT pl.max_profiles FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
         WHERE (s.user_id = uid OR s.user_email = (SELECT email FROM auth.users WHERE id = uid))
           AND s.is_active = true AND s.payment_status = 'approved'
           AND (s.expires_at IS NULL OR s.expires_at > now())
         ORDER BY s.user_id NULLS LAST LIMIT 1), 0);
$function$;

CREATE OR REPLACE FUNCTION public.revoke_user_access(p_user_id uuid, p_reason text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Acesso negado: esta funcao so pode ser chamada pelo servidor.'; END IF;
  UPDATE public.subscriptions SET is_active = false, payment_status = 'refunded', access_revoked_at = NOW(), refund_reason = p_reason, refunded_at = NOW() WHERE user_id = p_user_id;
  UPDATE auth.users SET email_confirmed_at = NULL, banned_until = NOW() + INTERVAL '100 years' WHERE id = p_user_id;
  RAISE NOTICE 'Acesso revogado para user_id: %, motivo: %', p_user_id, p_reason;
END; $function$;

CREATE OR REPLACE FUNCTION public.sync_subscription_user_id()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE public.subscriptions SET user_id = NEW.id, updated_at = now()
    WHERE lower(user_email) = lower(NEW.email) AND user_id IS NULL;
    RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.update_user_profile_management()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO user_profile_management (user_id, email, active_profiles_count, profile_names, plan_name)
  SELECT NEW.user_id, (SELECT email FROM auth.users WHERE id = NEW.user_id), COUNT(*), ARRAY_AGG(name ORDER BY id),
    (SELECT plans.name FROM subscriptions JOIN plans ON subscriptions.plan_id = plans.id
     WHERE subscriptions.user_id = NEW.user_id AND payment_status = 'approved' ORDER BY subscriptions.created_at DESC LIMIT 1)
  FROM profiles WHERE user_id = NEW.user_id GROUP BY user_id
  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, active_profiles_count = EXCLUDED.active_profiles_count,
    profile_names = EXCLUDED.profile_names, plan_name = EXCLUDED.plan_name, updated_at = NOW();
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.validate_access_token(token_input text)
 RETURNS TABLE(is_valid boolean, subscription_id uuid, user_email text, plan_name text, error_message text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sub_record RECORD;
BEGIN
  SELECT s.id, s.user_email, s.access_token_used, s.access_token_expires_at, s.payment_status, s.is_active, s.refunded_at, p.name as plan_name
  INTO sub_record FROM subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.access_token = token_input;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Token invalido ou nao encontrado'::TEXT; RETURN; END IF;
  IF sub_record.access_token_used THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Este link ja foi utilizado.'::TEXT; RETURN; END IF;
  IF sub_record.access_token_expires_at < NOW() THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Este link expirou.'::TEXT; RETURN; END IF;
  IF sub_record.payment_status != 'approved' THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Pagamento ainda nao foi aprovado.'::TEXT; RETURN; END IF;
  IF NOT sub_record.is_active THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Assinatura inativa.'::TEXT; RETURN; END IF;
  IF sub_record.refunded_at IS NOT NULL THEN RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT, 'Esta compra foi reembolsada.'::TEXT; RETURN; END IF;
  RETURN QUERY SELECT TRUE, sub_record.id, sub_record.user_email, sub_record.plan_name, NULL::TEXT;
END; $function$;

-- Restaura o grant notável (oráculo de token era executável por anon)
GRANT EXECUTE ON FUNCTION public.validate_access_token(text) TO anon;

-- Reagenda o cron horário que chamava expire_pending_payments()
SELECT cron.schedule('expire_pending_payments_hourly', '0 * * * *', 'SELECT expire_pending_payments();');
