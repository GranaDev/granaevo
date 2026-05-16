-- Armazena os IDs de account_members agendados para desativação quando
-- um downgrade de plano entrar em vigor na próxima renovação do ciclo.
-- Validado server-side em update-stripe-plan; aplicado pelo webhook ao renovar.
ALTER TABLE stripe_subscriptions
  ADD COLUMN IF NOT EXISTS pending_profile_removals JSONB;
