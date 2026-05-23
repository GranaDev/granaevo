-- Adiciona user_id na tabela password_reset_codes para evitar lookup de subscription
-- no momento do reset. O user_id é capturado em send-password-reset-code, que já
-- verificou a assinatura. Assim verify-and-reset-password não depende de assinatura ativa.
ALTER TABLE public.password_reset_codes
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Índice para eventual auditoria futura por user_id (não usado nas queries críticas)
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_id
  ON public.password_reset_codes (user_id)
  WHERE user_id IS NOT NULL;
