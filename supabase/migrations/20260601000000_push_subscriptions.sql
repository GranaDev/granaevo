-- Push Subscriptions — armazena endpoints VAPID por usuário/dispositivo
-- Cada usuário pode ter múltiplos dispositivos (desktop, mobile, tablet)
-- RLS: usuário só acessa suas próprias subscriptions

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint        text        NOT NULL,
  p256dh          text        NOT NULL,  -- chave pública do cliente
  auth_key        text        NOT NULL,  -- chave de autenticação do cliente
  user_agent      text,
  created_at      timestamptz DEFAULT now(),
  last_used_at    timestamptz DEFAULT now(),
  is_active       boolean     DEFAULT true,

  -- Previne subscriptions duplicadas por dispositivo
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions (user_id)
  WHERE is_active = true;

-- RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;

-- SELECT: usuário vê apenas suas próprias subscriptions
CREATE POLICY "push_select_own" ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT: usuário só insere para si mesmo
CREATE POLICY "push_insert_own" ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE: usuário só atualiza as próprias (apenas last_used_at e is_active)
CREATE POLICY "push_update_own" ON push_subscriptions
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE: usuário pode remover as próprias
CREATE POLICY "push_delete_own" ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- Revogar acesso anon (nenhum acesso sem autenticação)
REVOKE ALL ON push_subscriptions FROM anon;
REVOKE ALL ON push_subscriptions FROM public;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO authenticated;

-- Cleanup automático: remove subscriptions inativas há mais de 90 dias
-- Chamado pelo CRON job existente do Supabase
CREATE OR REPLACE FUNCTION cleanup_push_subscriptions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM push_subscriptions
  WHERE is_active = false
    AND last_used_at < now() - INTERVAL '90 days';

  DELETE FROM push_subscriptions
  WHERE last_used_at < now() - INTERVAL '180 days';
END;
$$;
