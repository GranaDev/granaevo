-- Coluna de idempotência do auto-reembolso da garantia de 7 dias (CDC art. 49).
-- O webhook-stripe checa refunded_at ANTES de reembolsar e grava DEPOIS: uma
-- reentrega do evento (a Stripe reentrega em 5xx) não reembolsa duas vezes.
ALTER TABLE public.stripe_subscriptions
    ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

COMMENT ON COLUMN public.stripe_subscriptions.refunded_at IS
    'Marca do auto-reembolso da garantia de 7 dias. NULL = nunca reembolsado. Trava de idempotencia do webhook-stripe. Ver migration 20260717140000.';
