-- ─────────────────────────────────────────────────────────────────────────────
-- RETENÇÃO DO LOG DE EXECUÇÃO DO pg_cron
--
-- MEDIDO em produção (2026-08-13):
--   cron.job_run_details ..... 37.478 linhas · 13 MB · MAIOR TABELA DO BANCO
--   linha mais antiga ........ 2026-01-08
--   falhas registradas ....... 15.908 (42,4%)
--
-- As 15.908 falhas são LIXO HISTÓRICO: todas de dois jobs que deixaram de
-- existir na limpeza do Cakto (2026-06-26) — `net.http_post` sem a extensão
-- pg_net e `UPDATE subscriptions` numa tabela que já não existia. A última
-- falha do banco é de 2026-06-26. Nenhum job ativo falha hoje.
--
-- O pg_cron NÃO limpa esta tabela sozinho: ela cresce ~150 linhas/dia, para
-- sempre. Dois custos vivos:
--
--   1. É a maior tabela do banco e entra inteira em todo backup — inclusive no
--      pg_dump do plano de recuperação de desastre.
--
--   2. `get_cron_failures_24h()` (o health check que roda pelo cron da Vercel)
--      faz SEQ SCAN da tabela toda, porque o único índice é a PK em runid:
--        Seq Scan on job_run_details  (Rows Removed by Filter: 37478)
--        Buffers: shared hit=1511     -- 12 MB varridos para devolver 0 linhas
--      Medido: 11 ms com cache quente; 577 ms de média em produção via PostgREST
--      (45 chamadas, pg_stat_statements) — 1,6% de todo o tempo de banco.
--
-- ✅ APLICADA EM PRODUÇÃO EM 2026-08-15, com decisão explícita do dono pelos
-- 30 dias. A poda inicial removeu 33.120 linhas (37.785 → 4.667) e o VACUUM
-- devolveu o espaço. Job  (jobid 32) ativo.
--
-- Registro do que a decisão pesou: só  lê esta tabela,
-- com janela de 24 h — 30 dias é 30× a necessidade e ainda deixa um mês para
-- investigar um job intermitente. As 15.908 falhas apagadas eram todas de dois
-- jobs mortos desde 2026-06-26.
--
-- (Texto original do aviso, mantido pelo histórico:)
-- ⚠️ ESTA MIGRATION NÃO FOI APLICADA EM PRODUÇÃO PELO AGENTE.
-- Apagar linha em produção é irreversível, e o próprio briefing manda verificar
-- a política de dados antes de mexer em retenção. Estes registros não são dado
-- pessoal (não entram na LGPD nem no financial_audit_log), mas a decisão de
-- quanto histórico operacional guardar é do dono. Aplicar quando ele decidir.
--
-- 30 dias é a escolha proposta: cobre com folga a janela de 24 h que o health
-- check consulta e ainda deixa um mês de histórico para investigar um job que
-- comece a falhar de forma intermitente.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. A função de poda. SECURITY DEFINER porque o schema `cron` pertence ao
--    postgres; `search_path` fixado, como toda DEFINER deste projeto.
CREATE OR REPLACE FUNCTION public.purge_cron_run_details()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
DECLARE
  removidas integer;
BEGIN
  DELETE FROM cron.job_run_details
   WHERE start_time < now() - interval '30 days';
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$;

-- Ninguém além do agendador tem motivo para chamar isto. Sem o REVOKE, uma
-- função DEFINER nasce executável por qualquer papel — inclusive o anon.
REVOKE ALL ON FUNCTION public.purge_cron_run_details() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_cron_run_details() FROM anon, authenticated;

COMMENT ON FUNCTION public.purge_cron_run_details() IS
  'Poda o log de execução do pg_cron (retenção 30 dias). O pg_cron não limpa '
  'esta tabela sozinho; sem poda ela cresce ~150 linhas/dia para sempre e força '
  'seq scan no health check get_cron_failures_24h().';

-- 2. Agenda. 04h40 não colide com nenhum dos jobs existentes (o mais tardio é
--    o das 04h20, granaevo-purge-signup-codes).
SELECT cron.schedule(
  'granaevo-purge-cron-run-details',
  '40 4 * * *',
  $$SELECT public.purge_cron_run_details();$$
);
