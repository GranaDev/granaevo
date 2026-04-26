-- =============================================================================
-- GranaEvo — Migration: Idempotência de webhooks via UNIQUE constraint
--
-- Problema: webhook-cakto usa check-then-insert sem transação atômica.
-- Dois webhooks simultâneos para o mesmo cakto_order_id criam subscriptions
-- duplicadas (race condition TOCTOU).
--
-- Solução: UNIQUE constraint em cakto_order_id força o banco a rejeitar o
-- segundo INSERT, independente de timing. O webhook-cakto já faz o check
-- SELECT antes do INSERT — na corrida, um dos dois INSERT falha com
-- constraint violation, que é capturado pelo try/catch e retorna 500,
-- levando a Cakto a retentar (e o retry encontra a subscription existente).
-- =============================================================================

-- Índice único parcial: apenas para cakto_order_id não nulo.
-- cakto_order_id NULL é permitido para subscriptions criadas manualmente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_cakto_order_id_unique
  ON public.subscriptions (cakto_order_id)
  WHERE cakto_order_id IS NOT NULL;

-- Idempotência na tabela payment_events — evita duplicação de log de eventos.
-- Composto: (cakto_order_id, event_type) para permitir múltiplos tipos
-- de evento (approved, refunded, cancelled) para o mesmo pedido.
-- Não aplica UNIQUE aqui pois o mesmo evento pode ser re-enviado pela Cakto.
-- O log duplicado não causa dano funcional, apenas ruído.
-- Deixamos como está para evitar rejeitar re-envios legítimos da Cakto.
