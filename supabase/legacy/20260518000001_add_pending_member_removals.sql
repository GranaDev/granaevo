-- Migration: adiciona pending_member_removals à stripe_subscriptions
-- Armazena IDs (UUID) de account_members a desativar quando o downgrade entrar em vigor.

ALTER TABLE stripe_subscriptions
  ADD COLUMN IF NOT EXISTS pending_member_removals JSONB DEFAULT NULL;

COMMENT ON COLUMN stripe_subscriptions.pending_member_removals IS
  'IDs (UUID) de account_members a desativar quando o downgrade pendente entrar em vigor na renovação';
