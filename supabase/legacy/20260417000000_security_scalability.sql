-- =============================================================================
-- GranaEvo — Migration: Segurança e Escalabilidade
-- Aplique via: supabase db push  (ou execute no SQL Editor do Supabase Dashboard)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. FUNÇÃO: lookup de usuário no auth.users por e-mail — O(1) via índice
--    Substitui auth.admin.listUsers() O(n) em link-user-subscription.
--    SECURITY DEFINER roda com os privilégios do owner (postgres),
--    permitindo acesso ao schema auth sem expô-lo na API pública.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_auth_user_by_email(p_email text)
RETURNS TABLE(user_id uuid, email_confirmed_at timestamptz)
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT au.id, au.email_confirmed_at
  FROM auth.users au
  WHERE au.email = lower(trim(p_email))
  LIMIT 1;
END;
$$;

-- Revogar acesso público; apenas service_role pode chamar
REVOKE ALL ON FUNCTION public.get_auth_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_auth_user_by_email(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_auth_user_by_email(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_auth_user_by_email(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. TABELA: edge_rate_limits — rate limiting server-side para Edge Functions
--    Evita spam/enumeração em endpoints públicos (check-email, reset-password).
--    TTL implícito: linhas com window_start > 1h são ignoradas nas queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  key             text        NOT NULL,
  count           integer     NOT NULL DEFAULT 1,
  window_start    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_rate_limits_pkey PRIMARY KEY (key)
);

-- Apenas service_role acessa (Edge Functions usam service role key)
REVOKE ALL ON TABLE public.edge_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.edge_rate_limits FROM anon;
REVOKE ALL ON TABLE public.edge_rate_limits FROM authenticated;
GRANT ALL ON TABLE public.edge_rate_limits TO service_role;

-- Limpeza automática de janelas expiradas (>2h) via cron do pg_cron (opcional)
-- SELECT cron.schedule('limpar-rate-limits', '0 * * * *', $$
--   DELETE FROM public.edge_rate_limits WHERE window_start < now() - interval '2 hours';
-- $$);

-- ---------------------------------------------------------------------------
-- 3. FUNÇÃO: check_rate_limit — atomicamente verifica + incrementa
--    Retorna TRUE se a requisição está dentro do limite.
--    Usa UPSERT com window reset para garantir atomicidade.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key             text,
  p_max             integer,
  p_window_seconds  integer
)
RETURNS boolean
SECURITY DEFINER
SET search_path = extensions, public
LANGUAGE plpgsql
AS $$
DECLARE
  v_count   integer;
  v_now     timestamptz := now();
  v_window  timestamptz := v_now - (p_window_seconds || ' seconds')::interval;
BEGIN
  -- Tenta inserir ou atualizar atomicamente
  INSERT INTO public.edge_rate_limits (key, count, window_start)
  VALUES (p_key, 1, v_now)
  ON CONFLICT (key) DO UPDATE SET
    count        = CASE
                     WHEN edge_rate_limits.window_start < v_window
                     THEN 1  -- janela expirou — reseta
                     ELSE edge_rate_limits.count + 1
                   END,
    window_start = CASE
                     WHEN edge_rate_limits.window_start < v_window
                     THEN v_now
                     ELSE edge_rate_limits.window_start
                   END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. ÍNDICES — consultas frequentes sem índice explícito
--    (adiciona apenas se não existirem para ser idempotente)
-- ---------------------------------------------------------------------------

-- subscriptions: busca por e-mail (check-email-status, send-password-reset-code)
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_email
  ON public.subscriptions (user_email);

-- subscriptions: busca por cakto_order_id (webhook)
CREATE INDEX IF NOT EXISTS idx_subscriptions_cakto_order_id
  ON public.subscriptions (cakto_order_id)
  WHERE cakto_order_id IS NOT NULL;

-- subscriptions: busca por user_id + status ativo (auth-guard, send-guest-invite)
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id_active
  ON public.subscriptions (user_id, is_active, payment_status)
  WHERE user_id IS NOT NULL;

-- account_members: busca por owner_user_id (send-guest-invite)
CREATE INDEX IF NOT EXISTS idx_account_members_owner
  ON public.account_members (owner_user_id, is_active);

-- account_members: busca por member_user_id (auth-guard)
CREATE INDEX IF NOT EXISTS idx_account_members_member
  ON public.account_members (member_user_id, is_active);

-- guest_invitations: busca por email + status (verify-guest-invite)
CREATE INDEX IF NOT EXISTS idx_guest_invitations_email_status
  ON public.guest_invitations (guest_email, used, expires_at);

-- guest_invitations: busca por owner + data (send-guest-invite rate limit)
CREATE INDEX IF NOT EXISTS idx_guest_invitations_owner_created
  ON public.guest_invitations (owner_user_id, created_at);

-- password_reset_codes: busca por email + status
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_email
  ON public.password_reset_codes (email, used, expires_at);

-- user_data: busca por user_id (data-manager)
CREATE INDEX IF NOT EXISTS idx_user_data_user_id
  ON public.user_data (user_id);

-- payment_events: busca por order_id (webhook idempotência)
CREATE INDEX IF NOT EXISTS idx_payment_events_order_id
  ON public.payment_events (cakto_order_id, event_type);

-- ---------------------------------------------------------------------------
-- 5. LIMPEZA DE RATE LIMITS EXPIRADOS — função para manutenção manual
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.edge_rate_limits
  WHERE window_start < now() - interval '2 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limits() TO service_role;
