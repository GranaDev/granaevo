-- =============================================================================
-- GranaEvo — Migration: Ativar pg_cron para limpeza periódica de rate limits
--
-- Pré-requisito: pg_cron deve estar habilitado no projeto Supabase.
--   Ative em: Dashboard → Settings → Database → Extensions → pg_cron
--
-- Esta migration agenda a limpeza de linhas expiradas na tabela
-- edge_rate_limits para evitar crescimento ilimitado em produção.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ativar extensão pg_cron (idempotente — não falha se já ativa)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 2. Agendar limpeza a cada hora — remove entradas com janela > 2h
--    A tabela edge_rate_limits acumula ~1 linha por IP/usuário por requisição.
--    Sem limpeza, cresce indefinidamente e degrada o UPSERT do rate limiter.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
    'limpar-rate-limits',           -- nome único do job (idempotente via nome)
    '0 * * * *',                    -- a cada hora, no minuto 0
    $$
        DELETE FROM public.edge_rate_limits
        WHERE window_start < now() - INTERVAL '2 hours';
    $$
);

-- ---------------------------------------------------------------------------
-- 3. Grant mínimo — pg_cron roda como superuser, mas o job altera public
--    Nenhum grant extra necessário (service_role já tem ALL em edge_rate_limits)
-- ---------------------------------------------------------------------------
