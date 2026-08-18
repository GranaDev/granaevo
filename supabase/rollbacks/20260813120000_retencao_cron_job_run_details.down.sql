-- ROLLBACK de 20260813120000_retencao_cron_job_run_details.sql
--
-- Desagenda a poda e remove a função. As linhas já apagadas NÃO voltam — o
-- rollback devolve o comportamento (tabela volta a crescer sem limite), não o
-- histórico. É a razão de a migration UP não ter sido aplicada sem decisão do
-- dono: a parte irreversível é o DELETE, não o agendamento.

SELECT cron.unschedule('granaevo-purge-cron-run-details')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-cron-run-details');

DROP FUNCTION IF EXISTS public.purge_cron_run_details();
