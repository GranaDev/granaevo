-- Rollback de 20260628100000. Os índices duplicados eram redundantes — não são
-- recriados (o gêmeo idêntico permaneceu, então nenhuma cobertura foi perdida).
DROP FUNCTION IF EXISTS public.get_cron_failures_24h();
