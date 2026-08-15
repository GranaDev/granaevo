-- ─────────────────────────────────────────────────────────────────────────────
-- RETENÇÃO DE `rate_limit_writes` — a tabela que vai começar a receber linhas
--
-- CONTEXTO (achado de 2026-08-14, corrigido em 2026-08-15):
-- `verificar_rate_limit_escrita()` existia desde sempre e nunca fora chamada.
-- A prova era esta tabela: `SELECT count(*) FROM rate_limit_writes` → 0 linhas
-- desde sempre. Contador zerado em tabela de contador não significa "ninguém
-- abusou", significa "ninguém contou".
--
-- A edge `save-user-data` passou a chamá-la (bloco 3.6). A partir do deploy,
-- esta tabela recebe UMA LINHA POR PESSOA POR HORA ATIVA — e o pg_cron não
-- limpa nada sozinho. Ligar o contador sem ligar a poda seria trocar um buraco
-- por outro: crescimento sem fim numa tabela que entra em todo backup.
--
-- POR QUE ESTA PODE SER APLICADA SEM DECISÃO DO DONO (ao contrário da
-- 20260813120000, que espera): lá o DELETE apaga histórico operacional real e
-- irreversível. Aqui não há o que perder — a tabela está VAZIA hoje, e o que
-- ela guardará são contadores de janelas já encerradas, sem valor depois que a
-- hora vira. A evidência de abuso não mora aqui: quem estoura o teto vira linha
-- em `fraud_logs` (`event_type = 'rate_limit_exceeded'`), que é permanente.
--
-- 2 HORAS: a janela é `date_trunc('hour', now())`. Duas horas cobrem a janela
-- corrente e a anterior com folga. É o mesmo número já usado para
-- `edge_rate_limits` no mesmo job — uma regra só, não duas para lembrar.
-- ─────────────────────────────────────────────────────────────────────────────

-- Reaproveita o job horário que já existe (`granaevo-limpar-rate-limits`,
-- jobid 7) em vez de criar um segundo. Duas tabelas com a mesma função, a mesma
-- coluna de janela e a mesma retenção não merecem dois agendamentos que podem
-- divergir com o tempo. `cron.schedule` com um jobname existente ATUALIZA o job.
SELECT cron.schedule(
  'granaevo-limpar-rate-limits',
  '0 * * * *',
  $$
    DELETE FROM public.edge_rate_limits
     WHERE window_start < now() - interval '2 hours';

    DELETE FROM public.rate_limit_writes
     WHERE window_start < now() - interval '2 hours';
  $$
);
