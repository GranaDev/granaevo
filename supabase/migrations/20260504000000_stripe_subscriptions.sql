-- ── stripe_subscriptions ─────────────────────────────────────────────────────
-- Tabela central para assinaturas recorrentes via Stripe.
-- Coexiste com a tabela `subscriptions` (Cakto/vitálicio) durante a migração.
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email              TEXT        NOT NULL,
  stripe_customer_id      TEXT        NOT NULL UNIQUE,
  stripe_subscription_id  TEXT        UNIQUE,
  stripe_price_id         TEXT,
  plan_name               TEXT,        -- 'individual' | 'casal' | 'familia'
  status                  TEXT        NOT NULL DEFAULT 'incomplete',
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN     NOT NULL DEFAULT FALSE,
  canceled_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stripe_subscriptions_user_id_idx    ON stripe_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_user_email_idx ON stripe_subscriptions (user_email);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_status_idx     ON stripe_subscriptions (status);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_id_idx ON stripe_subscriptions (stripe_customer_id);

-- ── stripe_events — idempotência de webhooks ──────────────────────────────────
-- Garante que o mesmo evento Stripe não seja processado duas vezes em caso de
-- retry do Stripe (ex: timeout na primeira entrega).
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT        PRIMARY KEY,  -- Stripe event ID (evt_xxx)
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Limpa eventos antigos automaticamente (mais de 30 dias)
CREATE INDEX IF NOT EXISTS stripe_events_processed_at_idx ON stripe_events (processed_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events         ENABLE ROW LEVEL SECURITY;

-- Usuários autenticados leem apenas suas próprias assinaturas
CREATE POLICY "stripe_sub_select_own"
  ON stripe_subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- stripe_events: sem acesso externo (somente service role via Edge Functions)
-- Ausência de policy = nenhum acesso para roles não-service.
