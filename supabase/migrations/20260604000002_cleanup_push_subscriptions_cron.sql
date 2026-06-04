-- =============================================================================
-- GranaEvo — Migration: Cron job para limpeza automática de push_subscriptions
--
-- Contexto: a tabela push_subscriptions tem uma função cleanup_push_subscriptions()
-- com SECURITY DEFINER, mas sem cron job configurado para chamá-la.
-- Esta migration ativa a limpeza automática via SQL inline (padrão do projeto).
--
-- Limpeza:
--   - Subscriptions inativas há mais de 90 dias → removidas
--   - Subscriptions sem uso há mais de 180 dias → removidas
-- =============================================================================

SELECT cron.schedule(
  'granaevo-limpar-push-subscriptions',
  '0 4 * * 0',  -- domingos às 4h UTC (baixo tráfego)
  $$
    DELETE FROM public.push_subscriptions
    WHERE is_active = false
      AND last_used_at < now() - INTERVAL '90 days';

    DELETE FROM public.push_subscriptions
    WHERE last_used_at < now() - INTERVAL '180 days';
  $$
);
