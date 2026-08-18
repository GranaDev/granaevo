-- Rollback do O-3 — recria os dois índices GIN exatamente como estavam.
--
-- Definições copiadas de `pg_indexes` em produção ANTES do DROP, não escritas
-- de memória. Recriar não "conserta" nada (eles continuam inutilizáveis), mas
-- rollback existe para restaurar o estado, não para julgá-lo.
--
-- CONCURRENTLY de propósito: recriar GIN trava escrita, e `user_data` é o
-- caminho de save do app inteiro. Um rollback não pode ser pior que o problema.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_data_json
  ON public.user_data USING gin (data_json);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_events_data
  ON public.payment_events USING gin (event_data);
