-- ── Novas RLS para stripe_subscriptions ──────────────────────────────────────
-- Permite que usuários autenticados leiam a própria subscription pelo email
-- quando user_id ainda é NULL (primeira autenticação após compra anônima).
-- Também permite que o usuário vincule a própria subscription (auto-link).

-- SELECT por email — necessário para auto-link no primeiro login
CREATE POLICY "stripe_sub_select_by_email"
  ON stripe_subscriptions FOR SELECT
  TO authenticated
  USING (lower(user_email) = lower(auth.jwt()->>'email'));

-- UPDATE para auto-link: apenas quando user_id é NULL e email bate
-- WITH CHECK garante que só possam setar user_id = auth.uid()
CREATE POLICY "stripe_sub_update_claim"
  ON stripe_subscriptions FOR UPDATE
  TO authenticated
  USING  (user_id IS NULL AND lower(user_email) = lower(auth.jwt()->>'email'))
  WITH CHECK (auth.uid() = user_id);
