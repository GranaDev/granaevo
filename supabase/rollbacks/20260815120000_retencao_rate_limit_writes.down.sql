-- ROLLBACK de 20260815120000_retencao_rate_limit_writes.sql
--
-- Devolve o job ao comando anterior: limpa só `edge_rate_limits`.
--
-- ⚠️ Só faz sentido reverter isto JUNTO com o desligamento da chamada a
-- `verificar_rate_limit_escrita()` na edge `save-user-data`. Reverter só a poda
-- deixa o contador ligado e a tabela crescendo para sempre — que é exatamente o
-- estado que esta migration existe para evitar.

SELECT cron.schedule(
  'granaevo-limpar-rate-limits',
  '0 * * * *',
  $$
    DELETE FROM public.edge_rate_limits
     WHERE window_start < now() - interval '2 hours';
  $$
);
