-- Colunas para agendamento de downgrade de plano (estilo Netflix/Spotify)
-- Upgrade: imediato com proration_behavior=always_invoice
-- Downgrade: agendado para o final do ciclo atual
ALTER TABLE stripe_subscriptions
  ADD COLUMN IF NOT EXISTS pending_plan_name         TEXT,
  ADD COLUMN IF NOT EXISTS pending_plan_effective_at TIMESTAMPTZ;
