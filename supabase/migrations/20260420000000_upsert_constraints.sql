-- =============================================================================
-- GranaEvo — Migration: UNIQUE constraints para suporte a upsert seguro
-- Aplique via: supabase db push
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. user_data: garantir UNIQUE em user_id para suportar upsert atômico
--    no data-manager.js. O índice idx_user_data_user_id existia como index
--    simples; precisamos de UNIQUE constraint para o ON CONFLICT do upsert.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_data
  ADD CONSTRAINT IF NOT EXISTS user_data_user_id_key UNIQUE (user_id);

-- ---------------------------------------------------------------------------
-- 2. pg_cron: limpeza automática de rate limits (ativa se pg_cron disponível)
--    Executa de hora em hora para manter edge_rate_limits enxuta.
-- ---------------------------------------------------------------------------
-- Descomente para ativar (requer pg_cron habilitado no projeto Supabase):
-- SELECT cron.schedule(
--   'limpar-rate-limits-horario',
--   '0 * * * *',
--   $$SELECT public.cleanup_expired_rate_limits();$$
-- );

-- ---------------------------------------------------------------------------
-- 3. Índice parcial em user_data para leituras frequentes do data-manager
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_data_user_id_partial
  ON public.user_data (user_id)
  WHERE user_id IS NOT NULL;
